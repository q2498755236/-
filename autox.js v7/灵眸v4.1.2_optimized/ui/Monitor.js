/**
 * 灵眸 v4.1.2 - 监控面板
 * CPU 从 /proc/stat 计算，不再用电池电量冒充 CPU。
 * FPS 默认关闭；可通过 setFPSProvider(fn) 注入真实 FPS。
 */
LingMouAPI.register("Monitor", function(API) {
    "use strict";

    var _config = {
        enable: true,
        updateInterval: 1000,
        enableCPU: true,
        enableMemory: true,
        enableFPS: false,
        enableBattery: true,
        enableThread: true,
        enableLog: true,
        enableAlert: true,
        alertCooldown: 30000,
        alertThresholds: {cpu: 90, memory: 90, battery: 10}
    };
    var _stats = {updates: 0, alerts: 0, logs: 0};
    var _visible = false;
    var _window = null;
    var _worker = null;
    var _generation = 0;
    var _threadMgr = null;
    var _fpsProvider = null;
    var _prevCpu = null;
    var _alertHistory = [];
    var _lastAlertAt = {};
    var _lock = threads.lock();
    var _logPath = null;

    function now() { return Date.now(); }

    function fileLog(msg) {
        if (!_config.enableLog || !_logPath) return;
        try { files.append(_logPath, now() + " | " + msg + "\n"); _stats.logs++; } catch (e) {}
    }

    function readCpuStat() {
        try {
            var line = files.read("/proc/stat").split("\n")[0].trim().split(/\s+/);
            if (line[0] !== "cpu") return null;
            var nums = [];
            for (var i = 1; i < line.length; i++) nums.push(Number(line[i]) || 0);
            var idle = (nums[3] || 0) + (nums[4] || 0);
            var total = 0;
            for (var j = 0; j < nums.length; j++) total += nums[j];
            var current = {idle: idle, total: total};
            if (!_prevCpu) {
                _prevCpu = current;
                return null;
            }
            var totalDelta = current.total - _prevCpu.total;
            var idleDelta = current.idle - _prevCpu.idle;
            _prevCpu = current;
            if (totalDelta <= 0) return null;
            return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
        } catch (e) {
            return null;
        }
    }

    function memoryInfo() {
        try {
            var rt = java.lang.Runtime.getRuntime();
            var used = rt.totalMemory() - rt.freeMemory();
            return {used: used, total: rt.totalMemory(), max: rt.maxMemory(), rate: used / rt.maxMemory()};
        } catch (e) { return null; }
    }

    return {
        init: function(options) {
            options = options || {};
            for (var k in options) if (options.hasOwnProperty(k) && _config.hasOwnProperty(k)) _config[k] = options[k];
            _config.updateInterval = Math.max(200, Math.min(60000, Number(_config.updateInterval) || 1000));
            _config.alertCooldown = Math.max(0, Math.min(3600000, Number(_config.alertCooldown) || 30000));
            var th = _config.alertThresholds || {};
            _config.alertThresholds = {
                cpu: Math.max(0, Math.min(100, Number(th.cpu) || 90)),
                memory: Math.max(0, Math.min(100, Number(th.memory) || 90)),
                battery: Math.max(0, Math.min(100, Number(th.battery) || 10))
            };
            _threadMgr = API.require("ThreadManager");
            var dir = files.join(API.getBaseDir(), "logs/");
            if (!files.exists(dir)) files.createWithDirs(dir);
            _logPath = files.join(dir, "monitor.log");
            return true;
        },

        setFPSProvider: function(fn) {
            _fpsProvider = typeof fn === "function" ? fn : null;
        },

        show: function() {
            if (!_config.enable || _visible) return _visible;
            if (!floaty.checkPermission()) return false;

            _window = floaty.window(
                <frame gravity="center" bg="#80000000" padding="10">
                    <vertical>
                        <text id="title" text="灵眸v4.1.2 监控" textColor="#00FF00" textSize="14sp" textStyle="bold"/>
                        <text id="cpu" text="CPU: --" textColor="#FFFFFF" textSize="12sp"/>
                        <text id="mem" text="MEM: --" textColor="#FFFFFF" textSize="12sp"/>
                        <text id="fps" text="FPS: --" textColor="#FFFFFF" textSize="12sp"/>
                        <text id="bat" text="BAT: --" textColor="#FFFFFF" textSize="12sp"/>
                        <text id="threads" text="THR: --" textColor="#FFFFFF" textSize="12sp"/>
                    </vertical>
                </frame>
            );
            _window.setPosition(Math.max(0, device.width - 300), 100);
            _visible = true;
            _prevCpu = null;
            var myGeneration = ++_generation;
            var self = this;
            var w = _threadMgr.start("Monitor", function() {
                while (_visible && myGeneration === _generation) {
                    try { self._update(); }
                    catch (e) { fileLog("UPDATE_ERROR " + e); }
                    sleep(_config.updateInterval);
                }
            }, 0);
            if (!w) {
                if (myGeneration === _generation) _visible = false;
                try { _window.close(); } catch (e) {}
                _window = null;
                return false;
            }
            _worker = w;
            return true;
        },

        hide: function() {
            _visible = false;
            _generation++;
            var old = _worker;
            _worker = null;
            if (old) old.cancel();
            if (_window) { try { _window.close(); } catch (e) {} _window = null; }
            return true;
        },

        _collectData: function() {
            var data = {timestamp: now()};
            if (_config.enableCPU) data.cpu = readCpuStat();
            if (_config.enableMemory) data.memory = memoryInfo();
            if (_config.enableBattery) {
                try { data.battery = device.getBattery(); } catch (e) { data.battery = null; }
            }
            if (_config.enableThread) {
                try { data.threads = _threadMgr.getActiveCount(); } catch (e) { data.threads = null; }
            }
            if (_config.enableFPS && _fpsProvider) {
                try { data.fps = _fpsProvider(); } catch (e) { data.fps = null; }
            } else {
                data.fps = null;
            }
            return data;
        },

        _update: function() {
            var data = this._collectData();
            _stats.updates++;
            if (_window) {
                ui.run(function() {
                    if (_window.cpu) _window.cpu.setText("CPU: " + (data.cpu === null || data.cpu === undefined ? "--" : data.cpu + "%"));
                    if (_window.mem) _window.mem.setText("MEM: " + (data.memory ? Math.round(data.memory.rate * 100) + "%" : "--"));
                    if (_window.fps) _window.fps.setText("FPS: " + (data.fps === null || data.fps === undefined ? "--" : data.fps));
                    if (_window.bat) _window.bat.setText("BAT: " + (data.battery === null || data.battery === undefined ? "--" : data.battery + "%"));
                    if (_window.threads) _window.threads.setText("THR: " + (data.threads === null || data.threads === undefined ? "--" : data.threads));
                });
            }
            if (_config.enableAlert) this._checkAlerts(data);
            return data;
        },

        _checkAlerts: function(data) {
            var a = [];
            var th = _config.alertThresholds || {};
            if (data.cpu !== null && data.cpu !== undefined && data.cpu > th.cpu) a.push("CPU " + data.cpu + "% > " + th.cpu + "%");
            if (data.memory && data.memory.rate * 100 > th.memory) a.push("MEM " + Math.round(data.memory.rate * 100) + "% > " + th.memory + "%");
            if (data.battery !== null && data.battery !== undefined && data.battery < th.battery) a.push("BAT " + data.battery + "% < " + th.battery + "%");
            if (!a.length) return;
            var t = now(), emitted = [];
            _lock.lock();
            try {
                for (var i = 0; i < a.length; i++) {
                    var key = a[i].split(" ")[0];
                    var last = _lastAlertAt[key] || 0;
                    if (_config.alertCooldown <= 0 || t - last >= _config.alertCooldown) {
                        _lastAlertAt[key] = t;
                        emitted.push(a[i]);
                    }
                }
                if (emitted.length) {
                    _stats.alerts++;
                    _alertHistory.push({time: t, alerts: emitted.slice()});
                    while (_alertHistory.length > 100) _alertHistory.shift();
                }
            } finally { _lock.unlock(); }
            if (emitted.length) fileLog("ALERT " + emitted.join("; "));
        },

        getStats: function() { return JSON.parse(JSON.stringify(_stats)); },
        getConfig: function() { return JSON.parse(JSON.stringify(_config)); },
        setConfig: function(key, value) { if (_config.hasOwnProperty(key)) _config[key] = value; },
        isVisible: function() { return _visible; }
    };
});
