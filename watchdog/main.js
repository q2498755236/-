"ui";
/* ==================== 看门狗 (AutoX.js v7) 主界面 ====================
 * 状态展示 + 设置(看护模式/看护时间段/服务端心跳判定) + 看护启停控制
 * 配置持久化: /sdcard/.watchdog/config.json
 * 协议对接: lib_proto.js (设备管理系统服务端, 与编辑器插件 monitor.js 共享设备身份)
 * 看护核心: lib_guard.js (本地进程检测 + 服务端心跳判定双通道, 可单用可共用)
 */

var proto = require('./lib_proto.js');
var guard = require('./lib_guard.js');

var MODE_LABELS = ['双用', '本地进程', '服务端心跳'];
var MODE_VALUES = ['both', 'local', 'server'];

var cfg = guard.init(proto);

ui.layout(
    '<vertical padding="12">'
    +   '<text text="看门狗 WatchDog" textSize="18sp" textStyle="bold" gravity="center"/>'
    +   '<text id="tvIdent" textSize="11sp" textColor="#666666" marginTop="4" gravity="center"/>'
    +   '<text id="tvState" textSize="12sp" marginTop="6" textColor="#333333"/>'
    +   '<button id="btnLog" text="显示悬浮日志" minWidth="0dp" textSize="12sp" marginTop="4" style="Widget.AppCompat.Button.Borderless"/>'
    +   '<ScrollView marginTop="6" layout_weight="1">'
    +     '<vertical>'
    +       '<text text="看护模式 (客户端存活判定)" textSize="13sp" textStyle="bold"/>'
    +       '<spinner id="spMode" entries="双用,本地进程,服务端心跳" spinnerMode="dropdown"/>'
    +       '<text text="本地: ps 查进程死亡即拉起; 心跳: 服务端 last_seen 超阈值判失联即拉起" textSize="10sp" textColor="#999999"/>'
    +       '<Switch id="swWindow" text="启用看护时间段" textSize="13sp" marginTop="8"/>'
    +       '<horizontal>'
    +         '<input id="inpStart" hint="开始 08:00" textSize="13sp" layout_weight="1"/>'
    +         '<input id="inpEnd" hint="结束 22:00" textSize="13sp" layout_weight="1" marginLeft="8"/>'
    +       '</horizontal>'
    +       '<text text="格式 HH:MM, 支持跨天(如 22:00-06:00), 起止相同=全天; 时段外仅心跳上报" textSize="10sp" textColor="#999999"/>'
    +       '<text text="心跳判定阈值(秒, 建议 >=180)" textSize="13sp" marginTop="8"/>'
    +       '<input id="inpThreshold" hint="180" inputType="number" textSize="13sp"/>'
    +       '<text text="服务端 list 密钥 (config.php 的 MONITOR_KEY)" textSize="13sp" marginTop="4"/>'
    +       '<input id="inpKey" hint="与服务端一致, 空=停用心跳判定" textSize="13sp"/>'
    +       '<text text="看护目标 App (每行一个: 包名 或 包名|名称)" textSize="13sp" marginTop="8"/>'
    +       '<input id="inpApps" hint="com.example.editor|自动化编辑器" inputType="textMultiLine" textSize="11sp"/>'
    +       '<text text="看护脚本 (仅 AutoX 引擎内脚本; 独立 APK 业务脚本请填到上方 App 列表)" textSize="13sp" marginTop="4"/>'
    +       '<input id="inpScripts" hint="/sdcard/脚本/main.js|业务脚本" inputType="textMultiLine" textSize="11sp"/>'
    +       '<Switch id="swFreeze" text="画面冻结检测 (无障碍快照比对)" textSize="13sp" marginTop="8"/>'
    +       '<text text="悬浮窗形态应用包名, 每行一个 (跳过本地进程判定与冻结检测, 由服务端心跳兜底)" textSize="13sp" marginTop="4"/>'
    +       '<input id="inpOverlay" hint="com.example.clicker|点击器" inputType="textMultiLine" textSize="11sp"/>'
    +       '<horizontal>'
    +         '<input id="inpFreezeSample" hint="采样间隔秒 20" inputType="number" textSize="13sp" layout_weight="1"/>'
    +         '<input id="inpFreezeTh" hint="无变化次数阈值 3" inputType="number" textSize="13sp" layout_weight="1" marginLeft="8"/>'
    +       '</horizontal>'
    +       '<Switch id="swPixel" text="像素指纹补充 (需截屏授权, 默认关)" textSize="13sp"/>'
    +       '<Switch id="swShell" text="本地进程检测 (shell ps)" textSize="13sp" marginTop="8"/>'
    +       '<Switch id="swRoot" text="root 强杀 force-stop (需设备有稳定 root)" textSize="13sp"/>'
    +       '<Switch id="swAcc" text="无障碍服务看护 (仅告警)" textSize="13sp"/>'
    +       '<Switch id="swRevive" text="主循环僵死自恢复 (selfRevive)" textSize="13sp"/>'
    +       '<text text="心跳上报/变量下发间隔与看护目标明细可直接编辑配置文件" textSize="10sp" textColor="#999999" marginTop="4"/>'
    +       '<text text="/sdcard/.watchdog/config.json" textSize="10sp" textColor="#999999"/>'
    +     '</vertical>'
    +   '</ScrollView>'
    +   '<horizontal marginTop="8">'
    +     '<button id="btnSave" text="保存配置" minWidth="0dp" layout_weight="1" textSize="13sp"/>'
    +     '<button id="btnStart" text="启动看护" minWidth="0dp" layout_weight="1" textSize="13sp" marginLeft="6"/>'
    +     '<button id="btnStop" text="停止" minWidth="0dp" layout_weight="1" textSize="13sp" marginLeft="6"/>'
    +   '</horizontal>'
    +   '<button id="btnReport" text="立即上报" minWidth="0dp" textSize="13sp" marginTop="4"/>'
    + '</vertical>'
);

