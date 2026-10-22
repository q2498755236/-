/**
 * 灵眸 v4.3 - 编辑器复刻层: JS 插件宿主
 * 对齐编辑器插件模型 (.auto 插件 JSON):
 *   { mName, mUUID, mCode, mActions:[{mName, params, options, results}], mConditions:[...] }
 * 执行语义:
 *   - 装载后调一次 setup() (存在时)
 *   - 动作执行: 参数值置入 auto 参数上下文 (auto.getValue 先读参数) -> loop()
 *   - 条件执行: 同上, loop() 返回值按布尔解释
 *   - 动作 results 名在执行后从变量表读回 (插件经 auto.setValue 写出)
 * mCode 经 eval 工厂包装, 闭包内顶层 var/function 状态跨调用保持。
 */
"use strict";

function JsPluginHost(opts) {
    opts = opts || {};
    this.bridge = opts.bridge;             // AutoBridge
    this.logger = typeof opts.logger === "function" ? opts.logger : function() {};
    this.plugins = {};                     // uuid -> {def, actions:{name->def}, conditions:{name->def}, fns}
    this._loaded = false;
}

/** 编译单个插件: 返回 {ok, message}。 */
JsPluginHost.prototype._compile = function(def) {
    var self = this;
    var code = String(def.mCode || "");
    var factory;
    try {
        factory = eval(
            "(function(auto){\n" + code +
            "\n;return {setup: (typeof setup==='function')?setup:null, loop: (typeof loop==='function')?loop:null};\n})"
        );
    } catch (e) {
        return { ok: false, message: "插件 " + def.mName + " 编译失败: " + e };
    }
    var fns = null;
    try {
        fns = factory(this.bridge);
    } catch (e2) {
        return { ok: false, message: "插件 " + def.mName + " 加载异常: " + e2 };
    }
    var actions = {};
    var conds = {};
    var i, a;
    var acts = Array.isArray(def.mActions) ? def.mActions : [];
    for (i = 0; i < acts.length; i++) {
        a = acts[i];
        if (a && a.mName) actions[a.mName] = a;
    }
    var cds = Array.isArray(def.mConditions) ? def.mConditions : [];
    for (i = 0; i < cds.length; i++) {
        a = cds[i];
        if (a && a.mName) conds[a.mName] = a;
    }
    return {
        ok: true,
        plugin: {
            def: def,
            // 文件名 uuid 权威 (任务 T29 引用按文件名); JSON 内 mUUID 可能不一致
            uuid: String(def.mFileUuid || def.mUUID || def.uuid || def.mName),
            name: String(def.mName || "未命名插件"),
            actions: actions,
            conditions: conds,
            fns: fns
        }
    };
};

/** 装载插件列表 (.auto 插件 JSON 数组)。setup() 在此执行。 */
JsPluginHost.prototype.loadAll = function(pluginDefs) {
    this.plugins = {};
    var list = Array.isArray(pluginDefs) ? pluginDefs : [];
    var okCount = 0;
    for (var i = 0; i < list.length; i++) {
        var def = list[i];
        if (!def || !def.mName && !def.mUUID) continue;
        var r = this._compile(def);
        if (!r.ok) { this.logger("[E] " + r.message, "error"); continue; }
        this.plugins[r.plugin.uuid] = r.plugin;
        okCount++;
        if (r.plugin.fns && r.plugin.fns.setup) {
            try { r.plugin.fns.setup(); }
            catch (e) { this.logger("[E] 插件 " + r.plugin.name + " setup 异常: " + e, "error"); }
        }
        this.logger("[插件] " + r.plugin.name + " (动作 " + Object.keys(r.plugin.actions).length + ", 条件 " + Object.keys(r.plugin.conditions).length + ")");
    }
    this._loaded = true;
    return okCount;
};

JsPluginHost.prototype.hasPlugin = function(uuid) {
    return !!this.plugins[String(uuid)];
};

JsPluginHost.prototype.getPlugin = function(uuid) {
    return this.plugins[String(uuid)] || null;
};

/** 动作清单 (供 UI 展示/编辑器任务 type=29 校验)。 */
JsPluginHost.prototype.listActions = function() {
    var out = [];
    for (var uuid in this.plugins) {
        if (!this.plugins.hasOwnProperty(uuid)) continue;
        var p = this.plugins[uuid];
        for (var an in p.actions) {
            if (!p.actions.hasOwnProperty(an)) continue;
            var a = p.actions[an];
            out.push({
                uuid: uuid,
                plugin: p.name,
                action: an,
                params: a.params || [],
                options: a.options || {},
                results: a.results || []
            });
        }
    }
    return out;
};

/** 参数值解析: action_varvalue 优先按变量 id/名取值, 取不到当字面量。 */
JsPluginHost.prototype._resolveParam = function(val) {
    if (this.bridge.vars) {
        var v = this.bridge.vars.get(String(val));
        if (v !== undefined) return v;
    }
    return val;
};

JsPluginHost.prototype._invoke = function(plugin, isCondition, params) {
    if (!plugin || !plugin.fns || typeof plugin.fns.loop !== "function") {
        return { ok: false, message: "插件 " + (plugin ? plugin.name : "?") + " 无 loop()" };
    }
    var map = {};
    var keys = Object.keys(params || {});
    for (var i = 0; i < keys.length; i++) {
        map[keys[i]] = this._resolveParam(params[keys[i]]);
    }
    this.bridge.pushParams(map);
    var ret;
    try {
        ret = plugin.fns.loop();
    } catch (e) {
        this.bridge.clearParams();
        return { ok: false, message: "插件 " + plugin.name + " loop 异常: " + e };
    }
    this.bridge.clearParams();
    if (isCondition) {
        return { ok: true, pass: ret === true || ret === "true" || ret === 1 || ret === "1", message: "" };
    }
    return { ok: true, message: "", value: ret };
};

/** 执行动作: uuid + 动作名 + 参数 (action_arg -> 原始值/变量id)。
 * 返回 {ok, results:{结果名:值}, message}。 */
JsPluginHost.prototype.runAction = function(uuid, actionName, params) {
    var plugin = this.plugins[String(uuid)];
    if (!plugin) return { ok: false, message: "未找到插件: " + uuid };
    var def = plugin.actions[String(actionName)];
    if (!def) return { ok: false, message: "插件 " + plugin.name + " 无动作: " + actionName };
    var r = this._invoke(plugin, false, params);
    if (!r.ok) return r;
    var results = {};
    var names = Array.isArray(def.results) ? def.results : [];
    for (var i = 0; i < names.length; i++) {
        results[names[i]] = this.bridge.vars ? this.bridge.vars.get(String(names[i])) : undefined;
    }
    return { ok: true, results: results, message: "" };
};

/** 执行条件: 返回 {ok, pass, message}。 */
JsPluginHost.prototype.runCondition = function(uuid, condName, params) {
    var plugin = this.plugins[String(uuid)];
    if (!plugin) return { ok: false, pass: false, message: "未找到插件: " + uuid };
    var def = plugin.conditions[String(condName)];
    if (!def) return { ok: false, pass: false, message: "插件 " + plugin.name + " 无条件: " + condName };
    return this._invoke(plugin, true, params);
};

module.exports = JsPluginHost;
