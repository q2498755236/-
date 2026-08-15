/* ==================== 卡密验证客户端 V2（自动化编辑器版） ====================
 * 签名方案 B：TOTP + 服务端盐双重绑定
 *   - TOTP 采用标准 RFC 6238（SHA1 + 动态截断 + Base32 密钥，兼容 Google Authenticator）
 *   - 请求签名 HMAC-SHA256(key = TOTP + 会话盐 + 种子)
 *   - 响应签名 HMAC-SHA256 校验，防伪造
 * 依赖 API：http.get / http.postJson / http.addHeader / auto.getValue / auto.setValue
 *           / auto.getClip / auto.toast / device.brand / device.model / device.product
 */

/* ==================== 配置区 (务必修改) ==================== */
var _u = "https://3000-8fae9ec7543c4704.monkeycode-ai.online/api";

/* TOTP 种子：Base32 编码（RFC 4648），此处为混淆存储，运行时由 _unmask 还原
 * 明文种子 = D67B65DNIELFRSWLICGZM47RENTKJTFL，客户端被完全逆向时仍有泄露风险，
 * 建议后续配合整体代码混淆/加固进一步抬高逆向成本 */
var _s = _unmask("1c470038745e761e11347b3c1038651c113270200f5f05021d3f6331083f741c", "Xq7zBk2P");

/* 心跳计时器：工具中需配置一个同名的"计时器"类型变量，验证成功后自动定时触发 loop 维持心跳 */
var _hbTimerVar = "心跳计时器";
var _hbTimerInterval = "0:60";

/* 设备指纹持久化文件：随机盐落盘后固定，保持指纹稳定（Root/模拟器可改硬件字段，此处只抬高门槛） */
var _deviceSaltFile = "/sdcard/.card_auth/device_salt.dat";

/* ==================== 全局变量（setup 中重置） ==================== */
var isCardValid = false;
var lastVerifyTime = 0;
var verifyResultMessage = "";
var deviceId = "";
var deviceFingerprint = "";
var sessionToken = "";
var lastHeartbeatTime = 0;
var serverTimeOffset = 0;
var lastNetworkTime = 0;
var sessionSalt = "";
var saltTime = 0;
var _deviceSalt = "";

/* ==================== 初始化（工具加载时执行一次） ==================== */
function setup() {
    isCardValid = false;
    lastVerifyTime = 0;
    verifyResultMessage = "";
    sessionToken = "";
    lastHeartbeatTime = 0;
    serverTimeOffset = 0;
    lastNetworkTime = 0;
    sessionSalt = "";
    saltTime = 0;
    _deviceSalt = _readFile(_deviceSaltFile);
    deviceId = _genDeviceId();
    deviceFingerprint = _genDeviceFingerprint();
    _syncTime();
    console.log('插件初始化完成');
    console.log('设备ID: ' + _maskId(deviceId));
    console.log('服务器: ' + _u);
}

/* ==================== 核心执行入口 ==================== */
function loop(action) {
    try {
        _maybeSendHeartbeat();
        switch (action) {
            case "条件类-判断卡密是否有效": {
                if (!isCardValid && (Date.now() - lastVerifyTime > 5000)) {
                    _verify();
                }
                return isCardValid;
            }
            case "条件类-判断是否需要重新验证": {
                return (Date.now() - lastVerifyTime) > 1800000;
            }
            case "动作类-执行卡密验证": {
                var result = _verify();
                auto.setValue("卡密验证状态", isCardValid ? "验证成功" : "验证失败");
                auto.setValue("验证结果状态", String(isCardValid));
                auto.setValue("验证失败原因", isCardValid ? "" : verifyResultMessage);
                return "验证操作完成";
            }
            case "动作类-重置验证状态": {
                _resetState();
                return "重置完成";
            }
            default:
                console.log('未知功能: ' + action);
                return false;
        }
    } catch (err) {
        console.log('插件执行异常: ' + err.message);
        return false;
    }
}

/* ==================== 主验证流程 ==================== */
function _verify() {
    return _verifyInternal(false);
}

