"ui";
/**
 * 灵眸 v4.2 RC13 - ECA Studio 入口
 * 4 层列表首页 + 事件/界面编辑页 + 底部日志 + 引擎启停。
 * AutoX.js v7 UI 模式。
 */
"use strict";

var EcaConfig = require("./EcaConfig");
var EcaEngine = require("./EcaEngine");
var MainScreen = require("./MainScreen");
var EventEditScreen = require("./EventEditScreen");
var ScreenEditScreen = require("./ScreenEditScreen");
var VariableScreen = require("./VariableScreen");
var VariableStore = require("./VariableStore");
var ImageService = require("./ImageService");
var FloatyBall = require("./FloatyBall");
var EditorScreen = require("./editor/EditorScreen");
var EditorTray = require("./editor/EditorTray");

ui.layout(
    <vertical bg="#1E1E1E">
        <horizontal bg="#2D2D30" gravity="center_vertical" w="*" h="44dp">
            <text text="灵眸 ECA" textSize="14sp" textColor="#4FC3F7" margin="8" textStyle="bold"/>
            <text id="modeView" text="顺序模式" textSize="11sp" textColor="#888888" margin="4"/>
            <vertical layout_weight="1"/>
            <button id="btnEditor" text="编辑器" textSize="12sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Borderless.Colored"/>
            <button id="btnVars" text="变量" textSize="12sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Borderless.Colored"/>
            <button id="btnMode" text="模式" textSize="12sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Borderless.Colored"/>
            <button id="btnStart" text="启动" textSize="12sp" minWidth="0dp" minHeight="0dp" padding="8" style="Widget.AppCompat.Button.Colored"/>
        </horizontal>
        <scroll w="*" h="0dp" layout_weight="1">
            <vertical id="screenContainer" w="*" h="auto"/>
        </scroll>
        <horizontal w="*" h="auto" bg="#1A1A1A">
            <button id="btnLogToggle" text="日志" textSize="10sp" minWidth="0dp" minHeight="0dp" padding="6" style="Widget.AppCompat.Button.Borderless.Colored"/>
            <button id="btnLogClear" text="清空" textSize="10sp" minWidth="0dp" minHeight="0dp" padding="6" style="Widget.AppCompat.Button.Borderless.Colored"/>
            <text id="engineState" text="已停止" textSize="10sp" textColor="#777777" margin="8"/>
        </horizontal>
        <vertical id="logPanel" w="*" h="130dp" bg="#1A1A1A">
            <scroll id="logScroll" w="*" h="*">
                <text id="logView" w="*" h="auto" textSize="10sp" textColor="#CCCCCC" padding="6"/>
            </scroll>
        </vertical>
    </vertical>
);

// ---------- 应用装配 ----------

function StudioApp() {
    this.config = null;
    this.engine = null;
    this.variableStore = null;
    this.imageService = null;
    this.floatyBall = null;
    this._logLines = [];
    this._logPaused = false;
    this.mainScreen = null;
}

StudioApp.prototype.appendLog = function(msg, level) {
    var self = this;
    if (this.floatyBall) this.floatyBall.log(msg, level);
    if (this._logPaused) return;
    var line = "[" + new Date().toLocaleTimeString() + "]" + (level === "error" ? "[E]" : level === "warn" ? "[W]" : "") + " " + String(msg);
    this._logLines.push(line);
    if (this._logLines.length > 200) this._logLines.shift();
    ui.run(function() {
        try {
            ui.logView.setText(self._logLines.join("\n"));
            try { ui.logScroll.fullScroll(android.view.View.FOCUS_DOWN); } catch (e2) {}
        } catch (e) {}
    });
};

