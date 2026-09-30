/* ==================== 看门狗核心 (AutoX.js v7) ====================
 * 客户端存活判定双通道 (可单用可共用, checkMode 配置):
 *   local  本地进程检测: shell ps -A 查看护目标包名, 死亡即拉起 (快, 受 ROM 限制)
 *   server 服务端心跳判定: GET /api/monitor/list 取本机 last_seen,
 *          超过阈值判定客户端失联 -> 拉起编辑器 (进程在但插件死掉也能发现)
 *   both   双用: 本地判死或服务端判失联任一命中即恢复
 * 看护时间段: guardWindowEnabled + guardStart/guardEnd (HH:MM, 支持跨天),
 *   时段外暂停拉起与判定, 心跳照常上报
 * 自保活: 主循环/哨兵双线程心跳文件互监控, 主循环僵死可 selfRevive 重启自身
 * 注: 服务端回传的挂机/离线状态是业务脚本侧语义, 看门狗不消费该状态,
 *     看护启停只由本地看护时间段控制
 */

var WD_DIR = '/sdcard/.watchdog';
var WD_CFG_FILE = WD_DIR + '/config.json';
var WD_BEAT_MAIN = WD_DIR + '/beat_main.dat';
var WD_BEAT_SENT = WD_DIR + '/beat_sentinel.dat';
var WD_LOG_FILE = WD_DIR + '/log.txt';

var DEFAULT_CFG = {
    server: 'https://2498755236.byethost7.com',
    reportIntervalSec: 60,
    guardIntervalSec: 15,
    sentinelIntervalSec: 10,
    maxStallSec: 90,
    maxRestartStreak: 5,
    useShell: true,
    useRootShell: false,
    selfRevive: true,
    accessibilityWatch: true,
    watchApps: [],
    watchScripts: [],
    checkMode: 'both',
    monitorKey: '',
    serverAliveThresholdSec: 180,
    listIntervalSec: 120,
    guardWindowEnabled: false,
    guardStart: '08:00',
    guardEnd: '22:00',
    /* 画面冻结检测 (无障碍语义快照比对) */
    freezeWatch: true,
    freezeSampleSec: 20,
    freezeThresholdTimes: 3,
    freezeGraceSec: 60,
    freezePixelFallback: false,
    /* 悬浮窗形态应用包名 (点击器等: 拉起后本体在后台仅悬浮窗显示):
     * 跳过本地进程判定与冻结检测, 由服务端心跳判定兜底。
     * (旧字段 freezeExcludePkg 自动迁移) */
    overlayPkgs: [],
    /* HTTP 探活: 列表内包名优先探测本机控制端口 (编辑器 EditorService
     * 内置 NanoHTTPD 11243/console, 免白名单), 通=存活, 不通走原判定链 */
    httpProbePort: 11243,
    httpProbePkgs: []
};

var _cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));
var _proto = null;
var _running = false;
var _stopRequested = false;
var _timers = [];
var _sentThread = null;
var _startMs = 0;
var _lastBeatMainMs = 0;
var _lastBeatSentMs = 0;
var _lastListMs = 0;
var _listFailStreak = 0;
var _listPausedUntilMs = 0;
var _restartStreak = 0;
var _streakResetMs = 0;
var _lastLaunchMs = 0;
var _stallStreak = 0;
var _selfReviving = false;
var _errThrottle = {};
var _stats = { checks: 0, launches: 0, launchFails: 0, scriptRestarts: 0, reports: 0, reportFails: 0, stalls: 0, freezeRestarts: 0 };

/* 客户端存活状态 (供 UI 展示): true 存活 / false 失联 / null 未知 */
var _clientLocal = null;
var _clientServer = null;
var _lastAction = '';

/* 画面冻结检测状态: pkg -> { lastHash, unchanged, lastChangeMs, restartMs, unknown } */
var _freezeState = {};
var _pixelRequested = false;
var _pixelReady = false;

/* logcat 桥接: 上次读到的最后一行 (增量去重) */
var _lastLogcatLine = '';
/* 连续无输出计数 (ROM 限制 logcat 时自动停用) */
var _logcatFailStreak = 0;

/* ==================== 工具 ==================== */
/* 日志: console (AutoX 日志可见) + 落盘 /sdcard/.watchdog/log.txt (超 200KB 截断保留末尾) */
function _nowStr() {
    try {
        var d = new Date();
        return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) +
            ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    } catch (e) {
        return String(Date.now());
    }
}

function _logWrite(line) {
    try {
        if (typeof files === 'undefined' || typeof files.append !== 'function') return;
        if (_proto) _proto.fMkdir(WD_DIR);
        files.append(WD_LOG_FILE, line + '\n');
        try {
            if (typeof files.getSize === 'function' && files.getSize(WD_LOG_FILE) > 200 * 1024) {
                var old = _proto ? _proto.fRead(WD_LOG_FILE) : '';
                if (_proto) _proto.fWrite(WD_LOG_FILE, old.slice(old.length - 50 * 1024));
            }
        } catch (e0) {}
    } catch (e1) {}
}

function log(msg) {
    var s = String(msg).slice(0, 300);
    try { console.log(s); } catch (e0) {}
    _logWrite('[' + _nowStr() + '] ' + s);
}

/* 错误日志: console.error (AutoX 日志红色醒目) + 落盘带 [ERR] 前缀 */
function logErr(msg) {
    var s = String(msg).slice(0, 300);
    try { console.error(s); } catch (e0) {}
    _logWrite('[' + _nowStr() + '] [ERR] ' + s);
}

