/**
 * 灵眸 v4.2 RC13 - ECA 引擎
 * 单线程固定序列遍历：L1(通用)→L2(界面)→L5(通用低)→L4(默认)
 * 顺序模式全序列走完；单事件模式 touchedUI=true 即中止回 L1。
 * L4 仅当本轮前序槽位全部无执行时进入。
 */
"use strict";

var ActionRunner = require("./ActionRunner");
var ConditionChecker = require("./ConditionChecker");

var SEQUENCE = ["L1", "L2", "L5", "L4"];

/**
 * @param opts {logger, getCurrentPackage, isTextExists, isDescExists, now, imageService, variableStore}
 *   依赖注入便于 node 测试；AutoX 环境默认绑定全局 API。
 *   imageService/variableStore 可为 null（对应条件不成立并给出原因）。
 */
function EcaEngine(opts) {
    opts = opts || {};
    this.logger = typeof opts.logger === "function" ? opts.logger : function() {};
    this.getCurrentPackage = typeof opts.getCurrentPackage === "function"
        ? opts.getCurrentPackage
        : function() { try { return currentPackage(); } catch (e) { return null; } };
    this.isTextExists = typeof opts.isTextExists === "function"
        ? opts.isTextExists
        : function(t) { try { return !!textContains(t).exists(); } catch (e) { return false; } };
    this.isDescExists = typeof opts.isDescExists === "function"
        ? opts.isDescExists
        : function(d) { try { return !!descContains(d).exists(); } catch (e) { return false; } };
    this.now = typeof opts.now === "function" ? opts.now : function() { return Date.now(); };
    this.imageService = opts.imageService || null;
    this.variableStore = opts.variableStore || null;
    // 节点取值：kind = text|desc，返回 {text,left,top,right,bottom} 或 null
    this.findNode = typeof opts.findNode === "function"
        ? opts.findNode
        : function(kind, value) {
            try {
                var sel = kind === "desc" ? descContains(value) : textContains(value);
                var n = sel.findOne(300);
                if (!n) return null;
                var b = n.bounds();
                return {text: String(n.text() || n.desc() || ""), left: b.left, top: b.top, right: b.right, bottom: b.bottom};
            } catch (e) {
                return null;
            }
        };

    this.config = null;
    this.running = false;
    this.stopRequested = false;
    this.paused = false;
    this.cycle = 0;
    this._lastPkgMap = {};   // foreground 边沿判定：eventId → 上次包名/匹配态
    this._nullPkgCount = 0;
}

EcaEngine.SEQUENCE = SEQUENCE;

/** 注入配置（EcaConfig.sanitize 产物）。 */
EcaEngine.prototype.setConfig = function(cfg) {
    this.config = cfg;
};

EcaEngine.prototype.isRunning = function() { return this.running; };

EcaEngine.prototype.start = function() {
    if (this.running || !this.config) return false;
    var self = this;
    this.running = true;
    this.stopRequested = false;
    this.paused = false;
    // 重置 foreground 边沿状态：重启后首次观测不触发
    this._lastPkgMap = {};
    this._nullPkgCount = 0;
    threads.start(function() {
        self._loop();
    });
    return true;
};

EcaEngine.prototype.stop = function() {
    this.stopRequested = true;
    this.paused = false;
};

/** 暂停：停止执行事件轮，循环保持待命（分片等待，stop 可随时打断）。 */
EcaEngine.prototype.pause = function() {
    if (this.running) this.paused = true;
};

/** 恢复：从暂停态继续执行。 */
EcaEngine.prototype.resume = function() {
    this.paused = false;
};

EcaEngine.prototype.isPaused = function() {
    return this.running && this.paused;
};

/** 引擎状态：stopped | running | paused（stop 请求后即时视为停止，UI 不滞后）。 */
EcaEngine.prototype.getStatus = function() {
    if (!this.running || this.stopRequested) return "stopped";
    return this.paused ? "paused" : "running";
};

