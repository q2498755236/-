/**
 * 灵眸 v4.2 RC13 - ECA 悬浮球控制台
 * 小圆点常驻悬浮（floaty）：颜色区分引擎状态（灰=停止 绿=运行 黄=暂停）。
 * 点击圆点展开控制面板：详情 / 日志 / 启动 / 暂停 / 停止。
 * 详情 = 内嵌运行详情面板（状态/轮次/最近执行），不拉起编辑器（规避 Android 后台启动限制）。
 * 日志按钮切换内嵌滚动日志面板（200 行缓冲，与编辑器日志同源）。
 * 圆点可拖动（位移 > 8px 判定为拖动，抬起未拖动视为点击）。
 */
"use strict";

var STATE_COLORS = {stopped: "#9E9E9E", running: "#4CAF50", paused: "#FFC107"};
var STATE_LABELS = {stopped: "已停止", running: "运行中", paused: "已暂停"};
var MAX_LINES = 200;

function FloatyBall(opts) {
    opts = opts || {};
    this.engine = opts.engine || null;
    this.logger = typeof opts.logger === "function" ? opts.logger : function() {};
    this.openEditor = typeof opts.openEditor === "function" ? opts.openEditor : function() {};
    this._lines = [];
    this._win = null;
    this._panelShown = false;
    this._logShown = false;
    this._detailShown = false;
}

/** 创建并显示悬浮球。权限缺失或创建失败时抛错由调用方兜底。 */
FloatyBall.prototype.show = function() {
    var self = this;
    var w = floaty.window(
        '<frame>' +
            '<vertical id="logPanel" w="236dp" h="280dp" bg="#E6000000" padding="6" visibility="gone">' +
                '<horizontal w="*" h="auto" gravity="center_vertical">' +
                    '<text id="btnLogBack" text="←" textSize="11sp" textColor="#FFFFFF" bg="#3A3A3A" w="34dp" h="24dp" gravity="center" margin="2"/>' +
                    '<text text="运行日志" textSize="11sp" textColor="#CCCCCC" layout_weight="1" padding="4"/>' +
                    '<text id="btnLogClear" text="清空" textSize="11sp" textColor="#FFFFFF" bg="#3A3A3A" w="44dp" h="24dp" gravity="center" margin="2"/>' +
                '</horizontal>' +
                '<scroll id="logScroll" w="*" h="*" fillViewport="true">' +
                    '<text id="logView" w="*" h="auto" textSize="9sp" textColor="#CCCCCC" padding="2"/>' +
                '</scroll>' +
            '</vertical>' +
            '<vertical id="detailPanel" w="236dp" h="280dp" bg="#E6000000" padding="6" visibility="gone">' +
                '<horizontal w="*" h="auto" gravity="center_vertical">' +
                    '<text id="btnDetailBack" text="←" textSize="11sp" textColor="#FFFFFF" bg="#3A3A3A" w="34dp" h="24dp" gravity="center" margin="2"/>' +
                    '<text text="运行详情" textSize="11sp" textColor="#CCCCCC" layout_weight="1" padding="4"/>' +
                    '<text id="btnDetailRefresh" text="刷新" textSize="11sp" textColor="#FFFFFF" bg="#3A3A3A" w="44dp" h="24dp" gravity="center" margin="2"/>' +
                '</horizontal>' +
                '<scroll id="detailScroll" w="*" h="*" fillViewport="true">' +
                    '<text id="detailText" w="*" h="auto" textSize="9sp" textColor="#CCCCCC" padding="2"/>' +
                '</scroll>' +
            '</vertical>' +
            '<vertical id="panel" w="auto" h="auto" bg="#E6000000" padding="4" gravity="center" visibility="gone">' +
                '<text id="stateText" text="已停止" textSize="10sp" textColor="#CCCCCC" gravity="center" marginBottom="1"/>' +
                '<text id="btnDetail" text="详情" textSize="11sp" textColor="#FFFFFF" bg="#3A3A3A" w="64dp" h="26dp" gravity="center" margin="2"/>' +
                '<text id="btnLog" text="日志" textSize="11sp" textColor="#FFFFFF" bg="#3A3A3A" w="64dp" h="26dp" gravity="center" margin="2"/>' +
                '<text id="btnStart" text="启动" textSize="11sp" textColor="#FFFFFF" bg="#2E5B2E" w="64dp" h="26dp" gravity="center" margin="2"/>' +
                '<text id="btnPause" text="暂停" textSize="11sp" textColor="#FFFFFF" bg="#5B4A1E" w="64dp" h="26dp" gravity="center" margin="2"/>' +
                '<text id="btnStop" text="停止" textSize="11sp" textColor="#FFFFFF" bg="#5B2E2E" w="64dp" h="26dp" gravity="center" margin="2"/>' +
            '</vertical>' +
            '<text id="dot" text="●" textSize="30sp" textColor="#9E9E9E" padding="2"/>' +
        '</frame>'
    );
    this._win = w;

    var dot = w.dot;
    var touchX = 0, touchY = 0, winX = 0, winY = 0, moved = false;
    dot.setOnTouchListener(function(view, event) {
        try {
            switch (event.getAction()) {
                case event.ACTION_DOWN:
                    touchX = event.getRawX();
                    touchY = event.getRawY();
                    winX = w.getX();
                    winY = w.getY();
                    moved = false;
                    return true;
                case event.ACTION_MOVE:
                    var dx = event.getRawX() - touchX;
                    var dy = event.getRawY() - touchY;
                    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
                    if (moved) w.setPosition(winX + dx, winY + dy);
                    return true;
                case event.ACTION_UP:
                    if (!moved) self.togglePanel();
                    return true;
            }
        } catch (e) {
            // 触摸异常不中断悬浮球
        }
        return false;
    });

    w.btnDetail.on("click", function() { self._showDetail(true); });
    w.btnDetailBack.on("click", function() { self._showDetail(false); });
    w.btnDetailRefresh.on("click", function() { self._flushDetail(); });
    w.btnLog.on("click", function() {
        self._showLog(true);
        self._flushLog();
    });
    w.btnLogBack.on("click", function() { self._showLog(false); });
    w.btnLogClear.on("click", function() {
        self._lines = [];
        self._flushLog();
    });
    w.btnStart.on("click", function() { self._ctrl("start"); });
    w.btnPause.on("click", function() { self._ctrl("pause"); });
    w.btnStop.on("click", function() { self._ctrl("stop"); });

    // 初始位置与状态
    try { w.setPosition(24, 240); } catch (e) {}
    this.refresh();
    return true;
};

