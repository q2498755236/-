/**
 * 灵眸 v4.3 - 编辑器复刻层: auto 对象与全局函数桥
 * 对齐《JavaScript-API文档》+《JS插件编写说明》:
 *   auto.getValue/setValue/toast/getClip/setClip/launchApp/shell/log/capture/
 *   isScreenOn/wakeUp/input/browse/ocr/getEnv/clientVersion/getColor/getImageInfo
 *   全局: click/sleep(秒)/swipe/keyEvent/touchDown/touchMove/touchUp/updateFrame
 * 底层走 AutoX 全局 API + 注入的图色服务; 全部 DI 便于 node 冒烟。
 */
"use strict";

function _str(v) { return String(v === undefined || v === null ? "" : v); }

/** "x,y[,w,h]" -> {x,y,w,h}; 全角逗号兼容; 解析失败返回 null。 */
function parseRegion(region) {
    var s = _str(region).replace(/，/g, ",").trim();
    if (!s) return null;
    var p = s.split(",").map(function(x) { return Math.round(Number(x.trim())); });
    if (p.length < 2 || isNaN(p[0]) || isNaN(p[1])) return null;
    var r = { x: p[0], y: p[1], w: p.length > 2 && !isNaN(p[2]) ? p[2] : 0, h: p.length > 3 && !isNaN(p[3]) ? p[3] : 0 };
    if (r.w <= 0) r.w = 1;
    if (r.h <= 0) r.h = 1;
    return r;
}

function AutoBridge(opts) {
    opts = opts || {};
    this.vars = opts.vars;                 // EditorVars
    this.image = opts.image;               // 灵眸 ImageService (可 null: 无图色)
    this.logger = typeof opts.logger === "function" ? opts.logger : function() {};
    this.version = opts.version || "4.3.0";
    this._params = {};                     // 插件参数上下文 (动作执行前置入)
    this._ops = opts.ops || {};            // 可覆盖的底层操作 (node 测试注入)
}

AutoBridge.prototype._op = function(name, fallback, args) {
    var fn = typeof this._ops[name] === "function" ? this._ops[name] : fallback;
    return fn.apply(this, args || []);
};

// ---------- 参数上下文 (JS 插件/动作调用前) ----------

AutoBridge.prototype.pushParams = function(map) {
    this._params = map || {};
};

AutoBridge.prototype.clearParams = function() {
    this._params = {};
};

// ---------- auto 对象 ----------

AutoBridge.prototype.getValue = function(name) {
    if (this._params.hasOwnProperty(name)) return _str(this._params[name]);
    var v = this.vars ? this.vars.get(String(name)) : undefined;
    return v === undefined ? "" : _str(v);
};

AutoBridge.prototype.setValue = function(name, value) {
    if (!this.vars) return false;
    return this.vars.set(String(name), value);
};

AutoBridge.prototype.toast = function(msg) {
    var self = this;
    return this._op("toast", function() {
        if (typeof toast === "function") toast(_str(msg));
        else if (typeof console !== "undefined") console.log("[toast] " + _str(msg));
        self.logger("[toast] " + _str(msg));
    }, [msg]);
};

AutoBridge.prototype.getClip = function() {
    var self = this;
    return this._op("getClip", function() {
        return typeof getClip === "function" ? _str(getClip()) : "";
    }, []);
};

AutoBridge.prototype.setClip = function(text) {
    var self = this;
    return this._op("setClip", function() {
        if (typeof setClip === "function") setClip(_str(text));
    }, [text]);
};

AutoBridge.prototype.launchApp = function(name) {
    var self = this;
    return this._op("launchApp", function() {
        var n = _str(name);
        if (typeof app !== "undefined" && app.launchPackage) {
            var ok = app.launchPackage(n);
            if (ok === false && typeof app.launchApp === "function") ok = app.launchApp(n);
            return ok !== false;
        }
        if (typeof launchApp === "function") return launchApp(n);
        self.logger("[E] launchApp 不可用: " + n, "error");
        return false;
    }, [name]);
};

