/**
 * 灵眸 v4.1.2 - GC 管理器
 * 删除无 acquire API 的伪 Image/Object Pool。
 */
LingMouAPI.register("GCManager", function(API) {
    "use strict";

    var _config = {
        enable: true,
        autoGC: true,
        autoGCThreshold: 0.85,
        autoGCInterval: 30000,
        enableMemoryReport: true,
        memoryReportInterval: 60000,
        enableLeakDetect: false,
        leakCheckInterval: 120000,
        enableLog: true
    };
    var _stats = {gcRuns: 0, forcedGC: 0, memoryReports: 0, leaksDetected: 0, avgGCTime: 0, totalGCTime: 0, imageRecycled: 0};
    var _running = false;
    var _generation = 0;
    var _worker = null;
    var _threadMgr = null;
    var _logPath = null;
    var _lastLeakRate = null;

    function now() { return Date.now(); }

    function memory() {
        try {
            var rt = java.lang.Runtime.getRuntime();
            var used = rt.totalMemory() - rt.freeMemory();
            return {used: used, total: rt.totalMemory(), max: rt.maxMemory(), rate: used / rt.maxMemory()};
        } catch (e) { return {used: 0, total: 0, max: 1, rate: 0}; }
    }

    function fileLog(msg) {
        if (!_config.enableLog || !_logPath) return;
        try { files.append(_logPath, now() + " | " + msg + "\n"); } catch (e) {}
    }

    return {
        init: function(options) {
            options = options || {};
            for (var k in options) if (options.hasOwnProperty(k) && _config.hasOwnProperty(k)) _config[k] = options[k];
            _config.autoGCThreshold = Math.max(0.1, Math.min(0.99, Number(_config.autoGCThreshold) || 0.85));
            _config.autoGCInterval = Math.max(1000, Number(_config.autoGCInterval) || 30000);
            _config.memoryReportInterval = Math.max(1000, Number(_config.memoryReportInterval) || 60000);
            _config.leakCheckInterval = Math.max(1000, Number(_config.leakCheckInterval) || 120000);
            _threadMgr = API.require("ThreadManager");
            var dir = files.join(API.getBaseDir(), "logs/");
            if (!files.exists(dir)) files.createWithDirs(dir);
            _logPath = files.join(dir, "gc.log");
            log("[GCManager] Initialized");
            return true;
        },

        start: function() {
            if (!_config.enable) return true;
            if (_running && _worker && !_worker.finished) return true;
            _running = true;
            var myGeneration = ++_generation;
            var self = this;
            var lastGC = now(), lastReport = now(), lastLeak = now();
            var w = _threadMgr.start("GCManager", function() {
                while (_running && myGeneration === _generation) {
                    sleep(1000);
                    if (!_running || myGeneration !== _generation) break;
                    var t = now();
                    if (_config.autoGC && t - lastGC >= _config.autoGCInterval) {
                        lastGC = t;
                        if (memory().rate >= _config.autoGCThreshold) self.forceGC("auto_threshold");
                    }
                    if (_config.enableMemoryReport && t - lastReport >= _config.memoryReportInterval) {
                        lastReport = t;
                        self.reportMemory();
                    }
                    if (_config.enableLeakDetect && t - lastLeak >= _config.leakCheckInterval) {
                        lastLeak = t;
                        self.checkLeaks();
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

        forceGC: function(reason) {
            var start = now();
            try {
                java.lang.System.gc();
                var cost = now() - start;
                _stats.gcRuns++;
                _stats.forcedGC++;
                _stats.totalGCTime += cost;
                _stats.avgGCTime = _stats.totalGCTime / _stats.gcRuns;
                fileLog("GC " + (reason || "manual") + " " + cost + "ms");
                return {success: true, time: cost, reason: reason || "manual"};
            } catch (e) {
                return {success: false, error: String(e), reason: reason || "manual"};
            }
        },

        recycleImage: function(img) {
            if (!img || !img.recycle) return false;
            try {
                if (!img.isRecycled || !img.isRecycled()) img.recycle();
                _stats.imageRecycled++;
                return true;
            } catch (e) { return false; }
        },

        recycleOldImages: function() {
            // v4.1 已删除伪池；保留旧 API 兼容，返回 0。
            return 0;
        },

        clearPools: function() {
            return {images: 0, objects: 0};
        },

        reportMemory: function() {
            var m = memory();
            _stats.memoryReports++;
            fileLog("MEM " + Math.round(m.rate * 100) + "%");
            return {timestamp: now(), used: m.used, total: m.total, max: m.max, rate: m.rate};
        },

        checkLeaks: function() {
            var r = memory().rate;
            var suspected = _lastLeakRate !== null && r > _lastLeakRate + 0.10;
            _lastLeakRate = r;
            if (suspected) {
                _stats.leaksDetected++;
                fileLog("LEAK_SUSPECT rate=" + r);
            }
            return {suspected: suspected, rate: r};
        },

        getStats: function() { return JSON.parse(JSON.stringify(_stats)); },
        getConfig: function() { return JSON.parse(JSON.stringify(_config)); },
        setConfig: function(key, value) { if (_config.hasOwnProperty(key)) _config[key] = value; }
    };
});
