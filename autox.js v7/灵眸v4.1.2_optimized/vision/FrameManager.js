/**
 * 灵眸 v4.1.2 - 帧管理器
 * 帧历史只保存轻量元数据，不让 ScreenshotManager 在调用方背后回收 Image。
 */
LingMouAPI.register("FrameManager", function(API) {
    "use strict";

    var _screenshot = null;
    var _history = [];
    var _maxHistory = 5;
    var _lock = threads.lock();

    return {
        init: function(options) {
            options = options || {};
            _maxHistory = Number(options.frameHistory || options.maxFrames || _maxHistory);
            _screenshot = API.require("ScreenshotManager");
            log("[FrameManager] Initialized, metadataHistory=" + _maxHistory);
            return true;
        },

        capture: function() {
            var img = _screenshot.capture();
            _lock.lock();
            try {
                _history.push({timestamp: Date.now(), width: img.getWidth ? img.getWidth() : 0, height: img.getHeight ? img.getHeight() : 0});
                while (_history.length > _maxHistory) _history.shift();
            } finally { _lock.unlock(); }
            return img;
        },

        getHistory: function() {
            _lock.lock();
            try { return JSON.parse(JSON.stringify(_history)); }
            finally { _lock.unlock(); }
        },

        getLatest: function() {
            _lock.lock();
            try { return _history.length ? JSON.parse(JSON.stringify(_history[_history.length - 1])) : null; }
            finally { _lock.unlock(); }
        },

        clear: function() {
            _lock.lock();
            try { _history = []; }
            finally { _lock.unlock(); }
        },

        stop: function() { this.clear(); }
    };
});