function nowSec() { return Math.floor(Date.now() / 1000); }

/* 错误上报 (5 分钟节流): 首次 error 级日志, 节流期内本地日志照打 (方便 AutoX 排查) */
function errThrottled(key, msg) {
    var now = Date.now();
    if (_errThrottle[key] && now - _errThrottle[key] < 300000) {
        log('(' + key + ' 节流中) ' + msg);
        return;
    }
    _errThrottle[key] = now;
    logErr(msg);
    if (_proto) _proto.recordError(msg);
}

/* ==================== 配置 ==================== */
/* 目标数组清洗: 剔除 null/坏元素 (config.json 手编坏数据防崩) */
function _sanitizeTargets(arr, key) {
    var out = [];
    var l = Array.isArray(arr) ? arr : [];
    for (var i = 0; i < l.length; i++) {
        var it = l[i];
        if (!it || typeof it !== 'object') continue;
        if (!String(it[key] || '').trim()) continue;
        out.push(it);
    }
    return out;
}

function loadConfig() {
    var raw = _proto ? _proto.fRead(WD_CFG_FILE) : '';
    if (!raw) return _cfg;
    try {
        var j = JSON.parse(raw);
        for (var k in DEFAULT_CFG) {
            if (!DEFAULT_CFG.hasOwnProperty(k)) continue;
            if (j[k] !== undefined) _cfg[k] = j[k];
        }
        if (!Array.isArray(_cfg.watchApps)) _cfg.watchApps = [];
        if (!Array.isArray(_cfg.watchScripts)) _cfg.watchScripts = [];
        if (!Array.isArray(_cfg.overlayPkgs)) _cfg.overlayPkgs = [];
        if (!Array.isArray(_cfg.httpProbePkgs)) _cfg.httpProbePkgs = [];
        _cfg.watchApps = _sanitizeTargets(_cfg.watchApps, 'pkg');
        _cfg.watchScripts = _sanitizeTargets(_cfg.watchScripts, 'path');
        var ov = [];
        for (var oi = 0; oi < _cfg.overlayPkgs.length; oi++) {
            var s = String(_cfg.overlayPkgs[oi] || '').trim();
            if (s) ov.push(s);
        }
        _cfg.overlayPkgs = ov;
        var hp = [];
        for (var hi = 0; hi < _cfg.httpProbePkgs.length; hi++) {
            var hs = String(_cfg.httpProbePkgs[hi] || '').trim();
            if (hs) hp.push(hs);
        }
        _cfg.httpProbePkgs = hp;
        var portN = parseInt(_cfg.httpProbePort, 10);
        _cfg.httpProbePort = (portN > 0 && portN < 65536) ? portN : 11243;
        /* 旧字段迁移: freezeExcludePkg -> overlayPkgs (新版配置并存时以 overlayPkgs 为准) */
        if (j.freezeExcludePkg !== undefined && j.overlayPkgs === undefined) {
            _cfg.overlayPkgs = Array.isArray(j.freezeExcludePkg) ? j.freezeExcludePkg : [];
        }
    } catch (e) {
        log('配置解析失败, 使用当前配置: ' + e.message);
    }
    return _cfg;
}

function saveConfig(newCfg) {
    if (newCfg) {
        for (var k in DEFAULT_CFG) {
            if (!DEFAULT_CFG.hasOwnProperty(k)) continue;
            if (newCfg[k] !== undefined) _cfg[k] = newCfg[k];
        }
    }
    if (_proto) {
        _proto.fMkdir(WD_DIR);
        _proto.fWrite(WD_CFG_FILE, JSON.stringify(_cfg, null, 2));
        _proto.configure({ server: _cfg.server });
    }
    log('配置已保存');
    return _cfg;
}

function getConfig() { return _cfg; }

/* ==================== 看护时间段 ==================== */
/* "HH:MM" -> 分钟数; 非法返回 -1 */
function _hmToMin(s) {
    var m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return -1;
    var h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (h < 0 || h > 24 || mm < 0 || mm > 59) return -1;
    return h * 60 + mm;
}

/* 在时段内返回 true; start==end 全天; start>end 跨天 (如 22:00-06:00) */
function inGuardWindow(now) {
    if (!_cfg.guardWindowEnabled) return true;
    var a = _hmToMin(_cfg.guardStart);
    var b = _hmToMin(_cfg.guardEnd);
    if (a < 0 || b < 0) return true;
    if (a === b) return true;
    var d = new Date(now || Date.now());
    var cur = d.getHours() * 60 + d.getMinutes();
    if (a < b) return cur >= a && cur < b;
    return cur >= a || cur < b;
}

/* ==================== 存活判定: 本地进程 ==================== */
/* 无障碍窗口列表找目标包窗口 (含悬浮窗 TYPE_APPLICATION_OVERLAY)。
 * 返回 true 有窗口(活) / false 调用成功但无该包窗口(死) / null 无障碍不可用(未知) */
function windowExists(pkg) {
    var okCall = false;
    try {
        if (typeof auto === 'undefined' || typeof auto.windowRoots !== 'function') return null;
        var roots = auto.windowRoots() || [];
        okCall = true;
        for (var i = 0; i < roots.length; i++) {
            try {
                if (roots[i] && String(roots[i].packageName() || '') === pkg) return true;
            } catch (e0) {}
        }
    } catch (e1) {}
    return okCall ? false : null;
}

