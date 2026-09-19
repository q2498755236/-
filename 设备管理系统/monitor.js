/* ==================== 设备运行状态监控插件 (v3 存储加固版) ====================
 * 独立运行于自动化编辑器, 与卡密插件 (v2.js) 完全无关
 * 服务端查看页: https://2498755236.byethost7.com/status.html
 *
 * 功能清单 (loop action):
 *   动作类-上报运行状态   向服务器上报设备状态 (内置 60 秒节流, 可放心高频触发)
 *   动作类-累计任务执行   业务任务完成时调用, 任务计数 +1
 *   动作类-记录运行错误   业务出错时调用, 读取 auto 参数 '错误信息' 记录
 *   动作类-重置监控计数   清零任务/错误计数
 *
 * v3 关键修复 (真机日志定位的两个 bug):
 *   1. "设备标识无效": 编辑器中 setup 周期写入的 auto 变量在动作周期读不到。
 *      改用 v2.js 真机验证过的存储模式: 文件存储优先 -> auto 变量兜底(带回读
 *      验证)。
 *      设备ID: 指纹式生成 (SHA256, 存储丢失也重算出同值)
 *      UUID:   随机生成 (文件 -> 变量 -> 都空随机生成, 写文件, 变量保底)
 *   2. "未返回数据": 编辑器要求动作返回数据。所有 case 改为 return 字符串
 *
 * 存储模式 (与 v2.js 相同, 真机验证过):
 *   file.write/read 优先 (/sdcard/.mon_monitor/), 失败回退 auto 变量,
 *   写入后立即回读验证, 两级都失败时身份靠设备指纹派生, 保证稳定
 *
 * 采集开关 (全部 false = 只用 v2.js 验证过的 API, 排查闪退用):
 *   MON_USE_SHELL  电量/内存 (auto.shell)
 *   MON_USE_SCREEN 屏幕开关 (auto.isScreenOn)
 *   MON_USE_PKG    前台应用 (auto.currentPackage)
 *   MON_USE_VER    编辑器版本 (auto.clientVersion)
 *   注意: JS try-catch 拦不住 native 层崩溃, 只能用开关禁用
 *
 * 上报内容: 基础信息 (品牌型号/屏幕/DPI) + 运行数据 (任务/错误/时长)
 *           + 扩展项 (电量/内存/屏幕开关/前台应用/编辑器版本, 单项失败自动降级)
 *           + 游戏进度 (金币/血量/层数/轮数, 读取 auto 变量 '金币' '血量' '层数' '轮数')
 *
 * 状态回传: 客户在状态页可将设备标记为 '挂机' 或 '离线', 服务端随心跳响应回传,
 * 插件写入 auto 变量 '状态' (取值: '在线' / '挂机' / '离线'),
 * 业务脚本用 auto.getValue('状态') 判断, 如 == '挂机' 暂停业务, == '离线' 结束任务。
 *
 * 编辑器变量同步 (内置, 随心跳自动执行, 无需配置 action):
 *   上报: auto 变量 '查看变量' 的内容随心跳上传, 状态页设备卡片只读展示
 *   下发: 状态页"修改变量"保存后, 设备下个心跳写入 auto 变量 '修改变量',
 *         业务脚本 auto.getValue('修改变量') 读取 (内容如 [{"name":"李四","count":4},...])
 *
 * 数组条件/动作 (loop action, 需配置工具变量: 数组变量名/匹配字段/匹配值/比较字段/
 *   判断条件/比较值/自增字段/步长, 详见 loop 内 case 注释):
 *   条件类-数组字段判断     判断数组内某条目字段是否符合条件, 返回 true/false
 *   动作类-数组字段自增     对数组内某条目字段自增并写回, 条目不存在自动新建
 *   动作类-数组字段自减     对数组内某条目字段自减并写回, 条目不存在自动新建
 *   动作类-数组字段自增自减 兼容旧配置: 步长正数自增/负数自减
 * ================================================================ */

var MON_SERVER = 'https://2498755236.byethost7.com';
var MON_UA = 'Googlebot/2.1 (+http://www.google.com/bot.html)';
var MON_INTERVAL_SEC = 60;

/* ---------- 缩略图配置 (速度优先, 能看就行) ----------
 * 独立生效, 与 MON_USE_SHELL 无关; 任一步失败静默放弃本张 */
var MON_USE_THUMB = true;            /* 缩略图总开关 */
var MON_THUMB_INTERVAL_SEC = 120;    /* 上传节流 (与心跳独立) */
var MON_THUMB_WIDTH = 180;           /* 缩略图宽度像素, 体积约 15-30KB */

/* TOTP 种子 (RFC 4648 Base32, XOR 混淆存储, 与卡密插件的种子相互独立)
 * 运行时 _unmask 还原; 服务端 config 保存明文 SEED 用于校验
 * 上报请求签名 = HMAC-SHA256(参数串, totp + 种子), 防抓包伪造与重放 */
var MON_TOTP_KEY = 'Mk7wQz9X';
var MON_TOTP_MASKED = '1838623e023c7819085d7427012d740078387840662363097e32753d024f6f1c';

/* ---------- 采集开关 (闪退排查) ----------
 * 全部 false 后插件只使用 v2.js 真机验证过的能力 (getValue/setValue/postJson/addHeader/file)
 * 若全关后仍闪退, 崩溃源在网络调用或编辑器本身; 若不闪退, 逐个打开定位崩溃源 */
var MON_USE_SHELL = false;   /* 电量/内存 (auto.shell) */
var MON_USE_SCREEN = false;  /* 屏幕开关 (auto.isScreenOn) */
var MON_USE_PKG = false;     /* 前台应用 (auto.currentPackage) */
var MON_USE_VER = false;     /* 编辑器版本 (auto.clientVersion) */

/* ---------- 持久化路径与兜底变量名 ---------- */
var MON_DIR = '/sdcard/.mon_monitor';
var MON_ID_FILE = MON_DIR + '/device_id.dat';        /* 兜底变量: mon_device_id */
var MON_SALT_FILE = MON_DIR + '/device_salt.dat';    /* 兜底变量: mon_device_salt */
var MON_UUID_FILE = MON_DIR + '/uuid.dat';           /* 兜底变量: mon_uuid */
var MON_TASK_FILE = MON_DIR + '/task_count.dat';     /* 兜底变量: mon_task_count */
var MON_ERR_FILE = MON_DIR + '/error_count.dat';     /* 兜底变量: mon_error_count */
var MON_LASTERR_FILE = MON_DIR + '/last_error.dat';  /* 兜底变量: mon_last_error */
var MON_LASTREP_FILE = MON_DIR + '/last_report.dat'; /* 兜底变量: mon_last_report */
var MON_THUMB_LAST_FILE = MON_DIR + '/last_thumb.dat'; /* 兜底变量: mon_last_thumb */
var MON_THUMB_FILE = MON_DIR + '/t.jpg';             /* 缩略图临时文件 */