EcaEngine.prototype._loop = function() {
    var self = this;
    while (!this.stopRequested) {
        // 暂停待命：分片等待恢复，不执行事件轮
        while (this.paused && !this.stopRequested) {
            sleep(200);
        }
        if (this.stopRequested) break;
        try {
            this.cycle++;
            this.runOnce();
        } catch (e) {
            this.logger("[E] 引擎轮次异常: " + e, "error");
        }
        if (this.stopRequested) break;
        // 分片 sleep 响应停止
        var remaining = this.config.cycleMs || 1500;
        while (remaining > 0 && !this.stopRequested) {
            var chunk = remaining > 200 ? 200 : remaining;
            sleep(chunk);
            remaining -= chunk;
        }
    }
    this.running = false;
    this.paused = false;
    this.logger("引擎已停止");
};

/**
 * 单轮遍历（可测试入口）。
 * @returns {cycle, executedAny, slots:[{layer, index, entered, hitScreen, executed, touchedUI}]}
 */
EcaEngine.prototype.runOnce = function() {
    var mode = this.config.runMode;
    var executedAny = false;
    var slots = [];
    var self = this;
    // 上一轮可能遗留缓存截屏（含单事件抢断提前返回路径），先失效
    if (this.imageService) this.imageService.invalidate();

    for (var i = 0; i < SEQUENCE.length; i++) {
        var layer = SEQUENCE[i];
        var slot = {layer: layer, index: i, entered: true, hitScreen: null, executed: false, touchedUI: false};

        if (layer === "L4" && executedAny) {
            slot.entered = false;
            slots.push(slot);
            break;
        }

        var res = this._runLayer(layer, slot);
        slot.executed = res.executed;
        slot.touchedUI = res.touchedUI;

        if (res.executed) {
            executedAny = true;
            if (mode === "single" && res.touchedUI) {
                slots.push(slot);
                this._log("轮次 " + this.cycle + ": 抢断（touchedUI），跳回顶部");
                return {cycle: this.cycle, executedAny: true, slots: slots};
            }
        }
        slots.push(slot);
        if (this.stopRequested) break;
    }
    return {cycle: this.cycle, executedAny: executedAny, slots: slots};
};

/** 执行单个槽位。L2 现场判定界面标识。 */
EcaEngine.prototype._runLayer = function(layer, slot) {
    var events;
    if (layer === "L2") {
        var screen = this._findHitScreen();
        if (!screen) return {executed: false, touchedUI: false};
        slot.hitScreen = screen.name;
        this._log("L2 命中界面 [" + screen.name + "]");
        return this._runEvents(screen.events, "界面[" + screen.name + "]");
    }
    var map = {L1: "topEvents", L4: "defaultEvents", L5: "lowEvents"};
    events = this.config[map[layer]] || [];
    return this._runEvents(events, layer);
};

/** 找第一个 enabled 且标识全成立的界面。 */
EcaEngine.prototype._findHitScreen = function() {
    var screens = this.config.screens || [];
    for (var i = 0; i < screens.length; i++) {
        var sc = screens[i];
        if (!sc.enabled) continue;
        if (this._markersPass(sc.markers)) return sc;
    }
    return null;
};

/** 标识条件全 AND。异常视为不成立。 */
EcaEngine.prototype._markersPass = function(markers) {
    for (var i = 0; i < markers.length; i++) {
        var m = markers[i];
        var ok = false;
        try {
            if (m.type === "text_exists") ok = this.isTextExists(String(m.params.text || ""));
            else if (m.type === "widget_exists") ok = this.isDescExists(String(m.params.desc || ""));
            else if (m.type === "pkg_match") ok = (this.getCurrentPackage() === String(m.params.pkg || ""));
            else if (m.type === "wait") ok = true;
            else ok = false;
        } catch (e) {
            ok = false;
        }
        if (!ok) return false;
    }
    return true;
};

/** 遍历事件列表执行触发的。返回 {executed, touchedUI}。 */
EcaEngine.prototype._runEvents = function(events, where) {
    var executed = false;
    var touched = false;
    for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (!ev.enabled) continue;
        if (this.stopRequested) break;
        var res = this._execEvent(ev, where);
        if (res.executed) {
            executed = true;
            if (res.touchedUI) touched = true;
            if (this.config.runMode === "single" && res.touchedUI) break; // 事件级抢断
        }
    }
    return {executed: executed, touchedUI: touched};
};