/* 是否悬浮窗形态应用 (跳过本地判定与冻结检测) */
function isOverlay(pkg) {
    var ex = _cfg.overlayPkgs || [];
    for (var i = 0; i < ex.length; i++) {
        if (String(ex[i]) === pkg) return true;
    }
    return false;
}

/* HTTP 探活: httpProbePkgs 列表内的包优先探测本机控制端口。
 * 编辑器 EditorService 内置 NanoHTTPD (默认 11243, GET /console 免白名单),
 * 拿到任何响应体即服务存活 (code!=0 时记日志); 连接失败返回 null 走原判定链。
 * 独立于 useShell, 关 shell 也能探。 */
function _httpProbeAlive(pkg) {
    if (!_cfg.httpProbePkgs || _cfg.httpProbePkgs.indexOf(pkg) < 0) return null;
    try {
        if (typeof http === 'undefined' || typeof http.get !== 'function') return null;
        var r = http.get('http://127.0.0.1:' + (_cfg.httpProbePort || 11243) + '/console', { timeout: 3000 });
        var b = r && r.body;
        var body = !b ? '' : (typeof b === 'string' ? b : (typeof b.string === 'function' ? String(b.string()) : String(b)));
        if (body) {
            if (body.indexOf('"code":0') < 0) {
                log('httpProbe ' + pkg + ' 响应异常: ' + body.slice(0, 80));
            }
            return true;
        }
    } catch (e) {
        errThrottled('httpProbe ' + pkg + ' 失败: ' + String((e && e.message) || e).slice(0, 100));
    }
    return null;
}

/* 返回 true 存活 / false 未发现进程 / null 检测不可用 (useShell 关闭或 shell 失败)
 * 判定顺序: HTTP 探活 -> 窗口判定 (零 shell, 不触发 AutoX shell 的 Java 崩溃面,
 * 有窗口即活, 覆盖悬浮窗形态应用) -> ps 兜底最终判定。
 * ps 用普通 shell (root 模式在无 root 设备会触发 AutoX 框架线程 NPE) */
function processAlive(pkg) {
    if (_httpProbeAlive(pkg) === true) return true;
    if (!_cfg.useShell || !_proto) return null;
    var w = windowExists(pkg);
    if (w === true) return true;
    var out = _proto.shellOut('ps -A', false);
    if (!out) return (w === false) ? false : null;
    return out.indexOf(pkg) >= 0;
}

function launchApp(pkg) {
    try {
        if (typeof app !== 'undefined' && typeof app.launchPackage === 'function') {
            var ok = app.launchPackage(pkg);
            return ok !== false;
        }
        logErr('launchApp: app.launchPackage 不可用');
    } catch (e) {
        logErr('拉起异常 ' + pkg + ': ' + ((e && e.message) || e));
    }
    return false;
}

/* ==================== 存活判定: 服务端心跳 ==================== */
/* 拉取 /api/monitor/list, 找本机 device_id, 比较 last_seen 与阈值 */
/* 返回 true 存活 / false 失联 / null 未知 (未配置 key / 请求失败 / 未找到本机) */
function serverCheckAlive(deviceId) {
    if (!_cfg.monitorKey || !_proto) return null;
    var now = Date.now();
    if (now < _listPausedUntilMs) return null;
    if (now - _lastListMs < _cfg.listIntervalSec * 1000) return _clientServer;

    var url = _proto.serverUrl() + '/api/monitor/list?key=' + encodeURIComponent(_cfg.monitorKey);
    var resp = _proto.httpGet(url);
    _lastListMs = now;
    if (!resp) {
        _listFailStreak++;
        log('list 请求失败(' + (_proto.lastHttpErr() || '无响应') + ') 连续 ' + _listFailStreak + ' 次');
        if (_listFailStreak >= 3) {
            /* 失败退避: 连续失败 3 次暂停 10 分钟, 防止服务端 IP 封禁 (key 错误/网络抖动) */
            _listPausedUntilMs = now + 600000;
            _listFailStreak = 0;
            log('list 连续失败, 暂停 10 分钟');
        }
        return null;
    }
    try {
        var j = JSON.parse(String(resp));
        if (!j || !j.success) {
            _listFailStreak++;
            if (_listFailStreak >= 3) {
                _listPausedUntilMs = now + 600000;
                _listFailStreak = 0;
                errThrottled('list_key', 'list 鉴权失败(检查 monitorKey): ' + String(j && j.message || '').slice(0, 60));
            }
            return null;
        }
        _listFailStreak = 0;
        var devices = j.devices || [];
        var serverNowMs = (j.serverTime ? j.serverTime * 1000 : now);
        for (var i = 0; i < devices.length; i++) {
            if (String(devices[i].device_id) === String(deviceId)) {
                var seen = parseInt(devices[i].last_seen, 10);
                if (!isFinite(seen)) return null;
                var gap = Math.abs(serverNowMs - now) > 300000 ? serverNowMs : now;
                _clientServer = (gap - seen) < _cfg.serverAliveThresholdSec * 1000;
                return _clientServer;
            }
        }
        _clientServer = false;
        return _clientServer;
    } catch (e) {
        return null;
    }
}

/* ==================== 看护动作 ==================== */
function _canRecover() {
    return _running && inGuardWindow() && Date.now() - _lastLaunchMs > 10000;
}