function _verifyInternal(retried) {
    try {
        if (!_isSecureEndpoint()) {
            console.log('验证失败：服务端地址必须使用 HTTPS');
            _updateState(false, "服务端地址必须使用 HTTPS");
            return false;
        }
        lastVerifyTime = Date.now();
        var code = _getCardCode();
        if (!code) {
            console.log('验证失败：未获取到卡密');
            _updateState(false, "未获取到卡密");
            return false;
        }
        console.log('待验证卡密: ' + _maskCode(code));
        _ensureSalt();
        var timestamp = _getServerTime();
        var nonce = _genNonce();
        var totp = _genTOTP(timestamp);
        var sign = _genSign(code, deviceFingerprint, timestamp, nonce);
        var bodyObj = {
            code: code,
            device_id: deviceId,
            device_fingerprint: deviceFingerprint,
            client_info: "AutoJS-2.0.0",
            nonce: nonce,
            salt: sessionSalt,
            totp: totp,
            timestamp: timestamp,
            sign: sign
        };
        console.log('请求验证卡密: code=' + _maskCode(code) + ' ts=' + timestamp + ' totp=****** nonce=****');
        var text = _httpPost("/verify", bodyObj);
        var json = JSON.parse(text);
        if (!json || typeof json.data !== "string" || typeof json.sign !== "string") {
            console.log('服务器响应格式异常: 响应长度=' + String(text).length);
            _updateState(false, "服务器响应格式异常");
            return false;
        }
        if (!_verifyResponse(json.data, json.sign, code)) {
            console.log('验证失败：响应签名校验失败');
            _updateState(false, "响应签名校验失败");
            return false;
        }
        var payload = JSON.parse(_utf8Decode(_base64Decode(json.data)));
        if (payload.success !== true) {
            var msg = payload.message || "验证失败";
            if (!retried && (msg.indexOf("签名") > -1 || msg.indexOf("过期") > -1)) {
                console.log('会话盐可能失效，刷新后重试');
                _syncTime();
                return _verifyInternal(true);
            }
            console.log('服务器返回失败: ' + msg);
            _updateState(false, msg);
            return false;
        }
        sessionToken = payload.token || "";
        _updateState(true, "验证成功");
        lastHeartbeatTime = Date.now();
        _touchHeartbeatTimer();
        console.log('验证成功：卡密有效，会话已建立');
        return true;
    } catch (e) {
        console.log('验证异常: ' + e.message);
        _updateState(false, "网络异常: " + e.message);
        return false;
    }
}

/* ==================== 心跳会话维持（事件驱动，无定时器） ==================== */
function _touchHeartbeatTimer(stop) {
    try {
        auto.setValue(_hbTimerVar, stop ? "0:0" : _hbTimerInterval);
    } catch (e) {}
}

function _maybeSendHeartbeat() {
    if (!isCardValid) return;
    if (Date.now() - lastHeartbeatTime < 60000) return;
    _sendHeartbeat();
}

function _sendHeartbeat() {
    if (!isCardValid) return;
    try {
        if (!_isSecureEndpoint()) {
            console.log('心跳失败：服务端地址必须使用 HTTPS');
            _updateState(false, "服务端地址必须使用 HTTPS");
            return;
        }
        var code = _getCardCode();
        if (!code) return;
        _ensureSalt();
        var timestamp = _getServerTime();
        var nonce = _genNonce();
        var sign = _genSign(code, deviceFingerprint, timestamp, nonce);
        var bodyObj = {
            code: code,
            device_id: deviceId,
            device_fingerprint: deviceFingerprint,
            client_info: "AutoJS-2.0.0",
            nonce: nonce,
            salt: sessionSalt,
            timestamp: timestamp,
            sign: sign
        };
        var text = _httpPost("/heartbeat", bodyObj);
        var json = JSON.parse(text);
        if (json && typeof json.data === "string" && typeof json.sign === "string") {
            if (!_verifyResponse(json.data, json.sign, code)) {
                _updateState(false, "心跳响应签名校验失败");
                return;
            }
            var payload = JSON.parse(_utf8Decode(_base64Decode(json.data)));
            if (payload.success !== true) {
                _updateState(false, payload.message || "会话已失效");
            } else {
                lastHeartbeatTime = Date.now();
            }
        }
    } catch (e) {
        console.log('心跳失败: ' + e.message);
    }
}

