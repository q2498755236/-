/**
 * 灵眸 v4.3 - 编辑器复刻层: 任务运行时解释器
 * 对齐编辑器 script.json 执行语义:
 *   - loop_mode=2 循环模式, loop_interval 毫秒为轮询间隔
 *   - scene.scene_event 为场景触发器 (界面标识找图条件), 命中后执行
 *     scene_event.action_list 并遍历 event_list (条件组 -> 动作序列)
 *   - 条件 item type: 1找图 2变量比较 3变量存在 4变量不存在 5嵌套组 7找色计数
 *   - 动作 type: 1取变量 2找图点击 3变量运算 4找图赋值 6变量重置 7多指手势
 *     9全部变量重置 11按键 12自定义代码 14随机数 16启动应用 22手势 29 JS插件调用
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
    this._screenSizeFn = typeof opts.screenSize === "function" ? opts.screenSize : null;
    this.running = false;
    this._stopFlag = false;
    this._scale = null;                    // 分辨率适配 (惰性): {s, ox, oy}
    this._stats = { loops: 0, scenesHit: 0, actionsRun: 0, errors: 0 };
}

/* ================= 分辨率适配 (adapter, CALIBRATE) ================= */

/** 任务基准分辨率 (ori_infos[0], 真实任务 1280x720) vs 运行设备分辨率。
 * adapter=1 按等比 min 缩放 + 居中偏移; 同分辨率零换算。 */
EditorRuntime.prototype._scaleInfo = function() {
    if (this._scale) return this._scale;
    var ori = null;
    var oi = this.task && this.task.model && this.task.model.ori_infos;
    if (Array.isArray(oi) && oi[0] && Number(oi[0].width) > 0) {
        ori = { w: Number(oi[0].width), h: Number(oi[0].height) };
    }
    var dev = this._screenSizeFn ? this._screenSizeFn() : null;
    if (!ori || !dev || !(dev.width > 0) || !(dev.height > 0) ||
        (dev.width === ori.w && dev.height === ori.h)) {
        this._scale = { s: 1, ox: 0, oy: 0 };
        return this._scale;
    }
    var sx = dev.width / ori.w, sy = dev.height / ori.h;
    var s = Math.min(sx, sy);
    this._scale = {
        s: s,
        ox: Math.round((dev.width - ori.w * s) / 2),
        oy: Math.round((dev.height - ori.h * s) / 2)
    };
    this.logger("[适配] 任务 " + ori.w + "x" + ori.h + " -> 设备 " + dev.width + "x" + dev.height +
        " (s=" + s.toFixed(3) + ")");
    return this._scale;
};

/** 任务坐标系点 -> 设备坐标 (同分辨率原样返回)。 */
EditorRuntime.prototype._fitPoint = function(x, y) {
    var sc = this._scaleInfo();
    if (sc.s === 1 && !sc.ox && !sc.oy) return { x: x, y: y };
    return { x: Math.round(x * sc.s) + sc.ox, y: Math.round(y * sc.s) + sc.oy };
};

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
        if (t === 1) return this._condFindImage(it, quick);
        if (t === 2) return this._condVarCompare(it);
        if (t === 3) return this._condVarExists(it);
        if (t === 4) return !this._condVarExists(it);
        if (t === 7) return this._condColorCount(it);
        this.logger("[W] 未知条件类型 " + t);
        return false;
    } catch (e) {
        this.logger("[E] 条件评估异常: " + e, "error");
        this._stats.errors++;
        return false;
    }
};

/** type=1 找图存在: state 1=存在 2=不存在 (真实任务两态并现, 0 兼容旧推断=存在;
 * CALIBRATE); timeout 内轮询 (轮询粒度 200ms)。quick=true (场景触发器, loop_interval
 * 节奏轮询) 忽略 timeout 单次判定——等图语义留在事件条件, 否则触发器卡死主循环。 */
