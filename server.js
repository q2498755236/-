'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ==================== 配置加载 ==================== */
function loadConfig() {
    const defaults = {
        SECRET: 'D67B65DNIELFRSWLICGZM47RENTKJTFL',
        PORT: 3000,
        ADMIN_TOKEN: 'admin123456',
        MAX_DEVICES_DEFAULT: 1,
        TIME_WINDOW: 300,
        SALT_TTL: 600000,
        TOKEN_TTL: 7200000,
        IP_FAIL_LIMIT: 10,
        IP_FAIL_WINDOW: 600000,
        RATE_LIMIT_TIME: 5,
        RATE_LIMIT_API: 10,
        RATE_LIMIT_ADMIN: 10,
        LOG_DIR: path.join(__dirname, 'logs'),
        BACKUP_DIR: path.join(__dirname, 'backups'),
        BACKUP_KEEP: 10,
        MAX_NONCE_CACHE: 50000,
        MAX_SALT_CACHE: 50000,
        MAX_TOKEN_CACHE: 50000,
        MAX_RATE_CACHE: 50000,
        MAX_IP_FAIL_CACHE: 50000,
        IP_BLACKLIST: [],
        IP_WHITELIST: [],
        IP_WHITELIST_ENABLED: false
    };

    let fileConfig = {};
    const configPath = path.join(__dirname, 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) {
        console.warn('[配置] 配置文件读取失败，使用默认值: ' + e.message);
    }

    const cfg = {};
    for (const key of Object.keys(defaults)) {
        const envVal = process.env[key];
        if (envVal !== undefined) {
            if (key === 'IP_BLACKLIST' || key === 'IP_WHITELIST') {
                cfg[key] = String(envVal).split(',').map(s => s.trim()).filter(Boolean);
            } else if (key === 'IP_WHITELIST_ENABLED') {
                cfg[key] = envVal === 'true' || envVal === '1';
            } else {
                cfg[key] = typeof defaults[key] === 'number' ? Number(envVal) : envVal;
            }
        } else if (fileConfig[key] !== undefined) {
            cfg[key] = fileConfig[key];
        } else {
            cfg[key] = defaults[key];
        }
    }
    return cfg;
}

const CFG = loadConfig();
const DATA_FILE = path.join(__dirname, 'cards.json');
const ADMIN_HTML = path.join(__dirname, 'admin.html');
const BLACKLIST_FILE = path.join(__dirname, 'ip_blacklist.json');
const WHITELIST_FILE = path.join(__dirname, 'ip_whitelist.json');

