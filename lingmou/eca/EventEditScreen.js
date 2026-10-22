/**
 * 灵眸 v4.2 RC13 - 事件编辑页
 * 触发器 / 条件树（AND/OR/括号） / 动作序列 三段式编辑。
 */
"use strict";

var EcaConfig = require("./EcaConfig");
var ConditionChecker = require("./ConditionChecker");

var TRIGGER_LABELS = {foreground: "进入界面", widget: "控件出现", interval: "定时"};
var CONDITION_LABELS = {
    text_exists: "文本存在", widget_exists: "控件存在", wait: "等待",
    image_color: "图色", variable: "变量", config_variable: "配置变量", js: "JS 条件"
};
var ACTION_LABELS = {
    tap: "点击坐标", long_click: "长按", swipe: "滑动", text: "输入文本",
    key: "按键", wait: "等待", log: "日志", script: "JS 动作",
    ocr_read: "OCR 取值", node_text: "节点取值", save_coord: "保存坐标",
    var_set: "变量赋值", var_inc: "变量自增", var_dec: "变量自减", var_reset: "变量重置"
};
var OP_LABELS = ConditionChecker.OP_LABELS;
var OP_KEYS = ["eq", "ne", "gt", "lt", "contains", "not_contains", "contained"];

function escapeXml(s) {
    return String(s === undefined || s === null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/\n/g, "&#10;");
}

/** 条目参数摘要。 */
function paramSummary(type, params) {
    var p = params || {};
    switch (type) {
        case "tap": case "long_click": return "(" + p.x + "," + p.y + (p.duration ? "," + p.duration : "") + ")";
        case "swipe": return "(" + p.x1 + "," + p.y1 + ")→(" + p.x2 + "," + p.y2 + ")";
        case "text": return "「" + (p.content || "") + "」";
        case "key": return p.name || "back";
        case "wait": return (p.seconds || 0) + "s";
        case "log": return "「" + (p.content || "").substring(0, 12) + "」";
        case "script": return (p.noUI ? "[纯计算] " : "") + (p.code || "").substring(0, 16).replace(/\n/g, " ");
        case "foreground": return p.pkg ? "包:" + p.pkg : "任意切换";
        case "widget": return "「" + (p.text || "") + "」" + (p.pkg ? "@" + p.pkg : "");
        case "interval": return (p.seconds || 0) + "s";
        case "text_exists": return "「" + (p.text || "") + "」";
        case "widget_exists": return "「" + (p.desc || "") + "」";
        case "image_color":
            if (p.mode === "color") return "色[" + (p.color || "") + "]";
            var pi = String(p.path || "").lastIndexOf("/");
            return "图[" + (pi >= 0 ? String(p.path).slice(pi + 1) : (p.path || "")) + "]";
        case "variable": case "config_variable":
            return "「" + (p.name || "") + "」" + (OP_LABELS[p.op] || p.op || "等于") + "「" + (p.value !== undefined ? p.value : "") + "」";
        case "js": return "return… " + String(p.code || "").substring(0, 14).replace(/\n/g, " ");
        case "ocr_read":
            return "区域[" + (p.region || "全屏") + "]" + (p.numberOnly ? "取数字" : "取文本") + "→" + (p.varName || "?");
        case "node_text":
            return (p.kind === "desc" ? "描述" : "文本") + "「" + (p.value || "") + "」→" + (p.varName || "?");
        case "save_coord":
            if (p.mode === "node") return "节点「" + (p.value || "") + "」→" + (p.varName || "?");
            if (p.mode === "color") return "色[" + (p.color || "") + "]→" + (p.varName || "?");
            var ps = String(p.path || "").lastIndexOf("/");
            return "图[" + (ps >= 0 ? String(p.path).slice(ps + 1) : (p.path || "")) + "]→" + (p.varName || "?");
        case "var_set":
            return "[" + (p.name || "?") + "] = " + (p.src === "copy" ? "@" + (p.value || "") : JSON.stringify(p.value !== undefined ? p.value : ""));
        case "var_inc": return "[" + (p.name || "?") + "] + " + (p.value !== undefined ? p.value : "?");
        case "var_dec": return "[" + (p.name || "?") + "] - " + (p.value !== undefined ? p.value : "?");
        case "var_reset": return "[" + (p.name || "?") + "] 恢复初始";
        default: return "";
    }
}