EditorRuntime.prototype._condFindImage = function(it, quick) {
    var want = Number(it.state) !== 2;
    var img = this.task ? this.task.imageFile(it.image_id) : null;
    if (!img) {
        this.logger("[W] 模板图缺失: " + it.image_id);
        return !want;
    }
    var timeout = quick ? 0 : (Number(it.timeout) || 0);
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

EditorRuntime.prototype._findImageHit = function(img, opts) {
    if (!this.image || typeof this.image.findTemplate !== "function") return null;
    var p = { path: img.path, threshold: img.sim, region: opts && opts.region };
    // type=4 二值化参数透传 (binarization/binarization_type/threshold/filter_color/filter_sim),
    // ImageService 现仅消费 path/threshold/region, 其余字段待扩展 (CALIBRATE)
    if (opts) {
        if (opts.binarization !== undefined) p.binarization = opts.binarization;
        if (opts.binarization_type !== undefined) p.binarization_type = opts.binarization_type;
        if (opts.bin_threshold !== undefined) p.bin_threshold = opts.bin_threshold;
        if (opts.filter_color !== undefined) p.filter_color = opts.filter_color;
        if (opts.filter_sim !== undefined) p.filter_sim = opts.filter_sim;
    }
    var r = this.image.findTemplate(p);
    if (r && r.pass && r.point) return { x: r.point.cx, y: r.point.cy, box: r.point };
    return null;
};

/** type=2 变量比较 (CALIBRATE state 枚举): 0等于 1不等 2包含 3不包含 4大于 5小于
 * 6大于等于 (真实任务出现 state=6, 按 UI 枚举顺序补齐)。 */
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
        case 6: return Number(lv) >= Number(rv);
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

/** type=7 找色计数: search_id 变量值 "x,y,w,h" 区域内找 color_list 定义色
 * (color_id -> colorDef, 负数 int 取低 24 位转 #RRGGBB), 命中写 count_id 变量 1/0。
 * color_list.sim (0~1 相似度) -> findColorHere 色差 threshold = (1-sim)*255 (CALIBRATE)。
 * state=8 语义待校准 (真实任务 1 处)。 */
EditorRuntime.prototype._condColorCount = function(it) {
    var regionStr = this.bridge.vars ? this.bridge.vars.get(String(it.search_id)) : "";
    var def = this.task ? this.task.colorDef(String(it.color_id)) : null;
    var hit = 0;
    if (def && this.image && typeof this.image.findColorHere === "function") {
        var rgb = Number(def.color) & 0xFFFFFF;
        var hex = "#" + ("000000" + rgb.toString(16)).slice(-6);
        var sim = Number(def.sim);
        var p = { color: hex };
        if (isFinite(sim) && sim > 0 && sim < 1) p.threshold = Math.round((1 - sim) * 255);
        if (regionStr) p.region = String(regionStr);
        var r = this.image.findColorHere(p);
        if (r && r.pass) hit = 1;
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
            case 6: return this._actVarReset(a);
            case 7: return this._actMultiGesture(a);
            case 9: return this._actResetAll(a);
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
    var pt = this._fitPoint(region.x + Math.floor(region.w / 2), region.y + Math.floor(region.h / 2));
    var x = pt.x, y = pt.y;
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
    var fpt = this._fitPoint(x, y);
    x = fpt.x; y = fpt.y;
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

/** 动作二值化参数 -> findImageHit opts (type=4 找图赋值 32 处全带; type=2 无)。 */
EditorRuntime.prototype._binOpts = function(a) {
    if (!a || a.binarization === undefined) return null;
    return {
        binarization: a.binarization,
        binarization_type: a.binarization_type,
        bin_threshold: a.threshold,
        filter_color: a.filter_color,
        filter_sim: a.filter_sim
    };
};

/** type=4 变量图找图赋值: 模板 = search_id 变量绑定的 crops (变量面板截图,
 * 真实任务 32/32 全绑定; 非动作 image_id), 命中坐标写 var_id "x,y" (CALIBRATE)。
 * 二值化参数 (binarization/threshold/binarization_type/filter_color/filter_sim) 经
 * opts 透传 findTemplate, ImageService 现仅消费 path/threshold/region, 其余待扩展。 */
EditorRuntime.prototype._actFindAssign = function(a) {
    var tpl = this.task ? this.task.cropImage(a.search_id) : null;
    if (!tpl) return { ok: false, message: "变量模板图缺失: " + a.search_id };
    var hit = this._findImageHit(tpl, this._binOpts(a));
    if (hit && this.bridge.vars) {
        this.bridge.vars.set(String(a.var_id), hit.x + "," + hit.y);
    }
    return { ok: !!hit, message: hit ? "" : "未找到目标图" };
};

/** type=6 变量重置: var_id 变量恢复为 var_list 初始值 (证据: 目标为运行时图色变量,
 * 重开流程时清掉上局状态)。cover 字段语义未定 (CALIBRATE), 均执行重置。 */
EditorRuntime.prototype._actVarReset = function(a) {
    if (!this.bridge.vars) return { ok: false, message: "变量表不可用" };
    var ok = this.bridge.vars.reset(String(a.var_id));
    this.logger("[重置] 变量 " + a.var_id + (ok ? "" : " (未注册)"));
    return { ok: true };
};

/** type=9 全部变量重置: 除 exclude 清单 (id 或名) 外全部恢复初始值。
 * 证据: exclude 为跨局计数/配置变量 ("总过关次数"等), 重开一局时其余状态清零。 */
EditorRuntime.prototype._actResetAll = function(a) {
    if (!this.bridge.vars) return { ok: false, message: "变量表不可用" };
    var n = this.bridge.vars.resetAll(a.exclude || []);
    this.logger("[重置] 全部变量 (保留 " + (a.exclude || []).length + ", 重置 " + n + ")");
    return { ok: true };
};

/** type=7 多指手势: var_list 坐标变量 (运行时由找图赋值写入 "x,y[,w,h]") +
 * time_list 每指 {press_time 按下ms, slide_time 保持秒}。无滑动终点字段 (CALIBRATE),
 * 按"各指并发按下 press_time ms 后保持 slide_time 秒抬起"实现: AutoX gestures
 * 多指 API 优先, 缺失退化为逐指原地点按。 */
EditorRuntime.prototype._actMultiGesture = function(a) {
    var ids = Array.isArray(a.var_list) ? a.var_list : [];
    var times = Array.isArray(a.time_list) ? a.time_list : [];
    if (!ids.length) return { ok: false, message: "手势坐标变量为空" };
    var vars = this.bridge.vars;
    var paths = [];
    for (var i = 0; i < ids.length; i++) {
        var region = AutoBridgeMod.parseRegion(vars ? vars.get(String(ids[i])) : null);
        if (!region) return { ok: false, message: "坐标变量非法: " + ids[i] };
        var cpt = this._fitPoint(region.x + Math.floor(region.w / 2), region.y + Math.floor(region.h / 2));
        var tm = times[i] || {};
        var press = Number(tm.press_time) || 0;
        var hold = Math.max(50, Math.round((Number(tm.slide_time) || 0) * 1000));
        paths.push({ x: cpt.x, y: cpt.y, ms: Math.max(press, hold) });
    }
    var okAny = false;
    if (typeof gestures === "function") {
        var gs = [];
        for (var j = 0; j < paths.length; j++) {
            gs.push([[paths[j].x, paths[j].y], [paths[j].x, paths[j].y, paths[j].ms]]);
        }
        try { gestures.apply(null, gs); okAny = true; } catch (eG) { okAny = false; }
    }
    if (!okAny && typeof swipe === "function") {
        for (var k = 0; k < paths.length; k++) {
            swipe(paths[k].x, paths[k].y, paths[k].x, paths[k].y, paths[k].ms);
        }
        okAny = true;
    }
    this.logger("[手势] " + paths.length + " 指 " + (okAny ? "(gestures)" : "(swipe 退化)"));
    return { ok: okAny, message: okAny ? "" : "手势 API 不可用" };
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
    var lt = Number(a.launch_type) || 2;
    // launch_type=4 (真实任务"顶号重登"流程) = 重启语义: 先 force-stop 再拉起 (CALIBRATE)
    if (lt === 4 && typeof this.bridge.forceStopApp === "function") {
        this.bridge.forceStopApp(pkg);
        this.logger("[启动] 强停后重启 " + pkg);
    }
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

/** type=29 JS插件调用: action_inputs {action_arg -> action_varvalue(变量id/字面量)},
 * action_optioninputs {action_arg -> action_option(选项类参数: 复选/下拉)}——两列表
 * 并入同一参数上下文。插件结果经 auto.setValue 已写回变量。 */
EditorRuntime.prototype._actPlugin = function(a) {
    if (!this.host) return { ok: false, message: "插件宿主未初始化" };
    var params = {};
    var inputs = Array.isArray(a.action_inputs) ? a.action_inputs : [];
    for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        if (inp && inp.action_arg) params[String(inp.action_arg)] = inp.action_varvalue;
    }
    var opts = Array.isArray(a.action_optioninputs) ? a.action_optioninputs : [];
    for (var j = 0; j < opts.length; j++) {
        var op = opts[j];
        if (op && op.action_arg) params[String(op.action_arg)] = op.action_option;
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
