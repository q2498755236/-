/**
 * 灵眸 v4.2 RC13 - ECA 配置模型与持久化
 * 单文件 eca/config.json：runMode + 4 层事件 + 自定义界面（标识条件）。
 * 原子写：先写 .tmp 再 files.move 覆盖；失败降级 files.write。
 */
"use strict";

var FileCompat = require("../core/FileCompat");

var _source = engines.myEngine().getSource();
var _baseDir = files.join(FileCompat.dirName(_source), "/");
var _configPath = files.join(_baseDir, "eca", "config.json");

var TRIGGER_TYPES = ["foreground", "widget", "interval"];
var CONDITION_TYPES = ["text_exists", "widget_exists", "wait", "image_color", "variable", "config_variable", "js"];
var ACTION_TYPES = ["tap", "long_click", "swipe", "text", "key", "wait", "log", "script",
    "ocr_read", "node_text", "save_coord", "var_set", "var_inc", "var_dec", "var_reset"];
var RUN_MODES = ["sequence", "single"];
/** 变量条件运算符：数字全量可用；文字值仅 eq。 */
var OPERATORS = ["eq", "ne", "gt", "lt", "contains", "not_contains", "contained"];
/** 通用层只有两个：L1 通用 / L5 通用低。 */
var LAYERS = ["L1", "L2", "L5", "L4"];

function genId(prefix) {
    return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
}

function isStr(v) { return typeof v === "string"; }
function isNum(v) { return typeof v === "number" && isFinite(v); }
function isBool(v) { return typeof v === "boolean"; }

/** 新建空事件（默认定时触发：无条件只有动作时按周期直接执行）。 */
function newEvent(name) {
    return {
        id: genId("e"),
        name: name || "未命名事件",
        enabled: true,
        trigger: {type: "interval", params: {seconds: 1}},
        conditions: {logic: "and", items: []},
        actions: [],
        lastRun: null
    };
}

/** 新建空界面。 */
function newScreen(name) {
    return {
        id: genId("s"),
        name: name || "新界面",
        enabled: true,
        markers: [],
        events: []
    };
}

/** 默认空配置。 */
function defaultConfig() {
    return {
        version: 2,
        runMode: "sequence",
        cycleMs: 1500,
        topEvents: [],
        screens: [],
        defaultEvents: [],
        lowEvents: [],
        variables: {runtime: {}, config: {}}
    };
}

// ---------- 清洗 ----------

function sanitizeParams(obj) {
    var out = {};
    if (!obj || typeof obj !== "object") return out;
    for (var k in obj) {
        if (!obj.hasOwnProperty(k)) continue;
        var v = obj[k];
        if (isStr(v) || isNum(v) || isBool(v)) out[k] = v;
    }
    return out;
}

function sanitizeTrigger(t) {
    if (!t || typeof t !== "object") return {type: "foreground", params: {}};
    var type = TRIGGER_TYPES.indexOf(t.type) >= 0 ? t.type : "foreground";
    return {type: type, params: sanitizeParams(t.params)};
}

function sanitizeCondition(c) {
    if (!c || typeof c !== "object" || CONDITION_TYPES.indexOf(c.type) < 0) return null;
    return {type: c.type, params: sanitizeParams(c.params)};
}

function sanitizeAction(a) {
    if (!a || typeof a !== "object" || ACTION_TYPES.indexOf(a.type) < 0) return null;
    return {type: a.type, params: sanitizeParams(a.params)};
}

