/* ==================== 卡密验证客户端 V2（自动化编辑器版） ====================
 * 签名方案 B：TOTP + 服务端盐双重绑定
 *   - TOTP 采用标准 RFC 6238（SHA1 + 动态截断 + Base32 密钥，兼容 Google Authenticator）
 *   - 请求签名 HMAC-SHA256(key = TOTP + 会话盐 + 种子)
 *   - 响应签名 HMAC-SHA256 校验，防伪造
 * 设备绑定：服务端首次验证签发 UUID（AES-GCM 加密下发），客户端存密文并回传，
 *   服务端解密校验绑定与指纹，客户端本地不再自造设备 ID（服务端可控、可吊销）
 * 依赖 API：http.get / http.postJson / http.addHeader / auto.getValue / auto.setValue
 *           / auto.getClip / auto.toast / device.brand / device.model / device.product
 */

/* ==================== 配置区 (务必修改) ==================== */
var _pluginVersion = "2.9.0";
var _u = "https://2498755236.byethost7.com/api";

/* TOTP 种子：Base32 编码（RFC 4648），此处为混淆存储，运行时由 _unmask 还原。
 * 客户端被完全逆向时仍有泄露风险，请勿在注释中保留明文种子 */
var _s = _unmask("1c470038745e761e11347b3c1038651c113270200f5f05021d3f6331083f741c", "Xq7zBk2P");

/* 心跳计时器：工具中需配置一个同名的"计时器"类型变量，验证成功后自动定时触发 loop 维持心跳 */
var _hbTimerVar = "心跳计时器";
var _hbTimerInterval = "0:60";
var _hbIntervalMs = 60000;

/* 设备指纹持久化文件：随机盐落盘后固定，保持指纹稳定（Root/模拟器可改硬件字段，此处只抬高门槛） */
var _deviceSaltFile = "/sdcard/.card_auth/device_salt.dat";

/* 设备 UUID 持久化文件：服务端首次验证签发（密文），客户端仅存储并在后续请求中回传，
 * 文件丢失时由服务端按指纹匹配重新绑定 */
var _uuidFile = "/sdcard/.card_auth/device_uuid.dat";

/* ==================== 全局变量（setup 中重置） ==================== */
var isCardValid = false;
var lastVerifyTime = 0;
var verifyResultMessage = "";
var deviceFingerprint = "";
var _uuidCipher = "";
var sessionToken = "";
var lastHeartbeatTime = 0;
var serverTimeOffset = 0;
var sessionSalt = "";
var saltTime = 0;
var _deviceSalt = "";
var _retryDelay = 5000;
var _cardExpireAt = 0;

/* 心跳连续失败计数：网络抖动时避免卡密状态频繁失效，连续 3 次失败才标记失效 */
var _hbFailCount = 0;
var _HB_MAX_FAIL = 3;

/* 指纹兜底盐：设备盐文件持久化失败时使用，保证同一设备指纹稳定（同设备重复验证不判为新设备） */
var _fallbackSalt = "";
function _getFallbackSalt() {
    if (!_fallbackSalt) _fallbackSalt = _sha256("card_fp_fallback:" + _s).substring(0, 16);
    return _fallbackSalt;
}

/* ==================== 初始化（工具加载时执行一次） ==================== */
function setup() {
    isCardValid = false;
    lastVerifyTime = 0;
    verifyResultMessage = "";
    sessionToken = "";
    lastHeartbeatTime = 0;
    serverTimeOffset = 0;
    sessionSalt = "";
    saltTime = 0;
    _retryDelay = 5000;
    _cardExpireAt = 0;
    _deviceSalt = _readFile(_deviceSaltFile);
    _uuidCipher = _readFile(_uuidFile);
    deviceFingerprint = _genDeviceFingerprint();
    _syncTime();
    console.log('设备盐: ' + (_deviceSalt ? '已加载' : '未找到') + ', UUID: ' + (_uuidCipher ? '已加载' : '未找到') +
        ', 存储通道: ' + (_isFileAvailable() ? '文件' : '编辑器变量'));
    console.log('插件初始化完成');
    console.log('插件版本: ' + _pluginVersion);
    console.log('设备UUID: ' + (_uuidCipher ? _maskId(_uuidCipher) : '（未绑定，待首次验证下发）'));
    console.log('服务器: ' + _u);
}

