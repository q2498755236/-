/**
 * 灵眸 v4.3 - 编辑器复刻层: 任务运行时解释器
 * 对齐编辑器 script.json 执行语义:
 *   - loop_mode=2 循环模式, loop_interval 毫秒为轮询间隔
 *   - scene.scene_event 为场景触发器 (界面标识找图条件), 命中后执行
 *     scene_event.action_list 并遍历 event_list (条件组 -> 动作序列)
 *   - 条件 item type: 1找图 2变量比较 3变量存在 5嵌套组 7找色计数
 *   - 动作 type: 1取变量 2找图点击 3变量运算 4找图赋值 11按键 12自定义代码
 *     14随机数 16启动应用 22手势 29 JS插件调用
 * 语义不确定处按最合理推断实现并标注 CALIBRATE, 待真机对照校准。
 */
"use strict";

function EditorRuntime(opts) {
    opts = opts || {};
    this.bridge = opts.bridge;             // AutoBridge
    this.host = opts.host;                 // JsPluginHost
    this.task = opts.task;                 // AutoTask (含 imageFile)
    this.image = opts.image || null;       // 灵眸 ImageService
    this.logger = typeof opts.logger === "function" ? opts.logger : function() {};
    this.stopOnError = !!opts.stopOnError;
    this.running = false;
    this._stopFlag = false;
    this._stats = { loops: 0, scenesHit: 0, actionsRun: 0, errors: 0 };
}

EditorRuntime.prototype.stopRequested = function() { return this._stopFlag; };

EditorRuntime.prototype.start = function() {
    if (this.running) return { ok: false, message: "任务已在运行" };
    if (!this.task || !this.task.model) return { ok: false, message: "未装载任务" };
    this.running = true;
    this._stopFlag = false;
    var model = this.task.model;
    this.bridge.vars.loadList(model.var_list || []);
    if (this.host && Array.isArray(this.task.pluginDefs)) {
        this.host.loadAll(this.task.pluginDefs);
    }
    var self = this;
    var mode = model.loop_mode;
    var intervalMs = Math.max(10, Number(model.loop_interval) || 30);
    this.logger("[运行] 循环模式 " + mode + ", 间隔 " + intervalMs + "ms, 场景 " + (model.scene_list || []).length);
    try {
        if (mode === 0 || mode === undefined) {
            this._runOnce(model);   // 单次
        } else {
            while (!self._stopFlag) {
                self._runOnce(model);
                self._stats.loops++;
                if (self._stopFlag) break;
                self.bridge.gSleep(intervalMs / 1000, function() { return self._stopFlag; });
            }
        }
    } catch (e) {
        this.logger("[E] 运行时异常: " + e, "error");
        this._stats.errors++;
    }
    this.running = false;
    this.logger("[停止] 循环 " + this._stats.loops + " 次, 动作 " + this._stats.actionsRun + ", 异常 " + this._stats.errors);
    return { ok: true, message: "" };
};

EditorRuntime.prototype.stop = function() {
    this._stopFlag = true;
    return { ok: true };
};

EditorRuntime.prototype._runOnce = function(model) {
    // 执行顺序对齐编辑器: 通用事件 -> 场景轮询 -> 默认场景(兜底) -> 通用低(兜底后)
    this._runFlatEvents(this._mapValues(model.common_event));
    var scenes = Array.isArray(model.scene_list) ? model.scene_list : [];
    for (var i = 0; i < scenes.length; i++) {
        if (this._stopFlag) return;
        var scene = scenes[i];
        var trig = scene.scene_event;
        if (!trig) continue;
        // 场景触发器: item_group 找图条件命中 -> 激活场景
        if (!this.evalGroup(trig.item_group, true)) continue;
        this._stats.scenesHit++;
        this.logger("[场景] " + (scene.name || trig.name || ("#" + i)) + " 命中");
        this.execActionList(trig.action_list);
        var events = Array.isArray(scene.event_list) ? scene.event_list : [];
        for (var j = 0; j < events.length; j++) {
            if (this._stopFlag) return;
            var ev = events[j];
            if (ev.disabled) continue;
            if (this.evalGroup(ev.item_group, false)) {
                this.execActionList(ev.action_list);
            }
        }
    }
    this._runDefaultScene(model.default_scene);
    this._runEventsWithCond(this._mapValues(model.common_event_low));
};