function guardApps() {
    var apps = _cfg.watchApps || [];
    for (var i = 0; i < apps.length; i++) {
        var target = apps[i];
        if (!target) continue;
        var pkg = String(target.pkg || '').trim();
        if (!pkg) continue;

        var alive = true;
        if (_cfg.checkMode === 'local' || _cfg.checkMode === 'both') {
            /* 悬浮窗形态应用: ps 与窗口兜底都可能误判, 跳过本地判定, 由心跳兜底 */
            var pa = isOverlay(pkg) ? null : processAlive(pkg);
            if (pa !== null) {
                _clientLocal = pa;
                if (!pa) alive = false;
            }
        }
        if (alive && (_cfg.checkMode === 'server' || _cfg.checkMode === 'both')) {
            var ident = _proto.ensureIdentity();
            var sa = serverCheckAlive(ident[0]);
            if (sa === false) alive = false;
        }

        if (!alive) {
            if (!_canRecover()) {
                _lastAction = pkg + ' 失联(时段外/挂机/离线, 不拉起)';
                log(_lastAction);
                continue;
            }
            /* 重启风暴退避: 连续失败越多, 拉起间隔越长 (10s -> 60s -> 120s ... 上限 10min) */
            if (_restartStreak >= _cfg.maxRestartStreak && Date.now() - _streakResetMs < 600000) {
                _lastAction = pkg + ' 连续拉起失败 ' + _restartStreak + ' 次, 退避中';
                continue;
            }
            _lastLaunchMs = Date.now();
            _stats.launches++;
            var ok = launchApp(pkg);
            _lastAction = pkg + ' 失联 -> 拉起' + (ok ? '成功' : '失败');
            log(_lastAction);
            if (ok) {
                _restartStreak = 0;
            } else {
                _stats.launchFails++;
                _restartStreak++;
                if (_restartStreak === 1) _streakResetMs = Date.now();
                if (_restartStreak >= _cfg.maxRestartStreak) {
                    errThrottled('launch_' + pkg, '拉起连续失败 ' + _restartStreak + ' 次: ' + pkg);
                    _streakResetMs = Date.now();
                }
            }
            /* 拉起后等待, 本轮不再处理其余目标 */
            return;
        }
        /* 存活: 稳定 5 分钟后清退避计数 */
        if (_restartStreak > 0 && Date.now() - _lastLaunchMs > 300000) _restartStreak = 0;
    }
}

/* AutoX 内脚本看护: engines.all() 找目标路径, 不在则 execScriptFile 重启 */
function guardScripts() {
    if (!_canRecover()) return;
    var list = _cfg.watchScripts || [];
    if (!list.length) return;
    var running = {};
    try {
        if (typeof engines === 'undefined' || typeof engines.all !== 'function') return;
        var all = engines.all();
        for (var i = 0; i < all.length; i++) {
            var p = '';
            try {
                var src = all[i].getSource ? all[i].getSource() : null;
                p = String(src && (src.getPath ? src.getPath() : src.path) || '');
            } catch (e0) { p = ''; }
            if (p) running[p] = true;
        }
    } catch (e1) {
        return;
    }
    for (var k = 0; k < list.length; k++) {
        var target = list[k];
        if (!target) continue;
        var path = String(target.path || '').trim();
        if (!path) continue;
        var found = false;
        for (var rp in running) {
            if (!running.hasOwnProperty(rp)) continue;
            if (rp === path || rp.indexOf(path) === rp.length - path.length) { found = true; break; }
        }
        if (found) continue;
        try {
            if (typeof engines.execScriptFile === 'function') {
                engines.execScriptFile(path, { delay: 100 });
                _stats.scriptRestarts++;
                _lastAction = '脚本重启: ' + (target.name || path);
                log(_lastAction);
            }
        } catch (e2) {
            errThrottled('script_' + path, '脚本重启失败: ' + path + ' ' + ((e2 && e2.message) || e2));
        }
    }
}

/* 无障碍看护: 服务不可用即记录错误 (Android 限制无法静默自启, 仅告警) */
function guardAccessibility() {
    if (!_cfg.accessibilityWatch) return;
    var ok = true;
    try {
        if (typeof auto !== 'undefined') {
            ok = auto.service !== null && auto.service !== undefined;
        } else {
            return;
        }
    } catch (e) {
        return;
    }
    if (!ok) errThrottled('acc', '无障碍服务未开启, 请手动检查');
}

/* ==================== 画面冻结检测 ==================== */
/* FNV-1a 32 位 (ES5 兼容), 快照本地比对用 */
function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}

/* 当前前台包名 (取不到返回 '') */
function frontPkg() {
    try {
        if (typeof currentPackage === 'function') return String(currentPackage() || '');
    } catch (e0) {}
    try {
        if (typeof auto !== 'undefined' && auto.rootInActiveWindow) {
            return String(auto.rootInActiveWindow.packageName() || '');
        }
    } catch (e1) {}
    return '';
}

/* 目标包窗口语义快照哈希: 遍历控件树拼接 className/text/desc/bounds
 * 返回 'hash_长度' / '' 该包无窗口或无障碍不可用 (depth<=8, 节点<=200 防失控) */
