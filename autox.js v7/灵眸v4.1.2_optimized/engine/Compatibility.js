/**
 * 灵眸 v4.1.2 - AutoX V7 兼容性检查
 * 权限申请集中在 main.js，这里只检查能力。
 */
LingMouAPI.register("Compatibility", function(API) {
    "use strict";
    var _last = null;

    function checkFn(name) {
        try { return typeof global[name] === "function"; } catch (e) { return false; }
    }

    return {
        init: function() {
            _last = this.check();
            log("[Compatibility] Initialized");
            return true;
        },
        check: function() {
            var result = {
                timestamp: Date.now(),
                accessibility: !!auto.service,
                captureApi: typeof requestScreenCapture === "function" && typeof captureScreen === "function",
                threads: typeof threads !== "undefined" && typeof threads.start === "function" && typeof threads.lock === "function",
                floaty: typeof floaty !== "undefined",
                paddle: typeof paddle !== "undefined"
            };
            _last = result;
            return result;
        },
        requestPermissions: function() {
            // 保留旧 API，但不重复申请；main.js 是唯一权限申请入口。
            return this.check();
        },
        getLastCheck: function() { return _last; }
    };
});