/* 本周期内存缓存 (跨周期不保证保留, 身份可随时重算所以无影响) */
var monStartSec = 0;
var monLoopCount = 0;   /* 内存全局: 本周期动作调用计数, 第一次强制心跳+截图 */
var monLastReportMs = 0;

/* ---------- 安全读取工具: 任何异常都返回 fallback, 绝不抛出 ---------- */
function gv(key, fb) {
    try {
        var v = auto.getValue(key);
        return (v === undefined || v === null) ? (fb === undefined ? '' : fb) : String(v);
    } catch (e) {
        return fb === undefined ? '' : fb;
    }
}

function sv(key, val) {
    try { auto.setValue(key, String(val)); } catch (e) {}
}

function slog(msg) {
    try { console.log(String(msg).slice(0, 300)); } catch (e) {}
}

/* 业务变量安全读数 (金币/血量/层数/轮数等, 由业务脚本写入) */
function num(k) {
    var v = Number(gv(k, '0'));
    return isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/* ==================== 文件存储层 (抄自 v2.js 真机验证过的实现) ==================== */
function monFileMkdir(path) {
    if (typeof file !== 'undefined') {
        if (typeof file.mkdir === 'function') { try { file.mkdir(path); return; } catch (e) {} }
        if (typeof file.mkdirs === 'function') { try { file.mkdirs(path); return; } catch (e) {} }
    }
    if (typeof File !== 'undefined') {
        try { File.mkdir(path); } catch (e) {}
    }
}

function monFileWrite(path, content) {
    if (typeof file !== 'undefined' && typeof file.write === 'function') {
        try { file.write(path, content); return true; } catch (e) {}
    }
    if (typeof File !== 'undefined' && typeof File.write === 'function') {
        try { File.write(path, content); return true; } catch (e) {}
    }
    return false;
}

function monFileRead(path) {
    if (typeof file !== 'undefined' && typeof file.read === 'function') {
        try { return String(file.read(path) || ''); } catch (e) {}
    }
    if (typeof File !== 'undefined' && typeof File.read === 'function') {
        try { return String(File.read(path) || ''); } catch (e) {}
    }
    return '';
}

/* 读: 文件优先, auto 变量兜底 */
function monRead(path, varName) {
    var v = monFileRead(path);
    if (v) return v.trim();
    return gv(varName).trim();
}

/* 写: 文件优先并回读验证, 失败回退 auto 变量(同样带回读验证), 返回是否两级成功之一 */
function monWrite(path, varName, content) {
    content = String(content);
    var idx = path.lastIndexOf('/');
    var dir = idx > 0 ? path.substring(0, idx) : '';
    if (dir) monFileMkdir(dir);
    if (monFileWrite(path, content)) {
        if (monFileRead(path) === content) return true;
    }
    try {
        auto.setValue(varName, content);
        return gv(varName) === content;
    } catch (e) {
        return false;
    }
}

/* 读数值: 非法/缺失一律返回 >= 0 的整数 */
function monReadNum(path, varName) {
    var v = Number(monRead(path, varName) || '0');
    return isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/* ==================== 纯 JS SHA-1 + HMAC (抄自 v2.js, TOTP 依赖) ==================== */
function _sha1Raw(msg) {
    var h0 = 0x67452301;
    var h1 = 0xEFCDAB89;
    var h2 = 0x98BADCFE;
    var h3 = 0x10325476;
    var h4 = 0xC3D2E1F0;
    var ml = msg.length * 8;
    var padded = msg + String.fromCharCode(0x80);
    while (padded.length % 64 !== 56) {
        padded += String.fromCharCode(0);
    }
    var hi = Math.floor(ml / 0x100000000);
    var lo = ml >>> 0;
    padded += String.fromCharCode(
        (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
        (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff
    );
    var w = new Array(80);
    for (var blockStart = 0; blockStart < padded.length; blockStart += 64) {
        var i;
        for (i = 0; i < 16; i++) {
            var j = blockStart + i * 4;
            w[i] = ((padded.charCodeAt(j) & 0xff) << 24) |
                   ((padded.charCodeAt(j + 1) & 0xff) << 16) |
                   ((padded.charCodeAt(j + 2) & 0xff) << 8) |
                   (padded.charCodeAt(j + 3) & 0xff);
        }
        for (i = 16; i < 80; i++) {
            var n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = (n << 1) | (n >>> 31);
        }
        var a = h0, b = h1, c = h2, d = h3, e = h4;
        for (i = 0; i < 80; i++) {
            var f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6; }
            var temp = ((a << 5) | (a >>> 27)) + f + e + k + w[i];
            e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
        }
        h0 = (h0 + a) | 0;
        h1 = (h1 + b) | 0;
        h2 = (h2 + c) | 0;
        h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0;
    }
    function toHex(n) {
        var s = '';
        for (var i = 7; i >= 0; i--) {
            s += ((n >>> (i * 4)) & 0xf).toString(16);
        }
        return s;
    }
    return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
}

function _hexToBytes(hex) {
    var out = '';
    for (var i = 0; i < hex.length; i += 2) {
        out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return out;
}

function _hmacSha1Bytes(messageBytes, keyBytes) {
    var blockSize = 64;
    var k = keyBytes;
    if (k.length > blockSize) {
        k = _hexToBytes(_sha1Raw(k));
    }
    while (k.length < blockSize) {
        k += String.fromCharCode(0);
    }
    var oPad = '', iPad = '';
    for (var i = 0; i < blockSize; i++) {
        var kb = k.charCodeAt(i) & 0xff;
        oPad += String.fromCharCode(kb ^ 0x5c);
        iPad += String.fromCharCode(kb ^ 0x36);
    }
    return _hexToBytes(_sha1Raw(oPad + _hexToBytes(_sha1Raw(iPad + messageBytes))));
}

/* HMAC-SHA256 (抄自 v2.js, 请求签名用) */
function _hmacSha256(message, key) {
    var blockSize = 64;
    var hasWide = false;
    for (var i = 0; i < key.length; i++) {
        if (key.charCodeAt(i) > 0xff) { hasWide = true; break; }
    }
    var keyStr = hasWide ? _utf8Bytes(key) : key;
    var keyBytes = [];
    for (var i = 0; i < keyStr.length; i++) {
        keyBytes.push(keyStr.charCodeAt(i) & 0xff);
    }
    if (keyBytes.length > blockSize) {
        var keyHash = _sha256(keyStr);
        keyBytes = [];
        for (var i = 0; i < keyHash.length; i += 2) {
            keyBytes.push(parseInt(keyHash.substr(i, 2), 16));
        }
    }
    while (keyBytes.length < blockSize) {
        keyBytes.push(0);
    }
    var oKeyPad = '', iKeyPad = '';
    for (var i = 0; i < blockSize; i++) {
        oKeyPad += String.fromCharCode(keyBytes[i] ^ 0x5c);
        iKeyPad += String.fromCharCode(keyBytes[i] ^ 0x36);
    }
    return _sha256(oKeyPad + _hexToBytes(_sha256(iKeyPad + _utf8Bytes(message), true)), true);
}

/* ==================== 标准 TOTP (RFC 6238, 抄自 v2.js) ==================== */
function _base32Decode(input) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    var cleaned = String(input).toUpperCase().replace(/[=\s-]/g, '');
    var bits = 0;
    var value = 0;
    var out = '';
    for (var i = 0; i < cleaned.length; i++) {
        var idx = alphabet.indexOf(cleaned.charAt(i));
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out += String.fromCharCode((value >> bits) & 0xff);
        }
    }
    return out;
}

function _intToBytes8(n) {
    var out = '';
    for (var i = 7; i >= 0; i--) {
        out += String.fromCharCode(Math.floor(n / Math.pow(256, i)) & 0xff);
    }
    return out;
}

var _secretCache = '';
var _secretBytesCache = '';

function _totp(secretBase32, serverTime) {
    if (_secretCache !== secretBase32 || !_secretBytesCache) {
        _secretCache = secretBase32;
        _secretBytesCache = _base32Decode(secretBase32);
    }
    var secretBytes = _secretBytesCache;
    var counter = Math.floor(serverTime / 30);
    var msg = _intToBytes8(counter);
    var hmac = _hmacSha1Bytes(msg, secretBytes);
    var offset = hmac.charCodeAt(hmac.length - 1) & 0x0f;
    var bin = ((hmac.charCodeAt(offset) & 0x7f) << 24) |
              (hmac.charCodeAt(offset + 1) << 16) |
              (hmac.charCodeAt(offset + 2) << 8) |
              (hmac.charCodeAt(offset + 3));
    var code = bin % 1000000;
    return ('00000' + code).substr(-6);
}

/* 种子混淆还原 (XOR + Hex, 抄自 v2.js) */
function _unmask(hex, key) {
    var out = '';
    for (var i = 0; i < hex.length; i += 2) {
        var c = parseInt(hex.substr(i, 2), 16);
        out += String.fromCharCode(c ^ key.charCodeAt((i / 2) % key.length));
    }
    return out;
}

function _monSeed() {
    return _unmask(MON_TOTP_MASKED, MON_TOTP_KEY);
}

function _genNonce() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var result = '';
    for (var i = 0; i < 16; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/* ==================== 纯 JS SHA-256 (抄自 v2.js, 真机验证过) ==================== */
var _SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function _utf8Bytes(message) {
    var out = '';
    for (var i = 0; i < message.length; i++) {
        var c = message.charCodeAt(i);
        if (c < 0x80) {
            out += String.fromCharCode(c);
        } else if (c < 0x800) {
            out += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c < 0xd800 || c >= 0xe000) {
            out += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else {
            i++;
            c = 0x10000 + (((c & 0x3ff) << 10) | (message.charCodeAt(i) & 0x3ff));
            out += String.fromCharCode(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return out;
}

function _sha256(message, rawBytes) {
    function rotateRight(n, x) {
        return (x >>> n) | (x << (32 - n));
    }
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var k = _SHA256_K;
    var msg = rawBytes ? message : _utf8Bytes(message);
    var msgLen = msg.length * 8;
    var blocks = [];
    for (var i = 0; i < msg.length; i++) {
        var idx = i >> 2;
        if (blocks[idx] === undefined) blocks[idx] = 0;
        blocks[idx] |= (msg.charCodeAt(i) << (24 - (i % 4) * 8));
    }
    var padIdx = msg.length >> 2;
    if (blocks[padIdx] === undefined) blocks[padIdx] = 0;
    blocks[padIdx] |= 0x80 << (24 - (msg.length % 4) * 8);
    var totalBlocks = ((msg.length + 8 >> 6) + 1) * 16;
    for (var i = blocks.length; i < totalBlocks; i++) {
        if (blocks[i] === undefined) blocks[i] = 0;
    }
    blocks[totalBlocks - 1] = msgLen;
    for (var i = 0; i < blocks.length; i += 16) {
        var w = new Array(64);
        for (var t = 0; t < 16; t++) {
            w[t] = blocks[i + t] || 0;
        }
        for (var t = 16; t < 64; t++) {
            var s0 = rotateRight(7, w[t - 15]) ^ rotateRight(18, w[t - 15]) ^ (w[t - 15] >>> 3);
            var s1 = rotateRight(17, w[t - 2]) ^ rotateRight(19, w[t - 2]) ^ (w[t - 2] >>> 10);
            w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
        }
        var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (var t = 0; t < 64; t++) {
            var S1 = rotateRight(6, e) ^ rotateRight(11, e) ^ rotateRight(25, e);
            var ch = (e & f) ^ (~e & g);
            var temp1 = (h + S1 + ch + k[t] + w[t]) | 0;
            var S0 = rotateRight(2, a) ^ rotateRight(13, a) ^ rotateRight(22, a);
            var maj = (a & b) ^ (a & c) ^ (b & c);
            var temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    function toHex(n) {
        var s = '', v;
        for (var i = 7; i >= 0; i--) {
            v = (n >>> (i * 4)) & 0xf;
            s += v.toString(16);
        }
        return s;
    }
    return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
}

/* ==================== 设备身份 (指纹式, 同设备永远稳定) ==================== */

/* 稳定盐:
 * 1. 文件/变量里已有盐 -> 直接用 (真机文件可靠, 防同型号设备碰撞)
 * 2. 生成随机盐, 且文件级持久化验证成功 -> 用随机盐 (跨周期稳定)
 * 3. 文件不可用 -> 派生盐 (从设备参数计算, 同设备永远重算出同值;
 *    代价是同型号同分辨率设备指纹相同, 极端降级场景可接受, 与 v2.js 兜底同级)
 * 注意: auto 变量兜底写入不作为盐的可信持久层 (跨周期可能丢失, 真机已验证),
 *       仅在读取时做历史兼容 */
function monStableSalt(devRaw) {
    var s = monFileRead(MON_SALT_FILE).trim();
    if (s.length >= 16) return s;
    s = gv('mon_device_salt').trim();
    if (s.length >= 16) return s;
    var chars = 'abcdef0123456789';
    var rnd = '';
    for (var i = 0; i < 32; i++) {
        rnd += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    var idx = MON_SALT_FILE.lastIndexOf('/');
    if (idx > 0) monFileMkdir(MON_SALT_FILE.substring(0, idx));
    if (monFileWrite(MON_SALT_FILE, rnd) && monFileRead(MON_SALT_FILE) === rnd) {
        return rnd;
    }
    return _sha256('mon_fp_v1:' + devRaw).substring(0, 32);
}

/* 随机 UUID: XXXX-XXXX-XXXX-XXXX (16 位大写 hex) */
function monGenUuid() {
    var chars = '0123456789ABCDEF';
    var u = '';
    for (var i = 0; i < 16; i++) {
        u += chars.charAt(Math.floor(Math.random() * 16));
    }
    return u.substring(0, 4) + '-' + u.substring(4, 8) + '-' + u.substring(8, 12) + '-' + u.substring(12, 16);
}

/* 确保设备ID与UUID就绪, 返回 [deviceId, uuid]; 任何周期调用都安全 */
function monEnsureIdentity() {
    var devRaw = '';
    try {
        devRaw = (device.brand || '') + '|' + (device.model || '') + '|' + (device.product || '') +
                 '|' + (device.width || '') + '|' + (device.height || '') + '|' + (device.dpi || '');
    } catch (e) {
        devRaw = 'unknown';
    }
    if (String(devRaw).replace(/\|/g, '').length < 2) devRaw = devRaw + '|' + 'nodevice';

    var salt = monStableSalt(devRaw);
    var fp = _sha256(devRaw + '|' + salt).toUpperCase().substring(0, 24);

    /* 设备ID: 已持久化的优先 (老设备兼容), 否则用指纹, 写回持久化 */
    var id = monRead(MON_ID_FILE, 'mon_device_id');
    if (!id || !/^[A-Za-z0-9_\-\.]{4,64}$/.test(id)) {
        id = 'M' + fp;
        monWrite(MON_ID_FILE, 'mon_device_id', id);
    }

    /* UUID: 文件 -> 变量 -> 都空则随机生成;
     * 生成后写持久化文件, 文件写不进则编辑器变量保底 (monWrite 内置两级) */
    var uuid = monRead(MON_UUID_FILE, 'mon_uuid');
    if (!uuid || !/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(uuid)) {
        uuid = monGenUuid();
        monWrite(MON_UUID_FILE, 'mon_uuid', uuid);
    }

    /* 同步到变量, 业务脚本可读; uuid 写失败不影响上报 */
    sv('mon_device_id', id);
    sv('mon_uuid', uuid);
    sv('uuid', uuid);
    return [id, uuid];
}

/* ==================== 扩展采集 (全部有开关 + 降级) ==================== */
function monBattery() {
    if (!MON_USE_SHELL) return 255;
    try {
        var out = String(auto.shell('dumpsys battery') || '');
        var m = out.match(/level:\s*(\d+)/);
        if (m) {
            var lv = parseInt(m[1], 10);
            if (lv >= 0 && lv <= 100) return lv;
        }
    } catch (e) {}
    return 255;
}

function monMem() {
    if (!MON_USE_SHELL) return [0, 0];
    try {
        var out = String(auto.shell('cat /proc/meminfo') || '');
        var mt = out.match(/MemTotal:\s*(\d+)\s*kB/);
        var ma = out.match(/MemAvailable:\s*(\d+)\s*kB/);
        if (mt) {
            return [Math.floor(parseInt(mt[1], 10) / 1024), ma ? Math.floor(parseInt(ma[1], 10) / 1024) : 0];
        }
    } catch (e) {}
    return [0, 0];
}

/* ==================== 上报 (TOTP + 签名, 方案对齐 v2.js 方案 B) ==================== */
function monPostReport() {
    var nowSec = Math.floor(Date.now() / 1000);
    var ident = monEnsureIdentity();
    var mem = monMem();
    var screenOn = 2;
    if (MON_USE_SCREEN) {
        try { var on = auto.isScreenOn(); screenOn = on ? 1 : 0; } catch (e) {}
    }
    var foreground = '';
    if (MON_USE_PKG) {
        try { foreground = String(auto.currentPackage() || '').slice(0, 120); } catch (e) {}
    }
    var editorVer = '';
    if (MON_USE_VER) {
        try { editorVer = String(auto.clientVersion() || '').slice(0, 40); } catch (e) {}
    }
    /* TOTP + nonce + 签名: 防抓包伪造与重放 (签名覆盖身份与时间因子) */
    var seed = _monSeed();
    var nonce = _genNonce();
    var totp = _totp(seed, nowSec);
    var signParams = 'deviceId=' + ident[0] + '&uuid=' + ident[1] +
                     '&nonce=' + nonce + '&timestamp=' + nowSec + '&totp=' + totp;
    var sign = _hmacSha256(signParams, totp + seed);
    var payload = {
        deviceId: ident[0],
        uuid: ident[1],
        timestamp: nowSec,
        nonce: nonce,
        totp: totp,
        sign: sign,
        model: '',
        brand: '',
        product: '',
        screen: '',
        dpi: 0,
        taskCount: monReadNum(MON_TASK_FILE, 'mon_task_count'),
        errorCount: monReadNum(MON_ERR_FILE, 'mon_error_count'),
        lastError: monRead(MON_LASTERR_FILE, 'mon_last_error').slice(0, 240),
        uptimeSec: Math.max(nowSec - monStartSec, 0),
        note: gv('mon_note').slice(0, 240),
        battery: monBattery(),
        memTotalMb: mem[0],
        memAvailMb: mem[1],
        screenOn: screenOn,
        foregroundPkg: foreground,
        editorVer: editorVer,
        gold: num('金币'),
        hp: num('血量'),
        floor: num('层数'),
        round: num('轮数'),
        /* 编辑器"查看变量"随心跳上报 (网页端只读展示) */
        viewVar: gv('查看变量').slice(0, 65536)
    };
    try {
        payload.model = String(device.model || '');
        payload.brand = String(device.brand || '');
        payload.product = String(device.product || '');
        payload.screen = (device.width || 0) + 'x' + (device.height || 0);
        payload.dpi = Math.max(Math.floor(parseFloat(device.dpi) || 0), 0);
    } catch (e2) {}
    try { http.addHeader('User-Agent', MON_UA); } catch (e3) {}
    /* 两参数形式, 与卡密插件 v2.js 真机验证过的用法一致 */
    var res = http.postJson(MON_SERVER + '/api/monitor/report', payload);
    return typeof res === 'string' ? res : (res && res.body) || JSON.stringify(res);
}

/* 拉取服务端变量 (网页端"修改变量"组的内容), 非空则写回编辑器变量 '修改变量' 供业务脚本读取 */
function monFetchVars() {
    var nowSec = Math.floor(Date.now() / 1000);
    var ident = monEnsureIdentity();
    var seed = _monSeed();
    var nonce = _genNonce();
    var totp = _totp(seed, nowSec);
    var signParams = 'deviceId=' + ident[0] + '&uuid=' + ident[1] +
                     '&nonce=' + nonce + '&timestamp=' + nowSec + '&totp=' + totp;
    var sign = _hmacSha256(signParams, totp + seed);
    try { http.addHeader('User-Agent', MON_UA); } catch (e0) {}
    var res = http.postJson(MON_SERVER + '/api/monitor/vars', {
        deviceId: ident[0],
        uuid: ident[1],
        timestamp: nowSec,
        nonce: nonce,
        totp: totp,
        sign: sign
    });
    var body = typeof res === 'string' ? res : (res && res.body) || '';
    try {
        var j = JSON.parse(String(body));
        if (j && j.success) {
            var edit = String(j.edit || '');
            if (edit === '') return 'empty';
            sv('修改变量', edit);
            return 'ok:' + edit.length + 'B';
        }
        return 'fail:' + String((j && j.message) || '').slice(0, 60);
    } catch (e) { return 'parse-fail'; }
}

/* ==================== 缩略图 (截屏->缩放->imwrite->shell base64->上传) ====================
 * opencv 封装签名文档未给出, resize/imwrite 均做多形态兼容尝试;
 * 任一步失败返回空串放弃本张, 不影响心跳
 * 资源回收: Mat 是 native 内存 (全屏可达数 MB), release 后才真正归还;
 * 临时文件上传后立即删除; MON_USE_SHELL 关闭时整链跳过 (依赖 shell base64) */
function monMatRelease(m) {
    /* 编辑器 cv 文档: mat.delete() 释放原生内存, 防崩溃的关键 */
    if (!m) return;
    try { if (typeof m.delete === 'function') { m.delete(); return; } } catch (e) {}
    try { if (typeof m.release === 'function') { m.release(); return; } } catch (e2) {}
    try { if (typeof m.free === 'function') m.free(); } catch (e3) {}
}

function monFileExists(path) {
    if (typeof file !== 'undefined') {
        if (typeof file.exists === 'function') { try { return !!file.exists(path); } catch (e) {} }
        if (typeof file.exist === 'function') { try { return !!file.exist(path); } catch (e) {} }
    }
    if (typeof File !== 'undefined') {
        if (typeof File.exists === 'function') { try { return !!File.exists(path); } catch (e) {} }
        if (typeof File.exist === 'function') { try { return !!File.exist(path); } catch (e) {} }
    }
    return false;
}

function monTryImwrite(f, mat) {
    /* cv 文档样例: saveOk = cv.imwrite(path, mat, [IMWRITE_JPEG_QUALITY, q]) 有返回值; 以返回值+文件存在双判 */
    var isJpg = f.indexOf('.jpg') >= 0 || f.indexOf('.jpeg') >= 0;
    var ok = false;
    try { if (typeof cv !== 'undefined' && cv && cv.imwrite) { ok = isJpg ? !!cv.imwrite(f, mat, [cv.IMWRITE_JPEG_QUALITY, 60]) : !!cv.imwrite(f, mat); } } catch (e0) {}
    if (ok || monFileExists(f)) return true;
    try { if (typeof cv !== 'undefined' && cv && cv.imwrite) ok = !!cv.imwrite(mat, f); } catch (e2) {}   /* 反序兜底 */
    if (ok || monFileExists(f)) return true;
    try { if (typeof auto !== 'undefined' && auto.imwrite) ok = !!auto.imwrite(f, mat); } catch (e3) {}
    if (ok || monFileExists(f)) return true;
    try { ok = !!imwrite(f, mat); } catch (e4) {}
    return ok || monFileExists(f);
}

/* resize 自适应: 真机证实 cv.resize 为 OpenCV Java 签名 (src, dst, Size)
 * 返回 [结果Mat, 失败描述]; 结果为 null 时描述各形态异常 */
function monTryResize(mat, w, h) {
    var tags = [];
    var cvOK = false;
    try { cvOK = (typeof cv !== 'undefined' && cv && typeof cv.resize === 'function'); } catch (eN) {}
    if (!cvOK) {
        /* cv 不可用时退回 auto/全局/Mat 形态 */
        try { var a = auto.resize(mat, w, h); if (a) return [a, '']; } catch (eA) { tags.push('A(auto):' + String(eA && eA.message ? eA.message : eA).slice(0, 40)); }
        try { var b = resize(mat, w, h); if (b) return [b, '']; } catch (eB) { tags.push('B(global):' + String(eB && eB.message ? eB.message : eB).slice(0, 40)); }
        try { var c = mat.resize(w, h); if (c) return [c, '']; } catch (eC) { tags.push('C(mat):' + String(eC && eC.message ? eC.message : eC).slice(0, 40)); }
        return [null, tags.join(' ')];
    }
    /* E': cv.resize(src, dst, dsize, fx, fy, INTER_AREA), dst=clone; 6参为文档标准用法, 3参兜底(真机已验证) */
    var d = null;
    try { d = mat.clone(); } catch (eCl) { d = null; }
    if (!d) return [null, 'clone不可用'];
    try {
        try { cv.resize(mat, d, new cv.Size(w, h), 0, 0, cv.INTER_AREA); return [d, '']; } catch (eE6) { tags.push('E6(6参):' + String(eE6 && eE6.message ? eE6.message : eE6).slice(0, 50)); }
        try { cv.resize(mat, d, new cv.Size(w, h)); return [d, '']; } catch (eE) { tags.push('E(new Size):' + String(eE && eE.message ? eE.message : eE).slice(0, 50)); }
        /* K: dst 用空 Mat 重建 */
        var d2 = null;
        try { d2 = new cv.Mat(); } catch (eK0) { d2 = null; }
        if (d2) {
            try { cv.resize(mat, d2, new cv.Size(w, h)); monMatRelease(d); return [d2, '']; } catch (eK) { tags.push('K(newMat):' + String(eK && eK.message ? eK.message : eK).slice(0, 60)); monMatRelease(d2); d2 = null; }
        }
        monMatRelease(d); d = null;
    } catch (eX) { tags.push('X:' + String(eX && eX.message ? eX.message : eX).slice(0, 40)); monMatRelease(d); d = null; }
    return [null, tags.join(' ')];
}

/* 编辑器 cv 方法探测: opencv 方法挂在哪个命名空间由真机日志告知 */
function monProbeCv(mat) {
    var out = [];
    /* 1. cv / image 命名空间的方法枚举 (限 25 条防日志截断) */
    var holders = [];
    try { if (typeof cv !== 'undefined' && cv) holders.push(['cv', cv]); } catch (e1) {}
    try { if (typeof image !== 'undefined' && image) holders.push(['image', image]); } catch (e2) {}
    for (var h = 0; h < holders.length; h++) {
        var hk = [];
        try {
            for (var k in holders[h][1]) {
                if (/resiz|pyr|scale|img|mat|imread|imwrit|cvt|size|flip|rotat/i.test(k)) {
                    hk.push(k + '(' + typeof holders[h][1][k] + ')');
                    if (hk.length >= 25) break;
                }
            }
        } catch (e3) { hk.push('枚举失败:' + String(e3 && e3.message ? e3.message : e3).slice(0, 30)); }
        slog('缩略图[探测' + holders[h][0] + '] ' + hk.join(', '));
    }
    /* 2. auto 对象上与图像相关的方法名 */
    try {
        for (var k2 in auto) {
            if (/resiz|pyr|scale|img|mat|imread|imwrit|cvt|flip|rotat/i.test(k2)) out.push('auto.' + k2 + '(' + typeof auto[k2] + ')');
        }
    } catch (eA) { out.push('auto枚举失败:' + String(eA && eA.message ? eA.message : eA).slice(0, 40)); }
    slog('缩略图[探测auto] ' + out.join(', '));
    /* 3. Mat 实例可用方法名 (限 30 条防日志截断) */
    if (mat) {
        var mk = [];
        try {
            for (var k3 in mat) { mk.push(k3 + '(' + typeof mat[k3] + ')'); if (mk.length >= 30) break; }
        } catch (eM) { mk.push('mat枚举失败:' + String(eM && eM.message ? eM.message : eM).slice(0, 40)); }
        slog('缩略图[探测mat] ' + mk.join(', '));
    }
    return out;
}

function monThumbSmallFile() {
    /* cv 缩图链路: captureScreenMat -> cv.resize -> imwrite 落盘, 返回文件路径; 失败返回 '' */
    var mat = null, small = null, f = '';
    try {
        try { mat = auto.captureScreenMat(); } catch (eCap) { slog('缩略图[1截屏]异常: ' + (eCap && eCap.message ? eCap.message : eCap)); mat = null; }
        if (!mat) { slog('缩略图[1截屏]返回空: 检查编辑器截屏权限/授权弹窗'); return ''; }
        /* 空Mat检查 (cols/rows 无效会引发 resize "input size is zero") */
        var matOk = false;
        try { matOk = !!(mat.cols && mat.rows); } catch (eV) { matOk = true; }   /* cols不可访问时放行, 让resize自判 */
        if (!matOk) { monMatRelease(mat); mat = null; slog('缩略图[1截屏]空Mat: 尺寸为0'); return ''; }
        var w = MON_THUMB_WIDTH;
        var h = Math.floor(w * 2.16);   /* 常见手机竖屏比例, 服务端会按真实比例再缩 */
        var r1 = monTryResize(mat, w, h);
        var small = r1[0];
        if (!small) { r1 = monTryResize(mat, h, w); small = r1[0]; }
        /* 速度优先: 缩放失败直接放弃, 不上传全尺寸图; 顺带探测编辑器 cv 方法挂在哪 (须在 Mat 释放前) */
        if (!small) {
            try { monProbeCv(mat); } catch (eP) { slog('缩略图[探测]异常: ' + (eP && eP.message ? eP.message : eP)); }
            monMatRelease(mat); mat = null;
            slog('缩略图[2缩放]失败: ' + r1[1]);
            return '';
        }
        monMatRelease(mat); mat = null;   /* 全屏 Mat 立即归还 */
        f = MON_THUMB_FILE;
        if (!monTryImwrite(f, small)) {
            f = MON_DIR + '/t.png';
            if (!monTryImwrite(f, small)) {
                monMatRelease(small); small = null;
                slog('缩略图[3编码]失败: imwrite jpg/png 均未落盘');
                return '';
            }
        }
        monMatRelease(small); small = null;   /* 像素数据已落盘, 归还 */
        return f;
    } catch (e0) {
        slog('缩略图[?]异常: ' + (e0 && e0.message ? e0.message : e0));
        return '';
    } finally {
        monMatRelease(small);
        monMatRelease(mat);
    }
}

function monMakeThumbFile() {
    /* 双链路: 优先 cv 缩图 (15-30KB 快传); 失败退 auto.capture 全屏直传 (文档: auto.capture(path) 一步落盘, 大但稳) */
    var f = monThumbSmallFile();
    if (f) return f;
    try {
        auto.capture(MON_THUMB_FILE);
        if (monFileExists(MON_THUMB_FILE)) { slog('缩略图: cv链路失败, capture全屏兜底OK'); return MON_THUMB_FILE; }
        slog('缩略图[兜底]capture落盘失败');
    } catch (eC) { slog('缩略图[兜底]capture异常: ' + (eC && eC.message ? eC.message : eC)); }
    return '';
}

function monThumbUpload() {
    /* http.upload multipart 直传文件, 省掉 shell base64 (体积小 33%, 不依赖 shell) */
    var nowSec = Math.floor(Date.now() / 1000);
    var ident = monEnsureIdentity();
    var f = monMakeThumbFile();
    if (!f) return '';
    var seed = _monSeed();
    var nonce = _genNonce();
    var totp = _totp(seed, nowSec);
    var signParams = 'deviceId=' + ident[0] + '&uuid=' + ident[1] +
                     '&nonce=' + nonce + '&timestamp=' + nowSec + '&totp=' + totp;
    var sign = _hmacSha256(signParams, totp + seed);
    var data = {
        deviceId: ident[0],
        uuid: ident[1],
        timestamp: String(nowSec),
        nonce: nonce,
        totp: totp,
        sign: sign
    };
    var files = {};
    var baseName = f.indexOf('/t.png') >= 0 ? 't.png' : 't.jpg';
    files[baseName] = f;
    try { http.addHeader('User-Agent', MON_UA); } catch (e3) {}
    var res = http.upload(MON_SERVER + '/api/monitor/thumb', data, files);
    try { auto.shell('rm -f ' + f); } catch (eF) {}   /* 上传后清理临时文件 */
    return typeof res === 'string' ? res : (res && res.body) || '';
}

/* 缩略图节流入口: 上报动作内调用, 120s 一张; force=true 时跳过节流 (首次必截)
 * 独立开关, 链路内部失败自动放弃本张 */
function monMaybeThumb(force) {
    if (!MON_USE_THUMB) return;
    try {
        var now = Date.now();
        var last = Number(monRead(MON_THUMB_LAST_FILE, 'mon_last_thumb') || '0');
        if (!force && last > 0 && now - last < MON_THUMB_INTERVAL_SEC * 1000 - 2000) return;
        monWrite(MON_THUMB_LAST_FILE, 'mon_last_thumb', String(now));
        var r = monThumbUpload();
        var ok = String(r).indexOf('"success":true') >= 0;
        var skipped = ok && String(r).indexOf('"skipped":true') >= 0;
        sv('监控缩略图结果', ok ? (skipped ? 'ok (服务端限频跳过)' : 'ok') : (r ? String(r).slice(0, 120) : '截图或编码失败'));
        slog('缩略图: ' + (ok ? (skipped ? '服务端限频内跳过 (图未更新)' : '成功') : (r ? '失败 ' + String(r).slice(0, 60) : '截图或编码失败')));
    } catch (e) {}
}

/* ==================== 动作入口 ====================
 * 合并动作: 一次调用 = 任务累计 + 错误收集 + 重置检查 + 心跳(含缩略图)
 * 官方规范: auto.setValue 存结果 + break 结束, 无 return
 * 编辑器需导入: 输出 监控上报结果/状态/uuid; 输入 错误信息/重置监控(可选) */
function monDoAll() {
    var now = Date.now();
    var parts = [];
    /* 1. 任务累计: 每次调用即一次任务执行 */
    var t = monReadNum(MON_TASK_FILE, 'mon_task_count') + 1;
    monWrite(MON_TASK_FILE, 'mon_task_count', String(t));
    parts.push('任务' + t);
    slog('任务累计: ' + t);
    /* 2. 错误收集: '错误信息' 非空则计一次并清空 (防同一错误重复计数) */
    var msg = gv('错误信息');
    var ec = monReadNum(MON_ERR_FILE, 'mon_error_count');
    if (msg) {
        ec += 1;
        monWrite(MON_ERR_FILE, 'mon_error_count', String(ec));
        monWrite(MON_LASTERR_FILE, 'mon_last_error', msg.slice(0, 240));
        slog('错误累计: ' + ec + ' 最新: ' + msg.slice(0, 60));
        try { auto.setValue('错误信息', ''); } catch (eC) {}
        parts.push('错误' + ec);
    }
    /* 3. 重置指令: 业务脚本写 '重置监控'='1', 下一轮监控动作清零并写回 '0' */
    if (gv('重置监控') === '1') {
        monWrite(MON_TASK_FILE, 'mon_task_count', '0');
        monWrite(MON_ERR_FILE, 'mon_error_count', '0');
        monWrite(MON_LASTERR_FILE, 'mon_last_error', '');
        try { auto.setValue('重置监控', '0'); } catch (eR) {}
        slog('监控计数已重置 (任务/错误归零)');
        parts = ['任务0', '错误0'];
    }
    /* 4. 心跳上报 (60s 节流; 本周期第一次调用强制上报, 含状态/uuid 写入与缩略图) */
    monLoopCount += 1;
    var firstCall = (monLoopCount === 1);
    var lastRep = Number(monRead(MON_LASTREP_FILE, 'mon_last_report') || '0');
    if (!firstCall && lastRep > 0 && now - lastRep < MON_INTERVAL_SEC * 1000 - 2000) {
        slog('心跳: 跳过 (距上次 < ' + MON_INTERVAL_SEC + 's)');
        parts.push('心跳跳过');
    } else {
        if (firstCall) slog('首次调用: 强制心跳+截图');
        var resp = monPostReport();
        var ok = String(resp).indexOf('"success":true') >= 0;
        monWrite(MON_LASTREP_FILE, 'mon_last_report', String(now));
        parts.push(ok ? '心跳ok' : '心跳失败');
        slog('心跳上报: ' + (ok ? '成功' : '失败 ' + String(resp).slice(0, 100)));
        /* 服务端回传客户标记的设备状态, 写入变量 '状态' 供业务脚本判断 */
        try {
            var rj = JSON.parse(String(resp));
            if (rj && rj.success) {
                var st = String(rj.status || '').trim();
                sv('状态', st === '' ? '在线' : st);
            }
        } catch (e2) {}
        monMaybeThumb(firstCall);
        /* 拉取网页端修改的变量并写回编辑器 (业务脚本 auto.getValue('修改变量') 使用) */
        try {
            var vr = monFetchVars();
            if (vr !== 'empty') slog('变量同步: ' + vr);
        } catch (eV) { slog('变量同步异常: ' + (eV && eV.message ? eV.message : eV)); }
    }
    /* 5. 汇总写入结果变量 (单变量, 编辑器只导这一个就能看到全部结果) */
    var lastErr = monRead(MON_LASTERR_FILE, 'mon_last_error') || '';
    var summary = 'ok: ' + parts.join(' ') + (lastErr ? ' | 最近错误: ' + lastErr.slice(0, 40) : '');
    sv('监控上报结果', summary.slice(0, 200));
    slog('监控上报结果: ' + summary);
}

/* ==================== 数组变量条件/动作 (集成) ====================
 * 需要在编辑器里配置的工具变量 (auto.getValue 读取):
 *   数组变量名  要读写的数组变量, 如 人物配置
 *   匹配字段    按哪个字段定位条目, 默认 name
 *   匹配值      条目匹配值, 如 张三
 *   比较字段    条件类: 要比较的字段, 默认 count
 *   判断条件    条件类: 等于/不等于/大于/小于/包含/不包含/被包含
 *   比较值      条件类: 阈值, 如 2
 *   自增字段    动作类: 要自增自减的字段, 默认 count
 *   步长        动作类: 正数自增/负数自减, 默认 1
 * 数据格式: [{"name":"李四","count":4},{"name":"张三","count":2}] */

/* 安全读取并解析数组变量: 返回数组, 失败/为空返回 null */
function arrRead(varName) {
    var raw = auto.getValue(varName);
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    try {
        var arr = JSON.parse(String(raw));
        return Array.isArray(arr) ? arr : null;
    } catch (e) {
        slog('数组解析失败: ' + varName);
        return null;
    }
}

/* 按字段定位第一个匹配条目: 返回条目对象或 null */
function arrFind(arr, keyField, matchVal) {
    for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        if (it && typeof it === 'object' && String(it[keyField]) === String(matchVal)) return it;
    }
    return null;
}

/* 通用条件比较: 双侧可转数值时按数值比较, 否则按字符串比较 */
function condCheck(cond, fieldVal, cmpVal) {
    var fv = String(fieldVal === undefined || fieldVal === null ? '' : fieldVal);
    var cv = String(cmpVal === undefined || cmpVal === null ? '' : cmpVal);
    var fn = parseFloat(fv), cn = parseFloat(cv);
    var numeric = fv.trim() !== '' && cv.trim() !== '' && !isNaN(fn) && !isNaN(cn);
    if (cond === '等于') return numeric ? fn === cn : fv === cv;
    if (cond === '不等于') return numeric ? fn !== cn : fv !== cv;
    if (cond === '大于') return numeric && fn > cn;
    if (cond === '小于') return numeric && fn < cn;
    if (cond === '包含') return fv.indexOf(cv) >= 0;
    if (cond === '不包含') return fv.indexOf(cv) < 0;
    if (cond === '被包含') return fv !== '' && cv.indexOf(fv) >= 0;
    return false;
}

/* 自增/自减共用实现: inc=true 加, false 减; 步长取绝对值, 条目不存在自动新建 */
function arrIncDec(actionName, inc) {
    var aName = auto.getValue('数组变量名') || '';
    var kField = auto.getValue('匹配字段') || 'name';
    var mVal = auto.getValue('匹配值') || '';
    var iField = auto.getValue('自增字段') || 'count';
    var step = parseInt(auto.getValue('步长') || '1', 10);
    if (isNaN(step)) step = 1;
    step = Math.abs(step);
    var arr = arrRead(aName);
    if (arr === null) arr = [];
    var it = arrFind(arr, kField, mVal);
    if (it === null) {
        var fresh = {};
        fresh[kField] = mVal;
        fresh[iField] = inc ? step : -step;
        arr.push(fresh);
        it = fresh;
    } else {
        var cur = parseInt(it[iField], 10);
        if (isNaN(cur)) cur = 0;
        it[iField] = inc ? cur + step : cur - step;
    }
    auto.setValue(aName, JSON.stringify(arr));
    slog((inc ? '自增' : '自减') + ': ' + mVal + ' 的 ' + iField + ' => ' + it[iField] + ' (步长 ' + step + ')');
    return it[iField];
}

function loop(action) {
    try {
        switch (action) {
            case '动作类-监控上报':
            /* 旧动作名兼容, 新配置统一用 动作类-监控上报 */
            case '动作类-上报运行状态':
            case '动作类-累计任务执行':
            case '动作类-记录运行错误':
            case '动作类-重置监控计数':
                monDoAll();
                break;
            /* 条件类: 判断数组内某条目字段是否符合条件, 返回 true/false
             * case 名用双引号 + return 直接跟表达式 (与 v2.js 编辑器识别范式一致) */
            case "条件类-数组字段判断": {
                var varName = auto.getValue('数组变量名') || '';
                var keyField = auto.getValue('匹配字段') || 'name';
                var matchVal = auto.getValue('匹配值') || '';
                var cmpField = auto.getValue('比较字段') || 'count';
                var cond = auto.getValue('判断条件') || '等于';
                var cmpVal = auto.getValue('比较值') || '';
                var arr = arrRead(varName);
                if (arr === null) { slog('数组为空或解析失败: ' + varName); return false; }
                var it = arrFind(arr, keyField, matchVal);
                if (it === null) { slog('未找到条目: ' + keyField + '=' + matchVal); return false; }
                slog('条件判断: ' + matchVal + ' 的 ' + cmpField + '=' + it[cmpField] + ' ' + cond + ' ' + cmpVal);
                return condCheck(cond, it[cmpField], cmpVal);
            }
            /* 动作类: 数组内某条目字段自增, 写回原变量; 条目不存在时自动新建 (步长取绝对值, 默认 1) */
            case "动作类-数组字段自增":
                return arrIncDec(action, true);
            /* 动作类: 数组内某条目字段自减, 写回原变量; 条目不存在时自动新建 (步长取绝对值, 默认 1) */
            case "动作类-数组字段自减":
                return arrIncDec(action, false);
            /* 兼容旧动作名: 步长正数自增/负数自减 */
            case "动作类-数组字段自增自减": {
                var aName = auto.getValue('数组变量名') || '';
                var kField = auto.getValue('匹配字段') || 'name';
                var mVal = auto.getValue('匹配值') || '';
                var iField = auto.getValue('自增字段') || 'count';
                var step = parseInt(auto.getValue('步长') || '1', 10);
                if (isNaN(step)) step = 1;
                var arr2 = arrRead(aName);
                if (arr2 === null) arr2 = [];
                var it2 = arrFind(arr2, kField, mVal);
                if (it2 === null) {
                    var fresh = {};
                    fresh[kField] = mVal;
                    fresh[iField] = step;
                    arr2.push(fresh);
                    it2 = fresh;
                } else {
                    var cur = parseInt(it2[iField], 10);
                    if (isNaN(cur)) cur = 0;
                    it2[iField] = cur + step;
                }
                auto.setValue(aName, JSON.stringify(arr2));
                slog('自增自减: ' + mVal + ' 的 ' + iField + ' => ' + it2[iField] + ' (步长 ' + step + ')');
                break;
            }
            default:
                slog('未知功能: ' + action);
                return false;
        }
    } catch (err) {
        slog('插件执行异常: ' + (err && err.message ? err.message : err));
        try { auto.setValue('mon_last_error', String(err && err.message ? err.message : err).slice(0, 240)); } catch (e2) {}
        return false;
    }
}

/* ==================== 初始化 ==================== */
function setup() {
    try { if (typeof auto === 'undefined' || typeof http === 'undefined') { slog('监控插件警告: 缺少 auto/http 全局对象'); return; } } catch (e0) {}
    try {
        monStartSec = Math.floor(Date.now() / 1000);
        monLoopCount = 0;   /* 每次插件启动重新计数, 首次调用强制心跳+截图 */
        var ident = monEnsureIdentity();
        slog('监控插件初始化完成, 设备标识: ' + ident[0] + ', 设备UUID: ' + ident[1] + ', 上报间隔: ' + MON_INTERVAL_SEC + 's');
        slog('>>> 设备UUID已写入变量 uuid, 业务脚本可用 auto.getValue(\'uuid\') 读取');
        slog('>>> 查询本设备状态请访问状态页并输入 UUID: ' + ident[1]);
    } catch (e) {
        slog('监控初始化异常(已忽略): ' + e.message);
    }
}
