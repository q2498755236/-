/* ==================== 看门狗协议层 (对接设备管理系统服务端) ====================
 * 协议与自动化编辑器插件 monitor.js (v3 存储加固版) 完全同源:
 *   - TOTP RFC 6238 + HMAC-SHA256 请求签名 (方案 B)
 *   - 设备身份指纹式生成, 与编辑器插件共用 /sdcard/.mon_monitor/ 身份文件
 *     (deviceId/uuid/盐 三文件共享, 服务端状态页同一台设备只有一个身份)
 *   - 接口: POST /api/monitor/report (状态上报+状态指令回传)
 *           POST /api/monitor/vars  (网页端变量下发)
 *   - 计数文件共享: task_count.dat / error_count.dat / last_error.dat
 *     看门狗只增错误计数与最近错误, 任务计数由编辑器插件维护, 双端不互相覆盖
 * 纯 JS crypto 抄自 v2.js / monitor.js (真机验证过), Rhino 环境直接可用
 * 依赖 API: http.postJson / http.get (AutoX.js v7) / files|file|File 三形态文件层
 *           device.brand / device.model / device.product / device.width ...
 *           shell() (AutoX) 或 auto.shell() (编辑器), 全部安全探测降级
 */

/* ==================== 常量 (与 monitor.js 保持一致) ==================== */
var PROTO_UA = 'Googlebot/2.1 (+http://www.google.com/bot.html)';
var PROTO_TOTP_KEY = 'Mk7wQz9X';
var PROTO_TOTP_MASKED = '1838623e023c7819085d7427012d740078387840662363097e32753d024f6f1c';

var MON_DIR = '/sdcard/.mon_monitor';
var MON_ID_FILE = MON_DIR + '/device_id.dat';
var MON_SALT_FILE = MON_DIR + '/device_salt.dat';
var MON_UUID_FILE = MON_DIR + '/uuid.dat';
var MON_TASK_FILE = MON_DIR + '/task_count.dat';
var MON_ERR_FILE = MON_DIR + '/error_count.dat';
var MON_LASTERR_FILE = MON_DIR + '/last_error.dat';
var MON_EDITVARS_FILE = MON_DIR + '/edit_vars.json';

var _server = 'https://2498755236.byethost7.com';

function configure(opts) {
    opts = opts || {};
    if (opts.server) _server = String(opts.server).replace(/\/+$/, '');
}

function serverUrl() { return _server; }

/* ==================== 日志 ==================== */
function slog(msg) {
    try { console.log(String(msg).slice(0, 300)); } catch (e) {}
}

/* ==================== 文件层 (AutoX files 优先, 编辑器 file/File 兼容) ==================== */
function fMkdir(path) {
    if (typeof files !== 'undefined') {
        try { files.createWithDirs(path + '/.keep'); return; } catch (e0) {}
        try { files.ensureDir(path); return; } catch (e0b) {}
    }
    if (typeof file !== 'undefined') {
        if (typeof file.mkdir === 'function') { try { file.mkdir(path); return; } catch (e1) {} }
        if (typeof file.mkdirs === 'function') { try { file.mkdirs(path); return; } catch (e2) {} }
    }
    if (typeof File !== 'undefined') {
        try { File.mkdir(path); } catch (e3) {}
    }
}

function fWrite(path, content) {
    if (typeof files !== 'undefined' && typeof files.write === 'function') {
        try { files.write(path, String(content)); return true; } catch (e0) {}
    }
    if (typeof file !== 'undefined' && typeof file.write === 'function') {
        try { file.write(path, String(content)); return true; } catch (e1) {}
    }
    if (typeof File !== 'undefined' && typeof File.write === 'function') {
        try { File.write(path, String(content)); return true; } catch (e2) {}
    }
    return false;
}

function fRead(path) {
    if (typeof files !== 'undefined' && typeof files.read === 'function') {
        try { if (files.exists(path)) return String(files.read(path) || ''); } catch (e0) {}
    }
    if (typeof file !== 'undefined' && typeof file.read === 'function') {
        try { return String(file.read(path) || ''); } catch (e1) {}
    }
    if (typeof File !== 'undefined' && typeof File.read === 'function') {
        try { return String(File.read(path) || ''); } catch (e2) {}
    }
    return '';
}

