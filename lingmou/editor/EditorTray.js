/**
 * 灵眸 v4.3 - 编辑器复刻层: 悬浮窗托盘
 * 对齐自动化编辑器形态: 后台仅悬浮窗常驻 (规避 Android 后台启动限制)。
 * 状态色: 灰=停止 绿=运行; 按钮: 运行/停止/隐藏。可拖动 (位移>8px 判定拖动)。
 */
"use strict";

var STATE_COLORS = {stopped: "#9E9E9E", running: "#4CAF50"};

function EditorTray(opts) {
    opts = opts || {};
    this.onRun = typeof opts.onRun === "function" ? opts.onRun : function() {};
    this.onStop = typeof opts.onStop === "function" ? opts.onStop : function() {};
    this.logger = typeof opts.logger === "function" ? opts.logger : function() {};
    this._win = null;
    this._running = false;
    this._taskName = "";
}

EditorTray.prototype.show = function() {
    var self = this;
    var w = floaty.window(
        '<frame>' +
            '<vertical id="panel" w="auto" h="auto" bg="#E6000000" padding="4" gravity="center" visibility="gone">' +
                '<text id="stateText" text="已停止" textSize="10sp" textColor="#CCCCCC" gravity="center" marginBottom="1"/>' +
                '<text id="taskText" text="-" textSize="9sp" textColor="#888888" gravity="center" marginBottom="2"/>' +
                '<horizontal>' +
                    '<text id="btnRun" text="运行" textSize="11sp" textColor="#FFFFFF" bg="#2E5B2E" w="52dp" h="26dp" gravity="center" margin="2"/>' +
                    '<text id="btnStop" text="停止" textSize="11sp" textColor="#FFFFFF" bg="#5B2E2E" w="52dp" h="26dp" gravity="center" margin="2"/>' +
                    '<text id="btnHide" text="隐藏" textSize="11sp" textColor="#FFFFFF" bg="#3A3A3A" w="52dp" h="26dp" gravity="center" margin="2"/>' +
                '</horizontal>' +
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
                    touchX = event.getRawX(); touchY = event.getRawY();
                    winX = w.getX(); winY = w.getY();
                    moved = false;
                    return true;
                case event.ACTION_MOVE:
                    var dx = event.getRawX() - touchX, dy = event.getRawY() - touchY;
                    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
                    if (moved) w.setPosition(winX + dx, winY + dy);
                    return true;
                case event.ACTION_UP:
                    if (!moved) {
                        var show = self._win.panel.getVisibility() === android.view.View.GONE;
                        self._win.panel.setVisibility(show ? android.view.View.VISIBLE : android.view.View.GONE);
                    }
                    return true;
            }
        } catch (e) {}
        return false;
    });

    w.btnRun.on("click", function() { self.onRun(); });
    w.btnStop.on("click", function() { self.onStop(); });
    w.btnHide.on("click", function() { self.hide(); });

    try { w.setPosition(24, 360); } catch (e) {}
    this.refresh();
    return true;
};

EditorTray.prototype.hide = function() {
    try { if (this._win) this._win.close(); } catch (e) {}
    this._win = null;
    return true;
};

EditorTray.prototype.setRunning = function(running, taskName) {
    this._running = !!running;
    this._taskName = taskName || "";
    this.refresh();
};

EditorTray.prototype.refresh = function() {
    if (!this._win) return;
    try {
        var c = STATE_COLORS[this._running ? "running" : "stopped"];
        this._win.dot.setTextColor(android.graphics.Color.parseColor(c));
        this._win.stateText.setText(this._running ? "运行中" : "已停止");
        this._win.taskText.setText(this._taskName || "-");
    } catch (e) {}
};

module.exports = EditorTray;
