/**
 * 灵眸 v4.2 RC13 - ECA 条件检查器
 * text_exists / widget_exists / wait / image_color / variable / config_variable / js，
 * 支持条件树（AND/OR 组合与嵌套，AND 优先于 OR，括号由树结构表达）。
 */
"use strict";

/** 变量运算符显示名。 */
var OP_LABELS = {
    eq: "等于", ne: "不等于", gt: "大于", lt: "小于",
    contains: "包含", not_contains: "不包含", contained: "被包含"
};

function isNumeric(v) {
    if (typeof v === "number") return isFinite(v);
    if (typeof v === "string" && v.trim() !== "") return isFinite(Number(v));
    return false;
}

/**
 * 单条件判定。
 * @param c {type, params}
 * @param opts {stopRequested, imageService, vars, rule, logger}
 *   imageService: ImageService（图色条件）
 *   vars: VariableStore（变量/配置变量条件）
 *   rule: 事件对象（JS 条件注入）
 * @returns {pass, message}
 */
function check(c, opts) {
    opts = opts || {};
    var stopRequested = typeof opts.stopRequested === "function" ? opts.stopRequested : function() { return false; };
    var p = (c && c.params) || {};
    switch (c && c.type) {
        case "text_exists":
            return {pass: selectorExists("textContains", String(p.text || "")),
                    message: "文本存在[" + p.text + "]"};
        case "widget_exists":
            return {pass: selectorExists("descContains", String(p.desc || "")),
                    message: "控件存在[" + p.desc + "]"};
        case "wait":
            return waitSeconds(Number(p.seconds) || 0, stopRequested);
        case "image_color":
            return checkImageColor(p, opts);
        case "variable":
            return checkVariable(p, opts.vars, false);
        case "config_variable":
            return checkVariable(p, opts.vars, true);
        case "js":
            return checkJs(p, opts);
        default:
            return {pass: false, message: "未知条件类型: " + (c && c.type)};
    }
}

/** 图色条件：找图（mode=image）或找色（mode=color）。 */
function checkImageColor(p, opts) {
    if (!opts.imageService) return {pass: false, message: "图色服务不可用"};
    var res = (p.mode === "color")
        ? opts.imageService.findColorHere(p)
        : opts.imageService.findTemplate(p);
    return {pass: !!res.pass, message: res.message};
}

/**
 * 变量条件。变量值为数字：eq/ne/gt/lt/contains/not_contains/contained；
 * 变量值为文字（非数字）：仅 eq，其余运算符一律不成立。
 * @param isConfig true 读配置变量（运行时只读）
 */
function checkVariable(p, store, isConfig) {
    var name = String(p.name || "");
    if (!name) return {pass: false, message: (isConfig ? "配置变量" : "变量") + "名为空"};
    if (!store) return {pass: false, message: "变量服务不可用"};
    var value = isConfig ? store.getConfig(name) : store.get(name);
    if (value === undefined) {
        return {pass: false, message: (isConfig ? "配置变量" : "变量") + "[" + name + "]未定义"};
    }
    var op = String(p.op || "eq");
    if (!OP_LABELS[op]) return {pass: false, message: "未知运算符: " + op};
    var cmp = p.value;
    var how = OP_LABELS[op];
    var pass = false;

    if (!isNumeric(value) && op !== "eq") {
        return {pass: false, message: "变量[" + name + "]为文字值，仅支持等于"};
    }
    if (op === "eq" || op === "ne") {
        var numBoth = isNumeric(value) && isNumeric(cmp);
        pass = numBoth ? (Number(value) === Number(cmp)) : (String(value) === String(cmp));
        if (op === "ne") pass = !pass;
    } else if (op === "gt" || op === "lt") {
        if (!(isNumeric(value) && isNumeric(cmp))) {
            return {pass: false, message: "变量[" + name + "]" + how + "需比较值为数字"};
        }
        pass = op === "gt" ? (Number(value) > Number(cmp)) : (Number(value) < Number(cmp));
    } else {
        // contains / not_contains / contained：按字符串包含语义
        if (op === "contains") pass = String(value).indexOf(String(cmp)) >= 0;
        else if (op === "not_contains") pass = String(value).indexOf(String(cmp)) < 0;
        else pass = String(cmp).indexOf(String(value)) >= 0; // contained：变量被包含于比较值
    }
    return {pass: pass, message: "变量[" + name + "] " + how + " " + String(cmp) + (pass ? " 成立" : " 不成立")};
}