function windowSnapshot(pkg) {
    var roots = null;
    try {
        if (typeof auto === 'undefined') return '';
        if (typeof auto.windowRoots === 'function') roots = auto.windowRoots();
        if (!roots || !roots.length) {
            var r0 = auto.rootInActiveWindow;
            if (r0) roots = [r0];
        }
    } catch (e0) { return ''; }
    if (!roots || !roots.length) return '';
    var sb = [];
    var count = 0;
    function walk(node, depth) {
        if (!node || count > 200) return;
        var cls = '', txt = '', dsc = '', b = '';
        try {
            cls = String(node.className() || '');
            txt = String(node.text() || '');
            dsc = String(node.desc() || '');
            var bd = node.bounds();
            if (bd) b = bd.left + ',' + bd.top + ',' + bd.right + ',' + bd.bottom;
        } catch (e1) {}
        sb.push(cls + '|' + txt + '|' + dsc + '|' + b);
        count++;
        if (depth >= 8) return;
        var n = 0;
        try { n = node.childCount() || 0; } catch (e2) {}
        for (var i = 0; i < n && count <= 200; i++) {
            var c = null;
            try { c = node.child(i); } catch (e3) {}
            walk(c, depth + 1);
        }
    }
    var found = false;
    for (var i = 0; i < roots.length; i++) {
        try {
            var r = roots[i];
            if (!r) continue;
            var pn = '';
            try { pn = String(r.packageName() || ''); } catch (e4) {}
            if (pn !== pkg) continue;
            found = true;
            walk(r, 0);
        } catch (e5) {}
    }
    if (!found) return '';
    var s = sb.join('\n');
    return String(fnv1a(s)) + '_' + s.length;
}

/* 像素指纹 (可选通道, 需 MediaProjection 授权): 中心 4x4 采样点灰度量化
 * 返回指纹串 / '' 失败 */
function pixelFingerprint() {
    try {
        if (typeof images === 'undefined' || typeof captureScreen !== 'function') return '';
        if (!_pixelRequested) {
            _pixelRequested = true;
            _pixelReady = !!requestScreenCapture();
            if (!_pixelReady) errThrottled('frz_pixel', '截屏授权失败, 像素指纹通道停用');
        }
        if (!_pixelReady) return '';
        var img = captureScreen();
        if (!img) return '';
        var w = 0, h = 0;
        try { w = img.getWidth(); h = img.getHeight(); } catch (e0) {
            try { w = img.width; h = img.height; } catch (e1) {}
        }
        if (!w || !h) { try { img.recycle(); } catch (e2) {} return ''; }
        var fp = [];
        for (var gy = 1; gy <= 4; gy++) {
            for (var gx = 1; gx <= 4; gx++) {
                var x = Math.floor(w * gx / 5);
                var y = Math.floor(h * gy / 5);
                var gray = -1;
                try {
                    var c = images.pixel(img, x, y);
                    var r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
                    gray = Math.floor((r * 299 + g * 587 + b * 114) / 1000 / 8);
                } catch (e3) {}
                fp.push(gray);
            }
        }
        try { img.recycle(); } catch (e4) {}
        if (fp.indexOf(-1) >= 0) return '';
        return 'px_' + fp.join('.');
    } catch (e5) {
        return '';
    }
}

/* 冻结恢复: force-stop (shell 可用时) + 拉起; 返回动作描述
 * force-stop 默认普通 shell (无 root 时执行会 Permission Denial 但不崩),
 * useRootShell=true 才走 root (需设备有稳定 root, 否则 AutoX 框架层 NPE) */
function freezeRestart(pkg) {
    var canKill = false;
    if (_cfg.useShell && _proto) {
        canKill = (typeof shell === 'function') ||
            (typeof auto !== 'undefined' && typeof auto.shell === 'function');
        if (canKill) _proto.shellOut('am force-stop ' + pkg, !!_cfg.useRootShell);
    }
    var ok = launchApp(pkg);
    _stats.freezeRestarts++;
    _lastLaunchMs = Date.now();
    var desc = pkg + ' 画面冻结 -> ' + (canKill ? (_cfg.useRootShell ? 'root强杀+' : 'force-stop尝试+') : '') + '拉起' + (ok ? '成功' : '失败');
    errThrottled('frz_' + pkg, '画面冻结已恢复: ' + pkg);
    _lastAction = desc;
    log(desc);
    return desc;
}

/* 单 App 冻结判定 (豁免: 悬浮窗应用/宽限期/息屏/非前台; 采样失败计 unknown 仅告警) */
function freezeCheckApp(pkg, now) {
    if (isOverlay(pkg)) return 'excluded';
    var st = _freezeState[pkg];
    if (!st) {
        st = { lastHash: '', unchanged: 0, lastChangeMs: now, restartMs: 0, unknown: 0 };
        _freezeState[pkg] = st;
    }
    if (st.restartMs && now - st.restartMs < Math.max(_cfg.freezeGraceSec, 0) * 1000) return null;
    var screenOn = true;
    try {
        if (typeof device !== 'undefined' && typeof device.isScreenOn === 'function') screenOn = !!device.isScreenOn();
    } catch (e0) {}
    if (!screenOn) return null;
    var fp = frontPkg();
    if (fp && fp !== pkg) return null;

    var hash = windowSnapshot(pkg);
    if (!hash && _cfg.freezePixelFallback) hash = pixelFingerprint();
    if (!hash) {
        st.unknown++;
        if (st.unknown >= 5) {
            errThrottled('frz_unk_' + pkg, '冻结检测采样失败(无窗口/无障碍/截屏): ' + pkg);
            _lastAction = pkg + ' 冻结检测采样失败';
        }
        return 'unknown';
    }
    st.unknown = 0;
    if (st.lastHash && hash === st.lastHash) {
        st.unchanged++;
        var need = Math.max(_cfg.freezeThresholdTimes, 2);
        if (st.unchanged >= need) {
            if (!_canRecover()) {
                _lastAction = pkg + ' 画面疑似冻结(时段外/冷却, 不处理)';
                log(_lastAction);
                return 'skipped';
            }
            if (_restartStreak >= _cfg.maxRestartStreak && now - _streakResetMs < 600000) {
                _lastAction = pkg + ' 冻结重启退避中';
                return 'backoff';
            }
            st.unchanged = 0;
            st.lastHash = '';
            st.restartMs = now;
            return freezeRestart(pkg);
        }
        return 'unchanged_' + st.unchanged;
    }
    st.lastHash = hash;
    st.unchanged = 0;
    st.lastChangeMs = now;
    return 'changed';
}

