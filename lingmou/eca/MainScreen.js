/**
 * 灵眸 v4.2 RC13 - 主界面（4 层列表）
 * L1 通用 / L2 自定义界面（可折叠）/ L4 默认界面 / L5 通用低
 */
"use strict";

var EcaConfig = require("./EcaConfig");

var LAYER_DEFS = [
    {key: "topEvents",    label: "通用事件",   hint: "每轮最先强制检查（L1）"},
    {key: "screens",      label: "自定义界面", hint: "按标识条件命中（L2）"},
    {key: "defaultEvents", label: "默认界面",  hint: "前序全部无执行时进入（L4）"},
    {key: "lowEvents",    label: "通用事件（低）", hint: "L4 之后兜底（L5）"}
];

var TRIGGER_LABELS = {foreground: "进入界面", widget: "控件出现", interval: "定时"};

function escapeXml(s) {
    return String(s === undefined || s === null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/\n/g, "&#10;");
}

function triggerSummary(ev) {
    var t = ev.trigger || {};
    var label = TRIGGER_LABELS[t.type] || t.type;
    if (t.type === "foreground" && t.params && t.params.pkg) label += ":" + t.params.pkg;
    if (t.type === "widget" && t.params && t.params.text) label += "「" + t.params.text + "」";
    if (t.type === "interval" && t.params && t.params.seconds) label += " " + t.params.seconds + "s";
    return label;
}

function MainScreen(app) {
    this.app = app;
    this.root = null;
    this._collapsed = {};
}

MainScreen.prototype.build = function(parent) {
    this.root = ui.inflate(
        '<vertical w="*" h="auto"></vertical>', parent, false);
    return this.root;
};

MainScreen.prototype.refresh = function() {
    if (!this.root) return;
    this.root.removeAllViews();
    var cfg = this.app.config;
    for (var i = 0; i < LAYER_DEFS.length; i++) {
        this._renderLayer(this.root, LAYER_DEFS[i], cfg);
    }
    var tip = ui.inflate('<text text="上移/下移调整顺序；点击条目进入编辑" textSize="10sp" textColor="#666666" padding="8 4 16 4"/>', this.root, false);
    this.root.addView(tip);
};

/** 渲染一个层分区。 */
MainScreen.prototype._renderLayer = function(parent, def, cfg) {
    var self = this;
    var header = ui.inflate(
        '<horizontal w="*" h="auto" bg="#333333" padding="8 6">' +
        '<text text="' + escapeXml(def.label) + '" textSize="12sp" textColor="#4FC3F7" textStyle="bold" layout_weight="1"/>' +
        '<text text="' + escapeXml(def.hint) + '" textSize="9sp" textColor="#777777" margin="4"/>' +
        '</horizontal>', parent, false);
    parent.addView(header);

    if (def.key === "screens") {
        this._renderScreens(parent, cfg);
        return;
    }

    var events = cfg[def.key] || [];
    for (var i = 0; i < events.length; i++) {
        this._renderEventRow(parent, events, i, def.key);
    }
    if (!events.length) {
        parent.addView(ui.inflate('<text text="（空）" textSize="10sp" textColor="#555555" padding="12 2"/>', parent, false));
    }
    this._addAddButton(parent, def.key, null);
};

/** 渲染事件条目。 */
MainScreen.prototype._renderEventRow = function(parent, arr, idx, layerKey, screenRef) {
    var self = this;
    var ev = arr[idx];
    var where = screenRef ? ("界面[" + screenRef.name + "] ") : "";
    var row = ui.inflate(
        '<horizontal w="*" h="auto" bg="#252526" padding="8 4" marginTop="1">' +
        '<vertical layout_weight="1">' +
        '<text text="' + escapeXml(where + ev.name) + '" textSize="12sp" textColor="#DDDDDD"/>' +
        '<text text="' + escapeXml(triggerSummary(ev) + " | " + ev.actions.length + " 动作" + (ev.lastRun ? " | 上次:" + (ev.lastRun.ok ? "成功" : "失败") : "")) + '" textSize="9sp" textColor="#888888"/>' +
        '</vertical>' +
        '<button id="rowUp" text="↑" textSize="10sp" minWidth="0dp" minHeight="0dp" padding="6" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<button id="rowDown" text="↓" textSize="10sp" minWidth="0dp" minHeight="0dp" padding="6" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<button id="rowDel" text="✕" textSize="10sp" minWidth="0dp" minHeight="0dp" padding="6" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<Switch id="rowEnabled" checked="' + (ev.enabled !== false) + '" padding="2"/>' +
        '</horizontal>', parent, false);

    row.rowUp.on("click", function() { self._move(arr, idx, -1); });
    row.rowDown.on("click", function() { self._move(arr, idx, 1); });
    row.rowDel.on("click", function() { self._removeEvent(arr, idx); });
    row.rowEnabled.on("check", function(checked) {
        ev.enabled = !!checked;
        self.app.saveConfig();
    });
    // 点击条目主体进编辑
    row.on("click", function() {
        self.app.showEventEdit(ev, layerKey, screenRef, function() { self.app.saveConfig(); });
    });
    parent.addView(row);
};