/* ==================== 控件 <-> 配置 同步 ==================== */
function modeIndexOf(v) {
    for (var i = 0; i < MODE_VALUES.length; i++) {
        if (MODE_VALUES[i] === v) return i;
    }
    return 0;
}

function fillUi() {
    try {
        ui.spMode.setSelection(modeIndexOf(cfg.checkMode));
        ui.swWindow.setChecked(!!cfg.guardWindowEnabled);
        ui.inpStart.setText(String(cfg.guardStart || '08:00'));
        ui.inpEnd.setText(String(cfg.guardEnd || '22:00'));
        ui.inpThreshold.setText(String(cfg.serverAliveThresholdSec || 180));
        ui.inpKey.setText(String(cfg.monitorKey || ''));
        ui.inpApps.setText(guard.targetsToText(cfg.watchApps, 'pkg'));
        ui.inpScripts.setText(guard.targetsToText(cfg.watchScripts, 'path'));
        ui.swFreeze.setChecked(cfg.freezeWatch !== false);
        ui.inpOverlay.setText((cfg.overlayPkgs || []).join('\n'));
        ui.inpFreezeSample.setText(String(cfg.freezeSampleSec || 20));
        ui.inpFreezeTh.setText(String(cfg.freezeThresholdTimes || 3));
        ui.swPixel.setChecked(!!cfg.freezePixelFallback);
        ui.swShell.setChecked(!!cfg.useShell);
        ui.swRoot.setChecked(!!cfg.useRootShell);
        ui.swAcc.setChecked(!!cfg.accessibilityWatch);
        ui.swRevive.setChecked(!!cfg.selfRevive);
    } catch (e) {
        toast('界面初始化异常: ' + e.message);
    }
}