StudioApp.prototype.start = function() {
    var self = this;
    var loaded = EcaConfig.load();
    this.config = loaded.config;
    if (!loaded.ok || loaded.message === "空配置") {
        this.appendLog(loaded.ok ? "无配置文件，使用空配置" : loaded.message);
    }

    this.variableStore = new VariableStore();
    this.variableStore.sync(this.config.variables);
    this.imageService = new ImageService({
        logger: function(msg, level) { self.appendLog(msg, level); }
    });

    this.engine = new EcaEngine({
        logger: function(msg, level) { self.appendLog(msg, level); },
        imageService: this.imageService,
        variableStore: this.variableStore
    });
    this.engine.setConfig(this.config);

    this._initFloatyBall();
    this._initEditorTray();
    this._wireToolbar();
    this.showMain();
    this.appendLog("灵眸 ECA Studio v4.2 RC13 启动");
    this.appendLog("顺序：通用→界面→通用低→默认");
    return true;
};

/** 编辑器任务托盘（灰=停止 绿=运行）。 */
StudioApp.prototype._initEditorTray = function() {
    var self = this;
    try {
        this.editorTray = new EditorTray({
            logger: function(msg, level) { self.appendLog(msg, level); },
            onRun: function() {
                if (self.editorScreen) self.editorScreen.runTask();
                else self.appendLog("[编辑器] 请先进入编辑器页导入任务", "warn");
            },
            onStop: function() {
                if (self.editorScreen) self.editorScreen.stopTask();
            }
        });
        this.editorTray.show();
    } catch (e) {
        this.editorTray = null;
        this.appendLog("[W] 编辑器托盘创建失败（检查悬浮窗权限）: " + e, "warn");
    }
};

/** 创建悬浮球控制台（小圆点：灰=停止 绿=运行 黄=暂停）。 */
StudioApp.prototype._initFloatyBall = function() {
    var self = this;
    try {
        this.floatyBall = new FloatyBall({
            engine: this.engine,
            logger: function(msg, level) { self.appendLog(msg, level); },
            openEditor: function() { self._bringToFront(); }
        });
        this.floatyBall.show();
    } catch (e) {
        this.floatyBall = null;
        this.appendLog("[W] 悬浮球创建失败（检查悬浮窗权限）: " + e, "warn");
    }
};

/** 把编辑器界面拉到前台（悬浮球"详情"按钮）。失败原因写日志便于真机排查。 */
StudioApp.prototype._bringToFront = function() {
    var self = this;
    ui.run(function() {
        try {
            if (typeof activity === "undefined" || !activity) {
                toast("编辑器界面未就绪，请从最近任务打开");
                return;
            }
            var Intent = android.content.Intent;
            var it = new Intent(context, activity.getClass());
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            context.startActivity(it);
        } catch (e) {
            toast("拉起编辑器失败，请从最近任务打开");
            self.appendLog("[W] 拉起编辑器失败: " + e, "warn");
        }
    });
};

StudioApp.prototype._wireToolbar = function() {
    var self = this;

    ui.btnStart.on("click", function() {
        try {
            if (self.engine.isRunning()) {
                self.engine.stop();
                self.appendLog("停止请求已发出");
            } else {
                if (self.engine.start()) {
                    self.appendLog("引擎启动（" + (self.config.runMode === "single" ? "单事件" : "顺序") + "模式）");
                }
            }
        } catch (e) { self.appendLog("[E] 启停失败: " + e, "error"); }
    });

    ui.btnMode.on("click", function() {
        try {
            dialogs.select("运行模式", ["顺序模式（流水线）", "单事件模式（抢断）"], function(idx) {
                if (idx < 0) return;
                var mode = idx === 1 ? "single" : "sequence";
                self.config.runMode = mode;
                EcaConfig.save(self.config);
                self._refreshModeView();
                self.appendLog("运行模式已切换为 " + (mode === "single" ? "单事件（下一轮生效）" : "顺序（下一轮生效）"));
            });
        } catch (e) { self.appendLog("[E] 模式切换失败: " + e, "error"); }
    });

    ui.btnVars.on("click", function() {
        try { self.showVariableScreen(); } catch (e) { self.appendLog("[E] 打开变量页失败: " + e, "error"); }
    });

    ui.btnEditor.on("click", function() {
        try { self.showEditor(); } catch (e) { self.appendLog("[E] 打开编辑器页失败: " + e, "error"); }
    });

    ui.btnLogToggle.on("click", function() {
        self._logPaused = !self._logPaused;
        ui.btnLogToggle.setText(self._logPaused ? "恢复" : "日志");
    });
    ui.btnLogClear.on("click", function() {
        self._logLines = [];
        ui.run(function() { try { ui.logView.setText(""); } catch (e) {} });
    });
};