/** 圆点点击：展开/收起控制面板（日志面板优先关闭）。 */
FloatyBall.prototype.togglePanel = function() {
    this._toggleAll(!this._panelShown);
};

FloatyBall.prototype._toggleAll = function(show) {
    this._panelShown = show;
    this._logShown = false;     // 展开控制面板时关日志/详情；收起时全部关闭
    this._detailShown = false;
    this.refresh();
};

FloatyBall.prototype._showLog = function(show) {
    this._logShown = show;
    if (show) this._detailShown = false;
    this.refresh();
};

/** 详情面板：悬浮球内嵌展示运行状态（不依赖系统拉起编辑器，规避后台启动限制）。 */
FloatyBall.prototype._showDetail = function(show) {
    this._detailShown = show;
    if (show) {
        this._logShown = false;
        this._flushDetail();
    }
    this.refresh();
};

/** 控制按钮统一入口：按当前状态分支（非法操作提示，不做置灰兼容坑）。 */
FloatyBall.prototype._ctrl = function(action) {
    var st = this.engine ? this.engine.getStatus() : "stopped";
    try {
        if (action === "start") {
            if (st !== "stopped") { toast("引擎已在" + STATE_LABELS[st]); return; }
            if (this.engine.start()) this.logger("悬浮球：引擎启动");
        } else if (action === "pause") {
            if (st === "running") {
                this.engine.pause();
                this.logger("悬浮球：引擎已暂停");
            } else if (st === "paused") {
                this.engine.resume();
                this.logger("悬浮球：引擎已恢复");
            } else {
                toast("引擎未运行");
                return;
            }
        } else if (action === "stop") {
            if (st === "stopped") { toast("引擎未运行"); return; }
            this.engine.stop();
            this.logger("悬浮球：停止请求已发出");
        }
    } catch (e) {
        this.logger("[E] 悬浮球控制失败: " + e, "error");
    }
    this.refresh();
};