/* 冻结检测入口 (独立循环调用, 间隔 freezeSampleSec) */
function freezeOnce() {
    if (!_running || _stopRequested || !_cfg.freezeWatch) return;
    if (!inGuardWindow()) return;
    var now = Date.now();
    var apps = _cfg.watchApps || [];
    for (var i = 0; i < apps.length; i++) {
        var pkg = String(apps[i] && apps[i].pkg || '').trim();
        if (!pkg) continue;
        try { freezeCheckApp(pkg, now); } catch (e0) {
            logErr('freezeCheckApp 异常 ' + pkg + ': ' + ((e0 && e0.message) || e0));
        }
    }
}

/* ==================== logcat 桥接 ==================== */
/* Java 层线程崩溃 (如 "Attempt to invoke virtual method...") 脚本 try-catch 拦不住,
 * 也进不了 AutoX 日志——唯一记录处是系统 logcat。本线程定期 dump 本 App 的
 * logcat 错误缓冲, 把崩溃栈桥接进 log.txt (普通 shell 可读本 uid 日志) */
function _logcatBridgeOnce() {
    if (!_running || _stopRequested || !_proto) return;
    if (_logcatFailStreak >= 5) return; /* ROM 限制读不到 logcat, 自动停用 */
    var out = _proto.shellOut('logcat -d -t 120 *:E', false);
    if (!out) {
        _logcatFailStreak++;
        if (_logcatFailStreak === 5) {
            log('logcat 桥接连续无输出, 已停用 (ROM 可能限制普通应用读 logcat)');
        }
        return;
    }
    _logcatFailStreak = 0;
    var lines = String(out).split('\n');
    var tail = [];
    for (var i = 0; i < lines.length; i++) {
        if (String(lines[i]).trim()) tail.push(lines[i]);
    }
    if (!tail.length) return;
    var startIdx = 0;
    if (_lastLogcatLine) {
        for (var k = 0; k < tail.length; k++) {
            if (tail[k] === _lastLogcatLine) { startIdx = k + 1; break; }
        }
    }
    _lastLogcatLine = tail[tail.length - 1];
    var written = 0;
    for (var j = startIdx; j < tail.length && written < 20; j++) {
        var l = String(tail[j]).trim();
        /* 只桥接崩溃特征行, 避免与本脚本自身日志重复刷屏 */
        if (/FATAL|Exception|Unable to|No Context|Attempt to invoke|on a null object|at (android|java|org\.mozilla|com\.stardust)/.test(l)) {
            _logWrite('[' + _nowStr() + '] [logcat] ' + l.slice(0, 240));
            written++;
        }
    }
}

/* ==================== 主循环 / 哨兵 / 上报 ==================== */
function beatWrite(path) {
    _proto.fMkdir(WD_DIR);
    _proto.fWrite(path, String(Date.now()));
}

function guardOnce() {
    if (!_running || _stopRequested) return;
    _stats.checks++;
    _lastBeatMainMs = Date.now();
    try { beatWrite(WD_BEAT_MAIN); } catch (e0) {}
    loadConfig();
    if (!inGuardWindow()) {
        _lastAction = '时段外 (' + _cfg.guardStart + '-' + _cfg.guardEnd + ')';
        return;
    }
    guardApps();
    guardScripts();
    guardAccessibility();
}

function sentinelOnce() {
    if (!_running || _stopRequested) return;
    _lastBeatSentMs = Date.now();
    try { beatWrite(WD_BEAT_SENT); } catch (e0) {}

    /* 主循环僵死检测: beat 文件时间戳超过 maxStallSec */
    var lastMain = parseInt(_proto.fRead(WD_BEAT_MAIN).trim(), 10);
    if (isFinite(lastMain) && lastMain > 0) {
        var stallMs = Date.now() - lastMain;
        if (stallMs > _cfg.maxStallSec * 1000) {
            _stats.stalls++;
            _stallStreak++;
            errThrottled('stall', '主循环僵死 ' + Math.floor(stallMs / 1000) + 's (连续 ' + _stallStreak + ' 次)');
            if (_cfg.selfRevive && _stallStreak >= 2 && !_selfReviving) {
                selfRevive();
            }
        } else {
            _stallStreak = 0;
        }
    }
}