/** 数字键 map -> 数组 (common_event/common_event_low/default_scene)。 */
EditorRuntime.prototype._mapValues = function(map) {
    if (!map) return [];
    if (Array.isArray(map)) return map;
    var out = [];
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
        if (map[keys[i]]) out.push(map[keys[i]]);
    }
    return out;
};

EditorRuntime.prototype._runFlatEvents = function(list) {
    for (var i = 0; i < list.length; i++) {
        if (this._stopFlag) return;
        var ev = list[i];
        if (ev.disabled) continue;
        this.execActionList(ev.action_list);
    }
};

EditorRuntime.prototype._runEventsWithCond = function(list) {
    for (var i = 0; i < list.length; i++) {
        if (this._stopFlag) return;
        var ev = list[i];
        if (ev.disabled) continue;
        if (this.evalGroup(ev.item_group, false)) this.execActionList(ev.action_list);
    }
};

/** 默认场景: 前序全部无执行时兜底 (CALIBRATE: 现按条件命中执行)。 */
EditorRuntime.prototype._runDefaultScene = function(map) {
    var list = this._mapValues(map);
    for (var i = 0; i < list.length; i++) {
        if (this._stopFlag) return;
        var ds = list[i];
        if (ds.disabled) continue;
        if (this.evalGroup(ds.item_group, false)) this.execActionList(ds.action_list);
    }
};

/* ================= 条件评估 ================= */

/** 条件组: relation 1=且 2=或; quick=true 时只评估找图类 (场景触发器)。 */
EditorRuntime.prototype.evalGroup = function(group, quick) {
    if (!group) return true;
    var items = Array.isArray(group.item_list) ? group.item_list : [];
    if (!items.length) return true;
    var isAnd = Number(group.relation) !== 2;
    var result = isAnd;
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var r = Number(it.type) === 5
            ? this.evalGroup({ item_list: it.item_list, relation: it.relation }, quick)
            : this.evalItem(it, quick);
        if (isAnd) { result = result && r; if (!result) return false; }
        else { result = result || r; if (result) return true; }
    }
    return result;
};

EditorRuntime.prototype.evalItem = function(it, quick) {
    try {
        var t = Number(it.type);
        if (t === 1) return this._condFindImage(it);
        if (t === 2) return this._condVarCompare(it);
        if (t === 3) return this._condVarExists(it);
        if (t === 7) return this._condColorCount(it);
        this.logger("[W] 未知条件类型 " + t);
        return false;
    } catch (e) {
        this.logger("[E] 条件评估异常: " + e, "error");
        this._stats.errors++;
        return false;
    }
};

/** type=1 找图存在: state 1=存在 0=不存在; timeout 内轮询 (CALIBRATE: 轮询粒度 200ms)。 */
EditorRuntime.prototype._condFindImage = function(it) {
    var want = Number(it.state) !== 0;
    var img = this.task ? this.task.imageFile(it.image_id) : null;
    if (!img) {
        this.logger("[W] 模板图缺失: " + it.image_id);
        return !want;
    }
    var timeout = Number(it.timeout) || 0;
    var deadline = Date.now() + Math.min(timeout, 30000);
    var hit = null;
    var self = this;
    do {
        hit = this._findImageHit(img);
        if (!!hit === want) return want;
        if (timeout > 0 && Date.now() < deadline) {
            this.bridge.gSleep(0.2, function() { return self._stopFlag; });
        }
    } while (timeout > 0 && Date.now() < deadline && !this._stopFlag);
    return !want;
};

EditorRuntime.prototype._findImageHit = function(img) {
    if (!this.image) return null;
    var r = this.image.findImage(img.path, null, img.sim);
    if (r && r.ok && r.x !== undefined) return { x: r.x, y: r.y };
    return null;
};