function collectUi() {
    var newCfg = {
        checkMode: MODE_VALUES[Math.max(ui.spMode.getSelectedItemPosition(), 0)],
        guardWindowEnabled: ui.swWindow.isChecked(),
        guardStart: String(ui.inpStart.getText()).trim() || '08:00',
        guardEnd: String(ui.inpEnd.getText()).trim() || '22:00',
        serverAliveThresholdSec: parseInt(String(ui.inpThreshold.getText()), 10) || 180,
        monitorKey: String(ui.inpKey.getText()).trim(),
        watchApps: guard.parseWatchTargets(String(ui.inpApps.getText()), 'pkg', cfg.watchApps || []),
        watchScripts: guard.parseWatchTargets(String(ui.inpScripts.getText()), 'path', cfg.watchScripts || []),
        freezeWatch: ui.swFreeze.isChecked(),
        overlayPkgs: guard.parseWatchTargets(String(ui.inpOverlay.getText()), 'pkg', cfg.overlayPkgs || [])
            .filter(function (it) { return it && it.pkg; })
            .map(function (it) { return it.pkg; }),
        freezeSampleSec: parseInt(String(ui.inpFreezeSample.getText()), 10) || 20,
        freezeThresholdTimes: parseInt(String(ui.inpFreezeTh.getText()), 10) || 3,
        freezePixelFallback: ui.swPixel.isChecked(),
        useShell: ui.swShell.isChecked(),
        useRootShell: ui.swRoot.isChecked(),
        accessibilityWatch: ui.swAcc.isChecked(),
        selfRevive: ui.swRevive.isChecked()
    };
    if (newCfg.serverAliveThresholdSec < 60) newCfg.serverAliveThresholdSec = 60;
    if (newCfg.freezeSampleSec < 10) newCfg.freezeSampleSec = 10;
    if (newCfg.freezeThresholdTimes < 2) newCfg.freezeThresholdTimes = 2;
    return newCfg;
}

/* ==================== 状态展示 ==================== */
function refresh() {
    try {
        var s = guard.summary();
        var ident = proto.ensureIdentity();
        ui.tvIdent.setText('设备: ' + ident[0] + '  UUID: ' + ident[1]);
        var alive = function (v) { return v === null ? '未知' : (v ? '存活' : '失联'); };
        var lines = [
            '看护: ' + (s.running ? '运行中 (已运行 ' + Math.floor(s.uptimeSec / 60) + ' 分钟)' : '已停止'),
            '模式: ' + s.checkMode + ' | 时段: ' + s.window + (s.inWindow ? '' : ' [时段外]'),
            '客户端: 本地=' + alive(s.clientLocal) + ' 心跳=' + alive(s.clientServer),
            '最近: ' + (s.lastAction || '-') + (s.httpErr ? ' [' + s.httpErr + ']' : ''),
            '统计: 检查' + s.checks + ' 拉起' + s.launches + '(败' + s.launchFails + ') 脚本重启' + s.scriptRestarts +
                ' 上报' + s.reports + '(败' + s.reportFails + ') 僵死' + s.stalls + ' 冻结重启' + s.freezeRestarts
        ];
        ui.tvState.setText(lines.join('\n'));
        ui.btnStart.setEnabled(!s.running);
        ui.btnStop.setEnabled(s.running);
    } catch (e) {}
}

/* ==================== 事件 ==================== */
ui.btnSave.on('click', function () {
    var newCfg = collectUi();
    guard.saveConfig(newCfg);
    var wOk = guard.inGuardWindow();
    toast('配置已保存' + (newCfg.guardWindowEnabled && !wOk ? ' (当前时段外, 仅心跳上报)' : ''));
});

ui.btnStart.on('click', function () {
    var cur = collectUi();
    guard.saveConfig(cur);
    if (!cur.watchApps.length && !cur.watchScripts.length) {
        toast('请先填写看护目标 App 或脚本');
        return;
    }
    guard.startLoops();
    toast('看护已启动');
});

ui.btnStop.on('click', function () {
    guard.stopLoops();
    toast('看护已停止');
});

ui.btnReport.on('click', function () {
    toast('上报中...');
    threads.start(function () {
        try { guard.reportOnce(); } catch (e) { proto.slog('手动上报异常: ' + e.message); }
    });
});

ui.btnLog.on('click', function () {
    try { console.show(); } catch (e) {}
});

/* ==================== 启动 ==================== */
fillUi();
refresh();
threads.start(function () {
    while (true) {
        try { sleep(2000); } catch (e0) { break; }
        try { ui.run(function () { refresh(); }); } catch (e1) { break; }
    }
});
