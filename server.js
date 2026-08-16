'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = process.env.SECRET || 'D67B65DNIELFRSWLICGZM47RENTKJTFL';
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin123456';
const DATA_FILE = path.join(__dirname, 'cards.json');
const ADMIN_HTML = path.join(__dirname, 'admin.html');
const TIME_WINDOW = 300;
const MAX_DEVICES_DEFAULT = 1;

const usedNonces = new Map();

function loadCards() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveCards(cards) {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cards, null, 2));
    fs.renameSync(tmp, DATA_FILE);
}

function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 16; i++) {
        if (i && i % 4 === 0) s += '-';
        s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
}

function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

function maskCard(code) {
    const s = String(code || '');
    if (s.length <= 4) return '****';
    return s.substring(0, 4) + '***' + s.slice(-2);
}

function maskId(id) {
    const s = String(id || '');
    if (s.length <= 8) return '****';
    return s.substring(0, 8) + '***';
}

/* ==================== 会话盐（动态密钥） ==================== */
const saltStore = new Map();
const SALT_TTL = 600000;

function issueSalt() {
    const salt = crypto.randomBytes(16).toString('hex');
    saltStore.set(salt, Date.now() + SALT_TTL);
    if (saltStore.size > 20000) {
        const now = Date.now();
        for (const [k, v] of saltStore) {
            if (v < now) saltStore.delete(k);
        }
    }
    return salt;
}

function checkSalt(salt) {
    if (!salt || typeof salt !== 'string' || salt.length > 64) return false;
    const expire = saltStore.get(salt);
    if (!expire) return false;
    if (expire < Date.now()) {
        saltStore.delete(salt);
        return false;
    }
    return true;
}

/* ==================== 会话 token（心跳绑定，verify 签发 / heartbeat 校验） ==================== */
const tokenStore = new Map();
const TOKEN_TTL = 7200000;

function issueToken(key) {
    const token = crypto.randomBytes(24).toString('hex');
    tokenStore.set(key, { token, expire: Date.now() + TOKEN_TTL });
    if (tokenStore.size > 20000) {
        const now = Date.now();
        for (const [k, v] of tokenStore) {
            if (v.expire < now) tokenStore.delete(k);
        }
    }
    return token;
}

function checkToken(key, token) {
    if (!token || typeof token !== 'string') return false;
    const rec = tokenStore.get(key);
    if (!rec) return false;
    if (rec.expire < Date.now()) {
        tokenStore.delete(key);
        return false;
    }
    return rec.token === token;
}

/* ==================== RFC 6238 TOTP（SHA1 + 动态截断 + Base32 密钥） ==================== */
function base32Decode(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleaned = String(input).toUpperCase().replace(/[=\s-]/g, '');
    const buf = [];
    let bits = 0;
    let value = 0;
    for (const ch of cleaned) {
        const idx = alphabet.indexOf(ch);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            buf.push((value >> bits) & 0xff);
        }
    }
    return Buffer.from(buf);
}

function genTotp(counter) {
    const key = base32Decode(SECRET);
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(msg).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(bin % 1000000).padStart(6, '0');
}

function verifyRequestSign(body) {
    if (!checkSalt(body.salt)) return false;
    const counter = Math.floor(nowSec() / 30);
    for (let d = -1; d <= 1; d++) {
        const totp = genTotp(counter + d);
        if (!safeEqual(totp, body.totp || '')) continue;
        const str = [
            'client_info=AutoJS-2.0.0',
            'code=' + body.code,
            'device_fingerprint=' + body.device_fingerprint,
            'device_id=' + body.device_id,
            'nonce=' + body.nonce,
            'salt=' + body.salt,
            'totp=' + totp,
            'timestamp=' + body.timestamp,
            'token=' + (body.token || '')
        ].join('&');
        const key = totp + body.salt + SECRET;
        const expect = crypto.createHmac('sha256', key).update(str).digest('hex');
        if (safeEqual(expect, body.sign)) return true;
    }
    return false;
}

