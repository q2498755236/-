/**
 * 灵眸 v4.1.2 - 动作引擎
 * - 坐标/时长/随机范围统一校验，抖动后默认限制在屏幕范围
 * - retry 参数支持显式 0，不再被 || 默认值覆盖
 * - KeyCode 仅用于显式物理键码；常用键优先使用无障碍 API
 * - Replay 记录动作开始/结束时间，避免回放把动作自身耗时重复计算
 */
LingMouAPI.register("ActionEngine", function(API) {
    "use strict";

    var _config = {
        coordinateMode: "screen",
        designWidth: 1080,
        designHeight: 1920,
        clickDelay: [80, 180],
        swipeDuration: [300, 600],
        longPressDuration: [800, 1200],
        randomOffset: 3,
        enableRandom: true,
        enableRetry: true,
        maxRetry: 3,
        retryDelay: 150
    };

    function finiteNumber(value, fallback, min, max) {
        var n = Number(value);
        if (!isFinite(n)) n = fallback;
        if (min !== undefined) n = Math.max(min, n);
        if (max !== undefined) n = Math.min(max, n);
        return n;
    }

    function normalizeRange(range, fallback, min, max) {
        if (!Array.isArray(range) || range.length < 2) range = fallback;
        var a = finiteNumber(range[0], fallback[0], min, max);
        var b = finiteNumber(range[1], fallback[1], min, max);
        if (a > b) { var t = a; a = b; b = t; }
        return [Math.round(a), Math.round(b)];
    }

    function randRange(range) {
        var min = Number(range[0]), max = Number(range[1]);
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function normalizeOptions(options) { return options || {}; }

    function toScreen(x, y, options) {
        options = normalizeOptions(options);
        var nx = Number(x), ny = Number(y);
        if (!isFinite(nx) || !isFinite(ny)) throw new Error("Invalid coordinates: " + x + "," + y);
        if (!(options.raw === true || options.coordinateMode === "screen" || _config.coordinateMode === "screen")) {
            nx = nx * device.width / _config.designWidth;
            ny = ny * device.height / _config.designHeight;
        }
        return {x: Math.round(nx), y: Math.round(ny)};
    }

    function clampPoint(p, options) {
        options = normalizeOptions(options);
        if (options.clamp === false) return p;
        var maxX = Math.max(0, Number(device.width || 1) - 1);
        var maxY = Math.max(0, Number(device.height || 1) - 1);
        return {
            x: Math.max(0, Math.min(maxX, p.x)),
            y: Math.max(0, Math.min(maxY, p.y))
        };
    }

    function jitter(p, options) {
        options = normalizeOptions(options);
        var result = {x: p.x, y: p.y};
        if (_config.enableRandom && options.random !== false) {
            var offset = options.randomOffset === undefined ? _config.randomOffset :
                finiteNumber(options.randomOffset, _config.randomOffset, 0, 1000);
            offset = Math.floor(offset);
            if (offset > 0) {
                result.x += Math.floor(Math.random() * (offset * 2 + 1)) - offset;
                result.y += Math.floor(Math.random() * (offset * 2 + 1)) - offset;
            }
        }
        return clampPoint(result, options);
    }

    function retry(actionName, fn, options) {
        options = normalizeOptions(options);
        var maxRetry = options.maxRetry === undefined ? _config.maxRetry :
            Math.floor(finiteNumber(options.maxRetry, _config.maxRetry, 0, 10));
        if (!_config.enableRetry || options.retry === false) maxRetry = 0;
        var retryDelay = options.retryDelay === undefined ? _config.retryDelay :
            finiteNumber(options.retryDelay, _config.retryDelay, 0, 60000);
        var attempts = 0, lastError = null;
        while (attempts <= maxRetry) {
            try {
                if (fn()) return true;
            } catch (e) {
                lastError = e;
            }
            attempts++;
            if (attempts <= maxRetry && retryDelay > 0) sleep(retryDelay);
        }
        if (lastError) log("[ActionEngine] " + actionName + " failed: " + lastError);
        return false;
    }

    function record(action, startedAt, endedAt) {
        try {
            var replay = API.require("Replay");
            if (replay && replay.isRecording && replay.isRecording()) {
                replay.recordAction(action, {startedAt: startedAt, endedAt: endedAt});
            }
        } catch (e) {}
    }

    function afterDelay(options, range) {
        options = normalizeOptions(options);
        if (options.delay === false) return;
        var ms = options.delay !== undefined ? finiteNumber(options.delay, 0, 0, 600000) : randRange(range);
        if (ms > 0) sleep(ms);
    }

    function timedAction(actionName, fn, recordData, options, delayRange) {
        var startedAt = Date.now();
        var ok = retry(actionName, fn, options);
        var endedAt = Date.now();
        if (ok && recordData) record(recordData, startedAt, endedAt);
        if (ok && delayRange) afterDelay(options, delayRange);
        return ok;
    }

    return {
        init: function(options) {
            options = options || {};
            for (var k in options) if (options.hasOwnProperty(k) && _config.hasOwnProperty(k)) _config[k] = options[k];
            if (["screen", "design"].indexOf(_config.coordinateMode) < 0) _config.coordinateMode = "screen";
            _config.designWidth = finiteNumber(_config.designWidth, 1080, 1, 100000);
            _config.designHeight = finiteNumber(_config.designHeight, 1920, 1, 100000);
            _config.clickDelay = normalizeRange(_config.clickDelay, [80, 180], 0, 60000);
            _config.swipeDuration = normalizeRange(_config.swipeDuration, [300, 600], 1, 60000);
            _config.longPressDuration = normalizeRange(_config.longPressDuration, [800, 1200], 1, 60000);
            _config.randomOffset = Math.floor(finiteNumber(_config.randomOffset, 3, 0, 1000));
            _config.maxRetry = Math.floor(finiteNumber(_config.maxRetry, 3, 0, 10));
            _config.retryDelay = Math.floor(finiteNumber(_config.retryDelay, 150, 0, 60000));
            log("[ActionEngine] Initialized, coordinateMode=" + _config.coordinateMode);
            return true;
        },

        click: function(x, y, options) {
            options = normalizeOptions(options);
            var p = jitter(toScreen(x, y, options), options);
            return timedAction("click", function() { return !!click(p.x, p.y); },
                {type: "click", x: p.x, y: p.y, options: {raw: true, random: false, delay: false}},
                options, _config.clickDelay);
        },

        clickResult: function(result, options) {
            if (!result) return false;
            var p = result.point || result;
            if ((!p.x && p.x !== 0) || (!p.y && p.y !== 0)) {
                if (p.bounds && typeof p.bounds === "function") {
                    var b = p.bounds();
                    p = {x: b.centerX(), y: b.centerY()};
                } else return false;
            }
            options = options || {};
            options.raw = true;
            return this.click(p.x, p.y, options);
        },

        longClick: function(x, y, options) {
            options = normalizeOptions(options);
            var p = jitter(toScreen(x, y, options), options);
            var duration = options.duration === undefined ? randRange(_config.longPressDuration) :
                Math.round(finiteNumber(options.duration, randRange(_config.longPressDuration), 1, 60000));
            return timedAction("longClick", function() { return !!press(p.x, p.y, duration); },
                {type: "longClick", x: p.x, y: p.y, options: {raw: true, duration: duration, random: false, delay: false}},
                options, null);
        },

        swipe: function(x1, y1, x2, y2, options) {
            options = normalizeOptions(options);
            var p1 = clampPoint(toScreen(x1, y1, options), options);
            var p2 = clampPoint(toScreen(x2, y2, options), options);
            var duration = options.duration === undefined ? randRange(_config.swipeDuration) :
                Math.round(finiteNumber(options.duration, randRange(_config.swipeDuration), 1, 60000));
            return timedAction("swipe", function() { return !!swipe(p1.x, p1.y, p2.x, p2.y, duration); },
                {type: "swipe", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, options: {raw: true, duration: duration, delay: false}},
                options, null);
        },

        scrollDown: function(options) {
            options = options || {};
            options.raw = true;
            return this.swipe(device.width * 0.5, device.height * 0.75, device.width * 0.5, device.height * 0.25, options);
        },

        scrollUp: function(options) {
            options = options || {};
            options.raw = true;
            return this.swipe(device.width * 0.5, device.height * 0.25, device.width * 0.5, device.height * 0.75, options);
        },

        input: function(text, options) {
            options = normalizeOptions(options);
            var value = String(text === undefined || text === null ? "" : text);
            var startedAt = Date.now();
            var ok = retry("input", function() { return typeof setText === "function" && !!setText(value); }, options);
            var endedAt = Date.now();
            if (ok) record({type: "input", text: value, options: {delay: false}}, startedAt, endedAt);
            if (ok) afterDelay(options, _config.clickDelay);
            return ok;
        },

        pressKey: function(key, options) {
            options = normalizeOptions(options);
            var startedAt = Date.now();
            var ok = retry("pressKey", function() {
                if (typeof key === "number") return typeof KeyCode === "function" && !!KeyCode(key);
                var raw = String(key);
                var name = raw.toLowerCase();
                if (name === "back") return !!back();
                if (name === "home") return !!home();
                if (name === "recents") return !!recents();
                if (name === "notifications" && typeof notifications === "function") return !!notifications();
                if (name === "quicksettings" && typeof quickSettings === "function") return !!quickSettings();
                if (name === "powerdialog" && typeof powerDialog === "function") return !!powerDialog();
                if (/^keycode_/i.test(raw) && typeof KeyCode === "function") return !!KeyCode(raw.toUpperCase());
                var n = Number(raw);
                if (isFinite(n) && typeof KeyCode === "function") return !!KeyCode(n);
                return false;
            }, options);
            var endedAt = Date.now();
            if (ok) record({type: "pressKey", key: key, options: {delay: false}}, startedAt, endedAt);
            if (ok) afterDelay(options, _config.clickDelay);
            return ok;
        },

        getConfig: function() { return JSON.parse(JSON.stringify(_config)); }
    };
});
