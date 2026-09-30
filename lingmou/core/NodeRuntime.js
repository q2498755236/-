/**
 * LingMou v4.2 RC13 - 节点运行时（真实实现）
 * 将节点参数映射为 AutoX.js v7 全局无障碍 API 调用。
 * 返回 {ok, branch, message}；branch 用于条件节点的出口选择。
 */
"use strict";

function isNum(v) {
    return typeof v === "number" && isFinite(v);
}

function toNum(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
}

function safeCall(fn, node) {
    try {
        return {ok: !!fn(), message: ""};
    } catch (e) {
        return {ok: false, message: node.type + " 执行异常: " + e};
    }
}

/** 等待，分片 sleep 并允许外部请求停止（上限 3600 秒，wait 入口另行校验）。 */
function sleepStoppable(totalMs, ctx) {
    var remaining = Math.max(0, Math.min(3600000, Math.round(totalMs)));
    var STEP = 200;
    while (remaining > 0) {
        if (ctx && ctx.stopRequested && ctx.stopRequested()) return false;
        var chunk = remaining > STEP ? STEP : remaining;
        if (typeof sleep === "function") sleep(chunk);
        else {
            var end = Date.now() + chunk;
            while (Date.now() < end) {}
        }
        remaining -= chunk;
    }
    return true;
}

var _handlers = {

    start: function(node, ctx) {
        return {ok: true, branch: "next", message: "流程启动"};
    },

    tap: function(node) {
        var x = toNum(node.params.x), y = toNum(node.params.y);
        if (x === null || y === null) return {ok: false, message: "tap 坐标非法: " + node.params.x + "," + node.params.y};
        if (typeof click !== "function") return {ok: false, message: "无障碍服务不可用（click 不存在）"};
        return safeCall(function() { return click(x, y); }, node);
    },

    long_click: function(node) {
        var x = toNum(node.params.x), y = toNum(node.params.y);
        var d = toNum(node.params.duration) || 1000;
        if (x === null || y === null) return {ok: false, message: "long_click 坐标非法"};
        if (typeof press !== "function") return {ok: false, message: "无障碍服务不可用（press 不存在）"};
        return safeCall(function() { return press(x, y, Math.round(d)); }, node);
    },

    swipe: function(node) {
        var x1 = toNum(node.params.x1), y1 = toNum(node.params.y1);
        var x2 = toNum(node.params.x2), y2 = toNum(node.params.y2);
        var d = toNum(node.params.duration) || 500;
        if (x1 === null || y1 === null || x2 === null || y2 === null) return {ok: false, message: "swipe 坐标非法"};
        if (typeof swipe !== "function") return {ok: false, message: "无障碍服务不可用（swipe 不存在）"};
        return safeCall(function() { return swipe(x1, y1, x2, y2, Math.round(d)); }, node);
    },

    text: function(node) {
        var value = String(node.params.text === undefined ? "" : node.params.text);
        if (typeof setText !== "function") return {ok: false, message: "无障碍服务不可用（setText 不存在）"};
        return safeCall(function() { return setText(value); }, node);
    },

    key: function(node) {
        var k = String(node.params.key || "back").toLowerCase();
        var fn = null;
        // typeof 对未定义标识符安全：无障碍未就绪时给出明确提示而非 ReferenceError
        if (k === "back" && typeof back === "function") fn = back;
        else if (k === "home" && typeof home === "function") fn = home;
        else if (k === "recents" && typeof recents === "function") fn = recents;
        if (fn === null) {
            return {ok: false, message: (k === "back" || k === "home" || k === "recents")
                ? "无障碍服务不可用（按键 " + k + " 不存在）" : "未知按键: " + k};
        }
        return safeCall(function() { return fn(); }, node);
    },

    wait: function(node, ctx) {
        var ms = toNum(node.params.ms);
        if (ms === null) return {ok: false, message: "wait 毫秒非法: " + node.params.ms};
        if (ms > 3600000) return {ok: false, message: "wait 上限 3600 秒: " + node.params.ms};
        var ok = sleepStoppable(ms, ctx);
        return {ok: ok, message: ok ? "" : "等待被中断"};
    },

    log: function(node, ctx) {
        var msg = String(node.params.message === undefined ? "" : node.params.message);
        if (ctx && typeof ctx.log === "function") ctx.log(msg);
        else log(msg);
        return {ok: true, branch: "next", message: ""};
    },

    condition: function(node) {
        var needle = String(node.params.text === undefined ? "" : node.params.text);
        var exists = false;
        try {
            exists = !!text(needle).exists();
        } catch (e) {
            return {ok: false, message: "condition 检测异常: " + e};
        }
        return {ok: true, branch: exists ? "yes" : "no", message: exists ? "文本存在" : "文本不存在"};
    }
};

/**
 * 执行单个节点。
 * @param node 节点对象 {id,type,name,params}
 * @param ctx  {log, stopRequested}
 */
function execute(node, ctx) {
    if (!node) return {ok: false, branch: null, message: "节点为空"};
    var handler = _handlers[node.type];
    if (!handler) return {ok: false, branch: null, message: "未实现的节点类型: " + node.type};
    if (ctx && ctx.stopRequested && ctx.stopRequested()) {
        return {ok: false, branch: null, message: "已停止"};
    }
    try {
        var result = handler(node, ctx);
        if (!result || typeof result !== "object") {
            return {ok: false, branch: null, message: "节点返回非法"};
        }
        if (result.branch === undefined) result.branch = result.ok ? "next" : null;
        return result;
    } catch (e) {
        return {ok: false, branch: null, message: "节点执行异常: " + e};
    }
}

/**
 * ECA 单动作执行入口（RC13）。
 * @param type 动作类型（NodeRuntime 节点同名：tap/long_click/swipe/text/key/wait/log）
 * @param params 动作参数（wait 期望 ms，log 期望 message）
 * @param ctx {log, stopRequested}
 */
function executeAction(type, params, ctx) {
    return execute({id: "eca", type: String(type), name: "ECA动作", params: params || {}}, ctx);
}

module.exports = {execute: execute, executeAction: executeAction};