function _resetState() {
    isCardValid = false;
    verifyResultMessage = "";
    lastVerifyTime = 0;
    sessionToken = "";
    lastHeartbeatTime = 0;
    _touchHeartbeatTimer(true);
    auto.setValue("卡密验证状态", "未验证");
    auto.setValue("验证结果状态", "false");
    auto.setValue("验证失败原因", "");
    console.log('验证状态已重置');
    try {
        auto.toast("验证状态已重置");
    } catch (e) {}
}

/* ==================== 状态更新 ==================== */
function _updateState(valid, message) {
    isCardValid = valid;
    verifyResultMessage = message || "";
    if (!valid) {
        lastHeartbeatTime = 0;
    }
    try {
        auto.toast(verifyResultMessage);
    } catch (e) {}
}

/* ==================== HTTP 封装 ==================== */
function _isSecureEndpoint() {
    return String(_u).indexOf("https://") === 0;
}

function _httpPost(path, obj) {
    try {
        http.addHeader("Content-Type", "application/json");
    } catch (e) {}
    var res = http.postJson(_u + path, obj);
    return _extractBody(res);
}

function _httpGet(path) {
    var res = http.get(_u + path);
    return _extractBody(res);
}

function _extractBody(res) {
    if (typeof res === "string") return res;
    if (res && typeof res.body === "string") return res.body;
    if (res && typeof res.bodyString === "string") return res.bodyString;
    return String(res);
}

/* ==================== 时间同步 ==================== */
function _syncTime() {
    try {
        var body = _httpGet("/time");
        var json = JSON.parse(body);
        if (json.timestamp) {
            var serverTime = json.timestamp * 1000;
            serverTimeOffset = serverTime - Date.now();
            lastNetworkTime = json.timestamp;
            sessionSalt = json.salt || "";
            saltTime = Date.now();
            console.log('时间同步: 偏移=' + serverTimeOffset + 'ms');
        }
    } catch (e) {
        serverTimeOffset = 0;
        sessionSalt = "";
        saltTime = 0;
        console.log('时间同步失败，使用本地时间: ' + e.message);
    }
}

function _ensureSalt() {
    if (!sessionSalt || (Date.now() - saltTime > 300000)) {
        _syncTime();
    }
}

function _getServerTime() {
    return Math.floor((Date.now() + serverTimeOffset) / 1000);
}

/* ==================== 敏感字段脱敏（日志输出） ==================== */
function _maskCode(code) {
    code = String(code || "");
    if (code.length <= 4) return "****";
    return code.substring(0, 4) + "***" + code.substring(code.length - 2);
}

function _maskId(id) {
    id = String(id || "");
    if (id.length <= 8) return "****";
    return id.substring(0, 8) + "***";
}

/* ==================== 设备指纹 ==================== */
function _readFile(path) {
    try {
        if (File.exist(path)) return String(File.read(path) || "").trim();
    } catch (e) {}
    return "";
}

function _writeFile(path, content) {
    try {
        var idx = path.lastIndexOf("/");
        var dir = idx > 0 ? path.substring(0, idx) : "";
        if (dir && !File.exist(dir)) File.mkdir(dir);
        File.write(path, content);
    } catch (e) {}
}

function _genDeviceId() {
    var info = String(device.brand || "") + "_" + String(device.model || "") + "_" + String(device.product || "");
    info = info.replace(/\s+/g, "").replace(/[^a-zA-Z0-9_]/g, "");
    if (info.length < 4) {
        info = "unknown_" + Math.floor(Math.random() * 1000000);
    }
    return "dev_" + _sha256(info).substring(0, 12);
}