/* 自复活: 新引擎拉起自身脚本, 旧引擎停止循环后退出 */
function selfRevive() {
    _selfReviving = true;
    var myPath = '';
    try {
        var eng = engines.myEngine();
        var src = eng.getSource ? eng.getSource() : null;
        myPath = String(src && (src.getPath ? src.getPath() : src.path) || '');
    } catch (e0) { myPath = ''; }
    if (!myPath) {
        logErr('selfRevive: 无法获取自身路径, 放弃');
        _selfReviving = false;
        return;
    }
    try {
        engines.execScriptFile(myPath, { delay: 500 });
        log('selfRevive: 已重新拉起 ' + myPath);
        _proto.recordError('看门狗主循环僵死, selfRevive 已重启自身');
        _stopRequested = true;
        /* 立即从脚本线程正常 exit()。禁用 setTimeout+forceStop:
         * 主线程杀引擎时工作线程已全退、Rhino Context 已释放,
         * ScriptExecuteActivity.onDestroy 里 engine.put 会抛
         * "No Context associated with current Thread" 导致 AutoX 崩溃 */
        try { exit(); } catch (e1) {}
    } catch (e2) {
        _selfReviving = false;
        logErr('selfRevive 失败: ' + ((e2 && e2.message) || e2));
    }
}

/* 心跳上报 + 服务端状态指令处理 + 变量同步 */
function reportOnce() {
    if (!_running || !_proto) return;
    var ident = _proto.ensureIdentity();
    var summaryText = buildWdState();
    var resp = _proto.postReport({ note: 'WD:' + summaryText, wdState: 'WD ' + summaryText });
    _stats.reports++;
    var okFlag = false;
    var diag = '';
    try {
        var j = JSON.parse(String(resp || ''));
        okFlag = !!(j && j.success);
        if (!okFlag) diag = String((j && j.message) || '').slice(0, 60);
    } catch (e) {
        diag = String(resp || '').slice(0, 60) || _proto.lastHttpErr() || '无响应';
    }
    if (!okFlag) {
        _stats.reportFails++;
        _lastAction = '心跳上报失败' + (diag ? ': ' + diag : '');
        log(_lastAction);
    }
    /* 变量下发: 落盘共享文件, 供编辑器插件/业务脚本读取 */
    try {
        var edit = _proto.fetchVars();
        if (edit !== null) _proto.saveEditVars(edit);
    } catch (e2) {}
}

function buildWdState() {
    var parts = [];
    parts.push(_running ? '看护中' : '停止');
    if (!_running) return parts[0];
    if (!inGuardWindow()) parts.push('时段外');
    if (_cfg.checkMode === 'local' || _cfg.checkMode === 'both') {
        parts.push('本地:' + (_clientLocal === null ? 'n/a' : (_clientLocal ? '活' : '死')));
    }
    if (_cfg.checkMode === 'server' || _cfg.checkMode === 'both') {
        parts.push('心跳:' + (_clientServer === null ? 'n/a' : (_clientServer ? '活' : '失联')));
    }
    if (_stats.launches) parts.push('拉起' + _stats.launches);
    if (_stats.freezeRestarts) parts.push('冻结' + _stats.freezeRestarts);
    if (_stats.stalls) parts.push('僵死' + _stats.stalls);
    return parts.join(' ').slice(0, 34);
}

/* ==================== 循环启停 (UI 调用) ==================== */
/* ui 模式下 setInterval 回调在 UI 线程, 同步 http 会报错
 * "Synchronous http request is not allowed in UI thread", 故循环全部用工作线程。
 * 分段 sleep 保证 stopLoops 后 500ms 内退出; interrupt 加速打断 */
function _loopThread(fn, ivSec) {
    try {
        if (typeof threads !== 'undefined' && typeof threads.start === 'function') {
            return threads.start(function () {
                while (!_stopRequested) {
                    try { fn(); } catch (e0) { logErr('循环异常: ' + ((e0 && e0.message) || e0) + '\n' + (e0 && e0.stack ? String(e0.stack).slice(0, 200) : '')); }
                    var iv = Math.max(ivSec, 5) * 1000;
                    for (var waited = 0; waited < iv && !_stopRequested; waited += 500) {
                        try { sleep(500); } catch (e1) { return; }
                    }
                }
            });
        }
    } catch (e) {
        log('线程启动失败(该循环不工作): ' + e.message);
    }
    return null;
}

function startLoops() {
    if (_running) { log('看护已在运行'); return false; }
    _stopRequested = false;
    _selfReviving = false;
    _running = true;
    _startMs = Date.now();
    _lastBeatMainMs = Date.now();
    _lastBeatSentMs = Date.now();
    loadConfig();
    if (_proto) {
        _proto.configure({ server: _cfg.server });
        beatWrite(WD_BEAT_MAIN);
        beatWrite(WD_BEAT_SENT);
    }

    /* 主看护线程 (首轮立即执行, 之后按 guardIntervalSec) */
    _timers.push(_loopThread(guardOnce, _cfg.guardIntervalSec));

    /* 上报线程 */
    _timers.push(_loopThread(reportOnce, _cfg.reportIntervalSec));

    /* 冻结检测线程 */
    _timers.push(_loopThread(freezeOnce, Math.max(_cfg.freezeSampleSec, 10)));

    /* logcat 桥接线程 (Java 层崩溃栈 -> log.txt) */
    if (_cfg.useShell) _timers.push(_loopThread(_logcatBridgeOnce, 30));

    /* 哨兵线程 (独立线程, 与主循环互监控) */
    try {
        if (typeof threads !== 'undefined' && typeof threads.start === 'function') {
            _sentThread = threads.start(function () {
                while (!_stopRequested) {
                    var iv = Math.max(_cfg.sentinelIntervalSec, 5) * 1000;
                    for (var waited = 0; waited < iv && !_stopRequested; waited += 500) {
                        try { sleep(500); } catch (e0) { return; }
                    }
                    if (_stopRequested) break;
                    try { sentinelOnce(); } catch (e1) {}
                }
            });
        }
    } catch (e2) {
        log('哨兵线程启动失败(仅失去自监控): ' + e2.message);
    }

    log('看护已启动: 模式=' + _cfg.checkMode +
        ' 时段=' + (_cfg.guardWindowEnabled ? (_cfg.guardStart + '-' + _cfg.guardEnd) : '全天') +
        ' 目标App=' + _cfg.watchApps.length + ' 脚本=' + _cfg.watchScripts.length);
    return true;
}