/** 单事件执行：trigger → 条件 → 动作。 */
EcaEngine.prototype._execEvent = function(ev, where) {
    if (!this._triggerPass(ev.trigger, ev.lastRun, ev.id)) {
        return {executed: false, touchedUI: false};
    }
    this._log("触发 [" + ev.name + "] " + (where ? "@ " + where : ""));

    var cond = ConditionChecker.checkTree(ev.conditions, {
        stopRequested: this._stopBound(),
        imageService: this.imageService,
        vars: this.variableStore,
        rule: ev
    });
    if (!cond.pass) {
        this._log("条件不满足 [" + ev.name + "]: " + cond.message);
        // 同步 lastRun：interval 触发以"检查时刻"起算间隔，避免长间隔事件退化为每轮重查
        ev.lastRun = {
            time: this.now(),
            ok: false,
            conditionPassed: false,
            actionsDone: 0,
            message: "条件不满足: " + cond.message
        };
        return {executed: false, touchedUI: false};
    }

    var self = this;
    var res = ActionRunner.runActions(ev.actions, {
        rule: {name: ev.name},
        vars: this.variableStore,
        logger: function(msg) { self._log("  [" + ev.name + "] " + msg); },
        stopRequested: this._stopBound(),
        findNode: this.findNode
    });
    // 动作可能已改变屏幕：截屏缓存失效
    if (this.imageService) this.imageService.invalidate();

    ev.lastRun = {
        time: this.now(),
        ok: res.ok,
        conditionPassed: true,
        actionsDone: res.actionsDone,
        message: res.message
    };
    this._log("完成 [" + ev.name + "] " + res.actionsDone + " 步" +
        (res.ok ? "" : " 中断: " + res.message));
    return {executed: true, touchedUI: res.touchedUI};
};

/** 触发器判定。foreground 边沿 / widget 电平 / interval 时间。eventId 用于边沿状态键。 */
EcaEngine.prototype._triggerPass = function(trigger, lastRun, eventId) {
    var t = trigger || {type: "foreground", params: {}};
    var p = t.params || {};
    try {
        if (t.type === "foreground") {
            var evId = eventId || "fg_anon";
            var cur = this.getCurrentPackage();
            if (cur === null || cur === undefined) {
                this._nullPkgCount++;
                if (this._nullPkgCount === 10) this.logger("[W] 连续 10 次获取前台包名失败，请检查无障碍服务", "warn");
                return false;
            }
            this._nullPkgCount = 0;
            var target = p.pkg ? String(p.pkg) : null;
            if (target) {
                // 指定包：包名匹配的上升沿
                var match = (cur === target);
                var was = this._lastPkgMap[evId] === true;
                this._lastPkgMap[evId] = match;
                return match && !was;
            }
            // 未指定包：任意前台包名变化的下降沿（切换应用即触发）
            var lastSeen = this._lastPkgMap[evId];
            this._lastPkgMap[evId] = cur;
            if (lastSeen === undefined) return false; // 首次观测不触发
            return cur !== lastSeen;
        }
        if (t.type === "widget") {
            var text = String(p.text || "");
            if (!text) return false;
            if (p.pkg && this.getCurrentPackage() !== String(p.pkg)) return false;
            return this.isTextExists(text);
        }
        if (t.type === "interval") {
            var seconds = Number(p.seconds);
            if (!isFinite(seconds) || seconds <= 0) return false;
            var last = (lastRun && lastRun.time) ? lastRun.time : 0;
            return (this.now() - last) >= seconds * 1000;
        }
    } catch (e) {
        this.logger("[E] 触发器判定异常: " + e, "error");
        return false;
    }
    return false;
};

EcaEngine.prototype._stopBound = function() {
    var self = this;
    return function() { return self.stopRequested; };
};

EcaEngine.prototype._log = function(msg) {
    this.logger(msg);
};

module.exports = EcaEngine;
