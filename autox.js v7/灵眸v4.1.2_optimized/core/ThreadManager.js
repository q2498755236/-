/**
 * 灵眸 v4.1.2 - 线程管理器
 * - 只管理本框架创建的线程
 * - 容量检查与槽位预留原子化，避免并发突破 maxThreads
 * - 单线程超时只 interrupt 自己，不调用 threads.shutDownAll()
 * - shutdown 不再把仍存活的线程伪装成“已清空”
 */
LingMouAPI.register("ThreadManager", function(API) {
    "use strict";

    var _items = [];
    var _lock = threads.lock();
    var _gcTimer = null;
    var _maxThreads = 16;
    var _defaultTimeout = 30000;
    var _gcInterval = 30000;
    var _initialized = false;
    var _shuttingDown = false;

    function toInt(value, fallback, min, max) {
        var n = Number(value);
        if (!isFinite(n)) n = fallback;
        n = Math.floor(n);
        if (min !== undefined) n = Math.max(min, n);
        if (max !== undefined) n = Math.min(max, n);
        return n;
    }

    function isAlive(w) {
        try { return !!(w && w.thread && w.thread.isAlive && w.thread.isAlive()); }
        catch (e) { return !!(w && !w.finished); }
    }

    function removeFinishedUnlocked() {
        var alive = [];
        for (var i = 0; i < _items.length; i++) {
            var w = _items[i];
            if (!w.finished || isAlive(w)) {
                alive.push(w);
            } else if (w._timeoutTimer) {
                try { clearTimeout(w._timeoutTimer); } catch (ignore) {}
                w._timeoutTimer = null;
            }
        }
        _items = alive;
    }

    function removeFinished() {
        _lock.lock();
        try { removeFinishedUnlocked(); }
        finally { _lock.unlock(); }
    }

    function snapshotItems() {
        _lock.lock();
        try {
            removeFinishedUnlocked();
            return _items.slice();
        } finally { _lock.unlock(); }
    }

    function activeCount() {
        _lock.lock();
        try {
            removeFinishedUnlocked();
            return _items.length;
        } finally { _lock.unlock(); }
    }

    function createWrapper(name) {
        var wrapper = {
            name: name || "anonymous",
            startTime: Date.now(),
            endTime: 0,
            finished: false,
            cancelled: false,
            timedOut: false,
            error: null,
            result: undefined,
            thread: null,
            _timeoutTimer: null,
            cancel: function() {
                if (this.finished) return false;
                this.cancelled = true;
                try { if (this.thread) this.thread.interrupt(); } catch (e) {}
                return true;
            },
            join: function(timeoutMs) {
                if (!this.thread || !this.thread.join) return this.finished;
                try {
                    if (timeoutMs === undefined) this.thread.join();
                    else this.thread.join(Math.max(0, Number(timeoutMs) || 0));
                } catch (e) {}
                return this.finished || !isAlive(this);
            }
        };
        return wrapper;
    }

    function launchWrapper(wrapper, fn, timeout) {
        if (wrapper.cancelled) {
            wrapper.finished = true;
            wrapper.endTime = Date.now();
            return wrapper;
        }
        try {
            wrapper.thread = threads.start(function() {
                try {
                    if (!wrapper.cancelled) wrapper.result = fn();
                } catch (e) {
                    wrapper.error = e;
                    if (!wrapper.cancelled) log("[ThreadManager] Thread error [" + wrapper.name + "]: " + e);
                } finally {
                    wrapper.endTime = Date.now();
                    wrapper.finished = true;
                    if (wrapper._timeoutTimer) {
                        try { clearTimeout(wrapper._timeoutTimer); } catch (ignore) {}
                        wrapper._timeoutTimer = null;
                    }
                }
            });
        } catch (e) {
            wrapper.error = e;
            wrapper.finished = true;
            wrapper.endTime = Date.now();
            throw e;
        }

        // 线程可能极快结束，因此创建 timeout 前再次检查 finished。
        if (!wrapper.finished && timeout > 0) {
            wrapper._timeoutTimer = setTimeout(function() {
                wrapper._timeoutTimer = null;
                if (!wrapper.finished) {
                    wrapper.timedOut = true;
                    wrapper.cancelled = true;
                    log("[ThreadManager] Timeout [" + wrapper.name + "], interrupting owned thread only");
                    try { if (wrapper.thread) wrapper.thread.interrupt(); } catch (e) {}
                }
            }, timeout);
        }
        return wrapper;
    }

    return {
        init: function(options) {
            options = options || {};
            _maxThreads = toInt(options.maxThreads, _maxThreads, 1, 64);
            _defaultTimeout = toInt(options.defaultTimeout, _defaultTimeout, 0, 600000);
            _gcInterval = toInt(options.gcInterval, _gcInterval, 1000, 600000);
            _shuttingDown = false;
            if (!_gcTimer) {
                var self = this;
                _gcTimer = setInterval(function() { self.gc(); }, _gcInterval);
            }
            _initialized = true;
            log("[ThreadManager] Initialized, maxThreads=" + _maxThreads);
            return true;
        },

        start: function(name, fn, timeout) {
            if (typeof fn !== "function") throw new Error("ThreadManager.start requires function");
            var timeoutMs = timeout === undefined ? _defaultTimeout : toInt(timeout, 0, 0, 600000);
            var wrapper = createWrapper(name);

            _lock.lock();
            try {
                removeFinishedUnlocked();
                if (_shuttingDown) {
                    log("[ThreadManager] Rejected [" + name + "]: shutting down");
                    return null;
                }
                if (_items.length >= _maxThreads) {
                    log("[ThreadManager] Rejected [" + name + "]: maxThreads reached");
                    return null;
                }
                // 先占槽，再在锁外启动。shutdownAll 若恰好并发，可通过 wrapper.cancelled 阻止启动。
                _items.push(wrapper);
            } finally { _lock.unlock(); }

            try {
                return launchWrapper(wrapper, fn, timeoutMs);
            } catch (e) {
                _lock.lock();
                try {
                    var i = _items.indexOf(wrapper);
                    if (i >= 0) _items.splice(i, 1);
                } finally { _lock.unlock(); }
                log("[ThreadManager] Failed to start [" + name + "]: " + e);
                return null;
            }
        },

        submit: function(name, fn, timeout) { return this.start(name, fn, timeout); },

        gc: function() {
            var before, after;
            _lock.lock();
            try {
                before = _items.length;
                removeFinishedUnlocked();
                after = _items.length;
            } finally { _lock.unlock(); }
            return before - after;
        },

        getActiveCount: function() { return activeCount(); },

        list: function() {
            var arr = snapshotItems();
            var result = [];
            for (var i = 0; i < arr.length; i++) {
                result.push({
                    name: arr[i].name,
                    startTime: arr[i].startTime,
                    endTime: arr[i].endTime || 0,
                    finished: !!arr[i].finished,
                    alive: isAlive(arr[i]),
                    cancelled: !!arr[i].cancelled,
                    timedOut: !!arr[i].timedOut,
                    error: arr[i].error ? String(arr[i].error) : null
                });
            }
            return result;
        },

        joinAll: function(timeout) {
            var deadline = Date.now() + toInt(timeout, 30000, 0, 600000);
            while (Date.now() < deadline) {
                if (activeCount() === 0) return true;
                sleep(50);
            }
            return activeCount() === 0;
        },

        shutdownAll: function(options) {
            options = options || {};
            var graceMs = toInt(options.graceMs, 1000, 0, 10000);
            _shuttingDown = true;
            if (_gcTimer) {
                try { clearInterval(_gcTimer); } catch (e) {}
                _gcTimer = null;
            }

            var arr = snapshotItems();
            for (var i = 0; i < arr.length; i++) arr[i].cancel();

            // 给可响应 interrupt 的线程一个有限退出窗口；不无限阻塞 stop()。
            var deadline = Date.now() + graceMs;
            for (var j = 0; j < arr.length && Date.now() < deadline; j++) {
                if (!arr[j].thread || !arr[j].thread.join || !isAlive(arr[j])) continue;
                try {
                    var remain = Math.max(0, deadline - Date.now());
                    arr[j].thread.join(remain);
                } catch (e) {}
            }
            removeFinished();

            var remaining = activeCount();
            if (remaining > 0) log("[ThreadManager] " + remaining + " owned thread(s) still alive after shutdown grace period");
            _initialized = false;
            _shuttingDown = false;
            return remaining === 0;
        },

        isInitialized: function() { return _initialized; }
    };
});