/* ==================== 初始化目录 ==================== */
(function initDirs() {
    try { fs.mkdirSync(CFG.LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
    try { fs.mkdirSync(CFG.BACKUP_DIR, { recursive: true }); } catch (e) { /* ignore */ }
})();

/* ==================== 日志系统 ==================== */
function log(level, module, message, extra) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] [${module}] ${message}`;
    if (level === 'ERROR' || level === 'WARN') {
        process.stderr.write(line + '\n');
    } else {
        process.stdout.write(line + '\n');
    }
    try {
        const date = ts.substring(0, 10);
        fs.appendFileSync(path.join(CFG.LOG_DIR, `server-${date}.log`), line + '\n');
    } catch (e) { /* ignore */ }
    if (extra) {
        try {
            fs.appendFileSync(path.join(CFG.LOG_DIR, 'audit.log'),
                `[${ts}] ${JSON.stringify(extra)}\n`);
        } catch (e) { /* ignore */ }
    }
}

const logger = {
    info:  (m, msg) => log('INFO', m, msg),
    warn:  (m, msg) => log('WARN', m, msg),
    error: (m, msg) => log('ERROR', m, msg),
    audit: (action, detail) => log('INFO', 'AUDIT', action, detail)
};

/* ==================== 数据持久化 ==================== */
function backupData() {
    try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(CFG.BACKUP_DIR, `cards-${ts}.json`);
        fs.copyFileSync(DATA_FILE, backupPath);
        const backups = fs.readdirSync(CFG.BACKUP_DIR)
            .filter(f => f.startsWith('cards-') && f.endsWith('.json'))
            .sort();
        while (backups.length > CFG.BACKUP_KEEP) {
            fs.unlinkSync(path.join(CFG.BACKUP_DIR, backups.shift()));
        }
    } catch (e) { /* ignore */ }
}

let cardsCache = null;

function loadCards() {
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        cardsCache = JSON.parse(raw);
        return cardsCache;
    } catch (e) {
        if (!cardsCache) cardsCache = {};
        return cardsCache;
    }
}

function saveCards(cards) {
    if (cards) cardsCache = cards;
    const tmp = DATA_FILE + '.tmp';
    const data = JSON.stringify(cardsCache, null, 2);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, DATA_FILE);
}

function getCards() {
    if (!cardsCache) loadCards();
    return cardsCache;
}

/* ==================== IP 黑名单持久化 ==================== */
let ipBlacklistCache = null;

function loadIpBlacklist() {
    try {
        const raw = fs.readFileSync(BLACKLIST_FILE, 'utf8');
        ipBlacklistCache = JSON.parse(raw);
        return ipBlacklistCache;
    } catch (e) {
        ipBlacklistCache = { ips: [], reason: {} };
        return ipBlacklistCache;
    }
}

function saveIpBlacklist(data) {
    if (data) ipBlacklistCache = data;
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(ipBlacklistCache, null, 2));
}

function getIpBlacklist() {
    if (!ipBlacklistCache) loadIpBlacklist();
    return ipBlacklistCache;
}

/* ==================== IP 白名单持久化 ==================== */
let ipWhitelistCache = null;

function loadIpWhitelist() {
    try {
        const raw = fs.readFileSync(WHITELIST_FILE, 'utf8');
        ipWhitelistCache = JSON.parse(raw);
        return ipWhitelistCache;
    } catch (e) {
        ipWhitelistCache = { ips: [], enabled: false };
        return ipWhitelistCache;
    }
}

function saveIpWhitelist(data) {
    if (data) ipWhitelistCache = data;
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(ipWhitelistCache, null, 2));
}

function getIpWhitelist() {
    if (!ipWhitelistCache) loadIpWhitelist();
    return ipWhitelistCache;
}

/* ==================== 工具函数 ==================== */
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

function maskIp(ip) {
    const parts = String(ip || '').split('.');
    if (parts.length !== 4) return '***';
    return parts[0] + '.' + parts[1] + '.*.*';
}

/* ==================== 会话盐 ==================== */
const saltStore = new Map();

function issueSalt() {
    const salt = crypto.randomBytes(16).toString('hex');
    saltStore.set(salt, Date.now() + CFG.SALT_TTL);
    cleanupStore(saltStore, CFG.MAX_SALT_CACHE);
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

/* ==================== 会话 token ==================== */
const tokenStore = new Map();

function issueToken(key) {
    const token = crypto.randomBytes(24).toString('hex');
    tokenStore.set(key, { token, expire: Date.now() + CFG.TOKEN_TTL });
    cleanupStore(tokenStore, CFG.MAX_TOKEN_CACHE);
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

/* ==================== 设备 UUID ==================== */
const UUID_KEY = crypto.createHash('sha256').update('card_uuid_v1:' + CFG.SECRET).digest();

function genUuid() {
    return crypto.randomBytes(16).toString('hex');
}

function encryptUuid(uuid) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', UUID_KEY, iv);
    const enc = Buffer.concat([cipher.update(String(uuid), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptUuid(encoded) {
    try {
        const buf = Buffer.from(String(encoded), 'base64');
        if (buf.length < 29) return null;
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const data = buf.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', UUID_KEY, iv);
        decipher.setAuthTag(tag);
        return decipher.update(data, null, 'utf8') + decipher.final('utf8');
    } catch (e) {
        return null;
    }
}

/* ==================== RFC 6238 TOTP ==================== */
function base32Decode(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleaned = String(input).toUpperCase().replace(/[=\s-]/g, '');
    const buf = [];
    let bits = 0, value = 0;
    for (const ch of cleaned) {
        const idx = alphabet.indexOf(ch);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) { bits -= 8; buf.push((value >> bits) & 0xff); }
    }
    return Buffer.from(buf);
}

function genTotp(counter) {
    const key = base32Decode(CFG.SECRET);
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(msg).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(bin % 1000000).padStart(6, '0');
}

/* ==================== 签名校验 ==================== */
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
            'uuid=' + (body.uuid || ''),
            'nonce=' + body.nonce,
            'salt=' + body.salt,
            'totp=' + totp,
            'timestamp=' + body.timestamp,
            'token=' + (body.token || '')
        ].join('&');
        const key = totp + body.salt + CFG.SECRET;
        const expect = crypto.createHmac('sha256', key).update(str).digest('hex');
        if (safeEqual(expect, body.sign)) return true;
    }
    return false;
}

const usedNonces = new Map();

function checkNonce(body) {
    const now = nowSec();
    if (!body.nonce || !body.timestamp) return false;
    if (Math.abs(now - Number(body.timestamp)) > CFG.TIME_WINDOW) return false;
    if (usedNonces.has(body.nonce)) return false;
    usedNonces.set(body.nonce, now);
    cleanupStore(usedNonces, CFG.MAX_NONCE_CACHE, 600);
    return true;
}

function signResponse(code, payload) {
    const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const inner = crypto.createHmac('sha256', 'response_salt_v2').update(code + CFG.SECRET).digest('hex');
    const rkey = Buffer.from(inner, 'hex');
    const sign = crypto.createHmac('sha256', rkey).update(data).digest('hex');
    return { data, sign };
}

function respond(res, obj, status) {
    const json = JSON.stringify(obj);
    res.writeHead(status || 200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
    });
    res.end(json);
}

function respondSigned(res, code, payload) {
    respond(res, signResponse(code, payload));
}

/* ==================== 卡密校验核心 ==================== */
function checkCard(code, uuidCipher, fingerprint) {
    const cards = getCards();
    const card = cards[code];
    if (!card) return { ok: false, reason: '卡密不存在' };
    if (card.status === 'locked') return { ok: false, reason: '卡密已被锁定' };
    if (card.status === 'frozen') return { ok: false, reason: '卡密已被冻结' };
    if (card.expireAt && card.expireAt < nowSec()) {
        card.status = 'expired';
        saveCards();
        return { ok: false, reason: '卡密已过期' };
    }

    /* 激活计时：首次验证时 ignite expireAt */
    if (card.expireMode === 'activate' && card.expireDays > 0 && !card.expireAt) {
        card.expireAt = nowSec() + card.expireDays * 86400;
    }
    const devices = card.devices || [];
    if (!card.fingerprints) card.fingerprints = {};
    const fps = card.fingerprints;

    if (uuidCipher) {
        const uuid = decryptUuid(uuidCipher);
        if (uuid && devices.indexOf(uuid) !== -1) {
            if (fps[uuid] && fps[uuid] !== fingerprint) {
                return { ok: false, reason: '设备指纹不匹配' };
            }
            return { ok: true, reason: '验证成功', expireAt: card.expireAt || 0, uuid: uuid };
        }
    }

    let matched = null;
    for (const id of devices) {
        if (fps[id] && fps[id] === fingerprint) { matched = id; break; }
    }
    if (matched !== null) {
        return { ok: true, reason: '验证成功', expireAt: card.expireAt || 0, uuid: matched };
    }
    if (devices.length >= (card.maxDevices || CFG.MAX_DEVICES_DEFAULT)) {
        return { ok: false, reason: '设备数已达上限' };
    }
    const uuid = genUuid();
    devices.push(uuid);
    fps[uuid] = fingerprint;
    card.devices = devices;
    card.fingerprints = fps;
    saveCards();
    return { ok: true, reason: '验证成功', expireAt: card.expireAt || 0, uuid: uuid };
}

/* ==================== 验证/心跳处理 ==================== */
function handleVerify(req, res, body, isHeartbeat) {
    const tag = isHeartbeat ? 'heartbeat' : 'verify';
    const ip = clientIp(req);
    if (ipBlacklisted(ip)) {
        return respondSigned(res, (body && body.code) || '', { success: false, message: '访问被拒绝' });
    }
    if (ipFailLocked(ip)) {
        return respondSigned(res, (body && body.code) || '', { success: false, message: '失败次数过多，请 10 分钟后再试' });
    }
    if (!body || typeof body.code !== 'string' || typeof body.device_fingerprint !== 'string' ||
        typeof body.nonce !== 'string' || (body.uuid !== undefined && body.uuid !== null && typeof body.uuid !== 'string') ||
        (isHeartbeat && typeof body.token !== 'string')) {
        logger.warn('VERIFY', '参数不完整 ip=' + ip + ' keys=' + Object.keys(body || {}).join(','));
        ipFailRecord(ip);
        return respondSigned(res, (body && body.code) || '', { success: false, message: '请求参数不完整' });
    }
    const signOk = verifyRequestSign(body);
    if (!signOk) {
        logger.warn('VERIFY', '签名校验失败 code=' + maskCard(body.code) + ' ip=' + ip);
        ipFailRecord(ip);
        return respondSigned(res, body.code, { success: false, message: '请求签名校验失败' });
    }
    if (!checkNonce(body)) {
        ipFailRecord(ip);
        return respondSigned(res, body.code, { success: false, message: '请求已过期或重复提交' });
    }
    const result = checkCard(body.code, body.uuid || '', body.device_fingerprint);
    if (!result.ok) {
        if (result.reason !== '设备数已达上限') ipFailRecord(ip);
        logger.warn('VERIFY', tag + '失败 code=' + maskCard(body.code) + ' reason=' + result.reason + ' ip=' + ip);
        return respondSigned(res, body.code, { success: false, message: result.reason });
    }
    ipFailClear(ip);

    const cards = getCards();
    const card = cards[body.code];
    if (card) {
        card.useCount = (card.useCount || 0) + 1;
        if (!card.lastUsedAt) {
            card.lastUsedAt = nowSec();
        } else {
            card.lastUsedAt = nowSec();
        }
        saveCards();
    }

    const tokKey = body.code + '|' + result.uuid;
    if (isHeartbeat) {
        if (!checkToken(tokKey, body.token)) {
            logger.info('VERIFY', '心跳 token 失效 code=' + maskCard(body.code));
            return respondSigned(res, body.code, { success: false, message: '会话已失效' });
        }
    }
    const token = isHeartbeat ? body.token : issueToken(tokKey);
    logger.info('VERIFY', tag + '成功 code=' + maskCard(body.code) + ' ip=' + ip);
    return respondSigned(res, body.code, {
        success: true,
        message: isHeartbeat ? '心跳正常' : result.reason,
        token: token,
        expireAt: result.expireAt || 0,
        uuid: encryptUuid(result.uuid)
    });
}

/* ==================== 请求体解析 ==================== */
function readBody(req, cb) {
    let data = '';
    req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
        try { cb(JSON.parse(data || '{}')); } catch (e) { cb({}); }
    });
    req.on('error', () => cb({}));
}

/* ==================== 管理员认证 ==================== */
function adminAuth(req) {
    return (req.headers.authorization || '') === 'Bearer ' + CFG.ADMIN_TOKEN;
}

/* ==================== IP 黑名单检查 ==================== */
function ipBlacklisted(ip) {
    const bl = getIpBlacklist();
    return bl.ips.indexOf(ip) !== -1 || CFG.IP_BLACKLIST.indexOf(ip) !== -1;
}

function ipWhitelisted(ip) {
    const wl = getIpWhitelist();
    if (!wl.enabled && !CFG.IP_WHITELIST_ENABLED) return true;
    return wl.ips.indexOf(ip) !== -1 || CFG.IP_WHITELIST.indexOf(ip) !== -1;
}

/* ==================== 速率限制 ==================== */
const rateMap = new Map();

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
    cleanupStore(rateMap, CFG.MAX_RATE_CACHE, 60000);
    return true;
}

/* ==================== 失败次数锁定 ==================== */
const ipFailMap = new Map();

function ipFailRecord(ip) {
    const now = Date.now();
    let rec = ipFailMap.get(ip);
    if (!rec || now > rec.until) {
        rec = { count: 0, until: now + CFG.IP_FAIL_WINDOW };
    }
    rec.count++;
    ipFailMap.set(ip, rec);
    cleanupStore(ipFailMap, CFG.MAX_IP_FAIL_CACHE);
}

function ipFailLocked(ip) {
    const rec = ipFailMap.get(ip);
    if (!rec) return false;
    if (Date.now() > rec.until) { ipFailMap.delete(ip); return false; }
    return rec.count >= CFG.IP_FAIL_LIMIT;
}

function ipFailClear(ip) {
    ipFailMap.delete(ip);
}

/* ==================== 存储清理 ==================== */
function cleanupStore(store, maxSize, ttlMs) {
    if (store.size <= maxSize) return;
    const now = Date.now();
    for (const [k, v] of store) {
        let expire;
        if (typeof v === 'object' && v !== null) {
            expire = v.expire || v.until;
        } else {
            expire = v;
        }
        if (typeof expire === 'number') {
            if (ttlMs) {
                if (now - expire > ttlMs || expire < now) store.delete(k);
            } else if (expire < now) {
                store.delete(k);
            }
        }
        if (store.size <= maxSize * 0.7) break;
    }
}

/* ==================== 定时清理 ==================== */
let cleanupTimer = null;

function startCleanupTimer() {
    cleanupTimer = setInterval(() => {
        const now = Date.now();
        let cleaned = 0;
        for (const [store] of [
            [saltStore], [tokenStore], [usedNonces], [rateMap], [ipFailMap]
        ]) {
            for (const [k, v] of store) {
                let expire;
                if (typeof v === 'object' && v !== null) {
                    expire = v.expire || v.until || v;
                } else {
                    expire = v;
                }
                if (typeof expire === 'number' && expire < now) {
                    store.delete(k);
                    cleaned++;
                }
            }
        }
        if (cleaned > 0) {
            logger.info('CLEANUP', '清理过期记录 ' + cleaned + ' 条');
        }
    }, 300000);
}

function stopCleanupTimer() {
    if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
}

/* ==================== 请求队列 ==================== */
let queue = Promise.resolve();

function enqueue(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
}

/* ==================== 管理 API ==================== */

function handleAdminList(req, res, query) {
    return enqueue(() => {
        const cards = getCards();
        const allCodes = Object.keys(cards);
        let list = [];
        for (const code of allCodes) {
            const c = cards[code];
            const now = nowSec();
            let status = c.status;
            if (status === 'active' && c.expireAt && c.expireAt < now) status = 'expired';
            list.push({
                code: code,
                status: status,
                expireAt: c.expireAt,
                expireMode: c.expireMode || 'create',
                expireDays: c.expireDays || 0,
                maxDevices: c.maxDevices,
                devices: c.devices || [],
                fingerprints: c.fingerprints || {},
                createdAt: c.createdAt,
                note: c.note || '',
                useCount: c.useCount || 0,
                lastUsedAt: c.lastUsedAt || 0
            });
        }
        const keyword = (query.search || '').toUpperCase().trim();
        if (keyword) {
            list = list.filter(c => c.code.toUpperCase().indexOf(keyword) !== -1 ||
                (c.note && c.note.toUpperCase().indexOf(keyword) !== -1));
        }
        const statusFilter = query.status || '';
        if (statusFilter && ['active', 'locked', 'frozen', 'expired'].indexOf(statusFilter) !== -1) {
            list = list.filter(c => c.status === statusFilter);
        }
        list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const total = list.length;
        const page = Math.max(parseInt(query.page, 10) || 1, 1);
        const size = Math.min(Math.max(parseInt(query.size, 10) || 50, 1), 200);
        const start = (page - 1) * size;
        const paged = list.slice(start, start + size);
        respond(res, {
            success: true,
            cards: paged,
            pagination: { page, size, total, pages: Math.ceil(total / size) }
        });
    });
}

function handleAdminStats(req, res) {
    return enqueue(() => {
        const cards = getCards();
        const now = nowSec();
        let total = 0, active = 0, locked = 0, frozen = 0, expired = 0;
        let totalDevices = 0, usedCards = 0, totalUseCount = 0;
        for (const code of Object.keys(cards)) {
            const c = cards[code];
            total++;
            totalUseCount += (c.useCount || 0);
            if (c.status === 'expired' || (c.expireAt && c.expireAt < now)) {
                expired++;
            } else {
                switch (c.status) {
                    case 'active': active++; break;
                    case 'locked': locked++; break;
                    case 'frozen': frozen++; break;
                }
            }
            if (c.devices && c.devices.length > 0) {
                usedCards++;
                totalDevices += c.devices.length;
            }
        }
        respond(res, {
            success: true,
            stats: {
                total, active, locked, frozen, expired,
                usedCards, unusedCards: total - usedCards,
                totalDevices, totalUseCount
            }
        });
    });
}

function handleAdminBatch(req, res, body) {
    return enqueue(() => {
        const codes = body.codes || [];
        const action = body.action || '';
        if (!Array.isArray(codes) || codes.length === 0) {
            return respond(res, { success: false, message: '请提供卡密列表' });
        }
        if (codes.length > 100) {
            return respond(res, { success: false, message: '单次最多操作 100 张卡密' });
        }
        const validActions = ['lock', 'unlock', 'freeze', 'unfreeze', 'delete'];
        if (validActions.indexOf(action) === -1) {
            return respond(res, { success: false, message: '无效操作' });
        }
        const cards = loadCards();
        let affected = 0, skipped = 0;
        for (const code of codes) {
            const card = cards[code];
            if (!card) { skipped++; continue; }
            switch (action) {
                case 'lock': card.status = 'locked'; affected++; break;
                case 'unlock': card.status = 'active'; affected++; break;
                case 'freeze': card.status = 'frozen'; affected++; break;
                case 'unfreeze': card.status = 'active'; affected++; break;
                case 'delete': delete cards[code]; affected++; break;
            }
        }
        saveCards(cards);
        backupData();
        logger.audit('批量操作', { action, total: codes.length, affected, skipped });
        respond(res, { success: true, affected, skipped });
    });
}

/* 设备解绑 */
function handleAdminUnbind(req, res, body) {
    return enqueue(() => {
        const cards = loadCards();
        const card = cards[body.code];
        if (!card) return respond(res, { success: false, message: '卡密不存在' });
        const devices = card.devices || [];
        const fps = card.fingerprints || {};
        const idx = devices.indexOf(body.device_uuid);
        if (idx === -1) return respond(res, { success: false, message: '设备未绑定到此卡密' });
        devices.splice(idx, 1);
        delete fps[body.device_uuid];
        card.devices = devices;
        card.fingerprints = fps;
        saveCards(cards);
        logger.audit('设备解绑', { code: maskCard(body.code), device: maskId(body.device_uuid) });
        respond(res, { success: true });
    });
}

/* 卡密备注 */
function handleAdminNote(req, res, body) {
    return enqueue(() => {
        const cards = loadCards();
        const card = cards[body.code];
        if (!card) return respond(res, { success: false, message: '卡密不存在' });
        const note = String(body.note || '').substring(0, 200);
        card.note = note;
        saveCards(cards);
        logger.audit('备注更新', { code: maskCard(body.code), note });
        respond(res, { success: true, note });
    });
}

/* 操作日志查询 */
function handleAdminLogs(req, res, query) {
    try {
        const logPath = path.join(CFG.LOG_DIR, 'audit.log');
        let lines = [];
        if (fs.existsSync(logPath)) {
            const content = fs.readFileSync(logPath, 'utf8');
            lines = content.split('\n').filter(Boolean).reverse();
        }
        const typeFilter = (query.type || '').trim();
        if (typeFilter) {
            lines = lines.filter(l => l.indexOf(typeFilter) !== -1);
        }
        const total = lines.length;
        const page = Math.max(parseInt(query.page, 10) || 1, 1);
        const size = Math.min(Math.max(parseInt(query.size, 10) || 50, 1), 200);
        const start = (page - 1) * size;
        const paged = lines.slice(start, start + size);
        respond(res, {
            success: true,
            logs: paged,
            pagination: { page, size, total, pages: Math.ceil(total / size) }
        });
    } catch (e) {
        respond(res, { success: false, message: '日志读取失败: ' + e.message });
    }
}

/* IP 黑名单管理 */
function handleAdminBlacklist(req, res, method, body) {
    return enqueue(() => {
        const bl = loadIpBlacklist();
        if (method === 'GET') {
            return respond(res, { success: true, blacklist: bl });
        }
        if (method === 'POST') {
            const ip = String(body.ip || '').trim();
            const reason = String(body.reason || '').substring(0, 100);
            if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
                return respond(res, { success: false, message: '无效的 IP 地址' });
            }
            if (bl.ips.indexOf(ip) === -1) {
                bl.ips.push(ip);
                bl.reason[ip] = reason;
                saveIpBlacklist(bl);
                logger.audit('IP 黑名单添加', { ip, reason });
            }
            return respond(res, { success: true, blacklist: bl });
        }
        if (method === 'DELETE') {
            const ip = String(body.ip || '').trim();
            const idx = bl.ips.indexOf(ip);
            if (idx !== -1) {
                bl.ips.splice(idx, 1);
                delete bl.reason[ip];
                saveIpBlacklist(bl);
                logger.audit('IP 黑名单移除', { ip });
            }
            return respond(res, { success: true, blacklist: bl });
        }
        respond(res, { success: false, message: '未知方法' });
    });
}

/* IP 白名单管理 */
function handleAdminWhitelist(req, res, method, body) {
    return enqueue(() => {
        const wl = loadIpWhitelist();
        if (method === 'GET') {
            return respond(res, { success: true, whitelist: wl });
        }
        if (method === 'POST') {
            if (body.enabled !== undefined) {
                wl.enabled = !!body.enabled;
                saveIpWhitelist(wl);
                logger.audit('白名单开关', { enabled: wl.enabled });
                return respond(res, { success: true, whitelist: wl });
            }
            const ip = String(body.ip || '').trim();
            if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
                return respond(res, { success: false, message: '无效的 IP 地址' });
            }
            if (wl.ips.indexOf(ip) === -1) {
                wl.ips.push(ip);
                saveIpWhitelist(wl);
                logger.audit('IP 白名单添加', { ip });
            }
            return respond(res, { success: true, whitelist: wl });
        }
        if (method === 'DELETE') {
            const ip = String(body.ip || '').trim();
            const idx = wl.ips.indexOf(ip);
            if (idx !== -1) {
                wl.ips.splice(idx, 1);
                saveIpWhitelist(wl);
                logger.audit('IP 白名单移除', { ip });
            }
            return respond(res, { success: true, whitelist: wl });
        }
        respond(res, { success: false, message: '未知方法' });
    });
}

/* ==================== HTTP 服务器 ==================== */
const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    const query = {};
    const qs = req.url.split('?')[1];
    if (qs) {
        for (const part of qs.split('&')) {
            const [k, v] = part.split('=');
            if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
        }
    }
    const ip = clientIp(req);

    if (ipBlacklisted(ip)) {
        return respond(res, { success: false, message: '访问被拒绝' }, 403);
    }
    if (urlPath.indexOf('/api/admin') === 0 && !ipWhitelisted(ip)) {
        return respond(res, { success: false, message: 'IP 不在白名单中' }, 403);
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        return res.end();
    }

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/admin')) {
        if (!rateLimit(ip, CFG.RATE_LIMIT_ADMIN)) {
            return respond(res, { success: false, message: '请求过于频繁' });
        }
        return fs.readFile(ADMIN_HTML, 'utf8', (err, html) => {
            if (err) return respond(res, { success: false, message: 'admin.html 缺失' });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        });
    }

    if (req.method === 'GET' && urlPath === '/api/time') {
        if (!rateLimit(ip, CFG.RATE_LIMIT_TIME)) {
            return respond(res, { success: false, message: '请求过于频繁' });
        }
        return respond(res, { timestamp: nowSec(), salt: issueSalt() });
    }

    if (req.method === 'POST' && (urlPath === '/api/verify' || urlPath === '/api/heartbeat')) {
        if (!rateLimit(ip, CFG.RATE_LIMIT_API)) {
            return respond(res, { success: false, message: '请求过于频繁' });
        }
        const isHeartbeat = urlPath === '/api/heartbeat';
        return readBody(req, (body) => {
            enqueue(() => handleVerify(req, res, body, isHeartbeat));
        });
    }

    if (urlPath.indexOf('/api/admin') === 0) {
        if (!rateLimit(ip, CFG.RATE_LIMIT_ADMIN)) {
            return respond(res, { success: false, message: '请求过于频繁' });
        }
        if (!adminAuth(req)) {
            return respond(res, { success: false, message: '未授权' }, 401);
        }

        if (req.method === 'POST' && urlPath === '/api/admin/issue') {
            return readBody(req, (body) => {
                const count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), 1000);
                const days = parseInt(body.days, 10) || 0;
                const maxDevices = parseInt(body.max_devices, 10) || CFG.MAX_DEVICES_DEFAULT;
                const prefix = String(body.prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6);
                const expireMode = (body.expire_mode === 'activate') ? 'activate' : 'create';
                const cards = loadCards();
                const codes = [];
                for (let i = 0; i < count; i++) {
                    let code, attempts = 0;
                    do {
                        code = genCode();
                        if (prefix) {
                            const parts = code.split('-');
                            code = prefix + code.substring(prefix.length);
                        }
                        attempts++;
                    } while (cards[code] && attempts < 100);
                    cards[code] = {
                        status: 'active',
                        expireAt: (expireMode === 'create' && days > 0) ? nowSec() + days * 86400 : 0,
                        expireMode: expireMode,
                        expireDays: days,
                        maxDevices: maxDevices,
                        devices: [],
                        createdAt: nowSec(),
                        useCount: 0,
                        lastUsedAt: 0
                    };
                    codes.push(code);
                }
                saveCards(cards);
                backupData();
                logger.audit('生成卡密', { count: codes.length, days, maxDevices });
                return respond(res, { success: true, codes: codes });
            });
        }

        if (req.method === 'GET' && urlPath === '/api/admin/list') {
            return handleAdminList(req, res, query);
        }

        if (req.method === 'GET' && urlPath === '/api/admin/stats') {
            return handleAdminStats(req, res);
        }

        if (req.method === 'GET' && urlPath === '/api/admin/logs') {
            return handleAdminLogs(req, res, query);
        }

        if (req.method === 'POST' && urlPath === '/api/admin/card') {
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
                    logger.audit('卡密操作', { code: maskCard(body.code), action: body.action });
                    respond(res, { success: true });
                });
            });
        }

        if (req.method === 'POST' && urlPath === '/api/admin/batch') {
            return readBody(req, (body) => handleAdminBatch(req, res, body));
        }

        if (req.method === 'POST' && urlPath === '/api/admin/unbind') {
            return readBody(req, (body) => handleAdminUnbind(req, res, body));
        }

        if (req.method === 'POST' && urlPath === '/api/admin/note') {
            return readBody(req, (body) => handleAdminNote(req, res, body));
        }

        if (urlPath === '/api/admin/blacklist') {
            if (req.method === 'GET') return handleAdminBlacklist(req, res, 'GET');
            if (req.method === 'POST') return readBody(req, (body) => handleAdminBlacklist(req, res, 'POST', body));
            if (req.method === 'DELETE') return readBody(req, (body) => handleAdminBlacklist(req, res, 'DELETE', body));
        }

        if (urlPath === '/api/admin/whitelist') {
            if (req.method === 'GET') return handleAdminWhitelist(req, res, 'GET');
            if (req.method === 'POST') return readBody(req, (body) => handleAdminWhitelist(req, res, 'POST', body));
            if (req.method === 'DELETE') return readBody(req, (body) => handleAdminWhitelist(req, res, 'DELETE', body));
        }

        return respond(res, { success: false, message: '未知管理接口' });
    }

    respond(res, { success: false, message: '404 Not Found' });
});

/* ==================== 优雅关闭 ==================== */
function gracefulShutdown(signal) {
    logger.info('SERVER', '收到 ' + signal + ' 信号，开始优雅关闭...');
    stopCleanupTimer();
    try { saveCards(); logger.info('SERVER', '数据已持久化'); } catch (e) { logger.error('SERVER', '数据持久化失败: ' + e.message); }
    server.close(() => { logger.info('SERVER', '服务已关闭'); process.exit(0); });
    setTimeout(() => { logger.warn('SERVER', '强制退出'); process.exit(1); }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    logger.error('SERVER', '未捕获异常: ' + err.message);
    gracefulShutdown('uncaughtException');
});

/* ==================== 启动 ==================== */
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args[0] === 'issue') {
        const count = parseInt(args[1], 10) || 1;
        const days = parseInt(args[2], 10) || 0;
        const cards = loadCards();
        const codes = [];
        for (let i = 0; i < count; i++) {
            let code;
            do { code = genCode(); } while (cards[code]);
            cards[code] = {
                status: 'active',
                expireAt: days > 0 ? nowSec() + days * 86400 : 0,
                expireMode: 'create',
                expireDays: days,
                maxDevices: CFG.MAX_DEVICES_DEFAULT,
                devices: [],
                createdAt: nowSec(),
                useCount: 0,
                lastUsedAt: 0
            };
            codes.push(code);
        }
        saveCards(cards);
        console.log('生成卡密 ' + codes.length + ' 张，有效期 ' + (days > 0 ? days + ' 天' : '永久') + '：');
        codes.forEach((c) => console.log('  ' + c));
    } else {
        server.listen(CFG.PORT, '0.0.0.0', () => {
            logger.info('SERVER', '服务端已启动: http://0.0.0.0:' + CFG.PORT);
            loadCards();
            loadIpBlacklist();
            loadIpWhitelist();
            startCleanupTimer();
            const cardCount = Object.keys(getCards()).length;
            logger.info('SERVER', '已加载 ' + cardCount + ' 张卡密');
            console.log('  GET  /api/time            - 时间同步');
            console.log('  POST /api/verify          - 卡密验证');
            console.log('  POST /api/heartbeat       - 心跳');
            console.log('  POST /api/admin/issue     - 生成卡密');
            console.log('  GET  /api/admin/list      - 卡密列表');
            console.log('  GET  /api/admin/stats     - 统计信息');
            console.log('  GET  /api/admin/logs      - 操作日志');
            console.log('  POST /api/admin/card      - 单卡操作');
            console.log('  POST /api/admin/batch     - 批量操作');
            console.log('  POST /api/admin/unbind    - 设备解绑');
            console.log('  POST /api/admin/note      - 卡密备注');
            console.log('  GET|POST|DELETE /api/admin/blacklist - IP黑名单');
            console.log('  GET|POST|DELETE /api/admin/whitelist - IP白名单');
        });
    }
}

module.exports = server;