/* ==================== 核心执行入口 ==================== */
function loop(action) {
    try {
        _maybeSendHeartbeat();
        switch (action) {
            case "条件类-判断卡密是否有效": {
                if (!isCardValid && (Date.now() - lastVerifyTime > _retryDelay)) {
                    _verify();
                }
                return _isCardActuallyValid();
            }
            case "条件类-判断卡密是否无效": {
                if (isCardValid && (Date.now() - lastVerifyTime > _retryDelay)) {
                    _verify();
                }
                return !_isCardActuallyValid();
            }
            case "条件类-3分钟检测卡密": {
                if (Date.now() - lastVerifyTime >= 180000) {
                    _verify();
                }
                return !_isCardActuallyValid();
            }
            case "条件类-判断是否需要重新验证": {
                return (Date.now() - lastVerifyTime) > 1800000;
            }
            case "动作类-执行卡密验证": {
                _verify();
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
    return _verifyInternal();
}

function _verifyInternal() {
    try {
        lastVerifyTime = Date.now();
        var result = _signedCall("/verify", false, true);
        if (!result.success) {
            var cls = _classifyError(result.message);
            if (cls.kind === 'business') {
                _retryDelay = Math.min(_retryDelay + 30000, 600000);
            } else {
                _backoff();
            }
            console.log('验证失败: ' + result.message + ' (kind=' + cls.kind + ')');
            _updateState(false, result.message);
            return false;
        }
        _retryDelay = 5000;
        sessionToken = result.token;
        _cardExpireAt = result.expireAt || 0;
        var _wasValid = isCardValid;
        _updateState(true, "验证成功");
        lastHeartbeatTime = Date.now();
        _touchHeartbeatTimer();
        if (result.uuid && result.uuid !== _uuidCipher) {
            _uuidCipher = result.uuid;
            if (!_writeFile(_uuidFile, result.uuid)) {
                console.log('UUID 文件写入失败，下次验证将按指纹重新绑定');
            }
        }
        console.log('验证成功：卡密有效，会话已建立');
        var _expireAt = result.expireAt || 0;
        var _expireText = "";
        if (_expireAt > 0) {
            var _days = Math.ceil((_expireAt * 1000 - Date.now()) / 86400000);
            _expireText = _days > 0 ? (_days + ' 天') : '已到期';
        } else {
            _expireText = '永久';
        }
        console.log('卡密有效期: ' + _expireText);
        if (_expireAt > 0 && _days > 0 && _days <= 3) {
            console.log('警告：卡密即将到期，请及时续费');
            _expireText = _expireText + '，即将到期，请及时续费';
        }
        try {
            if (!_wasValid) {
                auto.toast("卡密有效，有效期: " + _expireText);
            }
        } catch (e) {}
        return true;
    } catch (e) {
        var cls = _classifyError(e.message);
        _backoff();
        console.log('验证异常: ' + e.message + ' (kind=' + cls.kind + ')');
        _updateState(false, "网络异常: " + e.message);
        return false;
    }
}

/* 验证失败指数退避：5s -> 10s -> 20s -> 40s 封顶，带 ±20% 随机抖动避免客户端雪崩 */
function _backoff() {
    _retryDelay = Math.min(_retryDelay * 2, 40000);
    var jitter = 0.8 + Math.random() * 0.4;
    _retryDelay = Math.round(_retryDelay * jitter);
}

/* 错误分类：判断错误是否可自动重试
 * 返回 { retryable: bool, kind: string }
 *  - network    网络层故障（可重试）
 *  - salt       会话盐失效（可重试，刷新盐后重试）
 *  - signature  签名校验失败（可重试一次）
 *  - retryable  服务端提示可重试（如会话已失效）
 *  - business   业务拒绝（卡密无效/锁定/冻结/过期等，不可重试）
 *  - fatal      致命错误（不可重试） */
function _classifyError(message) {
    var msg = String(message || '');
    if (msg.indexOf('网络') > -1 || msg.indexOf('超时') > -1 ||
        msg.indexOf('无法连接') > -1 || msg.indexOf('连接') > -1 ||
        msg.indexOf('格式异常') > -1 || msg.indexOf('解析异常') > -1 ||
        msg.indexOf('未获取到卡密') > -1) {
        return { retryable: true, kind: 'network' };
    }
    if (msg.indexOf('会话盐') > -1 || msg.indexOf('会话已失效') > -1) {
        return { retryable: true, kind: 'salt' };
    }
    if (msg.indexOf('签名') > -1) {
        return { retryable: true, kind: 'signature' };
    }
    if (msg.indexOf('失败次数过多') > -1) {
        return { retryable: false, kind: 'locked' };
    }
    if (msg.indexOf('不存在') > -1 || msg.indexOf('已锁定') > -1 ||
        msg.indexOf('已冻结') > -1 || msg.indexOf('已过期') > -1 ||
        msg.indexOf('已达上限') > -1 || msg.indexOf('未绑定') > -1 ||
        msg.indexOf('指纹不匹配') > -1 || msg.indexOf('HTTPS') > -1) {
        return { retryable: false, kind: 'business' };
    }
    return { retryable: true, kind: 'network' };
}

/* ==================== 签名请求通用流程（验证/心跳共用） ====================
 * 服务端盐失效（重启或过期）时自动刷新盐并重试一次，实现心跳自愈 */
function _signedCall(path, retried, verbose) {
    if (!_isSecureEndpoint()) {
        return { success: false, message: '服务端地址必须使用 HTTPS' };
    }
    var code = _getCardCode(verbose);
    if (!code) {
        return { success: false, message: '未获取到卡密' };
    }
    if (verbose) console.log('待验证卡密: ' + _maskCode(code));
    _ensureSalt();
    if (!sessionSalt) {
        return { success: false, message: '无法连接服务器（时间同步失败）' };
    }
    var timestamp = _getServerTime();
    var nonce = _genNonce();
    var totp = _genTOTP(timestamp);
    var tokenVal = path === "/heartbeat" ? sessionToken : "";
    var sign = _genSign(code, deviceFingerprint, timestamp, nonce, tokenVal, totp);
    var bodyObj = {
        code: code,
        uuid: _uuidCipher,
        device_fingerprint: deviceFingerprint,
        client_info: "AutoJS-2.0.0",
        nonce: nonce,
        salt: sessionSalt,
        totp: totp,
        timestamp: timestamp,
        token: tokenVal,
        sign: sign
    };
    if (verbose) console.log('请求验证卡密: code=' + _maskCode(code) + ' ts=' + timestamp + ' totp=****** nonce=****');
    var text = _httpPost(path, bodyObj);
    if (text && typeof text === 'object' && text._err) {
        return { success: false, message: text._err };
    }
    var json = _parseJsonSafe(text);
    if (json && json.success === false && typeof json.data !== "string") {
        return { success: false, message: json.message || '请求失败' };
    }
    if (!json || typeof json.data !== "string" || typeof json.sign !== "string") {
        var hint = "";
        if (typeof text === 'string' && text.trim().charAt(0) !== '{') {
            hint = "（响应非 JSON，请检查服务地址或服务是否启动）";
        }
        console.log('服务器响应格式异常: 响应长度=' + String(text).length + hint);
        return { success: false, message: '服务器响应格式异常' + hint };
    }
    if (!_verifyResponse(json.data, json.sign, code)) {
        if (!retried) {
            console.log('响应签名校验失败，刷新会话盐后重试');
            _syncTime();
            return _signedCall(path, true, verbose);
        }
        return { success: false, message: '响应签名校验失败' };
    }
    var payload = _parseJsonSafe(_utf8Decode(_base64Decode(json.data)));
    if (!payload) {
        return { success: false, message: '服务器数据解析异常' };
    }
    if (payload.success !== true) {
        var msg = payload.message || "验证失败";
        var cls = _classifyError(msg);
        if (!retried && (cls.kind === 'salt' || cls.kind === 'signature')) {
            console.log('会话盐可能失效，刷新后重试');
            _syncTime();
            return _signedCall(path, true, verbose);
        }
        return { success: false, message: msg, retryable: (cls.kind === 'salt') };
    }
    return { success: true, message: payload.message || "", token: payload.token || "", expireAt: payload.expireAt || 0, uuid: payload.uuid || "" };
}

function _parseJsonSafe(text) {
    if (typeof text !== 'string') return null;
    text = text.trim();
    if (text.charAt(0) !== '{') return null;
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
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
    if (Date.now() - lastHeartbeatTime < _hbIntervalMs) return;
    _sendHeartbeat();
}

function _sendHeartbeat() {
    if (!isCardValid) return;
    try {
        var result = _signedCall("/heartbeat", false, false);
        if (!result.success) {
            if (result.retryable) {
                console.log('会话已失效，自动重新验证');
                _verify();
                return;
            }
            var cls = _classifyError(result.message);
            if (cls.kind === 'network') {
                _hbFailCount++;
                console.log('心跳失败(' + _hbFailCount + '/' + _HB_MAX_FAIL + '): ' + result.message);
                if (_hbFailCount >= _HB_MAX_FAIL) {
                    _hbFailCount = 0;
                    _updateState(false, result.message);
                }
                return;
            }
            _hbFailCount = 0;
            _updateState(false, result.message);
            return;
        }
        _hbFailCount = 0;
        lastHeartbeatTime = Date.now();
    } catch (e) {
        _hbFailCount++;
        console.log('心跳异常(' + _hbFailCount + '/' + _HB_MAX_FAIL + '): ' + e.message);
        if (_hbFailCount >= _HB_MAX_FAIL) {
            _hbFailCount = 0;
            _updateState(false, "心跳异常: " + e.message);
        }
    }
}

function _resetState() {
    isCardValid = false;
    verifyResultMessage = "";
    lastVerifyTime = 0;
    sessionToken = "";
    lastHeartbeatTime = 0;
    _cardExpireAt = 0;
    _hbFailCount = 0;
    _touchHeartbeatTimer(true);
    auto.setValue("卡密验证状态", "未验证");
    auto.setValue("验证结果状态", "false");
    auto.setValue("验证失败原因", "");
    console.log('验证状态已重置');
    try {
        auto.toast("验证状态已重置");
    } catch (e) {}
}

/* ==================== 状态更新（同步写入编辑器变量，任何路径触发均刷新） ==================== */
function _isCardActuallyValid() {
    if (!isCardValid) return false;
    if (_cardExpireAt > 0 && _cardExpireAt * 1000 < Date.now()) {
        _updateState(false, "卡密已到期");
        return false;
    }
    return true;
}

function _updateState(valid, message) {
    var changed = isCardValid !== valid;
    isCardValid = valid;
    verifyResultMessage = message || "";
    if (!valid) {
        lastHeartbeatTime = 0;
    }
    if (changed) {
        try {
            auto.toast(verifyResultMessage);
        } catch (e) {}
    }
    try {
        auto.setValue("卡密验证状态", valid ? "验证成功" : "验证失败");
        auto.setValue("验证结果状态", String(valid));
        auto.setValue("验证失败原因", valid ? "" : verifyResultMessage);
    } catch (e) {}
}

/* ==================== HTTP 封装 ==================== */
function _isSecureEndpoint() {
    return String(_u).indexOf("https://") === 0;
}

/* ==================== 服务端 JS 挑战处理 (ByetHost 防护) ==================== */
var _challengeCookie = "";
try { _challengeCookie = auto.getValue("server_challenge_cookie") || ""; } catch (e) {}

function _hexToBytes(h) {
    var arr = [];
    for (var i = 0; i < h.length; i += 2) arr.push(parseInt(h.substr(i, 2), 16));
    return arr;
}

function _bytesToHex(b) {
    var HEX = "0123456789abcdef";
    var s = "";
    for (var i = 0; i < b.length; i++) {
        var v = b[i] & 0xff;
        s += HEX.charAt(v >> 4) + HEX.charAt(v & 15);
    }
    return s;
}

/* ==================== 纯 JS AES-128 解密 (无 Java 依赖) ==================== */
var _AES_INV_SBOX = [
    0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb,
    0x7c,0xe3,0x39,0x82,0x9b,0x2f,0xff,0x87,0x34,0x8e,0x43,0x44,0xc4,0xde,0xe9,0xcb,
    0x54,0x7b,0x94,0x32,0xa6,0xc2,0x23,0x3d,0xee,0x4c,0x95,0x0b,0x42,0xfa,0xc3,0x4e,
    0x08,0x2e,0xa1,0x66,0x28,0xd9,0x24,0xb2,0x76,0x5b,0xa2,0x49,0x6d,0x8b,0xd1,0x25,
    0x72,0xf8,0xf6,0x64,0x86,0x68,0x98,0x16,0xd4,0xa4,0x5c,0xcc,0x5d,0x65,0xb6,0x92,
    0x6c,0x70,0x48,0x50,0xfd,0xed,0xb9,0xda,0x5e,0x15,0x46,0x57,0xa7,0x8d,0x9d,0x84,
    0x90,0xd8,0xab,0x00,0x8c,0xbc,0xd3,0x0a,0xf7,0xe4,0x58,0x05,0xb8,0xb3,0x45,0x06,
    0xd0,0x2c,0x1e,0x8f,0xca,0x3f,0x0f,0x02,0xc1,0xaf,0xbd,0x03,0x01,0x13,0x8a,0x6b,
    0x3a,0x91,0x11,0x41,0x4f,0x67,0xdc,0xea,0x97,0xf2,0xcf,0xce,0xf0,0xb4,0xe6,0x73,
    0x96,0xac,0x74,0x22,0xe7,0xad,0x35,0x85,0xe2,0xf9,0x37,0xe8,0x1c,0x75,0xdf,0x6e,
    0x47,0xf1,0x1a,0x71,0x1d,0x29,0xc5,0x89,0x6f,0xb7,0x62,0x0e,0xaa,0x18,0xbe,0x1b,
    0xfc,0x56,0x3e,0x4b,0xc6,0xd2,0x79,0x20,0x9a,0xdb,0xc0,0xfe,0x78,0xcd,0x5a,0xf4,
    0x1f,0xdd,0xa8,0x33,0x88,0x07,0xc7,0x31,0xb1,0x12,0x10,0x59,0x27,0x80,0xec,0x5f,
    0x60,0x51,0x7f,0xa9,0x19,0xb5,0x4a,0x0d,0x2d,0xe5,0x7a,0x9f,0x93,0xc9,0x9c,0xef,
    0xa0,0xe0,0x3b,0x4d,0xae,0x2a,0xf5,0xb0,0xc8,0xeb,0xbb,0x3c,0x83,0x53,0x99,0x61,
    0x17,0x2b,0x04,0x7e,0xba,0x77,0xd6,0x26,0xe1,0x69,0x14,0x63,0x55,0x21,0x0c,0x7d
];
var _AES_SBOX = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
];

function _aesGmul(a, b) {
    var p = 0;
    for (var i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        var hi = a & 0x80;
        a = (a << 1) & 0xff;
        if (hi) a ^= 0x1b;
        b >>= 1;
    }
    return p;
}

function _aesKeyExpansion(key) {
    var RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];
    var w = [];
    for (var i = 0; i < 4; i++) w.push([key[4*i], key[4*i+1], key[4*i+2], key[4*i+3]]);
    for (var i = 4; i < 44; i++) {
        var temp = w[i-1].slice();
        if (i % 4 === 0) {
            temp = [temp[1], temp[2], temp[3], temp[0]];
            for (var j = 0; j < 4; j++) temp[j] = _AES_SBOX[temp[j]];
            temp[0] ^= RCON[i/4 - 1];
        }
        w.push([w[i-4][0]^temp[0], w[i-4][1]^temp[1], w[i-4][2]^temp[2], w[i-4][3]^temp[3]]);
    }
    var rks = [];
    for (var r = 0; r < 11; r++) {
        var rk = [];
        for (var c = 0; c < 4; c++) {
            var word = w[r*4 + c];
            rk.push(word[0], word[1], word[2], word[3]);
        }
        rks.push(rk);
    }
    return rks;
}

function _aesDecryptBlock(ct, rks) {
    var s = ct.slice();
    function addRoundKey(rk) { for (var i = 0; i < 16; i++) s[i] ^= rk[i]; }
    function invShiftRows() {
        var t;
        t = s[13]; s[13] = s[9];  s[9]  = s[5];  s[5]  = s[1];  s[1]  = t;
        t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
        t = s[3];  s[3]  = s[7];  s[7]  = s[11]; s[11] = s[15]; s[15] = t;
    }
    function invSubBytes() { for (var i = 0; i < 16; i++) s[i] = _AES_INV_SBOX[s[i]]; }
    function invMixColumns() {
        for (var c = 0; c < 4; c++) {
            var i = 4*c;
            var a0 = s[i], a1 = s[i+1], a2 = s[i+2], a3 = s[i+3];
            s[i]   = _aesGmul(a0,14) ^ _aesGmul(a1,11) ^ _aesGmul(a2,13) ^ _aesGmul(a3,9);
            s[i+1] = _aesGmul(a0,9)  ^ _aesGmul(a1,14) ^ _aesGmul(a2,11) ^ _aesGmul(a3,13);
            s[i+2] = _aesGmul(a0,13) ^ _aesGmul(a1,9)  ^ _aesGmul(a2,14) ^ _aesGmul(a3,11);
            s[i+3] = _aesGmul(a0,11) ^ _aesGmul(a1,13) ^ _aesGmul(a2,9)  ^ _aesGmul(a3,14);
        }
    }
    addRoundKey(rks[10]);
    for (var r = 9; r >= 1; r--) {
        invShiftRows(); invSubBytes(); addRoundKey(rks[r]); invMixColumns();
    }
    invShiftRows(); invSubBytes(); addRoundKey(rks[0]);
    return s;
}

/* 解 slowAES 挑战页: 纯 JS AES-128-CBC 解密 c 得到 __test cookie 值 */
function _solveChallenge(html) {
    try {
        var m = String(html).match(/toNumbers\("([0-9a-f]{32})"\)[\s\S]*?toNumbers\("([0-9a-f]{32})"\)[\s\S]*?toNumbers\("([0-9a-f]{32})"\)/);
        if (!m) { console.log('挑战页解析失败: 未匹配到 a/b/c 参数'); return ""; }
        var key = _hexToBytes(m[1]);
        var iv = _hexToBytes(m[2]);
        var pt = _aesDecryptBlock(_hexToBytes(m[3]), _aesKeyExpansion(key));
        for (var i = 0; i < 16; i++) pt[i] ^= iv[i];
        var ck = "__test=" + _bytesToHex(pt);
        console.log('挑战解题成功, cookie 已更新');
        return ck;
    } catch (e) {
        console.log('挑战解题异常: ' + e);
        return "";
    }
}

/* ==================== 服务端防护应对 ==================== */
/* ByetHost 挑战层按 UA 分级: 白名单 UA(Googlebot/bingbot/facebookexternalhit)直接放行;
   普通 UA 需解 slowAES 挑战并携带 __test cookie。UA 是普通请求头, Cookie 在部分 http 模块会被过滤 */
var _UA_CANDIDATES = [
    "Googlebot/2.1 (+http://www.google.com/bot.html)",
    "facebookexternalhit/1.1",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"
];
var _uaMode = "";      /* 已验证生效的 UA, 空=未确定 */
var _headerMode = "";  /* addHeader=全局头 / options=请求第二参数 */
var _challengeCookie = "";
try { _challengeCookie = auto.getValue("server_challenge_cookie") || ""; } catch (e) {}

/* 响应是否为可用的业务 JSON (排除挑战页/403页等 HTML) */
function _looksGood(body) {
    if (typeof body !== "string") return false;
    if (body.indexOf("slowAES") > -1) return false;
    if (body.indexOf("<") === 0) return false;
    return true;
}

/* 发起一次原始请求, 按 _headerMode 决定头传递方式 */
function _rawRequest(method, path, obj, ua) {
    var url = _u + path;
    var useUa = ua || _uaMode;
    if (_headerMode === "options") {
        var headers = {};
        if (useUa) headers["User-Agent"] = useUa;
        else if (_challengeCookie) headers["Cookie"] = _challengeCookie;
        var opt = { headers: headers };
        return method === "GET" ? http.get(url, opt) : http.postJson(url, obj, opt);
    }
    if (useUa) { try { http.addHeader("User-Agent", useUa); } catch (e) {} }
    else if (_challengeCookie) { try { http.addHeader("Cookie", _challengeCookie); } catch (e) {} }
    return method === "GET" ? http.get(url) : http.postJson(url, obj);
}

/* UA 白名单探测: 逐个候选 UA 试探, 首个直接拿到 JSON 的即生效 */
function _probeUa(method, path, obj) {
    for (var i = 0; i < _UA_CANDIDATES.length; i++) {
        var ua = _UA_CANDIDATES[i];
        var modes = _headerMode ? [_headerMode] : ["addHeader", "options"];
        for (var j = 0; j < modes.length; j++) {
            try {
                _headerMode = modes[j];
                var saved = _challengeCookie;
                _challengeCookie = "";
                var body = _extractBody(_rawRequest(method, path, obj, ua));
                _challengeCookie = saved;
                if (_looksGood(body)) {
                    _uaMode = ua;
                    console.log('UA 白名单生效: ' + ua.slice(0, 24) + '... (方式: ' + modes[j] + ')');
                    return body;
                }
                console.log('UA ' + ua.slice(0, 16) + '... 经 ' + modes[j] + ' 未生效');
            } catch (e) {
                console.log('UA 探测 ' + modes[j] + ' 异常: ' + e);
            }
        }
    }
    _headerMode = "";
    return null;
}

/* 挑战解题后备路线: 解 slowAES, 探测 cookie 传递方式 */
function _challengeRetry(body, method, path, obj) {
    var ck = _solveChallenge(body);
    if (!ck) return { _err: '服务端防护校验失败(解题未通过)，请稍后重试' };
    _challengeCookie = ck;
    try { auto.setValue("server_challenge_cookie", ck); } catch (e) {}
    var modes = _headerMode ? [_headerMode] : ["addHeader", "options"];
    for (var i = 0; i < modes.length; i++) {
        try {
            _headerMode = modes[i];
            var body2 = _extractBody(_rawRequest(method, path, obj));
            if (_looksGood(body2)) {
                console.log('cookie 传递策略生效: ' + modes[i]);
                return body2;
            }
            console.log('cookie 策略 ' + modes[i] + ' 未通过, 尝试下一个');
        } catch (e) {
            console.log('cookie 策略 ' + modes[i] + ' 异常: ' + e);
        }
    }
    _headerMode = "";
    return { _err: '服务端防护校验未通过，请稍后重试' };
}

/* 统一请求入口: 先走已确定的 UA, 未确定则探测, UA 失败转挑战解题 */
function _request(method, path, obj) {
    try {
        try { http.setTimeout(15); } catch (e) {}
        var res = _rawRequest(method, path, obj);
        var body = _extractBody(res);
        if (_looksGood(body)) return body;
        if (typeof body === "string" && body.indexOf("slowAES") > -1 && !_uaMode) {
            var probed = _probeUa(method, path, obj);
            if (probed !== null) return probed;
        }
        if (typeof body === "string" && body.indexOf("slowAES") > -1) {
            return _challengeRetry(body, method, path, obj);
        }
        return body;
    } catch (e) {
        var em = String(e && e.message ? e.message : e);
        if (em.indexOf("timeout") > -1 || em.indexOf("timed out") > -1) {
            return { _err: '网络超时，请检查网络连接' };
        }
        return { _err: '网络异常: ' + em };
    }
}

function _httpPost(path, obj) {
    return _request("POST", path, obj);
}

function _httpGet(path) {
    return _request("GET", path, null);
}

function _extractBody(res) {
    if (res && typeof res === 'object' && res._err) return res;
    if (typeof res === "string") return res;
    if (res && typeof res.body === "string") return res.body;
    if (res && typeof res.bodyString === "string") return res.bodyString;
    if (res && res.body && typeof res.body.string === "function") {
        try { return String(res.body.string()); } catch (e) {}
    }
    return String(res);
}

/* ==================== 时间同步 ==================== */
function _syncTime() {
    try {
        var body = _httpGet("/time");
        if (body && typeof body === 'object' && body._err) {
            serverTimeOffset = 0;
            sessionSalt = "";
            saltTime = 0;
            console.log('时间同步失败: ' + body._err);
            return;
        }
        var json = JSON.parse(body);
        if (json.timestamp) {
            var serverTime = json.timestamp * 1000;
            serverTimeOffset = serverTime - Date.now();
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
function _isFileAvailable() {
    return typeof file !== "undefined" || typeof File !== "undefined";
}

function _fileWrite(path, content) {
    if (typeof file !== "undefined" && typeof file.write === "function") {
        try { file.write(path, content); return true; } catch (e) {}
    }
    if (typeof File !== "undefined" && typeof File.write === "function") {
        try { File.write(path, content); return true; } catch (e) {}
    }
    return false;
}

function _fileRead(path) {
    if (typeof file !== "undefined" && typeof file.read === "function") {
        try { return String(file.read(path) || ""); } catch (e) {}
    }
    if (typeof File !== "undefined" && typeof File.read === "function") {
        try { return String(File.read(path) || ""); } catch (e) {}
    }
    return "";
}

function _fileExists(path) {
    if (typeof file !== "undefined") {
        if (typeof file.exists === "function") { try { return !!file.exists(path); } catch (e) {} }
        if (typeof file.exist === "function") { try { return !!file.exist(path); } catch (e) {} }
    }
    if (typeof File !== "undefined") {
        if (typeof File.exist === "function") { try { return !!File.exist(path); } catch (e) {} }
        if (typeof File.exists === "function") { try { return !!File.exists(path); } catch (e) {} }
    }
    return false;
}

function _fileMkdir(path) {
    if (typeof file !== "undefined") {
        if (typeof file.mkdir === "function") { try { file.mkdir(path); return; } catch (e) {} }
        if (typeof file.mkdirs === "function") { try { file.mkdirs(path); return; } catch (e) {} }
    }
    if (typeof File !== "undefined" && typeof File.mkdir === "function") {
        try { File.mkdir(path); } catch (e) {}
    }
}

function _varNameFor(path) {
    if (String(path).indexOf("device_salt") > -1) return "S_卡密设备盐";
    if (String(path).indexOf("device_uuid") > -1) return "S_卡密设备UUID";
    return "S_卡密数据";
}

function _readVar(name) {
    try {
        return String(auto.getValue(name) || "").trim();
    } catch (e) {
        return "";
    }
}

function _writeVar(name, content) {
    try {
        auto.setValue(name, String(content));
        return _readVar(name) === String(content);
    } catch (e) {
        return false;
    }
}

function _readFile(path) {
    var v = _fileRead(path);
    if (v) return v.trim();
    return _readVar(_varNameFor(path));
}

function _writeFile(path, content) {
    content = String(content);
    var idx = path.lastIndexOf("/");
    var dir = idx > 0 ? path.substring(0, idx) : "";
    if (dir) _fileMkdir(dir);
    if (_fileWrite(path, content)) {
        if (_fileRead(path) === content) return true;
    }
    return _writeVar(_varNameFor(path), content);
}

function _genDeviceFingerprint() {
    var effectiveSalt = "";
    if (_deviceSalt && _deviceSalt.length >= 8) {
        effectiveSalt = _deviceSalt;
    } else {
        var chars = "abcdef0123456789";
        var s = "";
        for (var i = 0; i < 16; i++) {
            s += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        _deviceSalt = s;
        if (!_writeFile(_deviceSaltFile, s)) {
            console.log('设备盐文件持久化失败，使用兜底盐保持指纹稳定');
        }
        var persisted = _readFile(_deviceSaltFile);
        effectiveSalt = persisted.length >= 8 ? persisted : _getFallbackSalt();
    }
    var raw = (device.brand || "") + "|" + (device.model || "") + "|" + (device.product || "") +
              "|" + (device.width || "") + "|" + (device.height || "") + "|" + (device.dpi || "");
    if (String(raw).replace(/\|/g, "").length < 2) {
        raw = raw + "|" + effectiveSalt;
    }
    return _sha256(raw + "|" + effectiveSalt + "|" + _s);
}

/* ==================== 卡密获取 ==================== */
function _getCardCode(verbose) {
    var myCard = "";
    try {
        myCard = auto.getValue('CARD_CODE') || "";
        myCard = String(myCard).trim();
        if (myCard && verbose !== false) console.log('从变量 CARD_CODE 读取卡密');
    } catch (e) {
        myCard = "";
    }
    if (!myCard || myCard.length < 5) {
        try {
            myCard = auto.getClip() || "";
            myCard = String(myCard).trim();
            if (myCard && verbose !== false) console.log('从剪贴板读取卡密');
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
    return myCard.toUpperCase();
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

/* SHA-256 轮常量（模块级，避免每次调用重复分配） */
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

/* ==================== 纯 JS SHA256 ==================== */
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

/* ==================== 标准 TOTP（RFC 6238，SHA1 + 动态截断 + 6 位数字，种子字节缓存） ==================== */
var _secretCache = "";
var _secretBytesCache = "";

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
    return ("00000" + code).substr(-6);
}

/* ==================== 响应签名计算与验证（响应密钥按卡密缓存） ==================== */
var _respKeyCacheCode = "";
var _respKeyCache = "";

function _computeExpectedSign(base64Data, code) {
    if (_respKeyCacheCode !== code || !_respKeyCache) {
        _respKeyCache = _hexToBytes(_hmacSha256(code + _s, "response_salt_v2"));
        _respKeyCacheCode = code;
    }
    return _hmacSha256(base64Data, _respKeyCache);
}

function _verifyResponse(base64Data, sign, keyHint) {
    return sign === _computeExpectedSign(base64Data, keyHint);
}

/* ==================== 请求签名生成（方案 B：TOTP + 服务端盐双重绑定） ==================== */
function _genTOTP(serverTime) {
    return _totp(_s, serverTime);
}

function _genSign(code, fingerprint, timestamp, nonce, token, totp) {
    if (!totp) totp = _genTOTP(timestamp);
    var params = [
        "client_info=AutoJS-2.0.0",
        "code=" + code,
        "device_fingerprint=" + fingerprint,
        "uuid=" + (_uuidCipher || ""),
        "nonce=" + nonce,
        "salt=" + sessionSalt,
        "totp=" + totp,
        "timestamp=" + timestamp,
        "token=" + (token || "")
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