function fExists(path) {
    if (typeof files !== 'undefined' && typeof files.exists === 'function') {
        try { return !!files.exists(path); } catch (e0) {}
    }
    if (typeof file !== 'undefined') {
        if (typeof file.exists === 'function') { try { return !!file.exists(path); } catch (e1) {} }
        if (typeof file.exist === 'function') { try { return !!file.exist(path); } catch (e2) {} }
    }
    if (typeof File !== 'undefined') {
        if (typeof File.exists === 'function') { try { return !!File.exists(path); } catch (e3) {} }
        if (typeof File.exist === 'function') { try { return !!File.exist(path); } catch (e4) {} }
    }
    return false;
}

/* 写入后立即回读验证, 失败返回 false (身份/盐依赖文件级持久化保证稳定) */
function fWriteVerified(path, content) {
    if (!fWrite(path, content)) return false;
    return fRead(path).trim() === String(content).trim();
}

/* ==================== 编辑器变量安全层 (AutoX 环境自动降级为空操作) ==================== */
function gv(key, fb) {
    try {
        if (typeof auto !== 'undefined' && typeof auto.getValue === 'function') {
            var v = auto.getValue(key);
            return (v === undefined || v === null) ? (fb === undefined ? '' : fb) : String(v);
        }
    } catch (e) {}
    return fb === undefined ? '' : fb;
}

function sv(key, val) {
    try {
        if (typeof auto !== 'undefined' && typeof auto.setValue === 'function') {
            auto.setValue(key, String(val));
        }
    } catch (e) {}
}

/* ==================== 纯 JS crypto (抄自 monitor.js / v2.js, 真机验证过) ==================== */
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

function _unmask(hex, key) {
    var out = '';
    for (var i = 0; i < hex.length; i += 2) {
        var c = parseInt(hex.substr(i, 2), 16);
        out += String.fromCharCode(c ^ key.charCodeAt((i / 2) % key.length));
    }
    return out;
}

function _monSeed() {
    return _unmask(PROTO_TOTP_MASKED, PROTO_TOTP_KEY);
}

