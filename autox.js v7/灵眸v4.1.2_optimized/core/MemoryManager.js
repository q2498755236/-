/**
 * 灵眸 v4.1.2 - 内存管理
 */
LingMouAPI.register("MemoryManager", function(API) {
    "use strict";
    var _initialized = false;

    function info() {
        try {
            var rt = java.lang.Runtime.getRuntime();
            var used = rt.totalMemory() - rt.freeMemory();
            return {
                used: used,
                free: rt.freeMemory(),
                total: rt.totalMemory(),
                max: rt.maxMemory(),
                rate: rt.maxMemory() > 0 ? used / rt.maxMemory() : 0
            };
        } catch (e) {
            return {used: 0, free: 0, total: 0, max: 1, rate: 0};
        }
    }

    return {
        init: function() {
            _initialized = true;
            log("[MemoryManager] Initialized");
            return true;
        },
        getMemoryInfo: info,
        getUsage: function() { return info().rate; },
        gc: function() {
            try { java.lang.System.gc(); return true; } catch (e) { return false; }
        },
        cleanup: function() {
            _initialized = false;
            return true;
        },
        isReady: function() { return _initialized; }
    };
});