function sanitizeEvent(e) {
    if (!e || typeof e !== "object") return null;
    var ev = {
        id: isStr(e.id) && e.id ? e.id : genId("e"),
        name: isStr(e.name) && e.name ? e.name : "未命名事件",
        enabled: e.enabled !== false,
        trigger: sanitizeTrigger(e.trigger),
        conditions: {logic: "and", items: []},
        actions: [],
        lastRun: null
    };
    // 条件树：旧版平铺数组 → 根 AND 组；新版 {logic, items} 递归清洗
    var condRoot = null;
    if (e.conditions instanceof Array) {
        condRoot = sanitizeCondGroup({logic: "and", items: e.conditions}, 0);
    } else if (e.conditions && typeof e.conditions === "object") {
        condRoot = sanitizeCondGroup(e.conditions, 0);
    }
    if (condRoot) ev.conditions = condRoot;
    if (e.actions instanceof Array) {
        for (var j = 0; j < e.actions.length; j++) {
            var a = sanitizeAction(e.actions[j]);
            if (a) ev.actions.push(a);
        }
    }
    return ev;
}

/** 条件组清洗：{logic, items[]}，items 内为叶子条件或嵌套组（最深 3 层）。 */
function sanitizeCondGroup(g, depth) {
    if (!g || typeof g !== "object") return null;
    if (depth > 2) return null;
    var out = {logic: g.logic === "or" ? "or" : "and", items: []};
    var arr = g.items instanceof Array ? g.items : [];
    for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        if (!it || typeof it !== "object") continue;
        if (it.items !== undefined) {
            var sub = sanitizeCondGroup(it, depth + 1);
            if (sub) out.items.push(sub);
        } else {
            var leaf = sanitizeCondition(it);
            if (leaf) out.items.push(leaf);
        }
    }
    return out;
}

function sanitizeMarker(m) {
    if (!m || typeof m !== "object") return null;
    var type = m.type;
    if (CONDITION_TYPES.indexOf(type) < 0 && type !== "pkg_match") return null;
    return {type: type, params: sanitizeParams(m.params)};
}

function sanitizeScreen(s) {
    if (!s || typeof s !== "object") return null;
    var sc = {
        id: isStr(s.id) && s.id ? s.id : genId("s"),
        name: isStr(s.name) && s.name ? s.name : "未命名界面",
        enabled: s.enabled !== false,
        markers: [],
        events: []
    };
    if (s.markers instanceof Array) {
        for (var i = 0; i < s.markers.length; i++) {
            var m = sanitizeMarker(s.markers[i]);
            if (m) sc.markers.push(m);
        }
    }
    if (s.events instanceof Array) {
        for (var j = 0; j < s.events.length; j++) {
            var e = sanitizeEvent(s.events[j]);
            if (e) sc.events.push(e);
        }
    }
    return sc;
}

/** 变量表清洗：仅保留非空名 + 字符串/数字/布尔值。 */
function sanitizeVarMap(m) {
    var out = {};
    if (!m || typeof m !== "object") return out;
    for (var k in m) {
        if (!m.hasOwnProperty(k)) continue;
        if (typeof k !== "string" || !k) continue;
        var v = m[k];
        if (isStr(v) || isNum(v) || isBool(v)) out[k] = v;
    }
    return out;
}

/** 清洗整份配置：剔除未知字段与非法条目。 */
function sanitize(raw) {
    var cfg = defaultConfig();
    if (!raw || typeof raw !== "object") return cfg;
    if (RUN_MODES.indexOf(raw.runMode) >= 0) cfg.runMode = raw.runMode;
    if (isNum(raw.cycleMs) && raw.cycleMs >= 300 && raw.cycleMs <= 60000) cfg.cycleMs = Math.round(raw.cycleMs);
    cfg.variables = {
        runtime: sanitizeVarMap(raw.variables && raw.variables.runtime),
        config: sanitizeVarMap(raw.variables && raw.variables.config)
    };
    // v2 层级精简：通用层仅 L1/L5；旧配置 midEvents 并入 topEvents
    var topRaw = [];
    if (raw.topEvents instanceof Array) topRaw = topRaw.concat(raw.topEvents);
    if (raw.midEvents instanceof Array) topRaw = topRaw.concat(raw.midEvents);
    for (var t = 0; t < topRaw.length; t++) {
        var eTop = sanitizeEvent(topRaw[t]);
        if (eTop) cfg.topEvents.push(eTop);
    }
    if (raw.screens instanceof Array) {
        for (var s = 0; s < raw.screens.length; s++) {
            var sc = sanitizeScreen(raw.screens[s]);
            if (sc) cfg.screens.push(sc);
        }
    }
    var rest = [["defaultEvents", raw.defaultEvents], ["lowEvents", raw.lowEvents]];
    for (var r = 0; r < rest.length; r++) {
        var key = rest[r][0];
        if (rest[r][1] instanceof Array) {
            for (var i = 0; i < rest[r][1].length; i++) {
                var e = sanitizeEvent(rest[r][1][i]);
                if (e) cfg[key].push(e);
            }
        }
    }
    return cfg;
}

