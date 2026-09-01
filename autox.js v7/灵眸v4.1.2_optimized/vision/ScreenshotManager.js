/**
 * 灵眸 v4.1.2 - 截图管理器
 * 权限仅由 main.js 请求一次。
 * captureScreen() 的 Image 不在后台偷偷回收，调用方生命周期保持可预测。
 */
LingMouAPI.register("ScreenshotManager", function(API) {
    "use strict";

    var _ready = false;
    var _stats = {captures: 0, errors: 0, lastCapture: 0};

    return {
        init: function() {
            if (typeof captureScreen !== "function") throw new Error("captureScreen API unavailable");
            _ready = true;
            log("[ScreenshotManager] Initialized; permission is managed by main.js");
            return true;
        },

        capture: function() {
            if (!_ready) throw new Error("ScreenshotManager not initialized");
            try {
                var img = captureScreen();
                if (!img) throw new Error("captureScreen returned null");
                _stats.captures++;
                _stats.lastCapture = Date.now();
                return img;
            } catch (e) {
                _stats.errors++;
                throw e;
            }
        },

        captureAndConvert: function(type) {
            var img = this.capture();
            if (!type || type === "image") return img;
            if (type === "bitmap" && img.getBitmap) return img.getBitmap();
            return img;
        },

        getActiveCount: function() {
            // v4.1 不跟踪/隐藏回收调用方持有的 Image，因此不存在“活动图片池”。
            return 0;
        },

        getStats: function() { return JSON.parse(JSON.stringify(_stats)); },

        release: function() {
            _ready = false;
            return true;
        }
    };
});