function EventEditScreen(app, eventRef, layerKey, screenRef, onBack) {
    this.app = app;
    this.ev = eventRef;
    this.layerKey = layerKey;
    this.screenRef = screenRef;
    this.onBack = onBack;
    this.root = null;
}

EventEditScreen.prototype.build = function(parent) {
    this.root = ui.inflate('<vertical w="*" h="auto" padding="8"></vertical>', parent, false);
    this.refresh();
    return this.root;
};

EventEditScreen.prototype.refresh = function() {
    if (!this.root) return;
    var self = this;
    var ev = this.ev;
    // 防御：极旧配置可能仍是平铺数组 → 迁移为 AND 根组
    if (ev.conditions instanceof Array) {
        ev.conditions = {logic: "and", items: ev.conditions};
    }
    if (!ev.conditions || typeof ev.conditions !== "object" || !(ev.conditions.items instanceof Array)) {
        ev.conditions = {logic: "and", items: []};
    }
    this.root.removeAllViews();

    // 顶部：返回 + 名称 + 启用
    var head = ui.inflate(
        '<horizontal w="*" h="auto" gravity="center_vertical">' +
        '<button id="btnBack" text="← 返回" textSize="11sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<input id="evName" text="' + escapeXml(ev.name) + '" textSize="12sp" layout_weight="1" textColor="#DDDDDD"/>' +
        '<Switch id="evEnabled" checked="' + (ev.enabled !== false) + '"/>' +
        '</horizontal>', this.root, false);
    this._head = head;
    head.btnBack.on("click", function() { self._saveAndBack(); });
    head.evEnabled.on("check", function(checked) { ev.enabled = !!checked; });
    this.root.addView(head);

    // lastRun 摘要
    if (ev.lastRun) {
        var lr = ev.lastRun;
        this.root.addView(ui.inflate(
            '<text text="上次执行: ' + escapeXml((lr.ok ? "成功" : "失败") + " | " + lr.actionsDone + " 步" + (lr.message ? " | " + lr.message.substring(0, 30) : "")) + '" textSize="9sp" textColor="#777777" padding="2"/>',
            this.root, false));
    }

    // ---- 触发器段 ----
    this._section("触发器（" + (TRIGGER_LABELS[ev.trigger.type] || ev.trigger.type) + " " + paramSummary(ev.trigger.type, ev.trigger.params) + "）", "trigger");
    this._addBtn("修改触发器（定时/切应用/指定应用/控件出现）", function() { self._editTrigger(); });

    // ---- 条件段（树：AND/OR 组合）----
    this._section("条件（AND 优先于 OR）", "cond");
    var logicBtn = ui.inflate(
        '<button id="btnRootLogic" textSize="10sp" minWidth="0dp" minHeight="0dp" padding="6" style="Widget.AppCompat.Button.Borderless.Colored"/>',
        this.root, false);
    this.root.addView(logicBtn);
    var logicText = ev.conditions.logic === "or" ? "根逻辑: 满足任一（OR）→ 点击切换" : "根逻辑: 全部满足（AND）→ 点击切换";
    logicBtn.setText(logicText);
    logicBtn.on("click", function() {
        ev.conditions.logic = (ev.conditions.logic === "or") ? "and" : "or";
        self.app.saveConfig();
        self.refresh();
    });
    this._renderCondItems(ev.conditions, 0);
    this._addBtn("+ 添加条件", function() { self._addCondLeaf(ev.conditions); });
    this._addBtn("+ 添加条件组（括号）", function() { self._addGroup(ev.conditions, 0); });

    // ---- 动作段 ----
    this._section("动作（按序执行）", "action");
    for (var j = 0; j < ev.actions.length; j++) {
        this._itemRow("action", ev.actions, j);
    }
    this._addBtn("+ 添加动作", function() { self._pickType("action"); });
    this._addBtn("+ 添加 JS 动作", function() { self._editScript(null); });

    // 底部留白
    this.root.addView(ui.inflate('<text text=" " textSize="8sp"/>', this.root, false));
};