// ---------- 校验 ----------

/** 结构校验（清洗后）。返回 {ok, errors[]}。 */
function validate(cfg) {
    var errors = [];
    if (!cfg || typeof cfg !== "object") return {ok: false, errors: ["配置为空"]};
    if (RUN_MODES.indexOf(cfg.runMode) < 0) errors.push("runMode 非法: " + cfg.runMode);
    if (!isNum(cfg.cycleMs) || cfg.cycleMs < 300 || cfg.cycleMs > 60000) errors.push("cycleMs 超范围");
    for (var i = 0; i < cfg.screens.length; i++) {
        var sc = cfg.screens[i];
        if (!sc.markers.length) errors.push("界面 [" + sc.name + "] 缺少标识条件");
    }
    return {ok: errors.length === 0, errors: errors};
}

// ---------- 持久化 ----------

function ensureDir(path) {
    if (files.isDir(path)) return true;
    if (files.exists(path)) return false;
    files.createWithDirs(files.join(path, ".keep"));
    return files.isDir(path);
}

/** 保存（原子写：tmp → move，move 失败降级直接写）。 */
function save(cfg) {
    var clean = sanitize(cfg);
    var dir = FileCompat.dirName(_configPath);
    if (!ensureDir(dir)) return {ok: false, message: "eca 目录不可用"};
    var json = JSON.stringify(clean);
    var tmp = _configPath + ".tmp";
    try {
        files.write(tmp, json);
        if (files.move(tmp, _configPath)) return {ok: true, message: ""};
        // move 覆盖失败（目标已存在等）：降级直接写
        files.write(_configPath, json);
        return {ok: true, message: ""};
    } catch (e) {
        try { if (files.exists(tmp)) files.write(_configPath, json); } catch (e2) {}
        return {ok: false, message: "保存失败: " + e};
    }
}

/** 加载：损坏时备份 .bad 并返回默认配置。 */
function load() {
    try {
        if (!files.exists(_configPath)) return {ok: true, config: defaultConfig(), message: "空配置"};
        var text = files.read(_configPath);
        if (!text || !text.trim()) return {ok: true, config: defaultConfig(), message: "空配置"};
        var raw = JSON.parse(text);
        return {ok: true, config: sanitize(raw), message: ""};
    } catch (e) {
        try {
            if (files.exists(_configPath)) {
                files.copy(_configPath, _configPath + ".bad");
            }
        } catch (e2) {}
        return {ok: false, config: defaultConfig(), message: "配置损坏已重置: " + e};
    }
}

/** 供 node 测试注入路径。 */
function setPath(path) {
    _configPath = String(path);
}

module.exports = {
    TRIGGER_TYPES: TRIGGER_TYPES,
    CONDITION_TYPES: CONDITION_TYPES,
    ACTION_TYPES: ACTION_TYPES,
    RUN_MODES: RUN_MODES,
    OPERATORS: OPERATORS,
    LAYERS: LAYERS,
    defaultConfig: defaultConfig,
    newEvent: newEvent,
    newScreen: newScreen,
    sanitize: sanitize,
    validate: validate,
    save: save,
    load: load,
    setPath: setPath,
    configPath: function() { return _configPath; }
};
