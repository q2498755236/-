/**
 * 灵眸 v4.2 RC13 - ECA 图色服务
 * 截图权限申请（requestScreenCapture）+ 截屏缓存（每事件一次）+ 找图/找色/区域OCR。
 * 模板图按路径缓存；事件执行后 invalidate() 使截屏失效（动作可能已改变屏幕）。
 * 依赖注入（requestPermission/capture/readImage/findImage/findColor/recycle/ocrText）便于 node 测试。
 */
"use strict";

/**
 * @param opts {logger, requestPermission, capture, readImage, findImage, findColor, recycle, ocrText}
 *   AutoX 环境默认绑定全局 API（ocrText 默认走 paddle.ocrText）。
 */
function ImageService(opts) {
    opts = opts || {};
    var noop = function() {};
    this.logger = typeof opts.logger === "function" ? opts.logger : noop;
    this._requestPermission = typeof opts.requestPermission === "function"
        ? opts.requestPermission
        : function() { return requestScreenCapture(); };
    this._capture = typeof opts.capture === "function"
        ? opts.capture
        : function() { return captureScreen(); };
    this._readImage = typeof opts.readImage === "function"
        ? opts.readImage
        : function(p) { return images.read(p); };
    this._findImage = typeof opts.findImage === "function"
        ? opts.findImage
        : function(img, tpl, o) { return images.findImage(img, tpl, o); };
    this._findColor = typeof opts.findColor === "function"
        ? opts.findColor
        : function(img, color, o) { return images.findColor(img, color, o); };
    this._recycle = typeof opts.recycle === "function"
        ? opts.recycle
        : function(img) { try { img.recycle(); } catch (e) {} };
    // AutoX v7 Rhino Paddle OCR：paddle.ocrText(img, cpuThreadNum=4, useSlim=true)
    this._ocrText = typeof opts.ocrText === "function"
        ? opts.ocrText
        : function(img) { return paddle.ocrText(img, 4, true); };
    this._clip = typeof opts.clip === "function"
        ? opts.clip
        : function(img, x, y, w, h) { return images.clip(img, x, y, w, h); };

    this._granted = false;
    this._denied = false;
    this._screen = null;     // 当前缓存截屏
    this._templates = {};    // path -> Image
}

/** 申请截图权限（每进程一次；被拒后不再重复申请，防弹窗轰炸）。 */
ImageService.prototype.ensurePermission = function() {
    if (this._granted) return true;
    if (this._denied) return false;
    try {
        this._granted = !!this._requestPermission();
    } catch (e) {
        this._denied = true;
        this.logger("[E] 截图权限申请异常: " + e, "error");
        return false;
    }
    if (!this._granted) {
        this._denied = true;
        this.logger("[E] 截图权限未授予，图色条件不成立（重启 Studio 后可重新申请）", "error");
    }
    return this._granted;
};

/** 当前截屏（懒截取并缓存，直到 invalidate）。失败返回 null。 */
ImageService.prototype.getScreen = function() {
    if (this._screen) return this._screen;
    if (!this.ensurePermission()) return null;
    try {
        this._screen = this._capture();
    } catch (e) {
        this.logger("[E] 截屏失败: " + e, "error");
        return null;
    }
    return this._screen;
};

/** 使缓存截屏失效并回收（事件执行了动作后调用）。 */
ImageService.prototype.invalidate = function() {
    if (this._screen) {
        this._recycle(this._screen);
        this._screen = null;
    }
};

/** 释放全部资源（脚本退出时调用）。 */
ImageService.prototype.dispose = function() {
    this.invalidate();
    for (var p in this._templates) {
        if (this._templates.hasOwnProperty(p)) {
            this._recycle(this._templates[p]);
        }
    }
    this._templates = {};
};

/** "x,y,w,h" → [x,y,w,h]；空/非法返回 null。 */
ImageService.prototype._parseRegion = function(s) {
    if (s === undefined || s === null || String(s).trim() === "") return null;
    var parts = String(s).split(",");
    if (parts.length !== 2 && parts.length !== 4) return null;
    var nums = [];
    for (var i = 0; i < parts.length; i++) {
        var n = Number(parts[i].trim());
        if (!isFinite(n) || n < 0) return null;
        nums.push(Math.round(n));
    }
    return nums;
};

/**
 * 找图。@param p {path, threshold(0~1 相似度), region}
 */