function _genDeviceFingerprint() {
    if (!_deviceSalt || _deviceSalt.length < 8) {
        var chars = "abcdef0123456789";
        var s = "";
        for (var i = 0; i < 16; i++) {
            s += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        _deviceSalt = s;
        _writeFile(_deviceSaltFile, s);
    }
    var raw = (device.brand || "") + "|" + (device.model || "") + "|" + (device.product || "") +
              "|" + (device.width || "") + "|" + (device.height || "") + "|" + (device.dpi || "");
    if (String(raw).replace(/\|/g, "").length < 2) {
        raw = raw + "|" + _deviceSalt;
    }
    return _sha256(raw + "|" + _deviceSalt + "|" + _s);
}

/* ==================== 卡密获取 ==================== */
function _getCardCode() {
    var myCard = "";
    try {
        myCard = auto.getValue('CARD_CODE') || "";
        myCard = String(myCard).trim();
        if (myCard) console.log('从变量 CARD_CODE 读取卡密');
    } catch (e) {
        myCard = "";
    }
    if (!myCard || myCard.length < 5) {
        try {
            myCard = auto.getClip() || "";
            myCard = String(myCard).trim();
            if (myCard) console.log('从剪贴板读取卡密');
        } catch (e) {
            myCard = "";
        }
    }
    if (!myCard || myCard.length < 5 || myCard.length > 100) {
        return null;
    }
    var dangerous = ["{", "}", "function", "var ", "=>", "<script", "eval(", "exec("];
    for (var i = 0; i < dangerous.length; i++) {
        if (myCard.indexOf(dangerous[i]) > -1) {
            console.log('检测到危险内容: ' + dangerous[i]);
            return null;
        }
    }
    return myCard;
}

/* ==================== 种子混淆还原（XOR + Hex，防源码直接提取） ==================== */
function _unmask(hex, key) {
    var out = "";
    for (var i = 0; i < hex.length; i += 2) {
        var c = parseInt(hex.substr(i, 2), 16);
        out += String.fromCharCode(c ^ key.charCodeAt((i / 2) % key.length));
    }
    return out;
}

/* ==================== UTF-8 字节编码 ==================== */
function _utf8Bytes(message) {
    var out = "";
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

/* ==================== 纯 JS SHA256 ==================== */
function _sha256(message, rawBytes) {
    function rotateRight(n, x) {
        return (x >>> n) | (x << (32 - n));
    }

    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    var k = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

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
        var s = "", v;
        for (var i = 7; i >= 0; i--) {
            v = (n >>> (i * 4)) & 0xf;
            s += v.toString(16);
        }
        return s;
    }

    return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
}

/* ==================== 纯 JS SHA1（RFC 3174，输入为原始字节字符串） ==================== */
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
        var s = "";
        for (var i = 7; i >= 0; i--) {
            s += ((n >>> (i * 4)) & 0xf).toString(16);
        }
        return s;
    }

    return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
}

/* ==================== Hex 转原始字节字符串 ==================== */
function _hexToBytes(hex) {
    var out = "";
    for (var i = 0; i < hex.length; i += 2) {
        out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return out;
}

/* ==================== 纯 JS HMAC-SHA256 ==================== */
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
    var oKeyPad = "", iKeyPad = "";
    for (var i = 0; i < blockSize; i++) {
        oKeyPad += String.fromCharCode(keyBytes[i] ^ 0x5c);
        iKeyPad += String.fromCharCode(keyBytes[i] ^ 0x36);
    }
    return _sha256(oKeyPad + _hexToBytes(_sha256(iKeyPad + _utf8Bytes(message), true)), true);
}

/* ==================== 纯 JS HMAC-SHA1（RFC 2104，输入均为原始字节字符串） ==================== */
function _hmacSha1Bytes(messageBytes, keyBytes) {
    var blockSize = 64;
    var k = keyBytes;
    if (k.length > blockSize) {
        k = _hexToBytes(_sha1Raw(k));
    }
    while (k.length < blockSize) {
        k += String.fromCharCode(0);
    }
    var oPad = "", iPad = "";
    for (var i = 0; i < blockSize; i++) {
        var kb = k.charCodeAt(i) & 0xff;
        oPad += String.fromCharCode(kb ^ 0x5c);
        iPad += String.fromCharCode(kb ^ 0x36);
    }
    return _hexToBytes(_sha1Raw(oPad + _hexToBytes(_sha1Raw(iPad + messageBytes))));
}

