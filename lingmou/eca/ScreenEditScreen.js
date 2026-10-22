/**
 * 灵眸 v4.2 RC13 - 界面编辑页（标识条件 + 事件列表入口）
 */
"use strict";

var EcaConfig = require("./EcaConfig");

var MARKER_LABELS = {text_exists: "文本存在", widget_exists: "控件存在", pkg_match: "包名匹配"};

function escapeXml(s) {
    return String(s === undefined || s === null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/\n/g, "&#10;");
}

function markerSummary(m) {
    var p = m.params || {};
    if (m.type === "text_exists") return "文本「" + (p.text || "") + "」";
    if (m.type === "widget_exists") return "控件「" + (p.desc || "") + "」";
    if (m.type === "pkg_match") return "包名 " + (p.pkg || "");
    return m.type;
}

function ScreenEditScreen(app, screenRef, onBack) {
    this.app = app;
    this.sc = screenRef;
    this.onBack = onBack;
    this.root = null;
}

ScreenEditScreen.prototype.build = function(parent) {
    this.root = ui.inflate('<vertical w="*" h="auto" padding="8"></vertical>', parent, false);
    this.refresh();
    return this.root;
};

ScreenEditScreen.prototype.refresh = function() {
    if (!this.root) return;
    var self = this;
    var sc = this.sc;
    this.root.removeAllViews();

    var head = ui.inflate(
        '<horizontal w="*" h="auto" gravity="center_vertical">' +
        '<button id="btnBack" text="← 返回" textSize="11sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<input id="scName" text="' + escapeXml(sc.name) + '" textSize="12sp" layout_weight="1" textColor="#FFB74D"/>' +
        '<Switch id="scEnabled" checked="' + (sc.enabled !== false) + '"/>' +
        '</horizontal>', this.root, false);
    this._head = head;
    head.btnBack.on("click", function() { self._saveAndBack(); });
    head.scEnabled.on("check", function(checked) { sc.enabled = !!checked; });
    this.root.addView(head);

    this.root.addView(ui.inflate(
        '<text text="标识条件（全部成立时命中此界面）" textSize="12sp" textColor="#4FC3F7" textStyle="bold" marginTop="10" marginBottom="2"/>',
        this.root, false));

    for (var i = 0; i < sc.markers.length; i++) {
        this._markerRow(sc.markers, i);
    }
    if (!sc.markers.length) {
        this.root.addView(ui.inflate('<text text="（无标识条件，建议至少一条）" textSize="10sp" textColor="#FF7043" padding="4"/>', this.root, false));
    }

    var addM = ui.inflate('<button text="＋ 添加标识条件" textSize="11sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Borderless.Colored"/>', this.root, false);
    addM.on("click", function() { self._addMarker(); });
    this.root.addView(addM);

    this.root.addView(ui.inflate(
        '<text text="界面事件（' + sc.events.length + ' 条，返回主界面编辑）" textSize="12sp" textColor="#4FC3F7" textStyle="bold" marginTop="12" marginBottom="2"/>',
        this.root, false));

    var del = ui.inflate('<button text="删除此界面" textSize="11sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Colored"/>', this.root, false);
    del.on("click", function() { self._deleteScreen(); });
    this.root.addView(del);

    this.root.addView(ui.inflate('<text text=" " textSize="8sp"/>', this.root, false));
};

ScreenEditScreen.prototype._markerRow = function(arr, idx) {
    var self = this;
    var m = arr[idx];
    var row = ui.inflate(
        '<horizontal w="*" h="auto" bg="#252526" padding="6 3" marginTop="1">' +
        '<text text="' + escapeXml((MARKER_LABELS[m.type] || m.type) + " " + markerSummary(m)) + '" textSize="11sp" textColor="#DDDDDD" layout_weight="1"/>' +
        '<button id="rowDel" text="✕" textSize="9sp" minWidth="0dp" minHeight="0dp" padding="4" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '</horizontal>', this.root, false);
    row.rowDel.on("click", function() { arr.splice(idx, 1); self.refresh(); });
    row.on("click", function() { self._editMarker(m); });
    this.root.addView(row);
};

ScreenEditScreen.prototype._addMarker = function() {
    var self = this;
    var types = ["text_exists", "widget_exists", "pkg_match"];
    var labels = types.map(function(t) { return MARKER_LABELS[t]; });
    dialogs.select("标识条件类型", labels, function(idx) {
        if (idx < 0) return;
        var m = {type: types[idx], params: {}};
        self.sc.markers.push(m);
        self._editMarker(m);
    });
};

ScreenEditScreen.prototype._editMarker = function(m) {
    var self = this;
    var field = m.type === "text_exists" ? "文本内容"
              : m.type === "widget_exists" ? "控件描述"
              : "包名（如 com.tencent.mm）";
    var key = m.type === "text_exists" ? "text" : m.type === "widget_exists" ? "desc" : "pkg";
    var cur = m.params[key] !== undefined ? m.params[key] : "";
    dialogs.rawInput(field, String(cur), function(value) {
        if (value === null) return;
        m.params[key] = String(value);
        self.app.saveConfig();
        self.refresh();
    });
};

ScreenEditScreen.prototype._deleteScreen = function() {
    var self = this;
    var sc = this.sc;
    dialogs.confirm("删除界面", "确认删除 [" + sc.name + "] 及其 " + sc.events.length + " 条事件？", function(yes) {
        if (!yes) return;
        var screens = self.app.config.screens;
        for (var i = 0; i < screens.length; i++) {
            if (screens[i] === sc) { screens.splice(i, 1); break; }
        }
        self.app.saveConfig();
        self.app.appendLog("已删除界面: " + sc.name);
        self.onBack();
    });
};

ScreenEditScreen.prototype._saveAndBack = function() {
    try {
        var head = this._head;
        var scName = head && head.scName;
        if (scName) {
            var t = String(scName.getText());
            if (t.trim()) this.sc.name = t.trim();
        }
        this.app.saveConfig();
    } catch (e) { this.app.appendLog("[E] 保存失败: " + e, "error"); }
    this.onBack();
};

module.exports = ScreenEditScreen;