ImageService.prototype.findTemplate = function(p) {
    var path = String((p && p.path) || "");
    if (!path) return {pass: false, message: "图色条件缺少图片路径"};
    var tpl = this._templates[path];
    if (!tpl) {
        try {
            tpl = this._readImage(path);
        } catch (e) {
            return {pass: false, message: "模板图读取异常: " + e};
        }
        if (!tpl) return {pass: false, message: "模板图读取失败: " + path};
        this._templates[path] = tpl;
    }
    var screen = this.getScreen();
    if (!screen) return {pass: false, message: "截屏不可用"};
    var opts = {};
    var th = (p && p.threshold !== undefined && p.threshold !== "") ? Number(p.threshold) : NaN;
    if (isFinite(th) && th > 0 && th <= 1) opts.threshold = th;
    var region = this._parseRegion(p && p.region);
    if (region) opts.region = region;
    try {
        var pt = this._findImage(screen, tpl, opts);
        if (!pt) return {pass: false, message: "找图[" + pathBase(path) + "]未找到"};
        // 命中：返回模板包围盒（供保存坐标动作使用）
        var w = tplSize(tpl, "w");
        var h = tplSize(tpl, "h");
        var box = {
            x: pt.x, y: pt.y, w: w, h: h,
            cx: Math.round(pt.x + w / 2), cy: Math.round(pt.y + h / 2)
        };
        return {pass: true, point: box, message: "找图[" + pathBase(path) + "]命中 (" + pt.x + "," + pt.y + ")"};
    } catch (e) {
        return {pass: false, message: "找图异常: " + e};
    }
};

/** 模板图尺寸：兼容 AutoX Image（getWidth）与测试桩（width/height 字段）。 */
function tplSize(img, which) {
    try {
        if (which === "w") return (typeof img.getWidth === "function") ? img.getWidth() : (img.width || 0);
        return (typeof img.getHeight === "function") ? img.getHeight() : (img.height || 0);
    } catch (e) {
        return 0;
    }
}

/**
 * 找色。@param p {color, threshold(0~255 色差，默认4), region}
 */
ImageService.prototype.findColorHere = function(p) {
    var color = String((p && p.color) || "").trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(color)) return {pass: false, message: "颜色值非法: " + color};
    if (color.charAt(0) !== "#") color = "#" + color;
    var screen = this.getScreen();
    if (!screen) return {pass: false, message: "截屏不可用"};
    var opts = {};
    var th = (p && p.threshold !== undefined && p.threshold !== "") ? Number(p.threshold) : NaN;
    if (isFinite(th) && th >= 0 && th <= 255) opts.threshold = th;
    var region = this._parseRegion(p && p.region);
    if (region) opts.region = region;
    try {
        var pt = this._findColor(screen, color, opts);
        if (!pt) return {pass: false, message: "找色[" + color + "]未找到"};
        var box = {x: pt.x, y: pt.y, w: 1, h: 1, cx: pt.x, cy: pt.y};
        return {pass: true, point: box, message: "找色[" + color + "]命中 (" + pt.x + "," + pt.y + ")"};
    } catch (e) {
        return {pass: false, message: "找色异常: " + e};
    }
};

function pathBase(p) {
    var i = String(p).lastIndexOf("/");
    return i >= 0 ? String(p).slice(i + 1) : String(p);
}

/**
 * 区域 OCR：截屏 →（可选）clip 区域 → paddle.ocrText → 全部文本行拼接。
 * @param p {region: "x,y,w,h"，可空=全屏}
 * @returns {pass, text, message} 失败时 text 为 ""
 */
ImageService.prototype.ocrRegion = function(p) {
    var region = this._parseRegion(p && p.region);
    if (p && p.region !== undefined && p.region !== null && String(p.region).trim() !== "" && (!region || region.length !== 4)) {
        return {pass: false, text: "", message: "OCR 区域非法（需 x,y,w,h）"};
    }
    var screen = this.getScreen();
    if (!screen) return {pass: false, text: "", message: "截屏不可用"};
    var clip = null;
    try {
        var target = screen;
        if (region) {
            if (region[2] <= 0 || region[3] <= 0) {
                return {pass: false, text: "", message: "OCR 区域宽高需大于 0"};
            }
            // 按屏幕尺寸收缩区域：固定分辨率配置跨屏使用时防止越界异常
            var sw = tplSize(screen, "w"), sh = tplSize(screen, "h");
            if (region[0] >= sw || region[1] >= sh) {
                return {pass: false, text: "", message: "OCR 区域超出屏幕范围"};
            }
            var rx = region[0], ry = region[1];
            var rw = Math.min(region[2], sw - rx);
            var rh = Math.min(region[3], sh - ry);
            if (rw <= 0 || rh <= 0) {
                return {pass: false, text: "", message: "OCR 区域超出屏幕范围"};
            }
            clip = this._clip(screen, rx, ry, rw, rh);
            if (!clip) return {pass: false, text: "", message: "区域裁剪失败"};
            target = clip;
        }
        var text = String(this._ocrText(target) || "").trim();
        return {pass: true, text: text, message: text ? "OCR: " + text : "OCR 无文本"};
    } catch (e) {
        return {pass: false, text: "", message: "OCR 异常: " + e};
    } finally {
        if (clip) this._recycle(clip);
    }
};

module.exports = ImageService;
