/**
 * 灵眸 v4.1.2 - 性能统计
 */
LingMouAPI.register("PerfStats", function(API) {
    "use strict";

    var _config = {
        enable: true, collectInterval: 5000, enableHistory: true, maxHistory: 100,
        enableBottleneckDetect: true, bottleneckThreshold: 0.8,
        enableAutoExport: false, exportInterval: 300000
    };
    var _stats = {collects: 0, reports: 0, exports: 0, bottlenecks: 0};
    var _history = [];
    var _bottlenecks = [];
    var _collectors = {};
    var _running = false;
    var _generation = 0;
    var _worker = null;
    var _threadMgr = null;
    var _lock = threads.lock();
    var _exportPath = null;

    function now() { return Date.now(); }

    return {
        init: function(options) {
            options = options || {};
            for (var k in options) if (options.hasOwnProperty(k) && _config.hasOwnProperty(k)) _config[k] = options[k];
            _config.collectInterval = Math.max(500, Number(_config.collectInterval) || 5000);
            _config.maxHistory = Math.max(1, Math.floor(Number(_config.maxHistory) || 100));
            _config.bottleneckThreshold = Math.max(0, Math.min(1, Number(_config.bottleneckThreshold)));
            if (!isFinite(_config.bottleneckThreshold)) _config.bottleneckThreshold = 0.8;
            _config.exportInterval = Math.max(1000, Number(_config.exportInterval) || 300000);
            _threadMgr = API.require("ThreadManager");
            _exportPath = files.join(API.getBaseDir(), "perf/");
            if (!files.exists(_exportPath)) files.createWithDirs(_exportPath);
            this._registerDefaultCollectors();
            return true;
        },

        _registerDefaultCollectors: function() {
            var self = this;
            this.registerCollector("core", function() {
                var out = {};
                try { out.threads = API.require("ThreadManager").getActiveCount(); } catch (e) {}
                try { out.memory = API.require("MemoryManager").getMemoryInfo(); } catch (e) {}
                return out;
            });
            this.registerCollector("vision", function() {
                var out = {};
                try { out.ocrReady = API.require("OCREngine").isReady(); } catch (e) {}
                try { out.screenshot = API.require("ScreenshotManager").getStats(); } catch (e) {}
                return out;
            });
            this.registerCollector("engine", function() {
                try { return {scheduler: API.require("Scheduler").getStats()}; }
                catch (e) { return {}; }
            });
        },

        registerCollector: function(name, fn) {
            if (typeof fn !== "function") throw new Error("Collector must be function");
            _lock.lock();
            try { _collectors[String(name)] = fn; }
            finally { _lock.unlock(); }
            return true;
        },

        _collect: function() {
            var snap = {timestamp: now(), modules: {}, totalCollectTime: 0};
            var collectors = {};
            _lock.lock();
            try {
                for (var ck in _collectors) if (_collectors.hasOwnProperty(ck)) collectors[ck] = _collectors[ck];
            } finally { _lock.unlock(); }
            for (var name in collectors) {
                if (!collectors.hasOwnProperty(name)) continue;
                var start = now();
                try {
                    snap.modules[name] = {data: collectors[name](), collectTime: now() - start};
                } catch (e) {
                    snap.modules[name] = {data: null, error: String(e), collectTime: now() - start};
                }
                snap.totalCollectTime += snap.modules[name].collectTime;
            }
            _stats.collects++;

            if (_config.enableHistory) {
                _lock.lock();
                try {
                    _history.push(snap);
                    while (_history.length > _config.maxHistory) _history.shift();
                } finally { _lock.unlock(); }
            }
            if (_config.enableBottleneckDetect) this._detectBottleneck(snap);
            return snap;
        },

        _detectBottleneck: function(snap) {
            var found = [];
            for (var name in snap.modules) {
                if (!snap.modules.hasOwnProperty(name)) continue;
                var mod = snap.modules[name];
                var ratio = mod.collectTime / (snap.totalCollectTime || 1);
                if (mod.collectTime > 50 && ratio > _config.bottleneckThreshold) {
                    found.push({module: name, ratio: ratio, time: mod.collectTime});
                }
            }
            if (found.length) {
                _stats.bottlenecks++;
                _lock.lock();
                try {
                    _bottlenecks.push({time: now(), bottlenecks: found});
                    while (_bottlenecks.length > 20) _bottlenecks.shift();
                } finally { _lock.unlock(); }
            }
        },

        start: function() {
            if (!_config.enable) return true;
            if (_running && _worker && !_worker.finished) return true;
            _running = true;
            var myGeneration = ++_generation;
            var self = this;
            var lastCollect = 0, lastExport = now();
            var w = _threadMgr.start("PerfStats", function() {
                while (_running && myGeneration === _generation) {
                    sleep(500);
                    if (!_running || myGeneration !== _generation) break;
                    var t = now();
                    if (t - lastCollect >= _config.collectInterval) {
                        lastCollect = t;
                        self._collect();
                    }
                    if (_config.enableAutoExport && t - lastExport >= _config.exportInterval) {
                        lastExport = t;
                        self.exportReport();
                    }
                }
            }, 0);
            if (!w) {
                if (myGeneration === _generation) _running = false;
                return false;
            }
            _worker = w;
            return true;
        },

        stop: function() {
            _running = false;
            _generation++;
            var old = _worker;
            _worker = null;
            if (old) old.cancel();
            return true;
        },

        getReport: function() {
            _lock.lock();
            try {
                if (!_history.length) return null;
                _stats.reports++;
                return {
                    generated: now(),
                    snapshot: JSON.parse(JSON.stringify(_history[_history.length - 1])),
                    samples: _history.length,
                    bottlenecks: JSON.parse(JSON.stringify(_bottlenecks.slice(-5)))
                };
            } finally { _lock.unlock(); }
        },

        exportReport: function(filename) {
            var report = this.getReport();
            if (!report) return false;
            filename = String(filename || ("perf_" + now() + ".json"));
            filename = new java.io.File(filename).getName();
            if (!/\.json$/i.test(filename)) filename += ".json";
            try {
                files.write(files.join(_exportPath, filename), JSON.stringify(report, null, 2));
                _stats.exports++;
                return true;
            } catch (e) { return false; }
        },

        getStats: function() { return JSON.parse(JSON.stringify(_stats)); },
        getConfig: function() { return JSON.parse(JSON.stringify(_config)); }
    };
});