function checkNonce(body) {
    const now = nowSec();
    if (!body.nonce || !body.timestamp) return false;
    if (Math.abs(now - Number(body.timestamp)) > TIME_WINDOW) return false;
    if (usedNonces.has(body.nonce)) return false;
    usedNonces.set(body.nonce, now);
    if (usedNonces.size > 20000) {
        for (const [k, v] of usedNonces) {
            if (now - v > 600) usedNonces.delete(k);
        }
    }
    return true;
}

function signResponse(code, payload) {
    const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const inner = crypto.createHmac('sha256', 'response_salt_v2').update(code + SECRET).digest('hex');
    const rkey = Buffer.from(inner, 'hex');
    const sign = crypto.createHmac('sha256', rkey).update(data).digest('hex');
    return { data, sign };
}

function respond(res, obj) {
    const json = JSON.stringify(obj);
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(json);
}

function respondSigned(res, code, payload) {
    respond(res, signResponse(code, payload));
}

function checkCard(code, deviceId, fingerprint) {
    const cards = loadCards();
    const card = cards[code];
    if (!card) return { ok: false, reason: '卡密不存在' };
    if (card.status === 'locked') return { ok: false, reason: '卡密已被锁定' };
    if (card.status === 'frozen') return { ok: false, reason: '卡密已被冻结' };
    if (card.expireAt && card.expireAt < nowSec()) {
        card.status = 'expired';
        saveCards(cards);
        return { ok: false, reason: '卡密已过期' };
    }
    const bound = card.devices || [];
    if (!card.fingerprints) card.fingerprints = {};
    const fps = card.fingerprints;
    if (bound.indexOf(deviceId) === -1) {
        // 指纹兜底：deviceId 漂移时，若指纹与已绑定设备一致，视为同一设备换绑，不新增设备数
        let matched = null;
        for (const id of bound) {
            if (fps[id] && fps[id] === fingerprint) { matched = id; break; }
        }
        if (matched !== null) {
            const idx = bound.indexOf(matched);
            bound[idx] = deviceId;
            delete fps[matched];
            fps[deviceId] = fingerprint;
            card.devices = bound;
            card.fingerprints = fps;
            saveCards(cards);
            return { ok: true, reason: '验证成功', expireAt: card.expireAt || 0 };
        }
        if (bound.length >= (card.maxDevices || MAX_DEVICES_DEFAULT)) {
            return { ok: false, reason: '设备数已达上限' };
        }
        bound.push(deviceId);
        fps[deviceId] = fingerprint;
        card.devices = bound;
        card.fingerprints = fps;
        saveCards(cards);
    }
    return { ok: true, reason: '验证成功', expireAt: card.expireAt || 0 };
}

function handleVerify(req, res, body, isHeartbeat) {
    const tag = isHeartbeat ? 'heartbeat' : 'verify';
    const ip = clientIp(req);
    if (ipFailLocked(ip)) {
        return respondSigned(res, (body && body.code) || '', { success: false, message: '失败次数过多，请 10 分钟后再试' });
    }
    if (!body || typeof body.code !== 'string' || typeof body.device_id !== 'string' ||
        typeof body.device_fingerprint !== 'string' || typeof body.nonce !== 'string' ||
        (isHeartbeat && typeof body.token !== 'string')) {
        console.log('[' + tag + '] 参数不完整 keys=' + Object.keys(body || {}).join(','));
        ipFailRecord(ip);
        return respondSigned(res, (body && body.code) || '', { success: false, message: '请求参数不完整' });
    }
    const signOk = verifyRequestSign(body);
    console.log('[' + tag + '] code=' + maskCard(body.code) + ' device=' + maskId(body.device_id) +
        ' nonce=' + (body.nonce ? 'set' : 'none') + ' ts=' + body.timestamp + ' sign=' + (signOk ? 'OK' : 'FAIL') +
        ' tsDiff=' + Math.abs(nowSec() - Number(body.timestamp || 0)) + 's');
    if (!signOk) {
        ipFailRecord(ip);
        return respondSigned(res, body.code, { success: false, message: '请求签名校验失败' });
    }
    if (!checkNonce(body)) {
        ipFailRecord(ip);
        return respondSigned(res, body.code, { success: false, message: '请求已过期或重复提交' });
    }
    const result = checkCard(body.code, body.device_id, body.device_fingerprint);
    if (!result.ok) {
        if (result.reason !== '设备数已达上限') {
            ipFailRecord(ip);
        }
        return respondSigned(res, body.code, { success: false, message: result.reason });
    }
    ipFailClear(ip);
    const tokKey = body.code + '|' + body.device_id;
    if (isHeartbeat) {
        if (!checkToken(tokKey, body.token)) {
            console.log('[' + tag + '] 会话 token 校验失败，要求重新验证');
            return respondSigned(res, body.code, { success: false, message: '会话已失效' });
        }
    }
    const token = isHeartbeat ? body.token : issueToken(tokKey);
    return respondSigned(res, body.code, {
        success: true,
        message: isHeartbeat ? '心跳正常' : result.reason,
        token: token,
        expireAt: result.expireAt || 0
    });
}