function _genNonce() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var result = '';
    for (var i = 0; i < 16; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

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

/* ==================== 设备身份 (指纹式, 与编辑器插件共享文件) ==================== */

/* 稳定盐: 文件已有 -> 用; 无 -> 随机生成且写文件验证成功 -> 用; 文件不可用 -> 派生盐 */
function _stableSalt(devRaw) {
    var s = fRead(MON_SALT_FILE).trim();
    if (s.length >= 16) return s;
    var chars = 'abcdef0123456789';
    var rnd = '';
    for (var i = 0; i < 32; i++) {
        rnd += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    var idx = MON_SALT_FILE.lastIndexOf('/');
    if (idx > 0) fMkdir(MON_SALT_FILE.substring(0, idx));
    if (fWriteVerified(MON_SALT_FILE, rnd)) {
        return rnd;
    }
    return _sha256('mon_fp_v1:' + devRaw).substring(0, 32);
}

/* 随机 UUID: XXXX-XXXX-XXXX-XXXX (16 位大写 hex) */
function _genUuid() {
    var chars = '0123456789ABCDEF';
    var u = '';
    for (var i = 0; i < 16; i++) {
        u += chars.charAt(Math.floor(Math.random() * 16));
    }
    return u.substring(0, 4) + '-' + u.substring(4, 8) + '-' + u.substring(8, 12) + '-' + u.substring(12, 16);
}

/* 确保设备ID与UUID就绪, 返回 [deviceId, uuid]; 任何周期调用都安全 */
function ensureIdentity() {
    var devRaw = '';
    try {
        devRaw = (device.brand || '') + '|' + (device.model || '') + '|' + (device.product || '') +
                 '|' + (device.width || '') + '|' + (device.height || '') + '|' + (device.dpi || '');
    } catch (e) {
        devRaw = 'unknown';
    }
    if (String(devRaw).replace(/\|/g, '').length < 2) devRaw = devRaw + '|' + 'nodevice';

    var salt = _stableSalt(devRaw);
    var fp = _sha256(devRaw + '|' + salt).toUpperCase().substring(0, 24);

    var id = fRead(MON_ID_FILE).trim();
    if (!id || !/^[A-Za-z0-9_\-\.]{4,64}$/.test(id)) {
        id = 'M' + fp;
        fWrite(MON_ID_FILE, id);
    }

    var uuid = fRead(MON_UUID_FILE).trim();
    if (!uuid || !/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(uuid)) {
        uuid = _genUuid();
        fWrite(MON_UUID_FILE, uuid);
    }

    /* 同步到编辑器变量 (AutoX 环境自动降级), 业务插件可读 */
    sv('mon_device_id', id);
    sv('mon_uuid', uuid);
    sv('uuid', uuid);
    return [id, uuid];
}

/* ==================== 签名请求 (服务端 monitorVerifySigned 对应实现) ==================== */
/* 签名串: deviceId=<原始>&uuid=<原始>&nonce=<n>&timestamp=<s>&totp=<t>
 * 密钥: totp + seed; 服务端 ±120s 时间窗 + nonce 防重放 */

function _buildSigned(ident) {
    var nowSec = Math.floor(Date.now() / 1000);
    var seed = _monSeed();
    var nonce = _genNonce();
    var totp = _totp(seed, nowSec);
    var signParams = 'deviceId=' + ident[0] + '&uuid=' + ident[1] +
                     '&nonce=' + nonce + '&timestamp=' + nowSec + '&totp=' + totp;
    var sign = _hmacSha256(signParams, totp + seed);
    return {
        deviceId: ident[0],
        uuid: ident[1],
        timestamp: nowSec,
        nonce: nonce,
        totp: totp,
        sign: sign
    };
}

/* ==================== HTTP (AutoX.js v7 API, 与自动化编辑器的 http API 不同) ====================
 * AutoX v7: http.postJson(url, data, { headers }) 支持, 无 http.addHeader;
 * Response.body 是 ResponseBody 对象, 必须用 body.string() 取文本
 * (自动化编辑器 monitor.js 的 res.body 是纯字符串, 两者不可混用) */
var _lastHttpErr = '';

function _extractBody(res) {
    if (res === null || res === undefined) return '';
    if (typeof res === 'string') return res;
    if (typeof res === 'object') {
        try {
            if (res.body && typeof res.body.string === 'function') return String(res.body.string() || '');
        } catch (e0) {}
        try {
            if (typeof res.body === 'string') return res.body;
        } catch (e1) {}
    }
    return '';
}

function _statusCode(res) {
    try { return (res && typeof res.statusCode === 'number') ? res.statusCode : 0; } catch (e) { return 0; }
}

function _post(url, payload) {
    var res = null;
    try {
        res = http.postJson(url, payload, { headers: { 'User-Agent': PROTO_UA }, timeout: 15000 });
    } catch (e1) {
        try { res = http.postJson(url, payload); } catch (e2) {
            _lastHttpErr = String((e2 && e2.message) || e2).slice(0, 80);
            slog('http.postJson 异常: ' + url.slice(0, 60) + ' ' + _lastHttpErr);
            return '';
        }
    }
    var body = _extractBody(res);
    _lastHttpErr = body ? '' : ('HTTP ' + _statusCode(res) + ' 空响应');
    if (_lastHttpErr) slog('http.postJson 失败: ' + url.slice(0, 60) + ' ' + _lastHttpErr);
    return body;
}

/* GET 请求 (服务端 /api/monitor/list 用) */
function httpGet(url) {
    var res = null;
    try {
        res = http.get(url, { headers: { 'User-Agent': PROTO_UA }, timeout: 15000 });
    } catch (e1) {
        try { res = http.get(url); } catch (e2) {
            _lastHttpErr = String((e2 && e2.message) || e2).slice(0, 80);
            slog('http.get 异常: ' + url.slice(0, 60) + ' ' + _lastHttpErr);
            return '';
        }
    }
    var body = _extractBody(res);
    _lastHttpErr = body ? '' : ('HTTP ' + _statusCode(res) + ' 空响应');
    if (_lastHttpErr) slog('http.get 失败: ' + url.slice(0, 60) + ' ' + _lastHttpErr);
    return body;
}

/* ==================== 共享计数 (与编辑器插件同一套文件) ==================== */
function readNum(path) {
    var v = parseInt(fRead(path).trim(), 10);
    return (isFinite(v) && v > 0) ? Math.floor(v) : 0;
}

/* 看门狗错误记录: 自增共享错误计数 + 写最近错误 (双端共用, 状态页聚合展示) */
function recordError(msg) {
    var idx = MON_ERR_FILE.lastIndexOf('/');
    if (idx > 0) fMkdir(MON_ERR_FILE.substring(0, idx));
    var ec = readNum(MON_ERR_FILE) + 1;
    fWrite(MON_ERR_FILE, String(ec));
    fWrite(MON_LASTERR_FILE, String(msg || '').slice(0, 240));
    slog('错误记录: ' + ec + ' ' + String(msg || '').slice(0, 80));
    return ec;
}

function readTaskCount() {
    return readNum(MON_TASK_FILE);
}

/* ==================== 扩展采集 (全部安全探测降级, 不抛异常) ==================== */
/* useRoot: true 时用 root shell (su)。注意: 无 root 设备上 AutoX shell(cmd, true)
 * 内部 Process 为 null 时会抛 Java 层 NPE (Process.destroy on null, JS try-catch
 * 拦不住的线程崩溃), 因此默认一律普通 shell, root 仅在显式要求时使用 */
/* shell 互斥锁: 多工作线程并发调 shell 时 AutoX 内部 Process 管理非线程安全
 * (偶发 "Attempt to invoke void java.lang.Process..." NPE), 全部串行化 */
var _shellLock = (typeof threads !== 'undefined' && typeof threads.lock === 'function') ? threads.lock() : null;

function _shellOut(cmd, useRoot) {
    if (_shellLock) {
        try { _shellLock.lock(); } catch (eL) {}
    }
    try {
        if (typeof shell === 'function') {
            var r = useRoot ? shell(cmd, true) : shell(cmd, false);
            if (r === null || r === undefined) return '';
            /* AutoX shell 返回 { code, output }: output 为空串时不能用 || 兜底
             * (会把对象字符串化成 "[object Object]" 误判为有输出) */
            if (typeof r === 'object') {
                var o = (r.output !== undefined && r.output !== null) ? r.output : r.out;
                return String((o === undefined || o === null) ? '' : o);
            }
            return String(r);
        }
        if (typeof auto !== 'undefined' && typeof auto.shell === 'function') {
            return String(auto.shell(cmd) || '');
        }
        slog('shellOut: shell 与 auto.shell 均不可用: ' + cmd.slice(0, 60));
    } catch (e) {
        slog('shellOut 异常: ' + cmd.slice(0, 60) + ' ' + String((e && e.message) || e).slice(0, 120));
    } finally {
        if (_shellLock) {
            try { _shellLock.unlock(); } catch (eU) {}
        }
    }
    return '';
}

function batteryLevel() {
    var out = _shellOut('dumpsys battery');
    var m = out.match(/level:\s*(\d+)/);
    if (m) {
        var lv = parseInt(m[1], 10);
        if (lv >= 0 && lv <= 100) return lv;
    }
    return 255;
}

function memInfo() {
    var out = _shellOut('cat /proc/meminfo');
    var mt = out.match(/MemTotal:\s*(\d+)\s*kB/);
    var ma = out.match(/MemAvailable:\s*(\d+)\s*kB/);
    if (mt) {
        return [Math.floor(parseInt(mt[1], 10) / 1024), ma ? Math.floor(parseInt(ma[1], 10) / 1024) : 0];
    }
    return [0, 0];
}

function screenOnState() {
    try {
        if (typeof auto !== 'undefined' && typeof auto.isScreenOn === 'function') {
            return auto.isScreenOn() ? 1 : 0;
        }
        if (typeof device !== 'undefined' && typeof device.isScreenOn === 'function') {
            return device.isScreenOn() ? 1 : 0;
        }
    } catch (e) {}
    return 2;
}

function foregroundPkg() {
    try {
        if (typeof auto !== 'undefined' && typeof auto.currentPackage === 'function') {
            return String(auto.currentPackage() || '').slice(0, 120);
        }
        if (typeof currentPackage === 'function') {
            return String(currentPackage() || '').slice(0, 120);
        }
    } catch (e) {}
    return '';
}

/* ==================== 状态上报 ==================== */
/* extra: { note: 备注(状态页展示), wdState: 看门狗状态摘要(写 editorVer 字段, 上限 40 字) } */
function postReport(extra) {
    extra = extra || {};
    var ident = ensureIdentity();
    var mem = memInfo();

    var payload = _buildSigned(ident);
    payload.model = '';
    payload.brand = '';
    payload.product = '';
    payload.screen = '';
    payload.dpi = 0;
    payload.taskCount = readTaskCount();
    payload.errorCount = readNum(MON_ERR_FILE);
    payload.lastError = fRead(MON_LASTERR_FILE).trim().slice(0, 240);
    payload.note = String(extra.note || gv('mon_note')).slice(0, 240);
    payload.battery = batteryLevel();
    payload.memTotalMb = mem[0];
    payload.memAvailMb = mem[1];
    payload.screenOn = screenOnState();
    payload.foregroundPkg = foregroundPkg();
    payload.editorVer = String(extra.wdState || '').slice(0, 40);
    payload.gold = 0;
    payload.hp = 0;
    payload.floor = 0;
    payload.round = 0;
    payload.viewVar = '';

    try {
        payload.model = String(device.model || '');
        payload.brand = String(device.brand || '');
        payload.product = String(device.product || '');
        payload.screen = (device.width || 0) + 'x' + (device.height || 0);
        payload.dpi = Math.max(Math.floor(parseFloat(device.dpi) || 0), 0);
    } catch (e2) {}

    var resp = _post(_server + '/api/monitor/report', payload);
    return resp;
}

/* ==================== 变量下发 (网页端"修改变量"组) ==================== */
/* 成功返回 edit 字符串(可能为空串), 失败返回 null */
function fetchVars() {
    var ident = ensureIdentity();
    var body = _buildSigned(ident);
    var resp = _post(_server + '/api/monitor/vars', body);
    if (!resp) return null;
    try {
        var j = JSON.parse(String(resp));
        if (j && j.success) return String(j.edit || '');
        slog('变量同步失败: ' + String((j && j.message) || '').slice(0, 60));
        return null;
    } catch (e) {
        return null;
    }
}

/* 变量落盘: 供编辑器插件/业务脚本读取 (编辑器变量在 AutoX 环境不可达, 文件为共享通道) */
function saveEditVars(edit) {
    return fWrite(MON_EDITVARS_FILE, String(edit || ''));
}

module.exports = {
    configure: configure,
    serverUrl: serverUrl,
    ensureIdentity: ensureIdentity,
    postReport: postReport,
    fetchVars: fetchVars,
    httpGet: httpGet,
    saveEditVars: saveEditVars,
    recordError: recordError,
    readTaskCount: readTaskCount,
    sha256: _sha256,
    hmacSha256: _hmacSha256,
    totp: _totp,
    monSeed: _monSeed,
    buildSigned: _buildSigned,
    genNonce: _genNonce,
    fWrite: fWrite,
    fRead: fRead,
    fExists: fExists,
    fMkdir: fMkdir,
    gv: gv,
    sv: sv,
    slog: slog,
    lastHttpErr: function () { return _lastHttpErr; },
    extractBody: _extractBody,
    shellOut: _shellOut
};
