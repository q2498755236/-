/**
 * 灵眸 v4.2 RC13 - ECA 动作执行器
 * 按序执行动作序列（含 JS 动作、OCR/节点取值、保存坐标、变量修改），
 * 返回 {ok, touchedUI, actionsDone, message}。
 */
"use strict";

var NodeRuntime = require("../core/NodeRuntime");

/** touchedUI 表：界面操作动作为 true；纯计算动作为 false。 */
var TOUCHED_UI = {
    tap: true,
    long_click: true,
    swipe: true,
    text: true,
    key: true,
    wait: false,
    log: false,
    ocr_read: false,
    node_text: false,
    save_coord: false,
    var_set: false,
    var_inc: false,
    var_dec: false,
    var_reset: false
    // script 动态判定：params.noUI === true → false，否则 true
};

/** ECA 动作参数 → NodeRuntime 参数转换。 */
function convertParams(type, params) {
    switch (type) {
        case "wait":
            var sec = Number(params.seconds);
            return {ms: isFinite(sec) ? sec * 1000 : 1000};
        case "log":
            return {message: params.content};
        default:
            return params;
    }
}

/**
 * 执行动作序列。
 * @param actions [{type, params}]
 * @param opts {rule, vars, logger, stopRequested}
 *   rule: 传给 JS 动作的事件上下文 {name}
 *   vars: VariableStore（JS 动作沙箱 vars.get/set/getConfig）
 *   logger: function(msg)
 * @returns {ok, touchedUI, actionsDone, message}
 */
function runActions(actions, opts) {
    opts = opts || {};
    var logger = typeof opts.logger === "function" ? opts.logger : function() {};
    var stopRequested = typeof opts.stopRequested === "function" ? opts.stopRequested : function() { return false; };
    var touched = false;
    var done = 0;

    if (!(actions instanceof Array) || actions.length === 0) {
        return {ok: true, touchedUI: false, actionsDone: 0, message: "无动作"};
    }

    for (var i = 0; i < actions.length; i++) {
        if (stopRequested()) {
            return {ok: false, touchedUI: touched, actionsDone: done, message: "已停止（第 " + (done + 1) + " 步前）"};
        }
        var a = actions[i];
        var isUI = a.type === "script" ? (a.params && a.params.noUI === true ? false : true)
                                       : (TOUCHED_UI[a.type] === true);
        var res;

        if (a.type === "script") {
            res = runScript(a.params, opts.rule, logger, opts.vars);
        } else if (a.type === "ocr_read" || a.type === "node_text" || a.type === "save_coord") {
            res = runReadAction(a.type, a.params || {}, opts, logger);
        } else if (a.type === "var_set" || a.type === "var_inc" || a.type === "var_dec" || a.type === "var_reset") {
            res = runVarAction(a.type, a.params || {}, opts, logger);
        } else if (TOUCHED_UI[a.type] === undefined) {
            return {ok: false, touchedUI: touched, actionsDone: done,
                    message: "未知动作类型: " + a.type};
        } else {
            res = NodeRuntime.executeAction(a.type, convertParams(a.type, a.params || {}),
                {log: logger, stopRequested: stopRequested});
        }

        if (!res.ok) {
            return {ok: false, touchedUI: touched, actionsDone: done,
                    message: "动作[" + a.type + "]失败: " + res.message};
        }
        if (isUI) touched = true;
        done++;
    }
    return {ok: true, touchedUI: touched, actionsDone: done, message: ""};
}

/** JS 动作：new Function 隔离执行，注入 rule 上下文 + vars 沙箱 + log。 */
function runScript(params, rule, logger, store) {
    var code = String((params && params.code) || "");
    if (!code.trim()) return {ok: false, message: "JS 动作代码为空"};
    try {
        var fn = new Function("rule", "log", "vars", code);
        fn(rule || {}, logger, store ? store.sandbox() : {});
        return {ok: true, message: ""};
    } catch (e) {
        var firstLine = code.split("\n")[0].substring(0, 40);
        return {ok: false, message: "JS 动作异常(" + firstLine + "): " + e};
    }
}

// ---------- 取值动作 ----------

/**
 * 取值动作：OCR 取文本 / 节点取文本 / 保存坐标，结果写入变量。
 * @param opts {vars: VariableStore, imageService?, findNode?}
 */