function stopLoops() {
    if (!_running) return false;
    _running = false;
    _stopRequested = true;
    for (var i = 0; i < _timers.length; i++) {
        var t = _timers[i];
        if (!t) continue;
        try { if (typeof t === 'object' && typeof t.interrupt === 'function') t.interrupt(); } catch (e0) {}
    }
    _timers = [];
    _lastAction = '看护已停止';
    log(_lastAction);
    return true;
}

function isRunning() { return _running; }

/* UI 展示摘要 */
function summary() {
    var upSec = _running ? Math.floor((Date.now() - _startMs) / 1000) : 0;
    return {
        running: _running,
        checkMode: _cfg.checkMode,
        window: _cfg.guardWindowEnabled ? (_cfg.guardStart + '-' + _cfg.guardEnd) : '全天',
        inWindow: inGuardWindow(),
        clientLocal: _clientLocal,
        clientServer: _clientServer,
        lastAction: _lastAction,
        checks: _stats.checks,
        launches: _stats.launches,
        launchFails: _stats.launchFails,
        scriptRestarts: _stats.scriptRestarts,
        reports: _stats.reports,
        reportFails: _stats.reportFails,
        stalls: _stats.stalls,
        freezeRestarts: _stats.freezeRestarts,
        freezeState: _freezeState,
        httpErr: _proto ? _proto.lastHttpErr() : '',
        uptimeSec: upSec
    };
}

function init(proto) {
    _proto = proto;
    loadConfig();
    _proto.configure({ server: _cfg.server });
    return _cfg;
}

/* ==================== 看护目标解析 ==================== */
/* 支持 JSON 数组 [{"pkg":"x","name":"y"}] 或多行文本 (每行 "包名" 或 "包名|名称",
 * 脚本目标用路径: "路径" 或 "路径|名称"); 解析不出有效条目时返回 fallback。
 * 返回值统一清洗: 剔除 null/坏元素, fallback 同样清洗 */
function parseWatchTargets(s, key, fallback) {
    var t = String(s || '').trim();
    var result = null;
    if (t) {
        try {
            var v = JSON.parse(t);
            if (Array.isArray(v) && v.length > 0) result = v;
        } catch (e0) {}
        if (!result) {
            var lines = t.split(/\n+/);
            var arr = [];
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line) continue;
                var seg = line.split('|');
                var k = String(seg[0] || '').trim();
                if (!k) continue;
                /* pkg 按包名字符集校验 (过滤非法行); path 放宽 (路径可含中文/空格) */
                if (key === 'pkg' && !/^[A-Za-z0-9_\.\-]+$/.test(k)) continue;
                var item = {};
                item[key] = k;
                if (String(seg[1] || '').trim()) item.name = String(seg[1]).trim();
                arr.push(item);
            }
            if (arr.length) result = arr;
        }
    }
    if (!result) result = (fallback || []);
    var clean = [];
    for (var j = 0; j < result.length; j++) {
        var it = result[j];
        if (!it || typeof it !== 'object') continue;
        if (!String(it[key] || '').trim()) continue;
        clean.push(it);
    }
    return clean;
}

/* 目标列表转多行文本 (UI 回显用) */
function targetsToText(list, key) {
    var lines = [];
    var l = list || [];
    for (var i = 0; i < l.length; i++) {
        if (!l[i]) continue;
        var t = String(l[i][key] || '').trim();
        if (!t) continue;
        lines.push(t + (l[i].name ? '|' + String(l[i].name) : ''));
    }
    return lines.join('\n');
}

module.exports = {
    init: init,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    getConfig: getConfig,
    log: log,
    logErr: logErr,
    parseWatchTargets: parseWatchTargets,
    targetsToText: targetsToText,
    inGuardWindow: inGuardWindow,
    processAlive: processAlive,
    windowExists: windowExists,
    isOverlay: isOverlay,
    serverCheckAlive: serverCheckAlive,
    launchApp: launchApp,
    guardOnce: guardOnce,
    sentinelOnce: sentinelOnce,
    reportOnce: reportOnce,
    freezeOnce: freezeOnce,
    freezeCheckApp: freezeCheckApp,
    logcatBridgeOnce: _logcatBridgeOnce,
    windowSnapshot: windowSnapshot,
    windowExists: windowExists,
    frontPkg: frontPkg,
    fnv1a: fnv1a,
    startLoops: startLoops,
    stopLoops: stopLoops,
    isRunning: isRunning,
    summary: summary,
    buildWdState: buildWdState
};