/** JS 条件：new Function 隔离，注入 rule + vars，必须返回纯布尔值。 */
function checkJs(p, opts) {
    var code = String((p && p.code) || "");
    if (!code.trim()) return {pass: false, message: "JS 条件代码为空"};
    try {
        var fn = new Function("rule", "vars", code);
        var ret = fn(opts.rule || {}, opts.vars ? opts.vars.sandbox() : {});
        if (typeof ret !== "boolean") {
            return {pass: false, message: "JS 条件须返回布尔值，实际: " + typeof ret};
        }
        return {pass: ret, message: "JS 条件" + (ret ? "成立" : "不成立")};
    } catch (e) {
        return {pass: false, message: "JS 条件异常: " + e};
    }
}

/** selector 函数存在则调用，不存在（无障碍未就绪/node 环境）返回 false。
 *  直接引用标识符 + typeof：AutoX Rhino 注入的内置函数在 global 对象上不可靠。 */
function selectorExists(fnName, value) {
    try {
        var fn = null;
        if (fnName === "textContains" && typeof textContains === "function") fn = textContains;
        else if (fnName === "descContains" && typeof descContains === "function") fn = descContains;
        if (!fn) return false;
        if (!value) return false;
        return !!fn(value).exists();
    } catch (e) {
        return false;
    }
}

/** 分片等待，响应停止请求。sleep 存在时直接真睡（勿再忙等，否则时间翻倍）。 */
function waitSeconds(seconds, stopRequested) {
    var remaining = Math.max(0, Math.min(3600, seconds)) * 1000;
    var STEP = 200;
    while (remaining > 0) {
        if (stopRequested()) return {pass: false, message: "等待被中断"};
        var chunk = remaining > STEP ? STEP : remaining;
        if (typeof sleep === "function") {
            sleep(chunk);
        } else {
            var end = Date.now() + chunk;
            while (Date.now() < end) {}
        }
        remaining -= chunk;
    }
    return {pass: true, message: "等待 " + seconds + "s"};
}

/**
 * 条件链 AND 判定（短路）。
 * @param conditions []
 * @param opts {stopRequested, imageService, vars, rule, logger}
 * @returns {pass, failedIndex, message}
 */
function checkAll(conditions, opts) {
    if (!(conditions instanceof Array) || conditions.length === 0) {
        return {pass: true, failedIndex: -1, message: "无条件"};
    }
    for (var i = 0; i < conditions.length; i++) {
        var r = check(conditions[i], opts);
        if (!r.pass) {
            return {pass: false, failedIndex: i, message: "条件[" + i + "]失败: " + r.message};
        }
    }
    return {pass: true, failedIndex: -1, message: ""};
}

/**
 * 条件树判定：{logic: "and"|"or", items: [叶子|嵌套组]}。
 * AND 全过才成立，OR 任一过即成立，均短路。
 * 兼容旧版平铺数组（按 AND 根组处理）。
 * AND 优先于 OR 的语义由树结构天然表达：(A and B) or C。
 * @returns {pass, message}
 */
function checkTree(root, opts) {
    if (!root) return {pass: true, message: "无条件"};
    if (root instanceof Array) {
        return checkAll(root, opts);
    }
    if (!(root.items) || root.items.length === 0) {
        return {pass: true, message: "无条件"};
    }
    return evalGroup(root, opts, "");
}

/** 递归求值一个组。prefix 用于失败信息定位。 */
function evalGroup(g, opts, prefix) {
    var isAnd = g.logic !== "or";
    var label = prefix + (isAnd ? "全部" : "任一");
    for (var i = 0; i < g.items.length; i++) {
        var it = g.items[i];
        var r = (it.items !== undefined)
            ? evalGroup(it, opts, prefix + "组" + (i + 1) + ".")
            : check(it, opts);
        if (isAnd && !r.pass) {
            return {pass: false, message: label + "失败: " + r.message};
        }
        if (!isAnd && r.pass) {
            return {pass: true, message: ""};
        }
    }
    return isAnd ? {pass: true, message: ""} : {pass: false, message: label + "均不成立"};
}

module.exports = {check: check, checkAll: checkAll, checkTree: checkTree, OP_LABELS: OP_LABELS};
