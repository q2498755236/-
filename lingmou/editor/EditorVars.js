/**
 * 灵眸 v4.3 - 编辑器复刻层: 变量表
 * 对齐自动化编辑器 var_list 语义:
 *   - 变量按 id 引用 (动作节点 var_id/modify_id/search_id/deviation_id), name 为显示名
 *   - 值默认字符串, 纯数字内容存 number; S 开头变量名强制字符串 (JS 侧约定)
 *   - 图色变量 (type=2) 带 crops 绑定截图区域, 找图/找色动作写回坐标
 * node 可测: 全部状态内存化, 持久化经注入的 io
 */
"use strict";

function EditorVars() {
    this._byId = {};      // id -> var 记录
    this._byName = {};    // name -> var 记录 (JS 侧按名访问)
    this._order = [];     // 保持 var_list 顺序
}

function _coerce(value, forceStr) {
    if (forceStr) return String(value === undefined || value === null ? "" : value);
    if (typeof value === "string" && value !== "" && !isNaN(Number(value))) return Number(value);
    return value;
}

/** 从 .auto script.json 的 var_list 装载。 */
EditorVars.prototype.loadList = function(varList) {
    this._byId = {};
    this._byName = {};
    this._order = [];
    var list = Array.isArray(varList) ? varList : [];
    for (var i = 0; i < list.length; i++) {
        this._add(list[i]);
    }
    return this;
};

EditorVars.prototype._add = function(raw) {
    if (!raw || !raw.id) return null;
    var rec = {
        id: String(raw.id),
        name: String(raw.name || ""),
        type: raw.type,
        value: _coerce(raw.value, /^S/.test(String(raw.name || ""))),
        init: _coerce(raw.value, /^S/.test(String(raw.name || ""))),
        crops: raw.crops || null,
        conditionValues: Array.isArray(raw.condition_values) && raw.condition_values.length ? raw.condition_values : null,
        isLocal: !!raw.is_local,
        isConfig: !!raw.is_config,
        isGlobal: !!raw.is_global
    };
    this._byId[rec.id] = rec;
    if (rec.name) this._byName[rec.name] = rec;
    this._order.push(rec);
    return rec;
};

/** 注册运行期临时变量 (如 /run 代码、插件输出)。 */
EditorVars.prototype.register = function(name, value) {
    if (!name) return null;
    var exist = this._byName[name];
    if (exist) {
        exist.value = _coerce(value, /^S/.test(name));
        return exist;
    }
    return this._add({ id: "r_" + name, name: name, type: 1, value: value });
};

EditorVars.prototype.byId = function(id) {
    return this._byId[String(id)] || null;
};

EditorVars.prototype.byName = function(name) {
    return this._byName[String(name)] || null;
};

/** 读变量值: 先名后 id; 无名变量也按 id 读。 */
EditorVars.prototype.get = function(key) {
    var rec = this._byName[key] || this._byId[key];
    return rec ? rec.value : undefined;
};

EditorVars.prototype.set = function(key, value) {
    var rec = this._byName[key] || this._byId[key];
    if (!rec) {
        rec = this.register(String(key), value);
        return rec ? true : false;
    }
    rec.value = _coerce(value, /^S/.test(rec.name));
    return true;
};

/** 重置变量为初始值 (动作 type=6: var_id + cover)。运行期注册变量无初值则清空。 */
EditorVars.prototype.reset = function(key) {
    var rec = this._byName[key] || this._byId[key];
    if (!rec) return false;
    rec.value = rec.init === undefined ? "" : rec.init;
    return true;
};

/** 全部变量重置为初始值 (动作 type=9: exclude 列表中的变量保留, 按 id 或名匹配)。
 * 跨局计数/配置类变量由 exclude 保留, 其余随局重置。 */
EditorVars.prototype.resetAll = function(excludeKeys) {
    var ex = {};
    var list = Array.isArray(excludeKeys) ? excludeKeys : [];
    for (var i = 0; i < list.length; i++) ex[String(list[i])] = true;
    var n = 0;
    for (var j = 0; j < this._order.length; j++) {
        var rec = this._order[j];
        if (ex[rec.id] || (rec.name && ex[rec.name])) continue;
        rec.value = rec.init === undefined ? "" : rec.init;
        n++;
    }
    return n;
};

/** 全部变量导出 (调试/持久化)。 */
EditorVars.prototype.snapshot = function() {
    var out = {};
    for (var i = 0; i < this._order.length; i++) {
        var rec = this._order[i];
        if (rec.name) out[rec.name] = rec.value;
    }
    return out;
};

EditorVars.prototype.count = function() {
    return this._order.length;
};

/** 全部非空变量名 (合法标识符优先用于 js_code 前导注入)。 */
EditorVars.prototype.names = function() {
    var out = [];
    for (var i = 0; i < this._order.length; i++) {
        var n = this._order[i].name;
        if (n) out.push(n);
    }
    return out;
};

module.exports = EditorVars;