StudioApp.prototype._refreshModeView = function() {
    var self = this;
    ui.run(function() {
        try {
            var st = self.engine.getStatus();
            ui.modeView.setText(st === "paused" ? "已暂停" : (self.config.runMode === "single" ? "单事件模式" : "顺序模式"));
            ui.btnStart.setText(st === "stopped" ? "启动" : "停止");
            ui.engineState.setText(st === "running" ? "运行中" : st === "paused" ? "已暂停" : "已停止");
        } catch (e) {}
    });
};

/** 引擎状态轮询刷新（按钮/状态文案）。 */
StudioApp.prototype.startStatePolling = function() {
    var self = this;
    var t = setInterval(function() { self._refreshModeView(); }, 1000);
    events.on("exit", function() { clearInterval(t); });
};

// ---------- 屏幕切换 ----------

StudioApp.prototype._setScreen = function(node) {
    var c = ui.screenContainer;
    c.removeAllViews();
    c.addView(node);
};

StudioApp.prototype.showMain = function() {
    var self = this;
    if (!this.mainScreen) {
        this.mainScreen = new MainScreen(this);
    }
    this._setScreen(this.mainScreen.build(ui.screenContainer));
    this.mainScreen.refresh();
};

StudioApp.prototype.showEventEdit = function(eventRef, layerKey, screenRef, onBack) {
    var self = this;
    var editor = new EventEditScreen(this, eventRef, layerKey, screenRef, function() {
        self.showMain();
        if (onBack) onBack();
    });
    this._setScreen(editor.build(ui.screenContainer));
};

StudioApp.prototype.showScreenEdit = function(screenRef, onBack) {
    var self = this;
    var editor = new ScreenEditScreen(this, screenRef, function() {
        self.showMain();
        if (onBack) onBack();
    });
    this._setScreen(editor.build(ui.screenContainer));
};

StudioApp.prototype.showVariableScreen = function() {
    var self = this;
    var editor = new VariableScreen(this, function() {
        self.showMain();
    });
    this._setScreen(editor.build(ui.screenContainer));
};

StudioApp.prototype.showEditor = function() {
    var self = this;
    this.editorScreen = new EditorScreen(this, function() {
        self.showMain();
    });
    this._setScreen(this.editorScreen.build(ui.screenContainer));
    this.editorScreen.refresh();
};

StudioApp.prototype.saveConfig = function() {
    var res = EcaConfig.save(this.config);
    if (!res.ok) this.appendLog("[E] 保存失败: " + res.message, "error");
    return res.ok;
};

/** 变量定义变更后同步引擎存储（活跃运行值保留，仅补新增/清删除）。 */
StudioApp.prototype.syncVariables = function() {
    if (this.variableStore && this.config) {
        this.variableStore.sync(this.config.variables);
    }
};

var app = new StudioApp();
app.start();
app.startStatePolling();

events.on("exit", function() {
    try { if (app.floatyBall) app.floatyBall.hide(); } catch (e) {}
    try { if (app.editorTray) app.editorTray.hide(); } catch (e) {}
    try { if (app.editorScreen && app.editorScreen._server) app.editorScreen._server.stop(); } catch (e) {}
    try { if (app.editorScreen) app.editorScreen.stopTask(); } catch (e) {}
    try { if (app.engine) app.engine.stop(); } catch (e) {}
    try { if (app.imageService) app.imageService.dispose(); } catch (e) {}
});