/** 渲染 L2 界面分组。 */
MainScreen.prototype._renderScreens = function(parent, cfg) {
    var self = this;
    var screens = cfg.screens || [];
    for (var i = 0; i < screens.length; i++) {
        this._renderScreenGroup(parent, screens, i);
    }
    if (!screens.length) {
        parent.addView(ui.inflate('<text text="（未定义界面）" textSize="10sp" textColor="#555555" padding="12 2"/>', parent, false));
    }
    // 添加界面
    var addSc = ui.inflate('<button text="＋ 添加界面" textSize="11sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Borderless.Colored"/>', parent, false);
    addSc.on("click", function() { self._addScreen(); });
    parent.addView(addSc);
};

MainScreen.prototype._renderScreenGroup = function(parent, arr, idx) {
    var self = this;
    var sc = arr[idx];
    var collapsed = this._collapsed[sc.id] === true;
    var markerSummary = sc.markers.length
        ? sc.markers.map(function(m) {
            if (m.type === "text_exists") return "文本「" + m.params.text + "」";
            if (m.type === "widget_exists") return "控件「" + m.params.desc + "」";
            if (m.type === "pkg_match") return "包名" + m.params.pkg;
            return m.type;
        }).join(" 且 ")
        : "（无标识）";

    var header = ui.inflate(
        '<horizontal w="*" h="auto" bg="#2A2A2A" padding="8 4" marginTop="2">' +
        '<button id="toggle" text="' + (collapsed ? "▶" : "▼") + '" textSize="10sp" minWidth="0dp" minHeight="0dp" padding="4" style="Widget.AppCompat.Button.Borderless"/>' +
        '<vertical layout_weight="1">' +
        '<text text="' + escapeXml(sc.name) + '" textSize="12sp" textColor="#FFB74D" textStyle="bold"/>' +
        '<text text="' + escapeXml("标识: " + markerSummary + " | " + sc.events.length + " 事件") + '" textSize="9sp" textColor="#888888"/>' +
        '</vertical>' +
        '<button id="rowUp" text="↑" textSize="10sp" minWidth="0dp" minHeight="0dp" padding="6" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<button id="rowDown" text="↓" textSize="10sp" minWidth="0dp" minHeight="0dp" padding="6" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<Switch id="rowEnabled" checked="' + (sc.enabled !== false) + '" padding="2"/>' +
        '</horizontal>', parent, false);

    var self = this;
    header.toggle.on("click", function() {
        self._collapsed[sc.id] = !collapsed;
        self.refresh();
    });
    header.rowUp.on("click", function() { self._move(arr, idx, -1); });
    header.rowDown.on("click", function() { self._move(arr, idx, 1); });
    header.rowEnabled.on("check", function(checked) {
        sc.enabled = !!checked;
        self.app.saveConfig();
    });
    // 点击名称区进界面编辑
    header.on("click", function() {
        self.app.showScreenEdit(sc, function() { self.app.saveConfig(); });
    });
    parent.addView(header);

    if (collapsed) return;

    for (var e = 0; e < sc.events.length; e++) {
        this._renderEventRow(parent, sc.events, e, "screens", sc);
    }
    if (!sc.events.length) {
        parent.addView(ui.inflate('<text text="（无事件）" textSize="10sp" textColor="#555555" padding="12 2"/>', parent, false));
    }
    this._addAddButton(parent, "screens", sc);
};

MainScreen.prototype._addAddButton = function(parent, layerKey, screenRef) {
    var self = this;
    var btn = ui.inflate('<button text="＋ 添加事件" textSize="11sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Borderless.Colored"/>', parent, false);
    btn.on("click", function() { self._addEvent(layerKey, screenRef); });
    parent.addView(btn);
};

// ---------- 编辑操作 ----------

MainScreen.prototype._addEvent = function(layerKey, screenRef) {
    var self = this;
    dialogs.rawInput("事件名称", "新事件", function(value) {
        try {
            var name = (typeof value === "string" && value.trim()) ? value.trim() : "新事件";
            var ev = EcaConfig.newEvent(name);
            var target = screenRef ? screenRef.events : self.app.config[layerKey];
            target.push(ev);
            self.app.saveConfig();
            self.refresh();
            self.app.appendLog("添加事件: " + name + (screenRef ? " @界面[" + screenRef.name + "]" : ""));
        } catch (e) { self.app.appendLog("[E] 添加事件失败: " + e, "error"); }
    });
};

MainScreen.prototype._addScreen = function() {
    var self = this;
    dialogs.rawInput("界面名称", "新界面", function(value) {
        try {
            var name = (typeof value === "string" && value.trim()) ? value.trim() : "新界面";
            var sc = EcaConfig.newScreen(name);
            self.app.config.screens.push(sc);
            self.app.saveConfig();
            self.refresh();
            self.app.appendLog("添加界面: " + name + "（请设置标识条件）");
        } catch (e) { self.app.appendLog("[E] 添加界面失败: " + e, "error"); }
    });
};

MainScreen.prototype._removeEvent = function(arr, idx) {
    var self = this;
    var ev = arr[idx];
    dialogs.confirm("删除事件", "确认删除 [" + ev.name + "]？", function(yes) {
        if (!yes) return;
        arr.splice(idx, 1);
        self.app.saveConfig();
        self.refresh();
        self.app.appendLog("已删除事件: " + ev.name);
    });
};

MainScreen.prototype._move = function(arr, idx, delta) {
    var ni = idx + delta;
    if (ni < 0 || ni >= arr.length) return;
    var t = arr[idx];
    arr[idx] = arr[ni];
    arr[ni] = t;
    this.app.saveConfig();
    this.refresh();
};

module.exports = MainScreen;