/** type=2 变量比较 (CALIBRATE state 枚举): 0等于 1不等 2包含 3不包含 4大于 5小于。 */
EditorRuntime.prototype._condVarCompare = function(it) {
    var left = this.bridge.vars ? this.bridge.vars.get(String(it.variable_id)) : undefined;
    var lv = left === undefined ? "" : String(left);
    var rv = it.is_variable_compare
        ? String(this.bridge.vars && this.bridge.vars.get(String(it.compare_variable_id)) !== undefined
            ? this.bridge.vars.get(String(it.compare_variable_id)) : it.compare_value)
        : String(it.compare_value === undefined ? "" : it.compare_value);
    var s = Number(it.state);
    switch (s) {
        case 0: return lv === rv;
        case 1: return lv !== rv;
        case 2: return lv.indexOf(rv) >= 0;
        case 3: return lv.indexOf(rv) < 0;
        case 4: return Number(lv) > Number(rv);
        case 5: return Number(lv) < Number(rv);
        default:
            this.logger("[W] 变量比较未知 state " + s + " (CALIBRATE)");
            return lv === rv;
    }
};

/** type=3 变量存在: 值非空即存在。 */
EditorRuntime.prototype._condVarExists = function(it) {
    var v = this.bridge.vars ? this.bridge.vars.get(String(it.variable_id)) : undefined;
    return v !== undefined && v !== null && String(v) !== "";
};

/** type=7 找色计数: 区域(search_id 变量值 "x,y,w,h")内找色(color_id 变量值 #RRGGBB),
 * 命中写 count_id 变量 1/0 (CALIBRATE: 计数粒度)。state=8 待校准。 */
EditorRuntime.prototype._condColorCount = function(it) {
    var regionStr = this.bridge.vars ? this.bridge.vars.get(String(it.search_id)) : "";
    var colorStr = this.bridge.vars ? this.bridge.vars.get(String(it.color_id)) : "";
    var hit = 0;
    if (this.image && colorStr) {
        var region = AutoBridgeMod.parseRegion(regionStr);
        var rect = region ? [region.x, region.y, region.w, region.h] : null;
        var r = this.image.findColor(String(colorStr), rect);
        if (r && r.ok) hit = 1;
    }
    if (it.count_id && this.bridge.vars) this.bridge.vars.set(String(it.count_id), hit);
    return hit > 0;
};

/* ================= 动作执行 ================= */

EditorRuntime.prototype.execActionList = function(list) {
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length; i++) {
        if (this._stopFlag) return false;
        var r = this.execAction(arr[i]);
        this._stats.actionsRun++;
        if (!r.ok && this.stopOnError) {
            this.logger("[E] 动作失败中断: " + (r.message || ""), "error");
            return false;
        }
    }
    return true;
};

EditorRuntime.prototype.execAction = function(a) {
    if (!a) return { ok: true };
    try {
        // postpone: 动作前延迟 (秒, 支持小数; 样本 T22 postpone:0.5)
        var pp = Number(a.postpone) || 0;
        if (pp > 0) {
            var self = this;
            this.bridge.gSleep(pp, function() { return self._stopFlag; });
            if (this._stopFlag) return { ok: false, message: "停止" };
        }
        var t = Number(a.type);
        switch (t) {
            case 1: return this._actClickVar(a);
            case 2: return this._actFindClick(a);
            case 3: return this._actVarCalc(a);
            case 4: return this._actFindAssign(a);
            case 11: return this._actKey(a);
            case 12: return this._actJsCode(a);
            case 14: return this._actRandom(a);
            case 16: return this._actLaunch(a);
            case 22: return this._actGesture(a);
            case 29: return this._actPlugin(a);
            default:
                this.logger("[W] 未知动作类型 " + t + " (CALIBRATE)");
                return { ok: true };
        }
    } catch (e) {
        this.logger("[E] 动作 type=" + a.type + " 异常: " + e, "error");
        this._stats.errors++;
        return { ok: false, message: String(e) };
    }
};

/** type=1 点击坐标变量: var_id 值 "x,y[,w,h]" -> 区域中心点击。
 * (CALIBRATE: 字段含 interval/press_time, 按点击坐标变量实现) */
