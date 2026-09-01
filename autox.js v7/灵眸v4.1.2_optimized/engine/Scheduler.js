/**
 * 灵眸 v4.1.2 - 调度器
 * - 异步任务 running 防重入
 * - 任务状态变更统一受锁保护
 * - generation 防止 stop -> start 时旧 Scheduler 线程“复活”形成双循环
 * - 通过 ThreadManager 管理线程，并向 WatchDog 发送真实心跳
 */
LingMouAPI.register("Scheduler", function(API) {
    "use strict";

    var _tasks = {};
    var _running = false;
    var _thread = null;
    var _threadMgr = null;
    var _watchdog = null;
    var _lock = threads.lock();
    var _generation = 0;
    var _config = {tickInterval: 100, maxErrors: 10, recoveryEnabled: true};
    var _stats = {ticks: 0, runs: 0, errors: 0, skippedReentry: 0, rejected: 0, lastTick: 0};

    function now() { return Date.now(); }
    function finiteNumber(value, fallback, min, max) {
        var n = Number(value);
        if (!isFinite(n)) n = fallback;
        if (min !== undefined) n = Math.max(min, n);
        if (max !== undefined) n = Math.min(max, n);
        return n;
    }

    function taskSnapshot() {
        _lock.lock();
        try {
            var arr = [];
            for (var k in _tasks) if (_tasks.hasOwnProperty(k)) arr.push(_tasks[k]);
            return arr;
        } finally { _lock.unlock(); }
    }

    function executeTask(task) {
        _lock.lock();
        try {
            if (_tasks[task.name] !== task || !task.enabled) return;
            if (task.running) {
                _stats.skippedReentry++;
                return;
            }
            task.running = true;
            task.lastStart = now();
        } finally { _lock.unlock(); }

        function runner() {
            var error = null;
            try { task.fn(); }
            catch (e) { error = e; }
            finally {
                _lock.lock();
                try {
                    if (error) {
                        task.errors++;
                        _stats.errors++;
                        if (task.errors >= _config.maxErrors) task.enabled = false;
                    } else {
                        task.errors = 0;
                    }
                    task.lastEnd = now();
                    task.running = false;
                    task.worker = null;
                    _stats.runs++;
                } finally { _lock.unlock(); }

                if (error) {
                    log("[Scheduler] Task error [" + task.name + "]: " + error);
                    if (task.errors >= _config.maxErrors) log("[Scheduler] Task disabled after max errors: " + task.name);
                }
            }
        }

        if (task.async !== false) {
            var w = _threadMgr.start("scheduler:" + task.name, runner, task.timeout);
            _lock.lock();
            try {
                if (!w) {
                    task.running = false;
                    task.worker = null;
                    _stats.rejected++;
                } else if (task.running) {
                    // runner 可能极快结束；仅在仍运行时保存 worker，避免留下已完成的陈旧引用。
                    task.worker = w;
                }
            } finally { _lock.unlock(); }
        } else {
            runner();
        }
    }

    function tick() {
        var t = now();
        _lock.lock();
        try {
            _stats.ticks++;
            _stats.lastTick = t;
        } finally { _lock.unlock(); }

        if (_watchdog && _watchdog.tick) {
            try { _watchdog.tick(t); } catch (e) {}
        }

        var arr = taskSnapshot();
        for (var i = 0; i < arr.length; i++) {
            var task = arr[i];
            var due = false;
            _lock.lock();
            try {
                if (_tasks[task.name] === task && task.enabled && t >= task.nextRun) {
                    task.nextRun = t + task.interval;
                    due = true;
                }
            } finally { _lock.unlock(); }
            if (due) executeTask(task);
        }
    }

    return {
        init: function(options) {
            options = options || {};
            for (var k in options) if (options.hasOwnProperty(k) && _config.hasOwnProperty(k)) _config[k] = options[k];
            _config.tickInterval = Math.floor(finiteNumber(_config.tickInterval, 100, 20, 5000));
            _config.maxErrors = Math.floor(finiteNumber(_config.maxErrors, 10, 1, 1000));
            _threadMgr = API.require("ThreadManager");
            try { _watchdog = API.require("WatchDog"); } catch (e) { _watchdog = null; }
            log("[Scheduler] Initialized");
            return true;
        },

        addTask: function(name, fn, interval, options) {
            if (!name || typeof fn !== "function") throw new Error("Invalid scheduler task");
            options = options || {};
            var iv = Math.floor(finiteNumber(interval, 1000, 1, 86400000));
            var delay = Math.floor(finiteNumber(options.delay, iv, 0, 86400000));
            var timeout = Math.floor(finiteNumber(options.timeout, 0, 0, 600000));
            var task = {
                name: String(name),
                fn: fn,
                interval: iv,
                nextRun: now() + delay,
                async: options.async !== false,
                timeout: timeout,
                enabled: options.enabled !== false,
                running: false,
                worker: null,
                errors: 0,
                lastStart: 0,
                lastEnd: 0
            };
            _lock.lock();
            try { _tasks[task.name] = task; }
            finally { _lock.unlock(); }
            return task;
        },

        add: function(name, fn, interval, options) { return this.addTask(name, fn, interval, options); },
        schedule: function(name, fn, interval, options) { return this.addTask(name, fn, interval, options); },

        remove: function(name) {
            _lock.lock();
            try {
                name = String(name);
                var task = _tasks[name];
                if (!task) return false;
                task.enabled = false;
                delete _tasks[name];
                return true;
            } finally { _lock.unlock(); }
        },

        pause: function(name) {
            _lock.lock();
            try {
                if (!_tasks[name]) return false;
                _tasks[name].enabled = false;
                return true;
            } finally { _lock.unlock(); }
        },

        resume: function(name) {
            _lock.lock();
            try {
                if (!_tasks[name]) return false;
                _tasks[name].enabled = true;
                _tasks[name].nextRun = now() + _tasks[name].interval;
                return true;
            } finally { _lock.unlock(); }
        },

        start: function() {
            if (_running && _thread && !_thread.finished) return true;
            _running = true;
            var myGeneration = ++_generation;
            var self = this;
            var w = _threadMgr.start("Scheduler", function() {
                while (_running && myGeneration === _generation) {
                    try { tick(); } catch (e) { log("[Scheduler] Tick error: " + e); }
                    sleep(_config.tickInterval);
                }
            }, 0);
            if (!w) {
                if (myGeneration === _generation) _running = false;
                return false;
            }
            _thread = w;
            log("[Scheduler] Started generation=" + myGeneration);
            return true;
        },

        stop: function() {
            _running = false;
            _generation++;
            var old = _thread;
            _thread = null;
            if (old) old.cancel();
            log("[Scheduler] Stopped");
            return true;
        },

        restart: function() {
            this.stop();
            // generation 已保证旧线程即使稍后恢复，也不会进入新一代循环。
            return this.start();
        },

        tick: tick,

        getStats: function() {
            _lock.lock();
            try {
                var copy = JSON.parse(JSON.stringify(_stats));
                var count = 0;
                for (var k in _tasks) if (_tasks.hasOwnProperty(k)) count++;
                copy.taskCount = count;
                copy.running = _running;
                copy.generation = _generation;
                return copy;
            } finally { _lock.unlock(); }
        },

        clear: function() {
            _lock.lock();
            try {
                for (var k in _tasks) if (_tasks.hasOwnProperty(k)) _tasks[k].enabled = false;
                _tasks = {};
            } finally { _lock.unlock(); }
        }
    };
});
