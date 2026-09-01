/**
 * 灵眸 v4.1.2 - Scheduler 看门狗
 * Scheduler 每个 tick 调用 tick()；generation 防止快速 stop/start 产生重复监控线程。
 */
LingMouAPI.register("WatchDog", function(API) {
    "use strict";

    var _config = {enable: true, checkInterval: 5000, maxStallTime: 15000, recoveryEnabled: true};
    var _running = false;
    var _generation = 0;
    var _lastTick = 0;
    var _worker = null;
    var _threadMgr = null;
    var _onStall = null;
    var _stats = {checks: 0, stalls: 0, recoveries: 0};

    function finiteInt(value, fallback, min, max) {
        var n = Number(value);
        if (!isFinite(n)) n = fallback;
        n = Math.floor(n);
        return Math.max(min, Math.min(max, n));
    }

    return {
        init: function(options) {
            options = options || {};
            for (var k in options) {
                if (!options.hasOwnProperty(k)) continue;
                if (k === "onStall") _onStall = options[k];
                else if (_config.hasOwnProperty(k)) _config[k] = options[k];
            }
            _config.checkInterval = finiteInt(_config.checkInterval, 5000, 500, 600000);
            _config.maxStallTime = finiteInt(_config.maxStallTime, 15000, _config.checkInterval, 3600000);
            _threadMgr = API.require("ThreadManager");
            _lastTick = Date.now();
            log("[WatchDog] Initialized");
            return true;
        },

        tick: function(timestamp) { _lastTick = Number(timestamp) || Date.now(); },

        start: function() {
            if (!_config.enable) return true;
            if (_running && _worker && !_worker.finished) return true;
            _running = true;
            var myGeneration = ++_generation;
            _lastTick = Date.now();
            var w = _threadMgr.start("WatchDog", function() {
                while (_running && myGeneration === _generation) {
                    sleep(_config.checkInterval);
                    if (!_running || myGeneration !== _generation) break;
                    _stats.checks++;
                    var stalledFor = Date.now() - _lastTick;
                    if (stalledFor > _config.maxStallTime) {
                        _stats.stalls++;
                        log("[WatchDog] Scheduler heartbeat stalled for " + stalledFor + "ms");
                        if (_config.recoveryEnabled && typeof _onStall === "function") {
                            try {
                                _onStall(stalledFor);
                                _stats.recoveries++;
                            } catch (e) {
                                log("[WatchDog] Recovery error: " + e);
                            }
                        }
                        // 防止同一次 stall 在每个 checkInterval 重复触发恢复。
                        _lastTick = Date.now();
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

        getStats: function() {
            var s = JSON.parse(JSON.stringify(_stats));
            s.lastTick = _lastTick;
            s.running = _running;
            s.generation = _generation;
            return s;
        }
    };
});