EditorRuntime.prototype._actClickVar = function(a) {
    var v = this.bridge.vars ? this.bridge.vars.get(String(a.var_id)) : undefined;
    var region = AutoBridgeMod.parseRegion(v);
    if (!region) return { ok: false, message: "坐标变量非法: " + v };
    var x = region.x + Math.floor(region.w / 2), y = region.y + Math.floor(region.h / 2);
    var press = Number(a.press_time) || 0;
    if (press > 0) {
        if (typeof swipe === "function") swipe(x, y, x, y, press);
    } else if (typeof click === "function") {
        click(x, y);
    }
    this.logger("[点击] 变量坐标 (" + x + "," + y + ")");
    return { ok: true };
};

/** type=2 找图点击: 命中 -> 区域中心+偏移点击; press_time 长按 ms; click_times 次数; interval 间隔秒。 */
EditorRuntime.prototype._actFindClick = function(a) {
    var img = this.task ? this.task.imageFile(a.image_id) : null;
    if (!img) return { ok: false, message: "模板图缺失: " + a.image_id };
    var hit = this._findImageHit(img);
    if (!hit) return { ok: false, message: "未找到目标图" };
    var x = hit.x, y = hit.y;
    var dev = a.deviation_id && this.bridge.vars ? this.bridge.vars.get(String(a.deviation_id)) : null;
    var region = AutoBridgeMod.parseRegion(dev);
    if (region) {
        x += Math.floor(Math.random() * region.w);
        y += Math.floor(Math.random() * region.h);
    }
    var times = Math.max(1, Number(a.click_times) || 1);
    var press = Number(a.press_time) || 0;
    var gap = Number(a.interval) || 0;
    var self = this;
    for (var i = 0; i < times; i++) {
        if (this._stopFlag) break;
        if (press > 0) {
            if (typeof swipe === "function") swipe(x, y, x, y, press);
        } else if (typeof click === "function") {
            click(x, y);
        }
        this.logger("[点击] (" + x + "," + y + ") 第 " + (i + 1) + "/" + times + " 次");
        if (i < times - 1 && gap > 0) this.bridge.gSleep(gap, function() { return self._stopFlag; });
    }
    return { ok: true };
};

/** type=3 变量运算 (CALIBRATE action 数字枚举): 1加 2减 3乘 4除 5取余; 结果写回 var_id。 */
EditorRuntime.prototype._actVarCalc = function(a) {
    var vars = this.bridge.vars;
    if (!vars) return { ok: false, message: "变量表不可用" };
    var lv = vars.get(String(a.var_id));
    var rv = vars.get(String(a.modify_id));
    var op = Number(a.action);
    var ln = Number(lv), rn = Number(rv);
    if (isNaN(ln)) ln = 0;
    if (isNaN(rn)) rn = 0;
    var result;
    switch (op) {
        case 1: result = ln + rn; break;
        case 2: result = ln - rn; break;
        case 3: result = ln * rn; break;
        case 4: result = rn === 0 ? 0 : ln / rn; break;
        case 5: result = rn === 0 ? 0 : ln % rn; break;
        default:
            this.logger("[W] 变量运算未知 action: " + a.action + " (CALIBRATE)");
            result = ln;
    }
    vars.set(String(a.var_id), result);
    return { ok: true };
};

/** type=4 找图赋值: search_id 引用 image_list, 命中坐标写 var_id, 格式 "x,y" (CALIBRATE)。 */
EditorRuntime.prototype._actFindAssign = function(a) {
    var img = this.task ? this.task.imageFile(a.search_id) : null;
    if (!img) return { ok: false, message: "模板图缺失: " + a.search_id };
    var hit = this._findImageHit(img);
    if (hit && this.bridge.vars) {
        this.bridge.vars.set(String(a.var_id), hit.x + "," + hit.y);
    }
    return { ok: !!hit, message: hit ? "" : "未找到目标图" };
};

/** type=11 按键 (CALIBRATE 数字枚举): 1返回 2主页 3最近任务; 兼容字符串。 */
EditorRuntime.prototype._actKey = function(a) {
    var k = a.key;
    var map = { 1: "back", 2: "home", 3: "recents", back: "back", home: "home", recents: "recents" };
    var name = map[k] !== undefined ? map[k] : String(k);
    this.logger("[按键] " + name);
    this.bridge.gKeyEvent(name);
    return { ok: true };
};

