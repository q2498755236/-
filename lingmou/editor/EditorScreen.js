/**
 * 灵眸 v4.3 - 编辑器复刻层: 任务页面 (编辑器风格)
 * 功能: .auto 任务列表 / 导入解析 / 统计展示 / 运行停止 / 控制口开关
 * 组装链: AutoTask -> EditorVars -> AutoBridge -> JsPluginHost -> EditorRuntime -> EditorServer
 * 页面复刻自动化编辑器首页结构 (任务卡片列表), 细节样式待真机截图精修。
 */
"use strict";

var AutoTask = require("./AutoTask.js");
var EditorVars = require("./EditorVars.js");
var AutoBridge = require("./AutoBridge.js");
var JsPluginHost = require("./JsPluginHost.js");
var EditorRuntime = require("./EditorRuntime.js");
var EditorServer = require("./EditorServer.js");

function escapeXml(s) {
    return String(s === undefined || s === null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function EditorScreen(app, onBack) {
    this.app = app;
    this.onBack = typeof onBack === "function" ? onBack : function() {};
    this.root = null;
    this._task = null;          // AutoTask 实例 (含 model)
    this._runtime = null;
    this._server = null;
    this._running = false;
    this._loadedName = "";
}

EditorScreen.prototype.build = function(parent) {
    this.root = ui.inflate(
        '<vertical w="*" h="auto" padding="8">' +
            '<horizontal w="*" h="auto" gravity="center_vertical" marginBottom="6">' +
                '<text id="btnBack" text="←" textSize="16sp" textColor="#FFFFFF" bg="#3A3A3A" w="36dp" h="30dp" gravity="center"/>' +
                '<text text="自动化任务 (.auto)" textSize="14sp" textColor="#FFFFFF" layout_weight="1" padding="8 0"/>' +
                '<text id="btnServer" text="控制口" textSize="11sp" textColor="#FFFFFF" bg="#2E4A5B" w="64dp" h="28dp" gravity="center"/>' +
            '</horizontal>' +
            '<vertical id="infoBox" w="*" h="auto" bg="#262626" padding="8" marginBottom="6" visibility="gone">' +
                '<text id="infoTitle" text="-" textSize="12sp" textColor="#FFFFFF"/>' +
                '<text id="infoStat" text="-" textSize="10sp" textColor="#999999"/>' +
                '<horizontal marginTop="6">' +
                    '<text id="btnRun" text="运行" textSize="12sp" textColor="#FFFFFF" bg="#2E5B2E" w="72dp" h="32dp" gravity="center" marginRight="6"/>' +
                    '<text id="btnStop" text="停止" textSize="12sp" textColor="#FFFFFF" bg="#5B2E2E" w="72dp" h="32dp" gravity="center"/>' +
                '</horizontal>' +
            '</vertical>' +
            '<scroll w="*" h="auto" fillViewport="true">' +
                '<vertical id="taskList" w="*" h="auto"></vertical>' +
            '</scroll>' +
        '</vertical>', parent, false);
    var self = this;
    this.root.btnBack.on("click", function() { self.onBack(); });
    this.root.btnRun.on("click", function() { self.runTask(); });
    this.root.btnStop.on("click", function() { self.stopTask(); });
    this.root.btnServer.on("click", function() { self.toggleServer(); });
    return this.root;
};

EditorScreen.prototype.refresh = function() {
    if (!this.root) return;
    var list = this.root.taskList;
    list.removeAllViews();
    var files = this._listAutoFiles();
    var self = this;
    if (!files.length) {
        var empty = ui.inflate('<text text="暂无 .auto 任务。将编辑器导出的 .auto 放入 ' +
            escapeXml(this._tasksRoot()) + ' 后刷新。" textSize="11sp" textColor="#888888" padding="8"/>', list, false);
        list.addView(empty);
        return;
    }
    for (var i = 0; i < files.length; i++) {
        list.addView(this._buildTaskCard(list, files[i]));
    }
};

EditorScreen.prototype._tasksRoot = function() {
    return (this.app.config && this.app.config.editorTasksRoot) || "/sdcard/灵眸/auto";
};

EditorScreen.prototype._listAutoFiles = function() {
    var root = this._tasksRoot();
    try {
        if (typeof files !== "undefined" && files.isDir(root)) {
            return files.listDir(root, function(name) { return /\.auto$/i.test(name); }).sort();
        }
    } catch (e) {
        this.app.appendLog("[编辑器] 任务目录读取失败: " + e, "warn");
    }
    return [];
};

EditorScreen.prototype._buildTaskCard = function(parent, fileName) {
    var self = this;
    var selected = this._loadedName === fileName;
    var card = ui.inflate(
        '<horizontal w="*" h="auto" bg="#262626" padding="10 8" marginBottom="4">' +
            '<vertical layout_weight="1" w="0" h="auto">' +
                '<text text="' + escapeXml(fileName) + '" textSize="12sp" textColor="' +
                    (selected ? "#4CAF50" : "#DDDDDD") + '"/>' +
                '<text id="sub" text="点击导入解析" textSize="10sp" textColor="#888888"/>' +
            '</vertical>' +
        '</horizontal>', parent, false);
    card.on("click", function() { self.importTask(fileName, card); });
    return card;
};

/** 导入 .auto: 解包 + 解析 + 统计。 */
EditorScreen.prototype.importTask = function(fileName, card) {
    var path = this._tasksRoot() + "/" + fileName;
    var task = new AutoTask({ logger: function(m, lv) { this.app.appendLog(m, lv === "error" ? "error" : undefined); }.bind(this) });
    var r = task.parse(path, this._tasksRoot() + "/extracted");
    if (!r.ok) {
        this.app.appendLog("[编辑器] 导入失败: " + r.message, "error");
        if (typeof toast === "function") toast("导入失败: " + r.message);
        return;
    }
    this._task = task;
    this._loadedName = fileName;
    // 组装运行链
    var vars = new EditorVars();
    var bridge = new AutoBridge({
        vars: vars,
        image: this.app.imageService,
        logger: function(m, lv) { this.app.appendLog(m, lv === "error" ? "error" : lv === "warn" ? "warn" : undefined); }.bind(this),
        version: this.app.version || "4.3.0"
    });
    var host = new JsPluginHost({ bridge: bridge, logger: bridge.logger });
    this._runtime = new EditorRuntime({
        bridge: bridge, host: host, task: task,
        image: this.app.imageService,
        logger: bridge.logger,
        // 分辨率适配: 运行设备实际分辨率 (任务基准取 model.ori_infos[0])
        screenSize: function() {
            try {
                if (typeof device !== "undefined" && device.width && device.height) {
                    return { width: Number(device.width), height: Number(device.height) };
                }
            } catch (eD) {}
            return null;
        }
    });
    this._refreshInfo();
    this.refresh();
    this.app.appendLog("[编辑器] 已导入 " + fileName + " (场景 " + (task.model.scene_list || []).length + ")");
};

EditorScreen.prototype._refreshInfo = function() {
    if (!this.root || !this._task) return;
    var m = this._task.model;
    this.root.infoBox.setVisibility(android.view.View.VISIBLE);
    this.root.infoTitle.setText(this._loadedName + " (loop_mode=" + m.loop_mode + ", interval=" + m.loop_interval + "ms)");
    this.root.infoStat.setText("场景 " + (m.scene_list || []).length +
        " | 变量 " + (m.var_list || []).length +
        " | 插件 " + (this._task.pluginDefs || []).length +
        " | 模板图 " + Object.keys(this._task._imageMap || {}).length);
};

EditorScreen.prototype.runTask = function() {
    if (!this._runtime) {
        if (typeof toast === "function") toast("请先导入任务");
        return;
    }
    if (this._running) return;
    var self = this;
    var name = this._loadedName;
    this._running = true;
    threads.start(function() {
        try {
            self._runtime.start();
        } finally {
            self._running = false;
            self._notifyTray(false, name);
        }
    });
    this._notifyTray(true, name);
};

EditorScreen.prototype.stopTask = function() {
    if (this._runtime) this._runtime.stop();
};

EditorScreen.prototype._notifyTray = function(running, name) {
    if (this.app.editorTray) this.app.editorTray.setRunning(running, name);
    this.app.appendLog(running ? "[编辑器] 启动: " + name : "[编辑器] 停止: " + name);
};

/** 控制口 127.0.0.1:11243 开关。 */
EditorScreen.prototype.toggleServer = function() {
    if (this._server && this._server._running) {
        this._server.stop();
        this.root.btnServer.setText("控制口");
        this.app.appendLog("[编辑器] 控制口已关闭");
        return;
    }
    if (!this._server) {
        var self = this;
        this._server = new EditorServer({
            port: (this.app.config && this.app.config.editorServerPort) || 11243,
            runtime: {
                runUserCode: function(code) {
                    // /run code: 无任务上下文时用当前运行时; 无则建轻量上下文
                    if (self._runtime) return self._runtime.runUserCode(code);
                    var vars = new EditorVars();
                    var bridge = new AutoBridge({ vars: vars, image: self.app.imageService, logger: function(m) { self.app.appendLog(m); } });
                    try {
                        var fn = eval("(function(auto){\n" + code + "\n})");
                        fn(bridge);
                        return { ok: true, message: "" };
                    } catch (e) {
                        return { ok: false, message: String(e) };
                    }
                },
                stop: function() { if (self._runtime) self._runtime.stop(); }
            },
            logger: function(m, lv) { self.app.appendLog(m, lv === "error" ? "error" : undefined); }
        });
        var wlPath = (this.app.config && this.app.config.editorWhiteListPath) ||
            this._tasksRoot() + "/vs_white_list.txt";
        this._server.loadWhiteList(wlPath);
    }
    var r = this._server.start();
    if (r.ok) {
        this.root.btnServer.setText("控制口:开");
        this.app.appendLog("[编辑器] 控制口 127.0.0.1:" + this._server.port + " 已开启 (白名单 " + this._server.whiteList.length + " 项)");
    } else {
        if (typeof toast === "function") toast("控制口启动失败: " + r.message);
    }
};

module.exports = EditorScreen;
