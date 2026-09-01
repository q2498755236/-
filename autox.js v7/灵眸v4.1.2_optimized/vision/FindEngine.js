/**
 * 灵眸 v4.1.2 - 视觉查找
 */
LingMouAPI.register("FindEngine", function(API) {
    "use strict";

    var _screens = null;
    var _templates = null;
    var _ocr = null;
    var _timeout = 5000;

    return {
        init: function(options) {
            options = options || {};
            _timeout = Number(options.findTimeout || _timeout);
            _screens = API.require("ScreenshotManager");
            _templates = API.require("TemplateManager");
            _ocr = API.require("OCREngine");
            log("[FindEngine] Initialized");
            return true;
        },

        findImage: function(template, options) {
            options = options || {};
            var source = options.image || _screens.capture();
            var tpl = typeof template === "string" ? _templates.load(template) : template;
            if (!tpl) return null;
            try {
                var opts = {};
                if (options.threshold !== undefined) opts.threshold = options.threshold;
                if (options.region) opts.region = options.region;
                return images.findImage(source, tpl, opts);
            } catch (e) {
                log("[FindEngine] findImage error: " + e);
                return null;
            }
        },

        waitImage: function(template, options) {
            options = options || {};
            var timeout = Number(options.timeout || _timeout);
            var deadline = Date.now() + timeout;
            do {
                var p = this.findImage(template, options);
                if (p) return p;
                sleep(Number(options.interval || 100));
            } while (Date.now() < deadline);
            return null;
        },

        findColor: function(color, options) {
            options = options || {};
            var source = options.image || _screens.capture();
            try {
                var threshold = options.threshold === undefined ? 4 : options.threshold;
                return images.findColor(source, color, {region: options.region, threshold: threshold});
            } catch (e) {
                return null;
            }
        },

        findText: function(text, options) {
            options = options || {};
            if (!_ocr || !_ocr.isReady()) return [];
            var source = options.image || _screens.capture();
            var results = _ocr.recognize(source, options) || [];
            var matched = [];
            for (var i = 0; i < results.length; i++) {
                var item = results[i];
                var value = item.text !== undefined ? String(item.text) : String(item);
                if (value.indexOf(String(text)) >= 0) matched.push(item);
            }
            return matched;
        }
    };
});