/** type=12 自定义代码: 前导注入 var 声明 (读生效), 写出必须 auto.setValue (文档语义)。 */
EditorRuntime.prototype._actJsCode = function(a) {
    return this.runUserCode(String(a.js_code === undefined ? a.code : a.js_code || ""));
};

EditorRuntime.prototype._actRandom = function(a) {
    var min = Number(a.min), max = Number(a.max);
    if (isNaN(min)) min = 0;
    if (isNaN(max)) max = 100;
    if (max < min) { var t = min; min = max; max = t; }
    var v = Math.floor(Math.random() * (max - min + 1)) + min;
    if (a.var_id && this.bridge.vars) this.bridge.vars.set(String(a.var_id), v);
    this._lastValue = v;
    return { ok: true, value: v };
};

EditorRuntime.prototype._actLaunch = function(a) {
    var pkg = a.app_package || a.appName;
    var ok = this.bridge.launchApp(pkg);
    return { ok: ok, message: ok ? "" : "启动失败: " + pkg };
};

/** type=22 手势: gesture 字段引用 gesture_group_list (pathList 多段指针路径)。
 * 单指实现: 首段首点按下 -> 逐点 gesture 滑动 -> 末点抬起; 多指暂取首段 (CALIBRATE)。 */
EditorRuntime.prototype._actGesture = function(a) {
    var g = this.task ? this.task.gestureGroup(a.gesture) : null;
    if (!g) return { ok: false, message: "手势定义缺失: " + a.gesture };
    var seg = (Array.isArray(g.list) && g.list[0]) || null;
    var gl = seg && seg.gesture;
    if (!gl || !Array.isArray(gl.pathList) || !gl.pathList.length) {
        return { ok: false, message: "手势路径为空" };
    }
    var pts = gl.pathList[0];
    if (!pts || pts.length < 2) return { ok: false, message: "手势路径点不足" };
    if (typeof gesture === "function") {
        var dur = Number(seg.sleep) || 500;
        var path = [];
        for (var i = 0; i < pts.length; i++) path.push([pts[i].x, pts[i].y]);
        gesture(dur, path);
    } else if (typeof swipe === "function") {
        swipe(pts[0].x, pts[0].y, pts[pts.length - 1].x, pts[pts.length - 1].y, Number(seg.sleep) || 500);
    }
    this.logger("[手势] " + pts.length + " 点");
    return { ok: true };
};

/** type=29 JS插件调用: action_inputs {action_arg -> action_varvalue(变量id/字面量)}。
 * 插件结果经 auto.setValue 已写回变量。 */
EditorRuntime.prototype._actPlugin = function(a) {
    if (!this.host) return { ok: false, message: "插件宿主未初始化" };
    var params = {};
    var inputs = Array.isArray(a.action_inputs) ? a.action_inputs : [];
    for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        if (inp && inp.action_arg) params[String(inp.action_arg)] = inp.action_varvalue;
    }
    var r = this.host.runAction(String(a.uuid), String(a.action_name), params);
    if (!r.ok) {
        this.logger("[E] 插件调用失败: " + r.message, "error");
        this._stats.errors++;
    }
    return r;
};

/* ================= 纯代码执行 (/run code 与 type=12 共用) ================= */

/** 变量名 -> var 声明前导; 只注入代码中出现的名字 (全量 4046 变量会拖慢 eval 编译)。 */
EditorRuntime.prototype._buildHeader = function(code) {
    var vars = this.bridge.vars;
    if (!vars) return "";
    var lines = [];
    var names = vars.names();
    for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n)) continue;
        if (code.indexOf(n) < 0) continue;
        lines.push("var " + n + " = auto.getValue('" + n.replace(/'/g, "\\'") + "');");
    }
    return lines.join("\n");
};

EditorRuntime.prototype.runUserCode = function(code) {
    var header = this._buildHeader(code);
    try {
        var fn = eval("(function(auto){\n" + header + "\n" + code + "\n})");
        fn(this.bridge);
        return { ok: true, message: "" };
    } catch (e) {
        this.logger("[E] 代码执行异常: " + e, "error");
        this._stats.errors++;
        return { ok: false, message: String(e) };
    }
};

var AutoBridgeMod = require("./AutoBridge.js");

module.exports = EditorRuntime;