AutoBridge.prototype.shell = function(cmd, input) {
    var self = this;
    return this._op("shell", function() {
        if (typeof shell === "function") {
            var r = shell(_str(cmd));
            return r && r.output !== undefined ? _str(r.output) : _str(r);
        }
        return "";
    }, [cmd, input]);
};

AutoBridge.prototype.log = function(msg) {
    this.logger(_str(msg));
};

AutoBridge.prototype.capture = function(path) {
    var self = this;
    return this._op("capture", function() {
        var screen = this.image ? this.image.getScreen() : (typeof captureScreen === "function" ? captureScreen() : null);
        if (screen && typeof images !== "undefined" && images.save) {
            images.save(screen, _str(path));
            return true;
        }
        return false;
    }, [path]);
};

AutoBridge.prototype.isScreenOn = function() {
    return this._op("isScreenOn", function() {
        try { return typeof device !== "undefined" && device.isScreenOn ? !!device.isScreenOn() : true; }
        catch (e) { return true; }
    }, []);
};

AutoBridge.prototype.wakeUp = function() {
    return this._op("wakeUp", function() {
        if (typeof device !== "undefined" && device.wakeUp) device.wakeUp();
    }, []);
};

AutoBridge.prototype.input = function(text, mode) {
    var self = this;
    return this._op("input", function() {
        if (typeof setText === "function") return setText(_str(text));
        self.logger("[E] input 不可用 (无障碍未就绪)", "error");
        return false;
    }, [text, mode]);
};

AutoBridge.prototype.browse = function(url) {
    return this._op("browse", function() {
        if (typeof app !== "undefined" && app.openUrl) app.openUrl(_str(url));
    }, [url]);
};

AutoBridge.prototype.getEnv = function() {
    return this._op("getEnv", function() { return "无障碍"; }, []);
};

AutoBridge.prototype.clientVersion = function() {
    return this.version;
};

/** 编辑器 auto.ocr: {code:0, msg, result:[...]}。 */
AutoBridge.prototype.ocr = function(region) {
    var self = this;
    return this._op("ocr", function() {
        if (!self.image) return { code: -1, msg: "图色服务不可用", result: [] };
        var r = parseRegion(region);
        var res = self.image.ocrRegion(r ? [r.x, r.y, r.w, r.h] : null);
        if (res && res.ok) {
            var texts = (res.results || []).map(function(x) { return x.text !== undefined ? x.text : _str(x); });
            return { code: 0, msg: "", result: texts };
        }
        return { code: -1, msg: res && res.message ? res.message : "OCR 失败", result: [] };
    }, [region]);
};

/** 编辑器 getColor(颜色变量名): 变量表取 "#RRGGBB"。 */
AutoBridge.prototype.getColor = function(name) {
    var v = this.vars ? this.vars.get(String(name)) : undefined;
    return v === undefined ? "" : _str(v);
};

AutoBridge.prototype.getImageInfo = function(name) {
    this.logger("[W] getImageInfo(Mat) 复刻层未实现: " + name);
    return null;
};

AutoBridge.prototype.findOne = function(selector, target) {
    var self = this;
    return this._op("findOne", function() {
        var t = target || selector;
        if (!t || typeof t !== "object") return null;
        var sel = null;
        if (t.text) sel = typeof text === "function" ? text(_str(t.text)) : null;
        else if (t.id) sel = typeof id === "function" ? id(_str(t.id)) : null;
        else if (t.desc) sel = typeof desc === "function" ? desc(_str(t.desc)) : null;
        if (!sel) return null;
        var n = typeof findOne === "function" ? findOne(sel) : null;
        return n ? { id: _str(n.id()), text: _str(n.text()), class_name: _str(n.className()), package_name: _str(n.packageName()) } : null;
    }, [selector, target]);
};