function readBody(req, cb) {
    let data = '';
    req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
        try {
            cb(JSON.parse(data || '{}'));
        } catch (e) {
            cb({});
        }
    });
    req.on('error', () => cb({}));
}

function adminAuth(req) {
    return (req.headers.authorization || '') === 'Bearer ' + ADMIN_TOKEN;
}

/* ==================== 简单速率限制（防滥用，按 IP 内存计数） ==================== */
const rateMap = new Map();
const RATE_LIMIT = { time: 5, api: 10, admin: 10 };

function clientIp(req) {
    return String((req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
}

function rateLimit(ip, limit) {
    const now = Date.now();
    let rec = rateMap.get(ip);
    if (!rec || now - rec.start >= 1000) {
        rec = { start: now, count: 0 };
        rateMap.set(ip, rec);
    }
    rec.count++;
    if (rec.count > limit) return false;
    if (rateMap.size > 20000) {
        for (const [k, v] of rateMap) {
            if (now - v.start > 60000) rateMap.delete(k);
        }
    }
    return true;
}

/* ==================== 失败次数锁定（防暴破，按 IP） ==================== */
const ipFailMap = new Map();
const IP_FAIL_LIMIT = 10;
const IP_FAIL_WINDOW = 600000;

function ipFailRecord(ip) {
    const now = Date.now();
    let rec = ipFailMap.get(ip);
    if (!rec || now > rec.until) {
        rec = { count: 0, until: now + IP_FAIL_WINDOW };
    }
    rec.count++;
    ipFailMap.set(ip, rec);
}

function ipFailLocked(ip) {
    const rec = ipFailMap.get(ip);
    if (!rec) return false;
    if (Date.now() > rec.until) {
        ipFailMap.delete(ip);
        return false;
    }
    return rec.count >= IP_FAIL_LIMIT;
}

function ipFailClear(ip) {
    ipFailMap.delete(ip);
}

let queue = Promise.resolve();

function enqueue(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
}

const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const ip = clientIp(req);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        return res.end();
    }

    if (req.method === 'GET' && (url === '/' || url === '/admin')) {
        if (!rateLimit(ip, RATE_LIMIT.admin)) {
            return respond(res, { success: false, message: '请求过于频繁' });
        }
        return fs.readFile(ADMIN_HTML, 'utf8', (err, html) => {
            if (err) return respond(res, { success: false, message: 'admin.html 缺失' });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        });
    }

    if (req.method === 'GET' && url === '/api/time') {
        if (!rateLimit(ip, RATE_LIMIT.time)) {
            return respond(res, { success: false, message: '请求过于频繁' });
        }
        return respond(res, { timestamp: nowSec(), salt: issueSalt() });
    }

    if (req.method === 'POST' && (url === '/api/verify' || url === '/api/heartbeat')) {
        if (!rateLimit(ip, RATE_LIMIT.api)) {
            return respond(res, { success: false, message: '请求过于频繁' });
        }
        const isHeartbeat = url === '/api/heartbeat';
        return readBody(req, (body) => {
            enqueue(() => handleVerify(req, res, body, isHeartbeat));
        });
    }

    if (url.indexOf('/api/admin') === 0) {
        if (!rateLimit(ip, RATE_LIMIT.admin)) {
            return respond(res, { success: false, message: '请求过于频繁' });
        }
        if (!adminAuth(req)) {
            return respond(res, { success: false, message: '未授权' });
        }
        if (req.method === 'POST' && url === '/api/admin/issue') {
            return readBody(req, (body) => {
                const count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), 1000);
                const days = parseInt(body.days, 10) || 0;
                const maxDevices = parseInt(body.max_devices, 10) || MAX_DEVICES_DEFAULT;
                const cards = loadCards();
                const codes = [];
                for (let i = 0; i < count; i++) {
                    let code;
                    do {
                        code = genCode();
                    } while (cards[code]);
                    cards[code] = {
                        status: 'active',
                        expireAt: days > 0 ? nowSec() + days * 86400 : 0,
                        maxDevices: maxDevices,
                        devices: [],
                        createdAt: nowSec()
                    };
                    codes.push(code);
                }
                saveCards(cards);
                return respond(res, { success: true, codes: codes });
            });
        }
        if (req.method === 'GET' && url === '/api/admin/list') {
            return enqueue(() => {
                const cards = loadCards();
                const list = [];
                for (const code of Object.keys(cards)) {
                    const c = cards[code];
                    list.push({
                        code: code,
                        status: c.status,
                        expireAt: c.expireAt,
                        maxDevices: c.maxDevices,
                        devices: c.devices || [],
                        createdAt: c.createdAt
                    });
                }
                respond(res, { success: true, cards: list });
            });
        }
        if (req.method === 'POST' && url === '/api/admin/card') {
            return readBody(req, (body) => {
                enqueue(() => {
                    const cards = loadCards();
                    const card = cards[body.code];
                    if (!card) return respond(res, { success: false, message: '卡密不存在' });
                    if (body.action === 'lock') card.status = 'locked';
                    else if (body.action === 'unlock') card.status = 'active';
                    else if (body.action === 'freeze') card.status = 'frozen';
                    else if (body.action === 'unfreeze') card.status = 'active';
                    else if (body.action === 'delete') delete cards[body.code];
                    else return respond(res, { success: false, message: '未知操作' });
                    saveCards(cards);
                    respond(res, { success: true });
                });
            });
        }
        return respond(res, { success: false, message: '未知管理接口' });
    }

    respond(res, { success: false, message: '404 Not Found' });
});

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args[0] === 'issue') {
        const count = parseInt(args[1], 10) || 1;
        const days = parseInt(args[2], 10) || 0;
        const cards = loadCards();
        const codes = [];
        for (let i = 0; i < count; i++) {
            let code;
            do {
                code = genCode();
            } while (cards[code]);
            cards[code] = {
                status: 'active',
                expireAt: days > 0 ? nowSec() + days * 86400 : 0,
                maxDevices: MAX_DEVICES_DEFAULT,
                devices: [],
                createdAt: nowSec()
            };
            codes.push(code);
        }
        saveCards(cards);
        console.log('生成卡密 ' + codes.length + ' 张，有效期 ' + (days > 0 ? days + ' 天' : '永久') + '：');
        codes.forEach((c) => console.log('  ' + c));
    } else {
        server.listen(PORT, '0.0.0.0', () => {
            console.log('卡密验证服务端已启动: http://0.0.0.0:' + PORT);
            console.log('  GET  /api/time      - 时间同步');
            console.log('  POST /api/verify    - 卡密验证');
            console.log('  POST /api/heartbeat - 心跳');
            console.log('  POST /api/admin/issue  - 生成卡密 {count, days, max_devices}');
            console.log('  GET  /api/admin/list   - 卡密列表');
            console.log('  POST /api/admin/card   - {code, action: lock|unlock|freeze|unfreeze|delete}');
            console.log('管理接口需请求头: Authorization: Bearer <ADMIN_TOKEN>');
        });
    }
}

module.exports = server;
