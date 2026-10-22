/**
 * 灵眸 v4.2 RC13 - ECA 变量存储
 * 两个命名空间：
 *   runtime 普通变量：运行时 JS 动作可写（vars.set），初始值来自配置
 *   config  配置变量：运行时只读（JS 只能 getConfig，无 set 入口）
 * JS 沙箱入口 sandbox(): {get, set, getConfig, list}
 */
"use strict";

function VariableStore() {
    this.runtime = {};        // name -> live value
    this.config = {};         // name -> value（只读）
    this._initial = {};       // runtime 初始值快照（sync 时记录，供 reset）
}

/**
 * 与配置同步：config 命名空间整体替换；
 * runtime 仅补充新变量的初始值（已存在的活跃值不覆盖），并清理已删除的定义。
 * @param varsCfg {runtime: {name: value}, config: {name: value}}
 */
VariableStore.prototype.sync = function(varsCfg) {
    var cfg = varsCfg || {};
    var newRuntime = {};
    var init = cfg.runtime && typeof cfg.runtime === "object" ? cfg.runtime : {};
    for (var name in init) {
        if (!init.hasOwnProperty(name)) continue;
        if (this._initial.hasOwnProperty(name)) {
            // 已定义变量：活跃值保留，初始快照不变
            newRuntime[name] = this.runtime.hasOwnProperty(name) ? this.runtime[name] : this._initial[name];
        } else {
            // 新定义变量：记初始快照
            newRuntime[name] = init[name];
            this._initial[name] = init[name];
        }
    }
    this.runtime = newRuntime;
    for (var old in this._initial) {
        if (this._initial.hasOwnProperty(old) && !init.hasOwnProperty(old)) {
            delete this._initial[old];
        }
    }

    var newConfig = {};
    var conf = cfg.config && typeof cfg.config === "object" ? cfg.config : {};
    for (var cname in conf) {
        if (!conf.hasOwnProperty(cname)) continue;
        newConfig[cname] = conf[cname];
    }
    this.config = newConfig;
};

/** 普通变量读（未定义返回 undefined）。 */
VariableStore.prototype.get = function(name) {
    return this.runtime[name];
};

/** 普通变量写（仅运行时内存，不落盘）。 */
VariableStore.prototype.set = function(name, value) {
    if (typeof name !== "string" || !name) return false;
    this.runtime[name] = value;
    return true;
};

/** 配置变量读（未定义返回 undefined）。 */
VariableStore.prototype.getConfig = function(name) {
    return this.config[name];
};

/** 判断某名字是否为配置变量。 */
VariableStore.prototype.isConfig = function(name) {
    return Object.prototype.hasOwnProperty.call(this.config, name);
};

/** 普通变量重置回初始值（未定义过初始值则删除该运行时变量）。 */
VariableStore.prototype.reset = function(name) {
    if (typeof name !== "string" || !name) return false;
    if (this._initial.hasOwnProperty(name)) {
        this.runtime[name] = this._initial[name];
        return true;
    }
    delete this.runtime[name];
    return true;
};

/** JS 沙箱对象：get/set 操作普通变量，getConfig 读配置变量。 */
VariableStore.prototype.sandbox = function() {
    var self = this;
    return {
        get: function(name) { return self.runtime[name]; },
        set: function(name, value) { return self.set(name, value); },
        getConfig: function(name) { return self.config[name]; },
        list: function() {
            return {
                runtime: Object.keys(self.runtime),
                config: Object.keys(self.config)
            };
        }
    };
};

module.exports = VariableStore;