function runReadAction(type, params, opts, logger) {
    var store = opts.vars;
    if (!store) return {ok: false, message: "变量服务不可用"};
    var name = String(params.varName || "").trim();
    if (!name) return {ok: false, message: "目标变量名为空"};

    if (type === "ocr_read") {
        if (!opts.imageService) return {ok: false, message: "图色服务不可用"};
        var ocr = opts.imageService.ocrRegion(params);
        if (!ocr.pass) return {ok: false, message: ocr.message};
        var text = ocr.text;
        if (params.numberOnly === true) {
            var m = text.match(/-?\d+(\.\d+)?/);
            text = m ? m[0] : "";
        }
        store.set(name, text);
        logger("OCR[" + name + "] = " + text);
        return {ok: true, message: ""};
    }

    if (type === "node_text") {
        var kind = params.kind === "desc" ? "desc" : "text";
        var value = String(params.value || "");
        if (!value) return {ok: false, message: "节点" + (kind === "desc" ? "描述" : "文本") + "为空"};
        var findNode = typeof opts.findNode === "function" ? opts.findNode : null;
        if (!findNode) return {ok: false, message: "节点服务不可用"};
        var node = findNode(kind, value);
        if (!node) return {ok: false, message: "未找到节点[" + value + "]"};
        store.set(name, String(node.text || ""));
        logger("节点[" + value + "]文本 → " + name + " = " + node.text);
        return {ok: true, message: ""};
    }

    // save_coord：图色/节点坐标存对象 {x,y,w,h,cx,cy}
    var box;
    if (params.mode === "node") {
        var nkind = params.kind === "desc" ? "desc" : "text";
        var nvalue = String(params.value || "");
        if (!nvalue) return {ok: false, message: "节点" + (nkind === "desc" ? "描述" : "文本") + "为空"};
        var findNode2 = typeof opts.findNode === "function" ? opts.findNode : null;
        if (!findNode2) return {ok: false, message: "节点服务不可用"};
        var nd = findNode2(nkind, nvalue);
        if (!nd) return {ok: false, message: "未找到节点[" + nvalue + "]"};
        box = coordBox(nd.left, nd.top, nd.right - nd.left, nd.bottom - nd.top);
    } else {
        // mode=image：找图（saveCoord 图色服务）；mode=color 找色
        if (!opts.imageService) return {ok: false, message: "图色服务不可用"};
        var hit = params.mode === "color"
            ? opts.imageService.findColorHere(params)
            : opts.imageService.findTemplate(params);
        if (!hit.pass) return {ok: false, message: hit.message};
        box = hit.point;
    }
    store.set(name, box);
    logger("坐标[" + name + "] = (" + box.cx + "," + box.cy + ")");
    return {ok: true, message: ""};
}

/** 节点包围盒 → 坐标对象。 */
function coordBox(left, top, w, h) {
    return {
        x: left, y: top, w: w, h: h,
        cx: Math.round(left + w / 2), cy: Math.round(top + h / 2)
    };
}

// ---------- 变量修改动作 ----------

/** 变量值 → 数字（纯数字串或 number 才算）。 */
function toNum(v) {
    if (typeof v === "number") return isFinite(v) ? v : NaN;
    if (typeof v === "string" && v.trim() !== "" && isFinite(Number(v))) return Number(v);
    return NaN;
}

/**
 * 变量修改：var_set / var_inc / var_dec / var_reset。
 * 仅操作普通变量（配置变量运行时只读）。
 */
function runVarAction(type, params, opts, logger) {
    var store = opts.vars;
    if (!store) return {ok: false, message: "变量服务不可用"};
    var name = String(params.name || "").trim();
    if (!name) return {ok: false, message: "变量名为空"};
    if (store.isConfig(name)) {
        return {ok: false, message: "[" + name + "] 是配置变量，运行时只读"};
    }

    if (type === "var_set") {
        var value;
        var src = String(params.src || "literal");
        if (src === "copy") {
            // 复制变量：@变量名
            var ref = String(params.value || "").trim().replace(/^@/, "");
            if (!ref) return {ok: false, message: "复制来源变量为空"};
            value = store.get(ref);
            if (value === undefined) return {ok: false, message: "来源变量[" + ref + "]未定义"};
        } else if (src === "ocr") {
            // 从 OCR 取值动作写入的变量复制
            var ocrRef = String(params.ocrVar || "").trim();
            if (!ocrRef) return {ok: false, message: "OCR 变量名为空"};
            value = store.get(ocrRef);
            if (value === undefined) return {ok: false, message: "OCR 变量[" + ocrRef + "]未定义"};
        } else {
            value = literalValue(params.value);
        }
        store.set(name, value);
        logger("变量[" + name + "] = " + JSON.stringify(value));
        return {ok: true, message: ""};
    }

    if (type === "var_reset") {
        store.reset(name);
        logger("变量[" + name + "] 已重置");
        return {ok: true, message: ""};
    }

    // var_inc / var_dec：当前值必须为数字
    var cur = store.get(name);
    if (cur === undefined) return {ok: false, message: "变量[" + name + "]未定义"};
    var num = toNum(cur);
    if (isNaN(num)) {
        return {ok: false, message: "变量[" + name + "]当前值非数字: " + JSON.stringify(cur)};
    }
    var step = toNum(params.value);
    if (isNaN(step)) return {ok: false, message: "增减值需为数字: " + params.value};
    var result = type === "var_inc" ? num + step : num - step;
    store.set(name, result);
    logger("变量[" + name + "] " + (type === "var_inc" ? "+" : "-") + " " + step + " → " + result);
    return {ok: true, message: ""};
}

/** 直接输入值：数字串转 number，空串保持 ""，否则原文。 */
function literalValue(raw) {
    var s = raw === undefined || raw === null ? "" : String(raw);
    if (s === "") return "";
    if (s !== "" && isFinite(Number(s))) return Number(s);
    return s;
}

module.exports = {
    runActions: runActions,
    runScript: runScript,
    runReadAction: runReadAction,
    runVarAction: runVarAction,
    TOUCHED_UI: TOUCHED_UI
};