/* ==================== Base64 解码 ==================== */
function _base64Decode(input) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var str = input.replace(/=+$/, "");
    var out = "";
    var buffer = 0, bitsCollected = 0;
    for (var i = 0; i < str.length; i++) {
        var c = chars.indexOf(str.charAt(i));
        if (c < 0) continue;
        buffer = (buffer << 6) | c;
        bitsCollected += 6;
        if (bitsCollected >= 8) {
            bitsCollected -= 8;
            out += String.fromCharCode((buffer >> bitsCollected) & 0xFF);
        }
    }
    return out;
}

/* ==================== UTF-8 字节解码 ==================== */
function _utf8Decode(str) {
    var out = "";
    var i = 0;
    while (i < str.length) {
        var c = str.charCodeAt(i);
        if (c < 0x80) {
            out += String.fromCharCode(c);
            i += 1;
        } else if (c < 0xe0) {
            out += String.fromCharCode(((c & 0x1f) << 6) | (str.charCodeAt(i + 1) & 0x3f));
            i += 2;
        } else if (c < 0xf0) {
            out += String.fromCharCode(((c & 0x0f) << 12) | ((str.charCodeAt(i + 1) & 0x3f) << 6) | (str.charCodeAt(i + 2) & 0x3f));
            i += 3;
        } else {
            var cp = ((c & 0x07) << 18) | ((str.charCodeAt(i + 1) & 0x3f) << 12) | ((str.charCodeAt(i + 2) & 0x3f) << 6) | (str.charCodeAt(i + 3) & 0x3f);
            cp -= 0x10000;
            out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
            i += 4;
        }
    }
    return out;
}

/* ==================== Base32 解码（RFC 4648，忽略空格/-，大小写不敏感） ==================== */
function _base32Decode(input) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    var cleaned = String(input).toUpperCase().replace(/[=\s-]/g, "");
    var bits = 0;
    var value = 0;
    var out = "";
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

/* ==================== 64 位无符号整数 → 8 字节大端序 ==================== */
function _intToBytes8(n) {
    var out = "";
    for (var i = 7; i >= 0; i--) {
        out += String.fromCharCode(Math.floor(n / Math.pow(256, i)) & 0xff);
    }
    return out;
}

/* ==================== 标准 TOTP（RFC 6238，SHA1 + 动态截断 + 6 位数字） ==================== */
function _totp(secretBase32, serverTime) {
    var secretBytes = _base32Decode(secretBase32);
    var counter = Math.floor(serverTime / 30);
    var msg = _intToBytes8(counter);
    var hmac = _hmacSha1Bytes(msg, secretBytes);
    var offset = hmac.charCodeAt(hmac.length - 1) & 0x0f;
    var bin = ((hmac.charCodeAt(offset) & 0x7f) << 24) |
              (hmac.charCodeAt(offset + 1) << 16) |
              (hmac.charCodeAt(offset + 2) << 8) |
              (hmac.charCodeAt(offset + 3));
    var code = bin % 1000000;
    return ("00000" + code).substr(-6);
}

/* ==================== 响应签名计算与验证 ==================== */
function _computeExpectedSign(base64Data, code) {
    var responseKey = _hexToBytes(_hmacSha256(code + _s, "response_salt_v2"));
    return _hmacSha256(base64Data, responseKey);
}

function _verifyResponse(base64Data, sign, keyHint) {
    return sign === _computeExpectedSign(base64Data, keyHint);
}

/* ==================== 请求签名生成（方案 B：TOTP + 服务端盐双重绑定） ==================== */
function _genTOTP(serverTime) {
    return _totp(_s, serverTime);
}

function _genSign(code, fingerprint, timestamp, nonce) {
    var totp = _genTOTP(timestamp);
    var params = [
        "client_info=AutoJS-2.0.0",
        "code=" + code,
        "device_fingerprint=" + fingerprint,
        "device_id=" + deviceId,
        "nonce=" + nonce,
        "salt=" + sessionSalt,
        "totp=" + totp,
        "timestamp=" + timestamp
    ].join("&");
    return _hmacSha256(params, totp + sessionSalt + _s);
}

function _genNonce() {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    var result = "";
    for (var i = 0; i < 16; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
