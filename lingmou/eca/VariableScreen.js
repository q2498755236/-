/**
 * 灵眸 v4.2 RC13 - 变量管理页
 * 普通变量（运行时 JS 可写，此处编辑初始值）/ 配置变量（运行时只读）。
 * 存于 config.variables.{runtime, config}；保存后同步引擎 VariableStore。
 */
"use strict";

function escapeXml(s) {
    return String(s === undefined || s === null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/\n/g, "&#10;");
}

function VariableScreen(app, onBack) {
    this.app = app;
    this.onBack = onBack;
    this.root = null;
}

VariableScreen.prototype.build = function(parent) {
    this.root = ui.inflate('<vertical w="*" h="auto" padding="8"></vertical>', parent, false);
    this.refresh();
    return this.root;
};

VariableScreen.prototype.refresh = function() {
    if (!this.root) return;
    var self = this;
    this.root.removeAllViews();

    var head = ui.inflate(
        '<horizontal w="*" h="auto" gravity="center_vertical">' +
        '<button id="btnBack" text="← 返回" textSize="11sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
        '<text text="变量管理" textSize="13sp" textColor="#4FC3F7" textStyle="bold" margin="6"/>' +
        '</horizontal>', this.root, false);
    head.btnBack.on("click", function() { self._back(); });
    this.root.addView(head);

    var vars = this._vars();
    this._section("普通变量（初始值；运行时 JS 动作可写 vars.set）");
    this._renderMap(vars.runtime, "runtime");
    this._addBtn("＋ 添加普通变量", function() { self._editVar("runtime", null); });

    this._section("配置变量（运行时只读，JS 仅可 getConfig）");
    this._renderMap(vars.config, "config");
    this._addBtn("＋ 添加配置变量", function() { self._editVar("config", null); });

    this.root.addView(ui.inflate(
        '<text text="普通变量被 JS 改写后的值保存在内存，重启 Studio 后回到初始值" textSize="9sp" textColor="#777777" padding="8 4"/>',
        this.root, false));
};

VariableScreen.prototype._vars = function() {
    var cfg = this.app.config;
    if (!cfg.variables) cfg.variables = {runtime: {}, config: {}};
    if (!cfg.variables.runtime) cfg.variables.runtime = {};
    if (!cfg.variables.config) cfg.variables.config = {};
    return cfg.variables;
};

VariableScreen.prototype._section = function(title) {
    this.root.addView(ui.inflate(
        '<text text="' + escapeXml(title) + '" textSize="12sp" textColor="#4FC3F7" textStyle="bold" marginTop="12" marginBottom="2"/>',
        this.root, false));
};

VariableScreen.prototype._addBtn = function(label, handler) {
    var btn = ui.inflate('<button text="' + escapeXml(label) + '" textSize="11sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Borderless.Colored"/>', this.root, false);
    btn.on("click", handler);
    this.root.addView(btn);
};

VariableScreen.prototype._renderMap = function(map, ns) {
    var self = this;
    var names = Object.keys(map);
    if (!names.length) {
        this.root.addView(ui.inflate('<text text="（空）" textSize="10sp" textColor="#555555" padding="12 2"/>', this.root, false));
        return;
    }
    for (var i = 0; i < names.length; i++) {
        (function(name) {
            var v = map[name];
            var shown = (v === "" || v === undefined) ? "(空文本)" : String(v);
            var row = ui.inflate(
                '<horizontal w="*" h="auto" bg="#252526" padding="8 4" marginTop="1">' +
                '<text text="' + escapeXml(name + " = " + shown) + '" textSize="12sp" textColor="#DDDDDD" layout_weight="1"/>' +
                '<button id="rowDel" text="✕" textSize="9sp" minWidth="0dp" minHeight="0dp" padding="4" style="Widget.AppCompat.Button.Borderless.Colored"/>' +
                '</horizontal>', this.root, false);
            row.rowDel.on("click", function() {
                delete map[name];
                self._save();
                self.refresh();
            });
            row.on("click", function() { self._editVar(ns, name); });
            this.root.addView(row);
        }).call(this, names[i]);
    }
};

/** 编辑/新增变量：问名 → 问值。 */
VariableScreen.prototype._editVar = function(ns, name) {
    var self = this;
    var map = this._vars()[ns];
    var askName = function(cur) {
        dialogs.rawInput(ns === "config" ? "配置变量名" : "普通变量名", String(cur || ""), function(v) {
            if (v === null) return;
            var n = String(v).trim();
            if (!n) { toast("变量名不能为空"); return; }
            askValue(n);
        });
    };
    var askValue = function(n) {
        var cur = map[n] !== undefined ? map[n] : "";
        var prefill = (cur === "" || cur === undefined) ? "" : String(cur);
        var commit = function(s) {
            // 空输入存空文本 ""，与数字 0 严格区分；纯数字串存 number
            map[n] = (s.trim() !== "" && isFinite(Number(s))) ? Number(s) : s;
            self._save();
            self.refresh();
        };
        dialogs.rawInput("默认值（不填=空文本；0=数字零）", prefill, function(v) {
            if (v === null || v === undefined) {
                // 兼容部分版本空输入确认返回 null：确认后仍可建空文本变量
                dialogs.confirm("默认值", "将默认值设为空文本？\n（空文本仅支持等于判断；数字 0 支持全运算符）", function(yes) {
                    if (yes) commit("");
                });
                return;
            }
            commit(String(v));
        });
    };
    askName(name);
};

VariableScreen.prototype._save = function() {
    this.app.saveConfig();
    if (this.app.syncVariables) this.app.syncVariables();
};

VariableScreen.prototype._back = function() {
    this.onBack();
};

module.exports = VariableScreen;