EventEditScreen.prototype._section = function(title) {
    this.root.addView(ui.inflate(
        '<text text="' + escapeXml(title) + '" textSize="12sp" textColor="#4FC3F7" textStyle="bold" marginTop="10" marginBottom="2"/>',
        this.root, false));
};

EventEditScreen.prototype._addBtn = function(label, handler) {
    var self = this;
    var btn = ui.inflate('<button text="' + escapeXml(label) + '" textSize="11sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Borderless.Colored"/>', this.root, false);
    btn.on("click", handler);
    this.root.addView(btn);
};

EventEditScreen.prototype._itemRow = function(kind, arr, idx) {
    var self = this;
    var item = arr[idx];
    var labels = kind === "cond" ? CONDITION_LABELS : ACTION_LABELS;
    var row = ui.inflate(
        '<horizontal w="*" h="auto" bg="#252526" padding="6 3" marginTop="1">' +
        '<vertical layout_weight="1">' +
        '<text text="' + escapeXml((labels[item.type] || item.type) + " " + paramSummary(item.type, item.params)) + '" textSize="11sp" textColor="#DDDDDD"/>' +
        '</vertical>' +
        '<button id="rowUp" text="↑" textSize="9sp" minWidth="0dp" minHeight="0dp" padding="4" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<button id="rowDown" text="↓" textSize="9sp" minWidth="0dp" minHeight="0dp" padding="4" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<button id="rowDel" text="✕" textSize="9sp" minWidth="0dp" minHeight="0dp" padding="4" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '</horizontal>', this.root, false);
    row.rowUp.on("click", function() { self._move(arr, idx, -1); });
    row.rowDown.on("click", function() { self._move(arr, idx, 1); });
    row.rowDel.on("click", function() { arr.splice(idx, 1); self.refresh(); });
    row.on("click", function() { self._editItem(kind, item); });
    this.root.addView(row);
};

EventEditScreen.prototype._move = function(arr, idx, delta) {
    var ni = idx + delta;
    if (ni < 0 || ni >= arr.length) return;
    var t = arr[idx];
    arr[idx] = arr[ni];
    arr[ni] = t;
    this.refresh();
};

// ---------- 条件树渲染 ----------

var MAX_GROUP_DEPTH = 2; // 根组为 0 层，最多嵌套 2 层括号

/** 递归渲染条件组条目。 */
EventEditScreen.prototype._renderCondItems = function(group, depth) {
    for (var i = 0; i < group.items.length; i++) {
        var it = group.items[i];
        if (it.items !== undefined) {
            this._groupRow(group, i, depth);
            this._renderCondItems(it, depth + 1);
        } else {
            this._condRow(group, i, depth);
        }
    }
};

/** 条件叶子行。 */
EventEditScreen.prototype._condRow = function(group, idx, depth) {
    var self = this;
    var item = group.items[idx];
    var row = ui.inflate(
        '<horizontal w="*" h="auto" bg="#252526" padding="6 3" marginTop="1" marginLeft="' + (depth * 14) + '">' +
        '<vertical layout_weight="1">' +
        '<text text="' + escapeXml((CONDITION_LABELS[item.type] || item.type) + " " + paramSummary(item.type, item.params)) + '" textSize="11sp" textColor="#DDDDDD"/>' +
        '</vertical>' +
        '<button id="rowDel" text="✕" textSize="9sp" minWidth="0dp" minHeight="0dp" padding="4" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '</horizontal>', this.root, false);
    row.rowDel.on("click", function() { group.items.splice(idx, 1); self.app.saveConfig(); self.refresh(); });
    row.on("click", function() { self._editItem("cond", item); });
    this.root.addView(row);
};

/** 条件组行：逻辑切换 + 组内增删。 */
EventEditScreen.prototype._groupRow = function(group, idx, depth) {
    var self = this;
    var sub = group.items[idx];
    var row = ui.inflate(
        '<horizontal w="*" h="auto" bg="#1E3A5F" padding="6 3" marginTop="1" marginLeft="' + (depth * 14) + '">' +
        '<button id="gLogic" text="(" textSize="12sp" minWidth="0dp" minHeight="0dp" padding="4" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<vertical layout_weight="1">' +
        '<text id="gLabel" textSize="10sp" textColor="#4FC3F7"/>' +
        '</vertical>' +
        '<button id="gAddCond" text="+件" textSize="9sp" minWidth="0dp" minHeight="0dp" padding="4" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<button id="gAddGroup" text="+组" textSize="9sp" minWidth="0dp" minHeight="0dp" padding="4" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<button id="gDel" text="✕" textSize="9sp" minWidth="0dp" minHeight="0dp" padding="4" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '</horizontal>', this.root, false);
    var labelText = (sub.logic === "or" ? "或-任一成立" : "且-全部成立") + "（" + sub.items.length + " 项）";
    row.gLabel.setText(labelText);
    row.gLogic.on("click", function() {
        sub.logic = (sub.logic === "or") ? "and" : "or";
        self.app.saveConfig();
        self.refresh();
    });
    row.gAddCond.on("click", function() { self._addCondLeaf(sub); });
    row.gAddGroup.on("click", function() { self._addGroup(sub, depth + 1); });
    row.gDel.on("click", function() {
        group.items.splice(idx, 1);
        self.app.saveConfig();
        self.refresh();
    });
    this.root.addView(row);
};

/** 向组内添加条件叶子：选类型 → 立即编辑。 */
EventEditScreen.prototype._addCondLeaf = function(group) {
    var self = this;
    var types = ["text_exists", "widget_exists", "wait", "image_color", "variable", "config_variable", "js"];
    var labels = types.map(function(t) { return CONDITION_LABELS[t] + " " + paramSummary(t, {}); });
    dialogs.select("选择条件类型", labels, function(idx) {
        if (idx < 0) return;
        var item = {type: types[idx], params: {}};
        group.items.push(item);
        self.app.saveConfig();
        self.refresh();
        self._editItem("cond", item);
    });
};

/** 向组内添加嵌套组（括号）。depth 为目标组当前深度。 */
EventEditScreen.prototype._addGroup = function(group, depth) {
    if (depth >= MAX_GROUP_DEPTH) {
        toast("括号最多嵌套 " + MAX_GROUP_DEPTH + " 层");
        return;
    }
    group.items.push({logic: "and", items: []});
    this.app.saveConfig();
    this.refresh();
};

/** 类型选择：仅用于动作（条件经树按钮添加）。 */
/** 编辑触发器：类型 + 参数。 */
EventEditScreen.prototype._editTrigger = function() {
    var self = this;
    var ev = this.ev;
    dialogs.select("触发类型（决定事件何时被检查；无条件事件按此节奏直接执行）", [
        "定时（每 N 秒执行）",
        "切换应用时（前台包名变化即触发）",
        "指定应用前台（进入该应用时触发）",
        "控件出现时（屏幕存在指定文本）"
    ], function(idx) {
        if (idx < 0) return;
        var p = ev.trigger.params || {};
        if (idx === 0) {
            dialogs.rawInput("间隔秒数（正数）", String(p.seconds || "1"), function(v) {
                var sec = Number(v);
                if (!isFinite(sec) || sec <= 0) { toast("秒数需为正数"); return; }
                ev.trigger = {type: "interval", params: {seconds: sec}};
                self.app.saveConfig();
                self.refresh();
            });
        } else if (idx === 1) {
            ev.trigger = {type: "foreground", params: {}};
            self.app.saveConfig();
            self.refresh();
        } else if (idx === 2) {
            dialogs.rawInput("目标应用包名（如 com.tencent.mm）", String(p.pkg || ""), function(v) {
                ev.trigger = {type: "foreground", params: {pkg: String(v || "").trim()}};
                self.app.saveConfig();
                self.refresh();
            });
        } else {
            dialogs.rawInput("控件文本（屏幕存在该文本时触发）", String(p.text || ""), function(v) {
                var text = String(v || "").trim();
                if (!text) { toast("文本不能为空"); return; }
                ev.trigger = {type: "widget", params: {text: text}};
                self.app.saveConfig();
                self.refresh();
            });
        }
    });
};

EventEditScreen.prototype._pickType = function(kind) {
    var self = this;
    var types = ["tap", "long_click", "swipe", "text", "key", "wait", "log",
                 "ocr_read", "node_text", "save_coord", "var_set", "var_inc", "var_dec", "var_reset"];
    var labels = types.map(function(t) {
        return ACTION_LABELS[t] + " " + paramSummary(t, {});
    });
    dialogs.select("选择动作类型", labels, function(idx) {
        if (idx < 0) return;
        var item = {type: types[idx], params: {}};
        self.ev.actions.push(item);
        self.refresh();
        self._editItem("action", item);
    });
};

/** 编辑条目参数（表单 dialog / 专用编辑器）。 */
EventEditScreen.prototype._editItem = function(kind, item) {
    var self = this;
    if (kind === "cond") {
        if (item.type === "image_color") return this._editImageColor(item);
        if (item.type === "variable" || item.type === "config_variable") return this._editVariable(item);
        if (item.type === "js") return this._editJsCond(item);
    } else {
        if (item.type === "ocr_read") return this._editOcrRead(item);
        if (item.type === "node_text") return this._editNodeText(item);
        if (item.type === "save_coord") return this._editSaveCoord(item);
        if (item.type === "var_set") return this._editVarSet(item);
        if (item.type === "var_inc" || item.type === "var_dec") return this._editVarStep(item);
        if (item.type === "var_reset") return this._editVarReset(item);
    }
    var fields = this._fieldsOf(kind, item.type);
    if (!fields.length) { this.refresh(); return; }
    this._formDialog(fields, item.params, function(newParams) {
        item.params = newParams;
        self.app.saveConfig();
        self.refresh();
    });
};

/** 图色条件编辑：先选找图/找色，再逐字段表单。 */
EventEditScreen.prototype._editImageColor = function(item) {
    var self = this;
    var p = item.params || (item.params = {});
    dialogs.select("图色方式", ["找图（模板图片出现在屏幕）", "找色（颜色出现在屏幕）"], function(idx) {
        if (idx < 0) return;
        var isColor = (idx === 1);
        var fields;
        if (isColor) {
            fields = [
                {key: "color", label: "颜色 #RRGGBB", num: false, def: "#FF0000"},
                {key: "threshold", label: "色差阈值 0~255（默认4）", num: true, def: 4},
                {key: "region", label: "区域 x,y,w,h（可空=全屏）", num: false, def: ""}
            ];
        } else {
            fields = [
                {key: "path", label: "图片绝对路径", num: false, def: ""},
                {key: "threshold", label: "相似度 0~1（默认0.9）", num: true, def: 0.9},
                {key: "region", label: "区域 x,y,w,h（可空=全屏）", num: false, def: ""}
            ];
        }
        self._formDialog(fields, p, function(np) {
            np.mode = isColor ? "color" : "image";
            item.params = np;
            if (isColor && !np.color) { toast("颜色为空，条件不成立"); }
            if (!isColor && !np.path) { toast("图片路径为空，条件不成立"); }
            self.app.saveConfig();
            self.refresh();
        });
    });
};

/** 变量/配置变量条件编辑：选名 → 选运算符 → 输比较值。 */
EventEditScreen.prototype._editVariable = function(item) {
    var self = this;
    var isConfig = (item.type === "config_variable");
    var p = item.params || (item.params = {});
    var varCfg = (this.app.config && this.app.config.variables) || {};
    var names = Object.keys(isConfig ? (varCfg.config || {}) : (varCfg.runtime || {}));

    var askName = function() {
        if (names.length) {
            dialogs.select("选择变量（定义于「变量」页）", names.concat(["手动输入…"]), function(idx) {
                if (idx < 0) return;
                if (idx < names.length) { p.name = names[idx]; askOp(); }
                else dialogs.rawInput("变量名", String(p.name || ""), function(v) {
                    if (v === null) return;
                    p.name = String(v);
                    askOp();
                });
            });
        } else {
            dialogs.rawInput("变量名（可在「变量」页预定义）", String(p.name || ""), function(v) {
                if (v === null) return;
                p.name = String(v);
                askOp();
            });
        }
    };
    var askOp = function() {
        var ops = OP_KEYS.map(function(k) { return OP_LABELS[k]; });
        var curIdx = OP_KEYS.indexOf(p.op || "eq");
        if (curIdx < 0) curIdx = 0;
        dialogs.select("运算符（数字全量可用；文字值仅等于）", ops, function(idx) {
            if (idx < 0) return;
            p.op = OP_KEYS[idx];
            dialogs.rawInput("比较值", String(p.value !== undefined ? p.value : ""), function(v) {
                if (v === null) return;
                p.value = String(v);
                item.params = p;
                self.app.saveConfig();
                self.refresh();
            });
        });
    };
    askName();
};

/** JS 条件编辑：代码须 return 布尔值。 */
EventEditScreen.prototype._editJsCond = function(item) {
    var self = this;
    var p = item.params || (item.params = {});
    dialogs.rawInput("JS 代码（须 return true/false；可用 rule.name、vars.get/set/getConfig）", String(p.code || ""), function(code) {
        if (code === null) return;
        p.code = String(code);
        item.params = p;
        self.app.saveConfig();
        self.refresh();
    });
};

// ---------- 取值/变量动作编辑器 ----------

/** 选择目标变量名：预定义（普通变量区）或手动输入。 */
EventEditScreen.prototype._pickVarName = function(title, current, cb) {
    var varCfg = (this.app.config && this.app.config.variables) || {};
    var names = Object.keys(varCfg.runtime || {});
    var self = this;
    var opts = names.concat(["手动输入…"]);
    dialogs.select(title, opts, function(idx) {
        if (idx < 0) return;
        if (idx < names.length) { cb(names[idx]); return; }
        dialogs.rawInput("变量名", String(current || ""), function(v) {
            if (v === null || !String(v).trim()) return;
            cb(String(v).trim());
        });
    });
};

/** OCR 取值：区域 + 是否只取数字 + 目标变量。 */
EventEditScreen.prototype._editOcrRead = function(item) {
    var self = this;
    var p = item.params || (item.params = {});
    var fields = [
        {key: "region", label: "识别区域 x,y,w,h（可空=全屏）", num: false, def: ""},
        {key: "varName", label: "存入变量名", num: false, def: String(p.varName || "")},
        {key: "numberOnly", label: "只提取数字？（如「体力：120」→120）", bool: true, def: p.numberOnly === true}
    ];
    this._formDialog(fields, p, function(np) {
        item.params = np;
        self.app.saveConfig();
        self.refresh();
    });
};

/** 节点取值：按文本/描述找节点 → 文本存入变量。 */
EventEditScreen.prototype._editNodeText = function(item) {
    var self = this;
    var p = item.params || (item.params = {});
    dialogs.select("按什么查找节点", ["文本包含", "描述包含"], function(idx) {
        if (idx < 0) return;
        p.kind = (idx === 1) ? "desc" : "text";
        var fields = [
            {key: "value", label: p.kind === "desc" ? "控件描述（包含匹配）" : "节点文本（包含匹配）", num: false, def: String(p.value || "")},
            {key: "varName", label: "文本存入变量名", num: false, def: String(p.varName || "")}
        ];
        self._formDialog(fields, p, function(np) {
            item.params = np;
            self.app.saveConfig();
            self.refresh();
        });
    });
};

/** 保存坐标：找图 / 找色 / 节点位置 → {x,y,w,h,cx,cy} 存入变量。 */
EventEditScreen.prototype._editSaveCoord = function(item) {
    var self = this;
    var p = item.params || (item.params = {});
    dialogs.select("坐标来源", ["模板图片位置", "颜色位置", "节点位置"], function(idx) {
        if (idx < 0) return;
        if (idx === 0) {
            p.mode = "image";
            var f1 = [
                {key: "path", label: "图片绝对路径", num: false, def: String(p.path || "")},
                {key: "threshold", label: "相似度 0~1（默认0.9）", num: true, def: 0.9},
                {key: "region", label: "搜索区域 x,y,w,h（可空）", num: false, def: String(p.region || "")},
                {key: "varName", label: "坐标存入变量名", num: false, def: String(p.varName || "")}
            ];
            self._formDialog(f1, p, function(np) {
                item.params = np;
                self.app.saveConfig();
                self.refresh();
            });
        } else if (idx === 1) {
            p.mode = "color";
            var f2 = [
                {key: "color", label: "颜色 #RRGGBB", num: false, def: String(p.color || "#FF0000")},
                {key: "threshold", label: "色差阈值 0~255（默认4）", num: true, def: 4},
                {key: "region", label: "搜索区域 x,y,w,h（可空）", num: false, def: String(p.region || "")},
                {key: "varName", label: "坐标存入变量名", num: false, def: String(p.varName || "")}
            ];
            self._formDialog(f2, p, function(np) {
                item.params = np;
                self.app.saveConfig();
                self.refresh();
            });
        } else {
            p.mode = "node";
            dialogs.select("按什么查找节点", ["文本包含", "描述包含"], function(kidx) {
                if (kidx < 0) return;
                p.kind = (kidx === 1) ? "desc" : "text";
                var f3 = [
                    {key: "value", label: p.kind === "desc" ? "控件描述（包含匹配）" : "节点文本（包含匹配）", num: false, def: String(p.value || "")},
                    {key: "varName", label: "坐标存入变量名", num: false, def: String(p.varName || "")}
                ];
                self._formDialog(f3, p, function(np) {
                    item.params = np;
                    self.app.saveConfig();
                    self.refresh();
                });
            });
        }
    });
};

/** 变量赋值：直接输入 / 复制其他变量。 */
EventEditScreen.prototype._editVarSet = function(item) {
    var self = this;
    var p = item.params || (item.params = {src: "literal"});
    this._pickVarName("修改哪个变量", p.name, function(name) {
        p.name = name;
        dialogs.select("赋值方式", ["直接输入值", "复制其他变量"], function(idx) {
            if (idx < 0) return;
            if (idx === 1) {
                p.src = "copy";
                self._pickVarName("复制哪个变量（来源）", String(p.value || "").replace(/^@/, ""), function(src) {
                    p.value = src;
                    item.params = p;
                    self.app.saveConfig();
                    self.refresh();
                });
            } else {
                p.src = "literal";
                dialogs.rawInput("新值（空文本可留空；数字串自动存为数字）", String(p.value !== undefined ? p.value : ""), function(v) {
                    if (v === null) return;
                    p.value = String(v);
                    item.params = p;
                    self.app.saveConfig();
                    self.refresh();
                });
            }
        });
    });
};

/** 变量自增/自减：目标变量 + 步长。 */
EventEditScreen.prototype._editVarStep = function(item) {
    var self = this;
    var p = item.params || (item.params = {});
    this._pickVarName((item.type === "var_inc" ? "自增" : "自减") + "哪个变量", p.name, function(name) {
        p.name = name;
        dialogs.rawInput("步长（数字）", String(p.value !== undefined ? p.value : 1), function(v) {
            if (v === null) return;
            var n = parseFloat(String(v));
            if (!isFinite(n)) { toast("步长需为数字"); return; }
            p.value = n;
            item.params = p;
            self.app.saveConfig();
            self.refresh();
        });
    });
};

/** 变量重置：目标变量。 */
EventEditScreen.prototype._editVarReset = function(item) {
    var self = this;
    var p = item.params || (item.params = {});
    this._pickVarName("重置哪个变量", p.name, function(name) {
        p.name = name;
        item.params = p;
        self.app.saveConfig();
        self.refresh();
    });
};

/** 类型对应的表单字段定义。 */
EventEditScreen.prototype._fieldsOf = function(kind, type) {
    var F = function(key, label, isNum, def) { return {key: key, label: label, num: !!isNum, def: def}; };
    switch (type) {
        case "tap": return [F("x", "X 坐标", true), F("y", "Y 坐标", true)];
        case "long_click": return [F("x", "X", true), F("y", "Y", true), F("duration", "时长 ms", true, 1000)];
        case "swipe": return [F("x1", "起点X", true), F("y1", "起点Y", true), F("x2", "终点X", true), F("y2", "终点Y", true), F("duration", "时长 ms", true, 500)];
        case "text": return [F("content", "输入内容")];
        case "key": return [F("name", "按键(back/home/recents)", false, "back")];
        case "wait": return [F("seconds", "秒数", true, 1)];
        case "log": return [F("content", "日志内容")];
        case "foreground": return [F("pkg", "包名(留空=任意切换)", false, "")];
        case "widget": return [F("text", "控件文本"), F("pkg", "限定包名(可空)", false, "")];
        case "interval": return [F("seconds", "间隔秒", true, 60)];
        case "text_exists": return [F("text", "文本内容")];
        case "widget_exists": return [F("desc", "控件描述")];
        default: return [];
    }
};

/** 顺序表单：逐字段 rawInput；bool 字段用 是/否 选择。 */
EventEditScreen.prototype._formDialog = function(fields, params, onDone) {
    var self = this;
    var idx = 0;
    var result = {};
    var ask = function() {
        if (idx >= fields.length) {
            onDone(result);
            return;
        }
        var f = fields[idx];
        var cur = params[f.key] !== undefined ? params[f.key] : (f.def !== undefined ? f.def : "");
        if (f.bool) {
            dialogs.select(f.label, ["否", "是"], function(sel) {
                if (sel < 0) { ask(); return; }
                result[f.key] = (sel === 1);
                idx++;
                ask();
            });
            return;
        }
        dialogs.rawInput(f.label, String(cur), function(value) {
            try {
                var v = value;
                if (f.num) {
                    v = parseFloat(String(value));
                    if (!isFinite(v)) {
                        toast("[" + f.label + "] 需为数字");
                        ask(); // 重问当前字段
                        return;
                    }
                }
                result[f.key] = v;
                idx++;
                ask();
            } catch (e) { self.app.appendLog("[E] 表单错误: " + e, "error"); }
        });
    };
    ask();
};

/** JS 动作编辑：代码 + 纯计算标记。 */
EventEditScreen.prototype._editScript = function(item) {
    var self = this;
    var isNew = !item;
    item = item || {type: "script", params: {code: "", noUI: false}};
    dialogs.rawInput("JS 代码（可用 rule.name / log() / vars.get/set/getConfig）", String(item.params.code || ""), function(code) {
        if (code === null) return;
        item.params.code = String(code);
        dialogs.select("是否纯计算（不操作界面，不触发抢断）", ["否（默认，含界面操作）", "是（纯计算）"], function(idx) {
            if (idx < 0) idx = 0;
            item.params.noUI = (idx === 1);
            if (isNew) {
                if (!item.params.code.trim()) { toast("代码为空，未添加"); return; }
                self.ev.actions.push(item);
            }
            self.app.saveConfig();
            self.refresh();
        });
    });
};

EventEditScreen.prototype._saveAndBack = function() {
    try {
        var head = this._head;
        if (head && head.evName) {
            var t = String(head.evName.getText());
            if (t.trim()) this.ev.name = t.trim();
        }
        this.app.saveConfig();
    } catch (e) { this.app.appendLog("[E] 保存失败: " + e, "error"); }
    this.onBack();
};

module.exports = EventEditScreen;
