/**
 * 灵眸 v4.1.2 - OCR 引擎
 * AutoX V7 Rhino Paddle API: paddle.ocr / paddle.ocrText / paddle.release
 * OCR 默认可选；ocrRequired=true 时 Paddle 不可用才视为启动失败。
 */
LingMouAPI.register("OCREngine", function(API) {
    "use strict";

    var _ready = false;
    var _enabled = true;
    var _required = false;
    var _cpuThreads = 4;
    var _useSlim = true;
    var _stats = {runs: 0, errors: 0, unavailable: 0};

    function resolveModelPath(path) {
        path = String(path);
        try {
            var f = new java.io.File(path);
            if (f.isAbsolute()) return f.getCanonicalPath();
            return new java.io.File(files.join(API.getBaseDir(), path)).getCanonicalPath();
        } catch (e) {
            return files.join(API.getBaseDir(), path);
        }
    }

    function detailedToText(detailed) {
        var texts = [];
        detailed = detailed || [];
        for (var i = 0; i < detailed.length; i++) {
            var item = detailed[i] || {};
            texts.push(String(item.text !== undefined ? item.text : (item.words !== undefined ? item.words : "")));
        }
        return texts;
    }

    function callOCR(img, textOnly, options) {
        options = options || {};
        var cpu = Number(options.cpuThreadNum !== undefined ? options.cpuThreadNum :
            (options.cpuThreads !== undefined ? options.cpuThreads : _cpuThreads));
        if (!isFinite(cpu)) cpu = _cpuThreads;
        cpu = Math.max(1, Math.min(8, Math.floor(cpu)));
        var slim = options.useSlim === undefined ? _useSlim : options.useSlim !== false;

        if (options.modelPath) {
            // 文档仅为 paddle.ocr(img, absoluteModelPath) 提供自定义模型 overload。
            var detailed = paddle.ocr(img, String(resolveModelPath(options.modelPath))) || [];
            return textOnly ? detailedToText(detailed) : detailed;
        }

        if (textOnly && typeof paddle.ocrText === "function") return paddle.ocrText(img, cpu, slim) || [];
        var result = paddle.ocr(img, cpu, slim) || [];
        return textOnly ? detailedToText(result) : result;
    }

    return {
        init: function(options) {
            options = options || {};
            _enabled = options.ocrEnabled !== false && options.enabled !== false;
            _required = options.ocrRequired === true || options.required === true;
            _cpuThreads = Number(options.ocrCpuThreads !== undefined ? options.ocrCpuThreads :
                (options.cpuThreadNum !== undefined ? options.cpuThreadNum : _cpuThreads));
            if (!isFinite(_cpuThreads)) _cpuThreads = 4;
            _cpuThreads = Math.max(1, Math.min(8, Math.floor(_cpuThreads)));
            _useSlim = options.ocrUseSlim === undefined ?
                (options.useSlim === undefined ? _useSlim : options.useSlim !== false) : options.ocrUseSlim !== false;

            // recognize 只依赖 paddle.ocr；ocrText 缺失时 text() 可由详细结果降级生成。
            _ready = _enabled && typeof paddle !== "undefined" && typeof paddle.ocr === "function";

            if (!_enabled) log("[OCREngine] Disabled by config");
            else if (!_ready) {
                _stats.unavailable++;
                log("[OCREngine] Paddle OCR unavailable; continuing without OCR");
            } else {
                log("[OCREngine] Initialized, ocrText=" + (typeof paddle.ocrText === "function"));
            }
            return !_required || _ready;
        },

        recognize: function(img, options) {
            if (!_ready || !img) return [];
            try {
                _stats.runs++;
                return callOCR(img, false, options) || [];
            } catch (e) {
                _stats.errors++;
                log("[OCREngine] OCR error: " + e);
                return [];
            }
        },

        detect: function(img, options) { return this.recognize(img, options); },

        text: function(img, options) {
            if (!_ready || !img) return [];
            try {
                _stats.runs++;
                return callOCR(img, true, options) || [];
            } catch (e) {
                _stats.errors++;
                log("[OCREngine] OCR text error: " + e);
                return [];
            }
        },

        isReady: function() { return _ready; },
        isEnabled: function() { return _enabled; },

        release: function() {
            if (_ready && typeof paddle !== "undefined" && typeof paddle.release === "function") {
                try { paddle.release(); } catch (e) {}
            }
            _ready = false;
            return true;
        },

        getStats: function() { return JSON.parse(JSON.stringify(_stats)); }
    };
});