/** 按引擎状态刷新：圆点颜色、状态文本、暂停按钮文字。 */
FloatyBall.prototype.refresh = function() {
    var w = this._win;
    if (!w) return;
    var st = this.engine ? this.engine.getStatus() : "stopped";
    var self = this;
    ui.run(function() {
        try {
            w.dot.setTextColor(android.graphics.Color.parseColor(STATE_COLORS[st] || STATE_COLORS.stopped));
            w.stateText.setText(STATE_LABELS[st] || STATE_LABELS.stopped);
            w.btnPause.setText(st === "paused" ? "恢复" : "暂停");
            w.panel.setVisibility(self._panelShown && !self._logShown && !self._detailShown
                ? android.view.View.VISIBLE : android.view.View.GONE);
            w.logPanel.setVisibility(self._logShown
                ? android.view.View.VISIBLE : android.view.View.GONE);
            w.detailPanel.setVisibility(self._detailShown
                ? android.view.View.VISIBLE : android.view.View.GONE);
        } catch (e) {}
    });
};

/** 外部喂日志（与编辑器日志同源）。 */
FloatyBall.prototype.log = function(msg, level) {
    var line = "[" + new Date().toLocaleTimeString() + "]" +
        (level === "error" ? "[E]" : level === "warn" ? "[W]" : "") + " " + String(msg);
    this._lines.push(line);
    if (this._lines.length > MAX_LINES) this._lines.shift();
    if (this._logShown) this._flushLog();
};

FloatyBall.prototype._flushLog = function() {
    var w = this._win;
    if (!w) return;
    var text = this._lines.join("\n");
    var self = this;
    ui.run(function() {
        try {
            w.logView.setText(text);
            w.logScroll.fullScroll(android.view.View.FOCUS_DOWN);
        } catch (e) {}
    });
};

/** 构建详情文本：状态 + 轮次 + 最近执行（按时间倒序取 5 条）。 */
FloatyBall.prototype._buildDetail = function() {
    var lines = [];
    var eng = this.engine;
    var st = eng ? eng.getStatus() : "stopped";
    lines.push("状态: " + (STATE_LABELS[st] || st));
    if (eng && eng.config) {
        lines.push("轮次: " + (eng.cycle || 0));
        var evs = [];
        var cfg = eng.config;
        var collect = function(list, tag) {
            if (!list) return;
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].lastRun) evs.push({tag: tag, ev: list[i]});
            }
        };
        collect(cfg.topEvents, "L1");
        var screens = cfg.screens || [];
        for (var s = 0; s < screens.length; s++) {
            collect(screens[s] && screens[s].events, "L2·" + (screens[s].name || "?"));
        }
        collect(cfg.lowEvents, "L5");
        collect(cfg.defaultEvents, "L4");
        evs.sort(function(a, b) { return (b.ev.lastRun.time || 0) - (a.ev.lastRun.time || 0); });
        var shown = evs.slice(0, 5);
        if (shown.length === 0) {
            lines.push("最近执行: 暂无");
        } else {
            lines.push("最近执行:");
            for (var k = 0; k < shown.length; k++) {
                var lr = shown[k].ev.lastRun;
                var d = new Date(lr.time || 0);
                var hh = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2)
                    + ":" + ("0" + d.getSeconds()).slice(-2);
                var outcome = lr.conditionPassed === false ? "条件不满足" : (lr.ok ? "成功" : "中断");
                lines.push("- [" + shown[k].tag + "] " + shown[k].ev.name
                    + " " + outcome + " " + (lr.actionsDone || 0) + "步 " + hh);
            }
        }
    } else {
        lines.push("引擎未就绪");
    }
    return lines.join("\n");
};

FloatyBall.prototype._flushDetail = function() {
    var w = this._win;
    if (!w) return;
    var text = this._buildDetail();
    var self = this;
    ui.run(function() {
        try { w.detailText.setText(text); } catch (e) {}
    });
};

/** 关闭悬浮球（进程退出时调用）。 */
FloatyBall.prototype.hide = function() {
    var w = this._win;
    if (w) {
        try { w.close(); } catch (e) {}
        this._win = null;
    }
};

FloatyBall.STATE_COLORS = STATE_COLORS;
FloatyBall.STATE_LABELS = STATE_LABELS;
module.exports = FloatyBall;