AutoBridge.prototype.findNodes = function(selector, target) {
    var one = this.findOne(selector, target);
    return one ? [one] : [];
};

// ---------- 全局函数 ----------

/** 编辑器 click("x,y[,w,h]") 区域中心点击。 */
AutoBridge.prototype.gClick = function(region, timeMs) {
    var self = this;
    return this._op("click", function() {
        var r = parseRegion(region);
        if (!r) { self.logger("[E] click 区域非法: " + region, "error"); return false; }
        var cx = r.x + Math.floor(r.w / 2), cy = r.y + Math.floor(r.h / 2);
        if (typeof click === "function") return !!click(cx, cy);
        self.logger("[E] click 不可用 (无障碍未就绪)", "error");
        return false;
    }, [region, timeMs]);
};

/** 编辑器 sleep: 参数是秒 (支持小数); AutoX sleep 是毫秒。 */
AutoBridge.prototype.gSleep = function(sec, stopRequested) {
    var ms = Math.max(0, Math.round(Number(sec) * 1000 || 0));
    var STEP = 200;
    var left = ms;
    while (left > 0) {
        if (stopRequested && stopRequested()) return false;
        var chunk = left > STEP ? STEP : left;
        if (typeof sleep === "function") sleep(chunk); else {
            var end = Date.now() + chunk;
            while (Date.now() < end) {}
        }
        left -= chunk;
    }
    return true;
};

/** 编辑器 swipe: 多组 "x,y[,w,h]" + pressTime + duration(秒)。 */
AutoBridge.prototype.gSwipe = function(region, pressTime, duration) {
    var self = this;
    return this._op("swipe", function() {
        var r = parseRegion(region);
        if (!r) return false;
        var x1 = r.x + Math.floor(r.w / 2), y1 = r.y + Math.floor(r.h / 2);
        var x2 = parseRegion(arguments.length > 3 ? arguments[3] : null);
        if (!x2) return false;
        var cx2 = x2.x + Math.floor(x2.w / 2), cy2 = x2.y + Math.floor(x2.h / 2);
        var dur = Math.round((Number(duration) || 0.5) * 1000);
        if (typeof swipe === "function") return !!swipe(x1, y1, cx2, cy2, dur);
        return false;
    }, [region, pressTime, duration]);
};

AutoBridge.prototype.gKeyEvent = function(key) {
    var self = this;
    return this._op("keyEvent", function() {
        var k = _str(key).toLowerCase();
        if (typeof keyEvent === "function") return !!keyEvent(k === "back" || k === "home" || k === "recents" ? k : Number(key));
        if (typeof back === "function" && k === "back") { back(); return true; }
        if (typeof home === "function" && k === "home") { home(); return true; }
        return false;
    }, [key]);
};

AutoBridge.prototype.gTouchDown = function(x, y) {
    var self = this;
    this._touch = { x: Number(x) || 0, y: Number(y) || 0 };
    return this._op("touchDown", function() { return true; }, [x, y]);
};

AutoBridge.prototype.gTouchMove = function(x, y, durationMs) {
    var self = this;
    return this._op("touchMove", function() {
        var t = self._touch || { x: Number(x) || 0, y: Number(y) || 0 };
        if (typeof swipe === "function") swipe(t.x, t.y, Number(x) || 0, Number(y) || 0, Number(durationMs) || 300);
        return true;
    }, [x, y, durationMs]);
};

AutoBridge.prototype.gTouchUp = function() {
    return this._op("touchUp", function() { this._touch = null; return true; }, []);
};

/** 编辑器 updateFrame: 截屏失效重取。 */
AutoBridge.prototype.updateFrame = function() {
    var self = this;
    return this._op("updateFrame", function() {
        if (self.image) { self.image.invalidate(); self.image.getScreen(); }
        return true;
    }, []);
};

module.exports = AutoBridge;
module.exports.parseRegion = parseRegion;
