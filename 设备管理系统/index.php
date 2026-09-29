<?php
/**
 * 卡密验证服务端 (PHP 版，部署于虚拟主机)
 * 与 Node 版 server.js 协议完全兼容：
 *   - TOTP(RFC 6238/SHA1/Base32) + 会话盐 双重签名
 *   - AES-256-GCM 设备 UUID 加密下发
 *   - 响应 base64+HMAC 签名
 * 数据持久化: JSON 文件 (cards.json / ip_blacklist.json / ip_whitelist.json / 会话状态)
 */

/* ==================== 配置 ==================== */
$CFG = array(
    'SECRET'              => '',   /* 响应签名主密钥: 必须由 config.php 提供, 为空时拒绝服务 */
    /* 管理令牌: 必须由 config.php 覆盖配置, 为空时管理接口全部拒绝 */
    'ADMIN_TOKEN'         => '',
    'MAX_DEVICES_DEFAULT' => 1,
    'TIME_WINDOW'         => 300,
    'SALT_TTL'            => 600000,
    'TOKEN_TTL'           => 7200000,
    'IP_FAIL_LIMIT'       => 10,
    'IP_FAIL_WINDOW'      => 600000,
    'RATE_LIMIT_TIME'     => 5,
    'RATE_LIMIT_API'      => 10,
    'RATE_LIMIT_ADMIN'    => 10,
    'BACKUP_KEEP'         => 10,
    'MAX_NONCE_CACHE'     => 50000,
    'MAX_SALT_CACHE'      => 50000,
    'MAX_TOKEN_CACHE'     => 50000,
    'MAX_RATE_CACHE'      => 50000,
    'MAX_IP_FAIL_CACHE'   => 50000,
    /* MySQL 连接: 由 config.php 提供（不硬编码凭据） */
    'DB_HOST'             => '',
    'DB_NAME'             => '',
    'DB_USER'             => '',
    'DB_PASS'             => '',
    'DB_PORT'             => 3306,
    /* 监控通道共享密钥: 由 config.php 提供 */
    'MONITOR_KEY'         => '',
);

if (is_file(__DIR__ . '/config.php')) {
    $userCfg = include __DIR__ . '/config.php';
    if (is_array($userCfg)) $CFG = array_merge($CFG, $userCfg);
}

/* ==================== 全局错误防护 ==================== */
/* 隐藏所有 PHP 错误详情 (路径/栈/SQL), 统一返回 JSON 错误码; 详情进 error_log */
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);
ob_start();
function jsonInternalError($msg) {
    if (ob_get_level() > 0) { while (ob_get_level() > 1) ob_end_clean(); @ob_end_clean(); }
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json');
    }
    echo json_encode(array('success' => false, 'message' => $msg, 'code' => 'INTERNAL_ERROR'), JSON_UNESCAPED_UNICODE);
    exit;
}
set_error_handler(function ($no, $str, $file, $line) {
    error_log('PHP[' . $no . '] ' . $str . ' @ ' . basename($file) . ':' . $line);
    return true;   /* notice/warning 一律吞掉, 不污染 JSON 输出 */
});
set_exception_handler(function ($e) {
    error_log('Uncaught exception: ' . $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine());
    jsonInternalError('服务器内部错误');
});
register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
        error_log('PHP fatal: ' . $e['message'] . ' @ ' . basename($e['file']) . ':' . $e['line']);
        jsonInternalError('服务器内部错误');
    }
});

/* ==================== 数据目录 ==================== */
/* 优先放在站点根(htdocs)之外，避免被 HTTP 直接下载；不可写时回退到站内并依赖 .htaccess 拒绝访问 */
$__dataBase = dirname(__DIR__) . '/carddata';
if (!@is_dir($__dataBase) && !@mkdir($__dataBase, 0755, true)) {
    $__dataBase = __DIR__ . '/carddata';
    if (!@is_dir($__dataBase)) @mkdir($__dataBase, 0755, true);
    @file_put_contents($__dataBase . '/.htaccess', "Require all denied\n");
}
$DATA_FILE     = $__dataBase . '/cards.json';
$BLACKLIST_FILE = $__dataBase . '/ip_blacklist.json';
$WHITELIST_FILE = $__dataBase . '/ip_whitelist.json';
$STATE_DIR     = $__dataBase . '/state';
if (!is_dir($STATE_DIR)) @mkdir($STATE_DIR, 0755, true);
$LOG_DIR       = $__dataBase . '/logs';
if (!is_dir($LOG_DIR)) @mkdir($LOG_DIR, 0755, true);
$BACKUP_DIR    = $__dataBase . '/backups';
if (!is_dir($BACKUP_DIR)) @mkdir($BACKUP_DIR, 0755, true);

/* 首次部署导入: 数据目录无 cards.json 且站内带了初始 cards.json */
if (!is_file($DATA_FILE) && is_file(__DIR__ . '/cards.json')) {
    @copy(__DIR__ . '/cards.json', $DATA_FILE);
}

/* ==================== 基础 IO ==================== */
function nowMs() { return (int)round(microtime(true) * 1000); }
function nowSec() { return time(); }

function loadJson($file, $default) {
    if (!is_file($file)) return $default;
    $raw = @file_get_contents($file);
    if ($raw === false || $raw === '') return $default;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : $default;
}

function saveJson($file, $data) {
    $tmp = $file . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
        return false;
    }
    return @rename($tmp, $file);
}

/* 读-改-写互斥锁，防止多进程并发覆盖 */
function withLock($lockName, $fn) {
    global $STATE_DIR;
    $fp = fopen($STATE_DIR . '/' . $lockName . '.lock', 'c');
    if (!$fp) return $fn();
    flock($fp, LOCK_EX);
    try { $result = $fn(); } finally { flock($fp, LOCK_UN); fclose($fp); }
    return $result;
}

/* ==================== 日志 ==================== */
function maskCard($code) {
    $s = strval($code);
    if (strlen($s) <= 4) return '****';
    return substr($s, 0, 4) . '***' . substr($s, -2);
}
function maskId($id) {
    $s = strval($id);
    if (strlen($s) <= 8) return '****';
    return substr($s, 0, 8) . '***';
}
function auditLog($action, $detail) {
    global $LOG_DIR;
    $ts = gmdate('Y-m-d\TH:i:s.v\Z');
    @file_put_contents($LOG_DIR . '/audit.log',
        '[' . $ts . '] [INFO] [AUDIT] ' . $action . ' ' . json_encode($detail, JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND | LOCK_EX);
}

/* ==================== 工具 ==================== */
function genCode() {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $s = '';
    for ($i = 0; $i < 16; $i++) {
        if ($i && $i % 4 === 0) $s .= '-';
        $s .= $chars[random_int(0, strlen($chars) - 1)];
    }
    return $s;
}
function safeEqual($a, $b) {
    return hash_equals(strval($a), strval($b));
}
/* 按字符截断 UTF-8 字符串 (避免依赖 mbstring) */
function utf8Truncate($s, $max) {
    $s = strval($s);
    if (!preg_match_all('/./us', $s, $m)) return substr($s, 0, $max);
    return implode('', array_slice($m[0], 0, $max));
}

/* ==================== MySQL 存储层 ==================== */
/* 卡密 / IP 黑白名单 存 MySQL; 高频短生命周期会话状态(salt/token/nonce/rate/ipfail)仍存本地文件 */
$__db = null;
$__dbInited = false;

function db() {
    global $CFG, $__db, $__dbInited;
    if ($__db instanceof mysqli) return $__db;
    if (empty($CFG['DB_HOST']) || empty($CFG['DB_NAME'])) {
        respond(array('success' => false, 'message' => '数据库未配置 (缺少 config.php)'), 500);
    }
    /* PHP 8.1+ 默认 error/strict 模式: 连接失败抛 mysqli_sql_exception */
    try {
        $__db = new mysqli($CFG['DB_HOST'], $CFG['DB_USER'], $CFG['DB_PASS'], $CFG['DB_NAME'], intval($CFG['DB_PORT']));
    } catch (mysqli_sql_exception $e) {
        respond(array('success' => false, 'message' => '数据库连接失败'), 500);
    }
    $__db->set_charset('utf8mb4');
    dbInitSchema();
    $__dbInited = true;
    return $__db;
}

/* 客户账号独立库连接 (ACC_DB_NAME 未配置时回落主库) */
function dbAcc() {
    global $CFG, $__accDb;
    if ($__accDb instanceof mysqli) return $__accDb;
    if (empty($CFG['ACC_DB_NAME']) || $CFG['ACC_DB_NAME'] === $CFG['DB_NAME']) {
        $__accDb = db();
    } else {
        try {
            $__accDb = new mysqli($CFG['DB_HOST'], $CFG['DB_USER'], $CFG['DB_PASS'], $CFG['ACC_DB_NAME'], intval($CFG['DB_PORT']));
        } catch (mysqli_sql_exception $e) {
            respond(array('success' => false, 'message' => '账号数据库连接失败'), 500);
        }
        $__accDb->set_charset('utf8mb4');
    }
    /* 账号四表 (回落主库时同样确保存在; uuid UNIQUE: 一台设备只能绑一个账号) */
    $__accDb->query("CREATE TABLE IF NOT EXISTS monitor_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(32) NOT NULL UNIQUE,
        pass_hash VARCHAR(255) NOT NULL,
        created_ms BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $__accDb->query("CREATE TABLE IF NOT EXISTS monitor_tokens (
        token VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        expires_ms BIGINT NOT NULL DEFAULT 0,
        INDEX idx_tok_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $__accDb->query("CREATE TABLE IF NOT EXISTS monitor_binds (
        user_id INT NOT NULL,
        uuid VARCHAR(32) NOT NULL,
        created_ms BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, uuid),
        UNIQUE KEY uniq_bind_uuid (uuid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    /* 设备编辑器变量: 四组 — 查看变量 (设备上报, 网页只读) + 修改变量/配置变量内容 (设备上报, 网页在此基础上修改下发)
     * + 各自下发暂存 (网页保存, 设备心跳拉取) */
    $__accDb->query("CREATE TABLE IF NOT EXISTS monitor_vars (
        uuid VARCHAR(32) PRIMARY KEY,
        view_var MEDIUMTEXT NOT NULL,
        edit_var_dev MEDIUMTEXT NOT NULL,
        edit_var MEDIUMTEXT NOT NULL,
        config_var_dev MEDIUMTEXT NOT NULL,
        config_var MEDIUMTEXT NOT NULL,
        updated_ms BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    /* 存量表补列 (幂等) */
    $__rV = $__accDb->query("SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monitor_vars' AND COLUMN_NAME = 'edit_var_dev'");
    if ($__rV && !$__rV->fetch_assoc()) $__accDb->query("ALTER TABLE monitor_vars ADD COLUMN edit_var_dev MEDIUMTEXT NOT NULL AFTER view_var");
    $__rV = $__accDb->query("SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monitor_vars' AND COLUMN_NAME = 'config_var_dev'");
    if ($__rV && !$__rV->fetch_assoc()) $__accDb->query("ALTER TABLE monitor_vars ADD COLUMN config_var_dev MEDIUMTEXT NOT NULL AFTER edit_var");
    $__rV = $__accDb->query("SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monitor_vars' AND COLUMN_NAME = 'config_var'");
    if ($__rV && !$__rV->fetch_assoc()) $__accDb->query("ALTER TABLE monitor_vars ADD COLUMN config_var MEDIUMTEXT NOT NULL AFTER config_var_dev");
    return $__accDb;
}

function dbInitSchema() {
    global $__db;
    $db = $__db;
    $db->query("CREATE TABLE IF NOT EXISTS cards (
        code VARCHAR(32) PRIMARY KEY,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        expire_at BIGINT NOT NULL DEFAULT 0,
        expire_mode VARCHAR(16) NOT NULL DEFAULT 'create',
        expire_days INT NOT NULL DEFAULT 0,
        max_devices INT NOT NULL DEFAULT 1,
        devices LONGTEXT NOT NULL,
        fingerprints LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL DEFAULT 0,
        note VARCHAR(255) NOT NULL DEFAULT '',
        use_count BIGINT NOT NULL DEFAULT 0,
        last_used_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $db->query("CREATE TABLE IF NOT EXISTS ip_blacklist (
        ip VARCHAR(45) PRIMARY KEY,
        reason VARCHAR(100) NOT NULL DEFAULT ''
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $db->query("CREATE TABLE IF NOT EXISTS ip_whitelist (
        ip VARCHAR(45) PRIMARY KEY
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $db->query("CREATE TABLE IF NOT EXISTS settings (
        name VARCHAR(64) PRIMARY KEY,
        value VARCHAR(255) NOT NULL DEFAULT ''
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $db->query("CREATE TABLE IF NOT EXISTS client_status (
        device_id VARCHAR(64) PRIMARY KEY,
        model VARCHAR(64) NOT NULL DEFAULT '',
        brand VARCHAR(64) NOT NULL DEFAULT '',
        product VARCHAR(64) NOT NULL DEFAULT '',
        screen VARCHAR(32) NOT NULL DEFAULT '',
        dpi INT NOT NULL DEFAULT 0,
        task_count BIGINT NOT NULL DEFAULT 0,
        error_count BIGINT NOT NULL DEFAULT 0,
        last_error VARCHAR(255) NOT NULL DEFAULT '',
        uptime_sec BIGINT NOT NULL DEFAULT 0,
        note VARCHAR(255) NOT NULL DEFAULT '',
        report_count BIGINT NOT NULL DEFAULT 0,
        first_seen BIGINT NOT NULL DEFAULT 0,
        last_seen BIGINT NOT NULL DEFAULT 0,
        battery TINYINT UNSIGNED NOT NULL DEFAULT 255,
        mem_total_mb INT NOT NULL DEFAULT 0,
        mem_avail_mb INT NOT NULL DEFAULT 0,
        screen_on TINYINT NOT NULL DEFAULT 2,
        foreground_pkg VARCHAR(120) NOT NULL DEFAULT '',
        editor_ver VARCHAR(40) NOT NULL DEFAULT '',
        uuid VARCHAR(32) NOT NULL DEFAULT ''
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $db->query("CREATE TABLE IF NOT EXISTS monitor_nonces (
        nonce VARCHAR(32) PRIMARY KEY,
        created_ms BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    /* 存量表补齐扩展监控列 (幂等: 逐列/逐索引检查 information_schema) */
    $__newCols = array(
        'battery'        => "ALTER TABLE client_status ADD COLUMN battery TINYINT UNSIGNED NOT NULL DEFAULT 255",
        'mem_total_mb'   => "ALTER TABLE client_status ADD COLUMN mem_total_mb INT NOT NULL DEFAULT 0",
        'mem_avail_mb'   => "ALTER TABLE client_status ADD COLUMN mem_avail_mb INT NOT NULL DEFAULT 0",
        'screen_on'      => "ALTER TABLE client_status ADD COLUMN screen_on TINYINT NOT NULL DEFAULT 2",
        'foreground_pkg' => "ALTER TABLE client_status ADD COLUMN foreground_pkg VARCHAR(120) NOT NULL DEFAULT ''",
        'editor_ver'     => "ALTER TABLE client_status ADD COLUMN editor_ver VARCHAR(40) NOT NULL DEFAULT ''",
        'uuid'           => "ALTER TABLE client_status ADD COLUMN uuid VARCHAR(32) NOT NULL DEFAULT ''",
        'status'         => "ALTER TABLE client_status ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT ''",
        'gold'           => "ALTER TABLE client_status ADD COLUMN gold BIGINT NOT NULL DEFAULT 0",
        'hp'             => "ALTER TABLE client_status ADD COLUMN hp BIGINT NOT NULL DEFAULT 0",
        'floor'          => "ALTER TABLE client_status ADD COLUMN floor INT NOT NULL DEFAULT 0",
        'round'          => "ALTER TABLE client_status ADD COLUMN round INT NOT NULL DEFAULT 0",
        'reset_cmd'      => "ALTER TABLE client_status ADD COLUMN reset_cmd TINYINT NOT NULL DEFAULT 0",
        'rt_ms'          => "ALTER TABLE client_status ADD COLUMN rt_ms INT UNSIGNED NOT NULL DEFAULT 0",
        'env'            => "ALTER TABLE client_status ADD COLUMN env VARCHAR(64) NOT NULL DEFAULT ''",
        'android_ver'    => "ALTER TABLE client_status ADD COLUMN android_ver VARCHAR(24) NOT NULL DEFAULT ''",
        'dev_uptime_sec' => "ALTER TABLE client_status ADD COLUMN dev_uptime_sec INT UNSIGNED NOT NULL DEFAULT 0",
        'disk_avail_mb'  => "ALTER TABLE client_status ADD COLUMN disk_avail_mb INT UNSIGNED NOT NULL DEFAULT 0",
        'orientation'    => "ALTER TABLE client_status ADD COLUMN orientation VARCHAR(10) NOT NULL DEFAULT ''",
        'hb_gap_sec'     => "ALTER TABLE client_status ADD COLUMN hb_gap_sec INT UNSIGNED NOT NULL DEFAULT 0",
        'bat_status'     => "ALTER TABLE client_status ADD COLUMN bat_status TINYINT UNSIGNED NOT NULL DEFAULT 0",
        'mon_ver'        => "ALTER TABLE client_status ADD COLUMN mon_ver VARCHAR(24) NOT NULL DEFAULT ''",
    );
    foreach ($__newCols as $__col => $__ddl) {
        $__r = $db->query("SELECT 1 FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_status' AND COLUMN_NAME = '" . $__col . "'");
        if ($__r && !$__r->fetch_assoc()) $db->query($__ddl);
    }
    $__r = $db->query("SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_status' AND INDEX_NAME = 'idx_uuid'");
    if ($__r && !$__r->fetch_assoc()) $db->query("ALTER TABLE client_status ADD INDEX idx_uuid (uuid)");
    dbMigrateFromJson();
}

/* 存量 JSON 卡密一次性导入 MySQL (幂等: settings 标记 migrated_from_json=1 后永不重跑,
 * 否则卡密被批量删除清空表时会从遗留 JSON 意外恢复数据) */
function dbMigrateFromJson() {
    global $__db, $DATA_FILE;
    $r = $__db->query("SELECT value FROM settings WHERE name = 'migrated_from_json'");
    if ($r && $r->fetch_assoc()) return;
    if (!is_file($DATA_FILE)) return;
    $cards = json_decode((string)file_get_contents($DATA_FILE), true);
    if (!is_array($cards)) return;
    foreach ($cards as $code => $card) {
        if (!is_array($card)) continue;
        dbUpsertCard($code, $card);
    }
    dbExec("INSERT INTO settings (name, value) VALUES ('migrated_from_json','1')");
    auditLog('数据迁移', array('from' => 'cards.json', 'count' => count($cards)));
}

/* DB 行 -> 业务数组 (与文件版结构一致) */
function dbRowToCard($row) {
    return array(
        'status' => $row['status'],
        'expireAt' => intval($row['expire_at']),
        'expireMode' => $row['expire_mode'],
        'expireDays' => intval($row['expire_days']),
        'maxDevices' => intval($row['max_devices']),
        'devices' => json_decode($row['devices'], true) ?: array(),
        'fingerprints' => json_decode($row['fingerprints'], true) ?: array(),
        'createdAt' => intval($row['created_at']),
        'note' => $row['note'],
        'useCount' => intval($row['use_count']),
        'lastUsedAt' => intval($row['last_used_at']),
    );
}

function dbExec($sql, $params = array()) {
    $db = db();
    $types = '';
    foreach ($params as $p) {
        if (is_int($p)) $types .= 'i';
        elseif (is_float($p)) $types .= 'd';
        else $types .= 's';
    }
    $st = $db->prepare($sql);
    if ($params) $st->bind_param($types, ...$params);
    $st->execute();
    $affected = $st->affected_rows;
    $st->close();
    return $affected;
}

function dbUpsertCard($code, $card) {
    $devices = json_encode(isset($card['devices']) && is_array($card['devices']) ? $card['devices'] : array());
    $fps = json_encode(!empty($card['fingerprints']) && is_array($card['fingerprints']) ? $card['fingerprints'] : new stdClass());
    $expireMode = isset($card['expireMode']) ? $card['expireMode'] : 'create';
    dbExec("INSERT INTO cards (code,status,expire_at,expire_mode,expire_days,max_devices,devices,fingerprints,created_at,note,use_count,last_used_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE status=VALUES(status), expire_at=VALUES(expire_at), expire_mode=VALUES(expire_mode),
        expire_days=VALUES(expire_days), max_devices=VALUES(max_devices), devices=VALUES(devices),
        fingerprints=VALUES(fingerprints), created_at=VALUES(created_at), note=VALUES(note),
        use_count=VALUES(use_count), last_used_at=VALUES(last_used_at)", array(
        $code,
        isset($card['status']) ? $card['status'] : 'active',
        intval($card['expireAt'] ?? 0),
        $expireMode,
        intval($card['expireDays'] ?? 0),
        intval($card['maxDevices'] ?? 1),
        $devices,
        $fps,
        intval($card['createdAt'] ?? 0),
        isset($card['note']) ? $card['note'] : '',
        intval($card['useCount'] ?? 0),
        intval($card['lastUsedAt'] ?? 0),
    ));
}

/* 全量读取 (list/stats 用) */
function getCards() {
    $db = db();
    $res = $db->query("SELECT * FROM cards");
    $cards = array();
    while ($row = $res->fetch_assoc()) $cards[$row['code']] = dbRowToCard($row);
    return $cards;
}

/* 事务内锁定单卡 (checkCard/unbind 用) */
function dbLockCard($code) {
    $db = db();
    $st = $db->prepare("SELECT * FROM cards WHERE code = ? FOR UPDATE");
    $st->bind_param('s', $code);
    $st->execute();
    $row = $st->get_result()->fetch_assoc();
    $st->close();
    return $row ? dbRowToCard($row) : null;
}

function getSetting($name, $default = '') {
    $db = db();
    $st = $db->prepare("SELECT value FROM settings WHERE name = ?");
    $st->bind_param('s', $name);
    $st->execute();
    $row = $st->get_result()->fetch_assoc();
    $st->close();
    return $row ? $row['value'] : $default;
}
function setSetting($name, $value) {
    dbExec("INSERT INTO settings (name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)", array($name, strval($value)));
}

/* ==================== IP 黑/白名单 (MySQL) ==================== */
function getIpBlacklist() {
    $db = db();
    $res = $db->query("SELECT ip, reason FROM ip_blacklist");
    $ips = array(); $reason = array();
    while ($row = $res->fetch_assoc()) { $ips[] = $row['ip']; $reason[$row['ip']] = $row['reason']; }
    return array('ips' => $ips, 'reason' => $reason);
}
function getIpWhitelist() {
    $db = db();
    $res = $db->query("SELECT ip FROM ip_whitelist");
    $ips = array();
    while ($row = $res->fetch_assoc()) $ips[] = $row['ip'];
    return array('ips' => $ips, 'enabled' => getSetting('wl_enabled', '0') === '1');
}

/* ==================== 会话状态(文件化) ==================== */
/* salt / token / nonce / rate / ipfail 存 JSON 文件，读取时顺带清理过期项 */
function loadState($name, $ttlMs) {
    global $STATE_DIR;
    $d = loadJson($STATE_DIR . '/' . $name . '.json', array());
    if ($ttlMs !== null) {
        $now = nowMs();
        foreach ($d as $k => $v) {
            $expire = is_array($v) ? (isset($v['expire']) ? $v['expire'] : (isset($v['until']) ? $v['until'] : $v)) : $v;
            if (is_array($v) && isset($v['count']) && isset($v['start'])) continue;
            if (is_numeric($expire) && $expire < $now) unset($d[$k]);
        }
    }
    return $d;
}
function saveState($name, $data) {
    global $STATE_DIR;
    saveJson($STATE_DIR . '/' . $name . '.json', $data);
}

/* ---- 盐 ---- */
function issueSalt() {
    global $CFG;
    return withLock('salt', function () use ($CFG) {
        $salts = loadState('salts', $CFG['SALT_TTL']);
        if (count($salts) >= $CFG['MAX_SALT_CACHE']) $salts = array();
        $salt = bin2hex(random_bytes(16));
        $salts[$salt] = nowMs() + $CFG['SALT_TTL'];
        saveState('salts', $salts);
        return $salt;
    });
}
function checkSalt($salt) {
    global $CFG;
    if (!is_string($salt) || strlen($salt) > 64 || $salt === '') return false;
    $salts = loadState('salts', $CFG['SALT_TTL']);
    return isset($salts[$salt]);
}

/* ---- 会话 token ---- */
function issueToken($key) {
    global $CFG;
    return withLock('token', function () use ($key, $CFG) {
        $tokens = loadState('tokens', $CFG['TOKEN_TTL']);
        if (count($tokens) >= $CFG['MAX_TOKEN_CACHE']) $tokens = array();
        $token = bin2hex(random_bytes(24));
        $tokens[$key] = array('token' => $token, 'expire' => nowMs() + $CFG['TOKEN_TTL']);
        saveState('tokens', $tokens);
        return $token;
    });
}
function checkToken($key, $token) {
    global $CFG;
    if (!is_string($token) || $token === '') return false;
    $tokens = loadState('tokens', $CFG['TOKEN_TTL']);
    if (!isset($tokens[$key])) return false;
    return $tokens[$key]['token'] === $token;
}

/* ---- nonce 防重放 ---- */
function checkNonce($body) {
    global $CFG;
    $now = nowSec();
    if (empty($body['nonce']) || empty($body['timestamp'])) return false;
    if (abs($now - intval($body['timestamp'])) > $CFG['TIME_WINDOW']) return false;
    return withLock('nonce', function () use ($body, $CFG) {
        $nonces = loadState('nonces', 600000);
        if (isset($nonces[$body['nonce']])) return false;
        if (count($nonces) >= $CFG['MAX_NONCE_CACHE']) $nonces = array();
        $nonces[$body['nonce']] = nowMs() + 600000; /* 保留 10 分钟, 覆盖 300 秒防重放窗口 */
        saveState('nonces', $nonces);
        return true;
    });
}

/* ---- 设备 UUID AES-256-GCM (与 Node 版二进制兼容: base64(iv12 + tag16 + cipher)) ---- */
function uuidKey() {
    global $CFG;
    return hash('sha256', 'card_uuid_v1:' . $CFG['SECRET'], true);
}
function encryptUuid($uuid) {
    $iv = random_bytes(12);
    $tag = '';
    $enc = openssl_encrypt(strval($uuid), 'aes-256-gcm', uuidKey(), OPENSSL_RAW_DATA, $iv, $tag);
    if ($enc === false) return '';
    return base64_encode($iv . $tag . $enc);
}
function decryptUuid($encoded) {
    $buf = base64_decode(strval($encoded), true);
    if ($buf === false || strlen($buf) < 29) return null;
    $iv = substr($buf, 0, 12);
    $tag = substr($buf, 12, 16);
    $data = substr($buf, 28);
    $dec = openssl_decrypt($data, 'aes-256-gcm', uuidKey(), OPENSSL_RAW_DATA, $iv, $tag);
    return $dec === false ? null : $dec;
}

/* ==================== RFC 6238 TOTP ==================== */
function base32Decode($input) {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $cleaned = strtoupper(preg_replace('/[=\s\-]/', '', strval($input)));
    $buf = '';
    $bits = 0; $value = 0;
    for ($i = 0; $i < strlen($cleaned); $i++) {
        $idx = strpos($alphabet, $cleaned[$i]);
        if ($idx === false) continue;
        $value = ($value << 5) | $idx;
        $bits += 5;
        if ($bits >= 8) { $bits -= 8; $buf .= chr(($value >> $bits) & 0xff); }
    }
    return $buf;
}
function genTotp($counter) {
    global $CFG;
    $key = base32Decode($CFG['SECRET']);
    $msg = pack('N2', ($counter >> 32) & 0xffffffff, $counter & 0xffffffff);
    $hmac = hash_hmac('sha1', $msg, $key, true);
    $offset = ord($hmac[strlen($hmac) - 1]) & 0x0f;
    $bin = ((ord($hmac[$offset]) & 0x7f) << 24) | ((ord($hmac[$offset + 1]) & 0xff) << 16)
         | ((ord($hmac[$offset + 2]) & 0xff) << 8) | (ord($hmac[$offset + 3]) & 0xff);
    return str_pad(strval($bin % 1000000), 6, '0', STR_PAD_LEFT);
}

/* ==================== 签名校验 ==================== */
function verifyRequestSign($body) {
    global $CFG;
    if (!checkSalt(isset($body['salt']) ? $body['salt'] : '')) return false;
    $counter = floor(nowSec() / 30);
    for ($d = -1; $d <= 1; $d++) {
        $totp = genTotp($counter + $d);
        if (!safeEqual($totp, isset($body['totp']) ? $body['totp'] : '')) continue;
        $parts = array(
            'client_info=AutoJS-2.0.0',
            'code=' . (isset($body['code']) ? $body['code'] : ''),
            'device_fingerprint=' . (isset($body['device_fingerprint']) ? $body['device_fingerprint'] : ''),
            'uuid=' . (isset($body['uuid']) ? $body['uuid'] : ''),
            'nonce=' . (isset($body['nonce']) ? $body['nonce'] : ''),
            'salt=' . (isset($body['salt']) ? $body['salt'] : ''),
            'totp=' . $totp,
            'timestamp=' . (isset($body['timestamp']) ? $body['timestamp'] : ''),
            'token=' . (isset($body['token']) ? $body['token'] : ''),
        );
        $str = implode('&', $parts);
        $key = $totp . $body['salt'] . $CFG['SECRET'];
        $expect = hash_hmac('sha256', $str, $key);
        if (safeEqual($expect, isset($body['sign']) ? $body['sign'] : '')) return true;
    }
    return false;
}

function signResponse($code, $payload) {
    global $CFG;
    $data = base64_encode(json_encode($payload, JSON_UNESCAPED_UNICODE));
    $inner = hash_hmac('sha256', $code . $CFG['SECRET'], 'response_salt_v2');
    $sign = hash_hmac('sha256', $data, hex2bin($inner));
    return array('data' => $data, 'sign' => $sign);
}

function respond($obj, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-CSRF-Token');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    echo json_encode($obj, JSON_UNESCAPED_UNICODE);
    exit;
}
function respondSigned($code, $payload) {
    respond(signResponse($code, $payload));
}

/* ==================== 速率限制 / 失败锁定 ==================== */
function clientIp() {
    return isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
}
function rateLimit($ip, $limit) {
    global $CFG;
    return withLock('rate', function () use ($ip, $limit, $CFG) {
        $map = loadState('rate', null);
        $now = nowMs();
        if (!isset($map[$ip]) || !is_array($map[$ip]) || $now - $map[$ip]['start'] >= 1000) {
            $map[$ip] = array('start' => $now, 'count' => 0);
        }
        $map[$ip]['count']++;
        /* 超容量时按窗口过期时间逐个清理 (保留仍在窗口内的计数, 防止单 IP 刷爆 map 使他人限流失效) */
        if (count($map) > $CFG['MAX_RATE_CACHE']) {
            foreach ($map as $k => $v) {
                if ($k !== $ip && (!is_array($v) || $now - $v['start'] >= 1000)) unset($map[$k]);
            }
            /* 清理后仍超容量: 保留当前 IP 与计数最大的窗口, 丢弃其余 */
            if (count($map) > $CFG['MAX_RATE_CACHE']) {
                uasort($map, function ($a, $b) { return $b['count'] - $a['count']; });
                $map = array_slice($map, 0, $CFG['MAX_RATE_CACHE'], true);
                if (!isset($map[$ip])) $map[$ip] = array('start' => $now, 'count' => 1);
            }
        }
        saveState('rate', $map);
        return $map[$ip]['count'] <= $limit;
    });
}
function ipFailRecord($ip) {
    global $CFG;
    withLock('ipfail', function () use ($ip, $CFG) {
        $map = loadState('ipfail', $CFG['IP_FAIL_WINDOW']);
        $now = nowMs();
        if (!isset($map[$ip]) || !is_array($map[$ip]) || $now > $map[$ip]['until']) {
            $map[$ip] = array('count' => 0, 'until' => $now + $CFG['IP_FAIL_WINDOW']);
        }
        $map[$ip]['count']++;
        if (count($map) > $CFG['MAX_IP_FAIL_CACHE']) $map = array($ip => $map[$ip]);
        saveState('ipfail', $map);
    });
}
function ipFailLocked($ip) {
    global $CFG;
    $map = loadState('ipfail', $CFG['IP_FAIL_WINDOW']);
    if (!isset($map[$ip])) return false;
    return $map[$ip]['count'] >= $CFG['IP_FAIL_LIMIT'];
}
function ipFailClear($ip) {
    withLock('ipfail', function () use ($ip) {
        $map = loadState('ipfail', null);
        if (isset($map[$ip])) { unset($map[$ip]); saveState('ipfail', $map); }
    });
}
function ipBlacklisted($ip) {
    global $CFG;
    $bl = getIpBlacklist();
    return in_array($ip, $bl['ips']) || in_array($ip, $CFG['IP_BLACKLIST'] ?? array());
}
function ipWhitelisted($ip) {
    global $CFG;
    $wl = getIpWhitelist();
    if (!$wl['enabled'] && empty($CFG['IP_WHITELIST_ENABLED'])) return true;
    return in_array($ip, $wl['ips']) || in_array($ip, $CFG['IP_WHITELIST'] ?? array());
}

/* ==================== 卡密校验核心 ==================== */
function checkCard($code, $uuidCipher, $fingerprint) {
    global $CFG;
    $db = db();
    $db->begin_transaction();
    try {
        $st = $db->prepare("SELECT * FROM cards WHERE code = ? FOR UPDATE");
        $st->bind_param('s', $code);
        $st->execute();
        $row = $st->get_result()->fetch_assoc();
        $st->close();
        if (!$row) { $db->rollback(); return array('ok' => false, 'reason' => '卡密不存在'); }
        $card = dbRowToCard($row);
        $origExpireAt = $card['expireAt'];
        if ($card['status'] === 'locked') { $db->rollback(); return array('ok' => false, 'reason' => '卡密已被锁定'); }
        if ($card['status'] === 'frozen') { $db->rollback(); return array('ok' => false, 'reason' => '卡密已被冻结'); }
        if (!empty($card['expireAt']) && $card['expireAt'] < nowSec()) {
            dbExec("UPDATE cards SET status = 'expired' WHERE code = ?", array($code));
            $db->commit();
            return array('ok' => false, 'reason' => '卡密已过期');
        }
        /* 激活计时: 首次验证时点燃 expireAt */
        if ($card['expireMode'] === 'activate' && $card['expireDays'] > 0 && empty($card['expireAt'])) {
            $card['expireAt'] = nowSec() + $card['expireDays'] * 86400;
        }
        $devices = $card['devices'];
        $fps = $card['fingerprints'];

        if ($uuidCipher) {
            $uuid = decryptUuid($uuidCipher);
            if ($uuid !== null && in_array($uuid, $devices)) {
                if (isset($fps[$uuid]) && $fps[$uuid] !== $fingerprint) {
                    $db->rollback();
                    return array('ok' => false, 'reason' => '设备指纹不匹配');
                }
                commitExpire($db, $code, $card['expireAt'], $origExpireAt);
                $db->commit();
                return array('ok' => true, 'reason' => '验证成功', 'expireAt' => $card['expireAt'], 'uuid' => $uuid);
            }
        }
        $matched = null;
        foreach ($devices as $id) {
            if (isset($fps[$id]) && $fps[$id] === $fingerprint) { $matched = $id; break; }
        }
        if ($matched !== null) {
            commitExpire($db, $code, $card['expireAt'], $origExpireAt);
            $db->commit();
            return array('ok' => true, 'reason' => '验证成功', 'expireAt' => $card['expireAt'], 'uuid' => $matched);
        }
        if (count($devices) >= ($card['maxDevices'] ?: $CFG['MAX_DEVICES_DEFAULT'])) {
            $db->rollback();
            return array('ok' => false, 'reason' => '设备数已达上限');
        }
        $uuid = bin2hex(random_bytes(16));
        $devices[] = $uuid;
        $fps[$uuid] = $fingerprint;
        dbExec("UPDATE cards SET devices = ?, fingerprints = ?, expire_at = ? WHERE code = ?", array(
            json_encode($devices), json_encode($fps ? $fps : new stdClass()), $card['expireAt'], $code,
        ));
        $db->commit();
        return array('ok' => true, 'reason' => '验证成功', 'expireAt' => $card['expireAt'], 'uuid' => $uuid);
    } catch (Throwable $e) {
        @$db->rollback();
        throw $e;
    }
}

/* activate 模式首次验证点燃有效期 */
function commitExpire($db, $code, $expireAt, $origExpireAt) {
    if ($expireAt !== $origExpireAt) {
        $st = $db->prepare("UPDATE cards SET expire_at = ? WHERE code = ?");
        $st->bind_param('is', $expireAt, $code);
        $st->execute();
        $st->close();
    }
}

/* ==================== 验证/心跳 ==================== */
function handleVerify($body, $isHeartbeat) {
    global $CFG;
    $tag = $isHeartbeat ? 'heartbeat' : 'verify';
    $ip = clientIp();
    $bodyCode = (is_array($body) && isset($body['code'])) ? $body['code'] : '';
    if (empty($CFG['SECRET'])) respondSigned($bodyCode, array('success' => false, 'message' => '服务未配置'));   /* 主密钥未配置: 拒绝所有验证 */
    if (ipBlacklisted($ip)) {
        respondSigned($bodyCode, array('success' => false, 'message' => '访问被拒绝'));
    }
    if (ipFailLocked($ip)) {
        respondSigned($bodyCode, array('success' => false, 'message' => '失败次数过多，请 10 分钟后再试'));
    }
    $valid = is_array($body)
        && isset($body['code']) && is_string($body['code'])
        && isset($body['device_fingerprint']) && is_string($body['device_fingerprint'])
        && isset($body['nonce']) && is_string($body['nonce'])
        && (!isset($body['uuid']) || $body['uuid'] === null || is_string($body['uuid']))
        && (!$isHeartbeat || (isset($body['token']) && is_string($body['token'])));
    if (!$valid) {
        ipFailRecord($ip);
        respondSigned($bodyCode, array('success' => false, 'message' => '请求参数不完整'));
    }
    if (!verifyRequestSign($body)) {
        ipFailRecord($ip);
        respondSigned($body['code'], array('success' => false, 'message' => '请求签名校验失败'));
    }
    if (!checkNonce($body)) {
        ipFailRecord($ip);
        respondSigned($body['code'], array('success' => false, 'message' => '请求已过期或重复提交'));
    }
    $result = checkCard($body['code'], isset($body['uuid']) ? $body['uuid'] : '', $body['device_fingerprint']);
    if (!$result['ok']) {
        if ($result['reason'] !== '设备数已达上限') ipFailRecord($ip);
        respondSigned($body['code'], array('success' => false, 'message' => $result['reason']));
    }
    ipFailClear($ip);

    dbExec("UPDATE cards SET use_count = use_count + 1, last_used_at = ? WHERE code = ?", array(nowSec(), $body['code']));

    $tokKey = $body['code'] . '|' . $result['uuid'];
    if ($isHeartbeat) {
        if (!checkToken($tokKey, isset($body['token']) ? $body['token'] : '')) {
            respondSigned($body['code'], array('success' => false, 'message' => '会话已失效'));
        }
    }
    $token = $isHeartbeat ? $body['token'] : issueToken($tokKey);
    respondSigned($body['code'], array(
        'success' => true,
        'message' => $isHeartbeat ? '心跳正常' : $result['reason'],
        'token' => $token,
        'expireAt' => $result['expireAt'] ?? 0,
        'uuid' => encryptUuid($result['uuid']),
    ));
}

/* ==================== 数据备份 ==================== */
function backupData() {
    global $BACKUP_DIR, $CFG;
    $cards = getCards();
    if (!$cards) return;
    if (!is_dir($BACKUP_DIR)) @mkdir($BACKUP_DIR, 0755, true);
    $ts = gmdate('Y-m-d\TH-i-s.v\Z');
    @file_put_contents($BACKUP_DIR . '/cards-' . $ts . '.json', json_encode($cards, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    $backups = glob($BACKUP_DIR . '/cards-*.json');
    if ($backups && count($backups) > $CFG['BACKUP_KEEP']) {
        sort($backups);
        while (count($backups) > $CFG['BACKUP_KEEP']) {
            @unlink(array_shift($backups));
        }
    }
}

/* ==================== 管理 API ==================== */
function adminAuth() {
    global $CFG;
    if ($CFG['ADMIN_TOKEN'] === '') return false; /* 未配置令牌时拒绝所有管理请求 */
    $auth = '';
    if (isset($_SERVER['HTTP_AUTHORIZATION'])) $auth = $_SERVER['HTTP_AUTHORIZATION'];
    elseif (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) $auth = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    return $auth === 'Bearer ' . $CFG['ADMIN_TOKEN'];
}

function handleAdminList($query) {
    $cards = getCards();
    $now = nowSec();
    $list = array();
    foreach ($cards as $code => $c) {
        $status = isset($c['status']) ? $c['status'] : 'active';
        if ($status === 'active' && !empty($c['expireAt']) && $c['expireAt'] < $now) $status = 'expired';
        $list[] = array(
            'code' => $code,
            'status' => $status,
            'expireAt' => isset($c['expireAt']) ? $c['expireAt'] : 0,
            'expireMode' => isset($c['expireMode']) ? $c['expireMode'] : 'create',
            'expireDays' => isset($c['expireDays']) ? $c['expireDays'] : 0,
            'maxDevices' => isset($c['maxDevices']) ? $c['maxDevices'] : 1,
            'devices' => isset($c['devices']) && is_array($c['devices']) ? $c['devices'] : array(),
            'fingerprints' => isset($c['fingerprints']) && is_array($c['fingerprints']) ? (object)$c['fingerprints'] : new stdClass(),
            'createdAt' => isset($c['createdAt']) ? $c['createdAt'] : 0,
            'note' => isset($c['note']) ? $c['note'] : '',
            'useCount' => isset($c['useCount']) ? $c['useCount'] : 0,
            'lastUsedAt' => isset($c['lastUsedAt']) ? $c['lastUsedAt'] : 0,
        );
    }
    $keyword = strtoupper(trim(isset($query['search']) ? $query['search'] : ''));
    if ($keyword !== '') {
        $list = array_values(array_filter($list, function ($c) use ($keyword) {
            return strpos(strtoupper($c['code']), $keyword) !== false
                || ($c['note'] !== '' && strpos(strtoupper($c['note']), $keyword) !== false);
        }));
    }
    $statusFilter = isset($query['status']) ? $query['status'] : '';
    if ($statusFilter !== '' && in_array($statusFilter, array('active', 'locked', 'frozen', 'expired'))) {
        $list = array_values(array_filter($list, function ($c) use ($statusFilter) { return $c['status'] === $statusFilter; }));
    }
    usort($list, function ($a, $b) { return ($b['createdAt'] ?? 0) - ($a['createdAt'] ?? 0); });
    $total = count($list);
    $page = max(intval(isset($query['page']) ? $query['page'] : 1) ?: 1, 1);
    $size = min(max(intval(isset($query['size']) ? $query['size'] : 50) ?: 50, 1), 200);
    $paged = array_slice($list, ($page - 1) * $size, $size);
    respond(array(
        'success' => true,
        'cards' => $paged,
        'pagination' => array('page' => $page, 'size' => $size, 'total' => $total, 'pages' => (int)ceil($total / $size)),
    ));
}

function handleAdminStats() {
    $cards = getCards();
    $now = nowSec();
    $total = 0; $active = 0; $locked = 0; $frozen = 0; $expired = 0;
    $totalDevices = 0; $usedCards = 0; $totalUseCount = 0;
    foreach ($cards as $c) {
        $total++;
        $totalUseCount += isset($c['useCount']) ? $c['useCount'] : 0;
        $st = isset($c['status']) ? $c['status'] : 'active';
        if ($st === 'expired' || (!empty($c['expireAt']) && $c['expireAt'] < $now)) {
            $expired++;
        } else {
            if ($st === 'active') $active++;
            elseif ($st === 'locked') $locked++;
            elseif ($st === 'frozen') $frozen++;
        }
        if (isset($c['devices']) && is_array($c['devices']) && count($c['devices']) > 0) {
            $usedCards++;
            $totalDevices += count($c['devices']);
        }
    }
    respond(array('success' => true, 'stats' => array(
        'total' => $total, 'active' => $active, 'locked' => $locked, 'frozen' => $frozen, 'expired' => $expired,
        'usedCards' => $usedCards, 'unusedCards' => $total - $usedCards,
        'totalDevices' => $totalDevices, 'totalUseCount' => $totalUseCount,
    )));
}

function handleAdminIssue($body) {
    global $CFG;
    $count = min(max(intval(isset($body['count']) ? $body['count'] : 1) ?: 1, 1), 1000);
    $days = intval(isset($body['days']) ? $body['days'] : 0) ?: 0;
    $maxDevices = intval(isset($body['max_devices']) ? $body['max_devices'] : 0) ?: $CFG['MAX_DEVICES_DEFAULT'];
    $prefix = strtoupper(preg_replace('/[^A-Z0-9]/', '', strval(isset($body['prefix']) ? $body['prefix'] : '')));
    $prefix = substr($prefix, 0, 6);
    $expireMode = (isset($body['expire_mode']) && $body['expire_mode'] === 'activate') ? 'activate' : 'create';
    $existing = array_keys(getCards());
    $codes = array();
    for ($i = 0; $i < $count; $i++) {
        $attempts = 0;
        do {
            $code = genCode();
            if ($prefix !== '') $code = $prefix . substr($code, strlen($prefix));
            $attempts++;
        } while (in_array($code, $existing) && $attempts < 100);
        $existing[] = $code;
        dbUpsertCard($code, array(
            'status' => 'active',
            'expireAt' => ($expireMode === 'create' && $days > 0) ? nowSec() + $days * 86400 : 0,
            'expireMode' => $expireMode,
            'expireDays' => $days,
            'maxDevices' => $maxDevices,
            'devices' => array(),
            'createdAt' => nowSec(),
            'useCount' => 0,
            'lastUsedAt' => 0,
        ));
        $codes[] = $code;
    }
    backupData();
    auditLog('生成卡密', array('count' => count($codes)));
    respond(array('success' => true, 'codes' => $codes));
}

function cardStatusSql($action) {
    if ($action === 'lock') return 'locked';
    if ($action === 'unlock' || $action === 'unfreeze') return 'active';
    if ($action === 'freeze') return 'frozen';
    return null;
}

function handleAdminCard($body) {
    $action = isset($body['action']) ? $body['action'] : '';
    $code = isset($body['code']) ? $body['code'] : '';
    if ($action === 'delete') {
        $affected = dbExec("DELETE FROM cards WHERE code = ?", array($code));
        if ($affected < 1) respond(array('success' => false, 'message' => '卡密不存在'));
        backupData();
        auditLog('卡密操作', array('code' => maskCard($code), 'action' => $action));
        respond(array('success' => true));
    }
    $status = cardStatusSql($action);
    if ($status === null) respond(array('success' => false, 'message' => '未知操作'));
    $affected = dbExec("UPDATE cards SET status = ? WHERE code = ?", array($status, $code));
    if ($affected < 1) respond(array('success' => false, 'message' => '卡密不存在'));
    auditLog('卡密操作', array('code' => maskCard($code), 'action' => $action));
    respond(array('success' => true));
}

function handleAdminBatch($body) {
    $codes = isset($body['codes']) && is_array($body['codes']) ? $body['codes'] : array();
    $action = isset($body['action']) ? $body['action'] : '';
    if (count($codes) === 0) respond(array('success' => false, 'message' => '请提供卡密列表'));
    if (count($codes) > 100) respond(array('success' => false, 'message' => '单次最多操作 100 张卡密'));
    if (!in_array($action, array('lock', 'unlock', 'freeze', 'unfreeze', 'delete'))) {
        respond(array('success' => false, 'message' => '无效操作'));
    }
    $affected = 0; $skipped = 0;
    foreach ($codes as $code) {
        $n = ($action === 'delete')
            ? dbExec("DELETE FROM cards WHERE code = ?", array($code))
            : dbExec("UPDATE cards SET status = ? WHERE code = ?", array(cardStatusSql($action), $code));
        if ($n >= 1) $affected++; else $skipped++;
    }
    backupData();
    auditLog('批量操作', array('action' => $action, 'total' => count($codes), 'affected' => $affected, 'skipped' => $skipped));
    respond(array('success' => true, 'affected' => $affected, 'skipped' => $skipped));
}

function handleAdminUnbind($body) {
    $code = isset($body['code']) ? $body['code'] : '';
    $deviceUuid = isset($body['device_uuid']) ? $body['device_uuid'] : '';
    db();
    $db = $GLOBALS['__db'];
    $db->begin_transaction();
    try {
        $card = dbLockCard($code);
        if ($card === null) { $db->rollback(); respond(array('success' => false, 'message' => '卡密不存在')); }
        $devices = $card['devices'];
        $idx = array_search($deviceUuid, $devices);
        if ($idx === false) { $db->rollback(); respond(array('success' => false, 'message' => '设备未绑定到此卡密')); }
        array_splice($devices, $idx, 1);
        $fps = $card['fingerprints'];
        if (isset($fps[$deviceUuid])) unset($fps[$deviceUuid]);
        dbExec("UPDATE cards SET devices = ?, fingerprints = ? WHERE code = ?", array(
            json_encode($devices), json_encode($fps ? $fps : new stdClass()), $code,
        ));
        $db->commit();
    } catch (Throwable $e) {
        @$db->rollback();
        throw $e;
    }
    auditLog('设备解绑', array('code' => maskCard($code), 'device' => maskId($deviceUuid)));
    respond(array('success' => true));
}

function handleAdminNote($body) {
    $code = isset($body['code']) ? $body['code'] : '';
    $note = utf8Truncate(isset($body["note"]) ? $body["note"] : "", 200);
    $affected = dbExec("UPDATE cards SET note = ? WHERE code = ?", array($note, $code));
    if ($affected < 1) respond(array('success' => false, 'message' => '卡密不存在'));
    auditLog('备注更新', array('code' => maskCard($code), 'note' => $note));
    respond(array('success' => true, 'note' => $note));
}

function handleAdminLogs($query) {
    global $LOG_DIR;
    $logPath = $LOG_DIR . '/audit.log';
    $lines = array();
    if (is_file($logPath)) {
        $content = @file_get_contents($logPath);
        if ($content !== false) {
            $lines = array_reverse(array_values(array_filter(explode("\n", $content), function ($l) { return $l !== ''; })));
        }
    }
    $typeFilter = trim(isset($query['type']) ? $query['type'] : '');
    if ($typeFilter !== '') {
        $lines = array_values(array_filter($lines, function ($l) use ($typeFilter) { return strpos($l, $typeFilter) !== false; }));
    }
    $total = count($lines);
    $page = max(intval(isset($query['page']) ? $query['page'] : 1) ?: 1, 1);
    $size = min(max(intval(isset($query['size']) ? $query['size'] : 50) ?: 50, 1), 200);
    $paged = array_slice($lines, ($page - 1) * $size, $size);
    respond(array(
        'success' => true,
        'logs' => $paged,
        'pagination' => array('page' => $page, 'size' => $size, 'total' => $total, 'pages' => (int)ceil($total / $size)),
    ));
}

function handleAdminBlacklist($method, $body) {
    $bl = getIpBlacklist();
    if ($method === 'POST') {
        $ip = trim(strval(isset($body['ip']) ? $body['ip'] : ''));
        $reason = utf8Truncate(isset($body["reason"]) ? $body["reason"] : "", 100);
        if (!$ip || !preg_match('/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/', $ip)) {
            respond(array('success' => false, 'message' => '无效的 IP 地址'));
        }
        if (!in_array($ip, $bl['ips'])) {
            dbExec("INSERT INTO ip_blacklist (ip, reason) VALUES (?,?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)", array($ip, $reason));
            auditLog('IP 黑名单添加', array('ip' => $ip, 'reason' => $reason));
            $bl = getIpBlacklist();
        }
    }
    elseif ($method === 'DELETE') {
        $ip = trim(strval(isset($body['ip']) ? $body['ip'] : ''));
        if (dbExec("DELETE FROM ip_blacklist WHERE ip = ?", array($ip)) >= 1) {
            auditLog('IP 黑名单移除', array('ip' => $ip));
            $bl = getIpBlacklist();
        }
    }
    respond(array('success' => true, 'blacklist' => (object)array(
        'ips' => $bl['ips'],
        'reason' => (object)$bl['reason'],
    )));
}

function handleAdminWhitelist($method, $body) {
    $wl = getIpWhitelist();
    if ($method === 'POST') {
        if (array_key_exists('enabled', $body)) {
            setSetting('wl_enabled', $body['enabled'] ? '1' : '0');
            auditLog('白名单开关', array('enabled' => (bool)$body['enabled']));
            $wl = getIpWhitelist();
        }
        else {
            $ip = trim(strval(isset($body['ip']) ? $body['ip'] : ''));
            if (!$ip || !preg_match('/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/', $ip)) {
                respond(array('success' => false, 'message' => '无效的 IP 地址'));
            }
            if (!in_array($ip, $wl['ips'])) {
                dbExec("INSERT IGNORE INTO ip_whitelist (ip) VALUES (?)", array($ip));
                auditLog('IP 白名单添加', array('ip' => $ip));
                $wl = getIpWhitelist();
            }
        }
    }
    elseif ($method === 'DELETE') {
        $ip = trim(strval(isset($body['ip']) ? $body['ip'] : ''));
        if (dbExec("DELETE FROM ip_whitelist WHERE ip = ?", array($ip)) >= 1) {
            auditLog('IP 白名单移除', array('ip' => $ip));
            $wl = getIpWhitelist();
        }
    }
    respond(array('success' => true, 'whitelist' => $wl));
}

/* ==================== 设备监控 (独立于卡密业务) ==================== */
function monitorAuth($key) {
    global $CFG;
    return $CFG['MONITOR_KEY'] !== '' && safeEqual(strval($key), $CFG['MONITOR_KEY']);
}

/* ============ 管理员密钥/令牌防爆破: 连续失败 3 次封禁该 IP 30 分钟 ============ */
function adminFailCheck($ip) {
    $map = loadState('admin_fail', 1800000);
    if (!isset($map[$ip]) || !is_array($map[$ip])) return false;
    return intval($map[$ip]['count']) >= 3 && nowMs() < intval($map[$ip]['until']);
}

function adminFail($ip) {
    withLock('admin_fail', function () use ($ip) {
        $map = loadState('admin_fail', 1800000);
        $now = nowMs();
        if (!isset($map[$ip]) || !is_array($map[$ip]) || $now >= intval($map[$ip]['until'])) {
            $map[$ip] = array('count' => 0, 'until' => $now + 1800000);
        }
        $map[$ip]['count']++;
        if ($map[$ip]['count'] >= 3) $map[$ip]['until'] = $now + 1800000;
        saveState('admin_fail', $map);
    });
}

function adminFailClear($ip) {
    withLock('admin_fail', function () use ($ip) {
        $map = loadState('admin_fail', 1800000);
        unset($map[$ip]);
        saveState('admin_fail', $map);
    });
}

/* Base32 解码 (RFC 4648, 与客户端 monitor.js 的 _base32Decode 一致) */
function monitorBase32Decode($b32) {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $b32 = strtoupper(preg_replace('/[=\s\-]/', '', strval($b32)));
    $bits = 0;
    $value = 0;
    $out = '';
    for ($i = 0, $n = strlen($b32); $i < $n; $i++) {
        $idx = strpos($alphabet, $b32[$i]);
        if ($idx === false) continue;
        $value = ($value << 5) | $idx;
        $bits += 5;
        if ($bits >= 8) {
            $bits -= 8;
            $out .= chr(($value >> $bits) & 0xff);
        }
    }
    return $out;
}

/* 标准 TOTP 校验 (RFC 6238 SHA1 + 动态截断, 允许 ±1 个 30 秒窗口) */
function monitorTotpVerify($seedB32, $totp, $tsSec) {
    $key = monitorBase32Decode($seedB32);
    if ($key === '') return false;
    $counter = intdiv(intval($tsSec), 30);
    for ($w = -1; $w <= 1; $w++) {
        $c = $counter + $w;
        $bin = pack('N2', ($c >> 32) & 0xffffffff, $c & 0xffffffff);
        $h = hash_hmac('sha1', $bin, $key, true);
        $off = ord(substr($h, -1)) & 0x0f;
        $val = ((ord($h[$off]) & 0x7f) << 24) | (ord($h[$off + 1]) << 16) | (ord($h[$off + 2]) << 8) | ord($h[$off + 3]);
        $code = str_pad(strval($val % 1000000), 6, '0', STR_PAD_LEFT);
        if (safeEqual($code, strval($totp))) return true;
    }
    return false;
}

/* TOTP + 签名公共验证 (report/thumb 共用):
 * timestamp 允许 ±120 秒时钟偏移; totp 允许 ±1 个 30 秒窗口;
 * sign = HMAC-SHA256(参数串, totp . seed); nonce 主键去重防重放
 * 返回 array(deviceId, uuid) 或直接 respond 错误 */
function monitorVerifySigned($body) {
    global $CFG;
    $ts = intval(isset($body['timestamp']) ? $body['timestamp'] : 0);
    $nonce = preg_replace('/[^A-Za-z0-9]/', '', strval(isset($body['nonce']) ? $body['nonce'] : ''));
    $totp = preg_replace('/[^0-9]/', '', strval(isset($body['totp']) ? $body['totp'] : ''));
    $sign = preg_replace('/[^0-9a-f]/', '', strval(isset($body['sign']) ? $body['sign'] : ''));
    if (strlen($nonce) < 8 || strlen($totp) !== 6 || strlen($sign) !== 64) {
        respond(array('success' => false, 'message' => '缺少动态凭证'), 400);
    }
    if ($CFG['MONITOR_TOTP_SEED'] === '' || abs(nowSec() - $ts) > 120) {
        respond(array('success' => false, 'message' => '时间偏移过大'), 400);
    }
    if (!monitorTotpVerify($CFG['MONITOR_TOTP_SEED'], $totp, $ts)) {
        respond(array('success' => false, 'message' => '动态码无效'), 401);
    }
    /* 验签使用客户端发送的原始身份值 (清洗后再拼参数串会与客户端不一致) */
    $deviceIdRaw = strval(isset($body['deviceId']) ? $body['deviceId'] : '');
    $uuidRaw = strval(isset($body['uuid']) ? $body['uuid'] : '');
    $expected = hash_hmac('sha256',
        'deviceId=' . $deviceIdRaw . '&uuid=' . $uuidRaw . '&nonce=' . $nonce . '&timestamp=' . $ts . '&totp=' . $totp,
        $totp . $CFG['MONITOR_TOTP_SEED']);
    if (!safeEqual($expected, $sign)) {
        respond(array('success' => false, 'message' => '签名无效'), 401);
    }
    /* nonce 防重放: 主键插入失败即已存在; 顺手清理 10 分钟前的过期 nonce */
    if (dbExec("INSERT IGNORE INTO monitor_nonces (nonce, created_ms) VALUES (?, ?)", array($nonce, nowMs())) < 1) {
        respond(array('success' => false, 'message' => '重复请求'), 401);
    }
    dbExec("DELETE FROM monitor_nonces WHERE created_ms < ?", array(nowMs() - 600000));
    return array('deviceId' => $deviceIdRaw, 'uuid' => $uuidRaw);
}

function handleMonitorReport($body) {
    global $CFG;
    $v = monitorVerifySigned($body);
    $deviceId = preg_replace('/[^A-Za-z0-9_\-\.]/', '', $v['deviceId']);
    if ($deviceId === '' || strlen($deviceId) > 64) {
        respond(array('success' => false, 'message' => '设备标识无效'), 400);
    }
    $now = nowMs();
    /* battery: 0-100 有效, 255=未知; screenOn: 0=灭屏 1=亮屏 2=未知 */
    $battery = intval(isset($body['battery']) ? $body['battery'] : 255);
    $battery = ($battery >= 0 && $battery <= 100) ? $battery : 255;
    $screenOn = intval(isset($body['screenOn']) ? $body['screenOn'] : 2);
    if ($screenOn !== 0 && $screenOn !== 1) $screenOn = 2;
    $fields = array(
        'model'      => utf8Truncate(isset($body['model']) ? $body['model'] : '', 60),
        'brand'      => utf8Truncate(isset($body['brand']) ? $body['brand'] : '', 60),
        'product'    => utf8Truncate(isset($body['product']) ? $body['product'] : '', 60),
        'screen'     => utf8Truncate(isset($body['screen']) ? $body['screen'] : '', 30),
        'dpi'        => max(0, min(2000, intval(isset($body['dpi']) ? $body['dpi'] : 0))),
        'task_count' => max(0, min(1000000000, intval(isset($body['taskCount']) ? $body['taskCount'] : 0))),
        'error_count'=> max(0, min(1000000000, intval(isset($body['errorCount']) ? $body['errorCount'] : 0))),
        'last_error' => utf8Truncate(isset($body['lastError']) ? $body['lastError'] : '', 240),
        'uptime_sec' => max(0, min(4000000000, intval(isset($body['uptimeSec']) ? $body['uptimeSec'] : 0))),
        'note'       => utf8Truncate(isset($body['note']) ? $body['note'] : '', 240),
        'battery'        => $battery,
        'mem_total_mb'   => max(0, min(2000000, intval(isset($body['memTotalMb']) ? $body['memTotalMb'] : 0))),
        'mem_avail_mb'   => max(0, min(2000000, intval(isset($body['memAvailMb']) ? $body['memAvailMb'] : 0))),
        'screen_on'      => $screenOn,
        'foreground_pkg' => utf8Truncate(isset($body['foregroundPkg']) ? $body['foregroundPkg'] : '', 120),
        'editor_ver'     => utf8Truncate(isset($body['editorVer']) ? $body['editorVer'] : '', 40),
        'uuid'           => strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', strval(isset($body['uuid']) ? $body['uuid'] : ''))),
        'gold'           => max(0, min(9999999999, intval(isset($body['gold']) ? $body['gold'] : 0))),
        'hp'             => max(0, min(9999999999, intval(isset($body['hp']) ? $body['hp'] : 0))),
        'floor'          => max(0, min(9999999, intval(isset($body['floor']) ? $body['floor'] : 0))),
        'round'          => max(0, min(9999999999, intval(isset($body['round']) ? $body['round'] : 0))),
        /* 诊断项: 往返延迟/运行环境/Android版本/设备开机时长/磁盘可用/屏幕方向/心跳间隔/充电状态 */
        'rt_ms'          => max(0, min(600000, intval(isset($body['rtMs']) ? $body['rtMs'] : 0))),
        'env'            => utf8Truncate(isset($body['env']) ? $body['env'] : '', 64),
        'android_ver'    => utf8Truncate(isset($body['androidVer']) ? $body['androidVer'] : '', 24),
        'dev_uptime_sec' => max(0, min(4000000000, intval(isset($body['deviceUptimeSec']) ? $body['deviceUptimeSec'] : 0))),
        'disk_avail_mb'  => max(0, min(2000000, intval(isset($body['diskAvailMb']) ? $body['diskAvailMb'] : 0))),
        'orientation'    => utf8Truncate(isset($body['orientation']) ? $body['orientation'] : '', 10),
        'hb_gap_sec'     => max(0, min(3000000, intval(isset($body['hbGapSec']) ? $body['hbGapSec'] : 0))),
        'bat_status'     => max(0, min(3, intval(isset($body['batStatus']) ? $body['batStatus'] : 0))),
        /* 客户端插件版本号 (monitor.js MON_VERSION), 设备卡与升级排查用 */
        'mon_ver'        => utf8Truncate(isset($body['ver']) ? $body['ver'] : '', 24),
    );
    dbExec(
        "INSERT INTO client_status
            (device_id, model, brand, product, screen, dpi, task_count, error_count, last_error, uptime_sec, note,
             battery, mem_total_mb, mem_avail_mb, screen_on, foreground_pkg, editor_ver, uuid,
             gold, hp, floor, round, rt_ms, env, android_ver, dev_uptime_sec, disk_avail_mb, orientation, hb_gap_sec, bat_status,
             mon_ver, report_count, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
            model=VALUES(model), brand=VALUES(brand), product=VALUES(product), screen=VALUES(screen), dpi=VALUES(dpi),
            task_count=VALUES(task_count), error_count=VALUES(error_count), last_error=VALUES(last_error),
            uptime_sec=VALUES(uptime_sec), note=VALUES(note),
            battery=VALUES(battery), mem_total_mb=VALUES(mem_total_mb), mem_avail_mb=VALUES(mem_avail_mb),
            screen_on=VALUES(screen_on), foreground_pkg=VALUES(foreground_pkg), editor_ver=VALUES(editor_ver),
            uuid=VALUES(uuid), gold=VALUES(gold), hp=VALUES(hp), floor=VALUES(floor), round=VALUES(round),
            rt_ms=VALUES(rt_ms), env=VALUES(env), android_ver=VALUES(android_ver),
            dev_uptime_sec=VALUES(dev_uptime_sec), disk_avail_mb=VALUES(disk_avail_mb),
            orientation=VALUES(orientation), hb_gap_sec=VALUES(hb_gap_sec), bat_status=VALUES(bat_status),
            mon_ver=VALUES(mon_ver),
            report_count=report_count+1, last_seen=VALUES(last_seen)",
        array_merge(array($deviceId), array_values($fields), array(1, $now, $now))
    );
    /* 编辑器"查看变量"+"修改变量内容"+"配置变量内容"上报: 均为设备原始字符串, 尽力存储, 失败不影响心跳;
     * 修变量内容 (editVarDev) 与配置变量内容 (configVarDev) 是网页可修改项的数据来源, 下发暂存 (edit_var/config_var) 默认不被上报覆盖;
     * 上发配置 (uploadCfg=1, 设备为新配置源): 设备上报内容反向覆盖下发基线 (edit_var/config_var), 网页基线与设备当前配置对齐;
     * 旧客户端未带对应字段时保留已存内容 */
    $repUuid = strtoupper(strval($fields['uuid']));
    $upCfg = isset($body['uploadCfg']) && intval($body['uploadCfg']) === 1;
    if ($repUuid !== '' && (isset($body['viewVar']) || isset($body['editVarDev']))) {
        $vv = isset($body['viewVar']) && is_string($body['viewVar']) ? strval($body['viewVar']) : '';
        $dv = isset($body['editVarDev']) && is_string($body['editVarDev']) ? strval($body['editVarDev']) : null;
        $nowV = nowMs();
        $empty = '';
        if ($dv !== null && strlen($vv) <= 65536 && strlen($dv) <= 65536) {
            $cvd = isset($body['configVarDev']) && is_string($body['configVarDev']) ? strval($body['configVarDev']) : '';
            if ($upCfg) {
                $stV = dbAcc()->prepare("INSERT INTO monitor_vars (uuid, view_var, edit_var_dev, edit_var, config_var_dev, config_var, updated_ms) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE view_var = VALUES(view_var), edit_var_dev = VALUES(edit_var_dev), edit_var = VALUES(edit_var), updated_ms = VALUES(updated_ms)");
                if ($stV) {
                    $stV->bind_param('ssssssi', $repUuid, $vv, $dv, $dv, $cvd, $empty, $nowV);
                    $stV->execute();
                    $stV->close();
                    /* 上发生效审计: 设备内容已反向覆盖下发基线; 摘要一行可读, 完整 JSON 快照限长 2000 供网页展开查看 */
                    auditLog('配置上发', array('device' => maskId($repUuid), 'by' => '设备', 'editLen' => strlen($dv), 'cfgLen' => strlen($cvd),
                        'cfg' => monVarsDigest($cvd), 'edit' => monVarsDigest($dv),
                        'cfgContent' => utf8Truncate($cvd, 2000), 'editContent' => utf8Truncate($dv, 2000)));
                }
            } else {
                $stV = dbAcc()->prepare("INSERT INTO monitor_vars (uuid, view_var, edit_var_dev, edit_var, config_var_dev, config_var, updated_ms) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE view_var = VALUES(view_var), edit_var_dev = VALUES(edit_var_dev), updated_ms = VALUES(updated_ms)");
                if ($stV) {
                    $stV->bind_param('ssssssi', $repUuid, $vv, $dv, $empty, $cvd, $empty, $nowV);
                    $stV->execute();
                    $stV->close();
                }
            }
        } elseif ($dv === null && strlen($vv) <= 65536) {
            $stV = dbAcc()->prepare("INSERT INTO monitor_vars (uuid, view_var, edit_var_dev, edit_var, config_var_dev, config_var, updated_ms) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE view_var = VALUES(view_var), updated_ms = VALUES(updated_ms)");
            if ($stV) {
                $stV->bind_param('ssssssi', $repUuid, $vv, $empty, $empty, $empty, $empty, $nowV);
                $stV->execute();
                $stV->close();
            }
        }
    }
    /* 配置变量内容上报: 与修改变量同构的第二组可修改下发数据, 下发暂存 (config_var) 默认不被上报覆盖;
     * 上发配置 (uploadCfg=1) 时设备内容反向覆盖 config_var 基线 */
    if ($repUuid !== '' && isset($body['configVarDev']) && is_string($body['configVarDev']) && strlen($body['configVarDev']) <= 65536) {
        $cv = strval($body['configVarDev']);
        $nowC = nowMs();
        $emptyC = '';
        if ($upCfg) {
            $stC = dbAcc()->prepare("INSERT INTO monitor_vars (uuid, view_var, edit_var_dev, edit_var, config_var_dev, config_var, updated_ms) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE config_var_dev = VALUES(config_var_dev), config_var = VALUES(config_var), updated_ms = VALUES(updated_ms)");
            if ($stC) {
                $stC->bind_param('ssssssi', $repUuid, $emptyC, $emptyC, $emptyC, $cv, $cv, $nowC);
                $stC->execute();
                $stC->close();
            }
        } else {
            $stC = dbAcc()->prepare("INSERT INTO monitor_vars (uuid, view_var, edit_var_dev, edit_var, config_var_dev, config_var, updated_ms) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE config_var_dev = VALUES(config_var_dev), updated_ms = VALUES(updated_ms)");
            if ($stC) {
                $stC->bind_param('ssssssi', $repUuid, $emptyC, $emptyC, $emptyC, $cv, $emptyC, $nowC);
                $stC->execute();
                $stC->close();
            }
        }
    }
    /* 状态由客户在网页设置, report 仅回传, upsert 不覆盖 */
    $st = db()->prepare("SELECT status, reset_cmd FROM client_status WHERE device_id = ?");
    $st->bind_param('s', $deviceId);
    $st->execute();
    $row = $st->get_result()->fetch_assoc();
    $st->close();
    /* 清零指令: 置位后随下一次心跳下发, 下发即消费清零 (设备端收到后归零本地计数, 下次心跳上报 0) */
    $resetCmd = !empty($row['reset_cmd']);
    if ($resetCmd) dbExec("UPDATE client_status SET reset_cmd = 0 WHERE device_id = ?", array($deviceId));
    respond(array('success' => true, 'timestamp' => intval($now / 1000), 'status' => strval($row['status']), 'resetCmd' => $resetCmd, 'screen' => monScreenInfo($repUuid, nowSec())));
}

/* 管理端: 下发任务/错误计数清零指令 (全部设备置位 reset_cmd, 设备心跳领取后本地归零并回传 0) */
function handleMonitorClearCounts($body) {
    global $CFG;
    $cip = clientIp();
    if (adminFailCheck($cip)) respond(array('success' => false, 'message' => '失败次数过多, IP 已被暂时封禁'), 429);
    if (!monitorAuth(isset($body['key']) ? $body['key'] : '')) {
        adminFail($cip);
        respond(array('success' => false, 'message' => '密钥错误'), 401);
    }
    adminFailClear($cip);
    /* 可选 uuid: 单设备清零 (测试设备/个别设备场景, 被删设备心跳重建行后可单发); 缺省全部设备;
     * force=1 + uuid: 强清 (永久离线的设备永远领不到 reset_cmd 指令, 服务端直接清计数镜像;
     * 设备日后复活会把本地计数再次上报回来, 仅对确认永久离线的设备使用) */
    $uuid = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', strval(isset($body['uuid']) ? $body['uuid'] : '')));
    if ($uuid !== '' && !empty($body['force'])) {
        $n = dbExec("UPDATE client_status SET task_count = 0, error_count = 0, last_error = '' WHERE uuid = ?", array($uuid));
        auditLog('监控计数强清', array('uuid' => maskId($uuid), 'by' => '管理员'));
        respond(array('success' => true, 'message' => '服务端计数已清零', 'devices' => intval($n)));
    }
    if ($uuid !== '') {
        $n = dbExec("UPDATE client_status SET reset_cmd = 1 WHERE uuid = ?", array($uuid));
        auditLog('监控计数清零指令', array('scope' => '单设备', 'uuid' => maskId($uuid), 'by' => '管理员'));
    } else {
        $n = dbExec("UPDATE client_status SET reset_cmd = 1", array());
        auditLog('监控计数清零指令', array('devices' => intval($n), 'by' => '管理员'));
    }
    respond(array('success' => true, 'message' => '清零指令已下发, 等待设备心跳应用', 'devices' => intval($n)));
}

/* 缩略图上传: 复用 TOTP 验签; 覆盖式存储 mon_thumbs/{uuid}.webp (jpg 兜底);
 * 限频用文件 mtime (100s), 不查库;
 * 双引擎策略: Imagick 优先 (Lanczos 缩放 + adaptiveSharpen 智能轻度锐化, WebP q95),
 * Imagick 异常/不可用时 GD 兜底 (Bicubic 缩放, 不做任何增强, 防马赛克放大与锐化白边),
 * 两引擎全失败则原始字节直存保底;
 * 480 宽防御缩回与变形防御 (比例偏差超 50% 压回屏幕比例) 为两引擎共用逻辑 */
/* ============ 画面状态检测 (缩略图 dHash 对比 + 黑屏检测) ============ */
/* 原理: 每张缩略图落盘前与上一张的 dHash 指纹比对, 汉明距离<=3 判画面未变;
 * 状态存 carddata/state/screen_{UUID}.json (与限频/防爆破状态同目录, HTTP 不可达) */
define('MON_SCREEN_HASH_SIM', 3);     /* dHash 汉明距离 <= 3 视为同一画面 (容忍压缩噪声) */
define('MON_SCREEN_STATIC_SEC', 240); /* 连续未变 >= 240s (两个上传周期) 才报静止, 减少误报 */

/* 帧分析: GD 解码 → 黑屏判定 (32x32 灰度均值<18 且方差<300) + dHash 指纹 (裁掉顶部
 * 状态栏 1/12 高度后缩 9x8 灰度, 行内左>右记 1, 64 位 = 16 hex); 失败返回 null */
function monScreenAnalyzeBin($bin) {
    if (!function_exists('imagecreatefromstring')) return null;
    $im = @imagecreatefromstring($bin);
    if ($im === false) return null;
    $w = imagesx($im); $h = imagesy($im);
    if ($w < 9 || $h < 16) { imagedestroy($im); return null; }
    $g = imagecreatetruecolor(32, 32);
    imagecopyresampled($g, $im, 0, 0, 0, 0, 32, 32, $w, $h);
    imagefilter($g, IMG_FILTER_GRAYSCALE);
    $sum = 0; $sum2 = 0;
    for ($y = 0; $y < 32; $y++) {
        for ($x = 0; $x < 32; $x++) {
            $v = imagecolorat($g, $x, $y) & 0xFF;
            $sum += $v; $sum2 += $v * $v;
        }
    }
    imagedestroy($g);
    $mean = $sum / 1024;
    $variance = max(0, $sum2 / 1024 - $mean * $mean);
    $cropY = intval($h / 12);
    $d = imagecreatetruecolor(9, 8);
    imagecopyresampled($d, $im, 0, 0, 0, $cropY, 9, 8, $w, $h - $cropY);
    imagefilter($d, IMG_FILTER_GRAYSCALE);
    $hex = '';
    for ($y = 0; $y < 8; $y++) {
        $bits = '';
        for ($x = 0; $x < 8; $x++) {
            $l = imagecolorat($d, $x, $y) & 0xFF;
            $r = imagecolorat($d, $x + 1, $y) & 0xFF;
            $bits .= ($l > $r) ? '1' : '0';
        }
        $hex .= str_pad(base_convert($bits, 2, 16), 2, '0', STR_PAD_LEFT);
    }
    imagedestroy($d);
    imagedestroy($im);
    return array('hash' => $hex, 'black' => ($mean < 18 && $variance < 300));
}

/* 16 hex dHash 指纹的汉明距离 (长度异常返回 99 = 视为不同画面) */
function monHammingHex($a, $b) {
    if (!is_string($a) || !is_string($b) || strlen($a) !== 16 || strlen($b) !== 16) return 99;
    $dist = 0;
    for ($i = 0; $i < 16; $i++) {
        $x = hexdec($a[$i]) ^ hexdec($b[$i]);
        while ($x) { $dist += $x & 1; $x >>= 1; }
    }
    return $dist;
}

/* 收到新缩略图时更新画面状态: hash 相同保持 changed_ts (静止时长自动累计),
 * 变化/首次则重置; 黑屏单独记 black_since; 尽力而为, 失败不影响存储流程 */
function monScreenUpdate($uuid, $bin, $nowSec) {
    $u = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', strval($uuid)));
    if ($u === '' || strlen($u) > 32) return;
    $an = monScreenAnalyzeBin($bin);
    if ($an === null) return;
    $key = 'screen_' . $u;
    $st = loadState($key, null);
    if (!is_array($st)) $st = array();
    if (isset($st['hash']) && monHammingHex($st['hash'], $an['hash']) <= MON_SCREEN_HASH_SIM) {
        /* 画面未变: changed_ts 保留, 静止时长持续累计 */
    } else {
        $st['hash'] = $an['hash'];
        $st['changed_ts'] = $nowSec;
    }
    if ($an['black']) {
        if (empty($st['black']) || empty($st['black_since'])) $st['black_since'] = $nowSec;
        $st['black'] = true;
    } else {
        $st['black'] = false;
        $st['black_since'] = 0;
    }
    $st['updated_ts'] = $nowSec;
    saveState($key, $st);
}

/* 读取画面状态 (心跳响应/缩略图响应/设备列表共用); 无数据返回 null */
function monScreenInfo($uuid, $nowSec) {
    $u = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', strval($uuid)));
    if ($u === '' || strlen($u) > 32) return null;
    $st = loadState('screen_' . $u, null);
    if (!is_array($st) || !isset($st['hash'], $st['changed_ts'])) return null;
    $staticSec = max(0, $nowSec - intval($st['changed_ts']));
    $black = !empty($st['black']);
    $blackSec = ($black && !empty($st['black_since'])) ? max(0, $nowSec - intval($st['black_since'])) : 0;
    return array(
        'state'      => $black ? 'black' : ($staticSec >= MON_SCREEN_STATIC_SEC ? 'static' : 'normal'),
        'static_sec' => $staticSec,
        'black_sec'  => $blackSec,
    );
}

function handleMonitorThumb($body) {
    /* http.upload 走 multipart: 签名参数在 $_POST, JSON body 为空 → 合并取值 */
    if (!empty($_POST) && is_array($body)) { $body = array_merge($body, $_POST); }
    $v = monitorVerifySigned($body);
    $uuid = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', $v['uuid']));
    if ($uuid === '' || strlen($uuid) > 32) {
        respond(array('success' => false, 'message' => '设备UUID无效'), 400);
    }
    /* 图像来源: multipart $_FILES 优先 (http.upload 直传), base64 img 字段兜底 (postJson 旧链路) */
    $bin = null;
    if (!empty($_FILES)) {
        foreach ($_FILES as $f) {
            if (!empty($f['tmp_name']) && is_uploaded_file($f['tmp_name'])) {
                $bin = file_get_contents($f['tmp_name']);
                break;
            }
        }
    }
    if ($bin === null || $bin === false || strlen($bin) < 100) {
        $imgB64 = preg_replace('/\s+/', '', strval(isset($body['img']) ? $body['img'] : ''));
        if (strlen($imgB64) >= 100 && strlen($imgB64) <= 2000000) {
            $bin = base64_decode($imgB64, true);
        }
    }
    if ($bin === false || $bin === null || strlen($bin) < 100) {
        respond(array('success' => false, 'message' => '图像数据无效'), 400);
    }
    /* 字节头校验: 只接受 JPEG / PNG */
    if (substr($bin, 0, 3) !== "\xFF\xD8\xFF" && substr($bin, 0, 8) !== "\x89PNG\r\n\x1a\n") {
        respond(array('success' => false, 'message' => '图像格式不支持'), 400);
    }
    $dir = __DIR__ . '/mon_thumbs';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);   /* 幂等: 新部署/本地测试环境首次落盘自建 */
    $file = $dir . '/' . $uuid . '.webp';
    /* 限频: 100 秒内已更新过则幂等跳过 (须短于客户端 120s 节流, 保证每次上传都真落盘) */
    if (is_file($file) && (time() - filemtime($file)) < 100) {
        respond(array('success' => true, 'skipped' => true));
    }
    if (is_file($dir . '/' . $uuid . '.jpg') && (time() - filemtime($dir . '/' . $uuid . '.jpg')) < 100) {
        respond(array('success' => true, 'skipped' => true));
    }
    /* 画面状态分析: 与上一张 dHash 对比 + 黑屏检测, 先于落盘 (旧图此时还是上一张) */
    monScreenUpdate($uuid, $bin, nowSec());
    $saved = false;
    /* 目标宽: 该设备上报的屏幕分辨率宽 (还原原分辨率);
     * 未上报/格式异常兜底 720, 上限 1080 (防 2K 平板内存与体积失控) */
    $targetW = 720;
    $scrW = 0; $scrH = 0;
    try {
        $st = db()->prepare("SELECT screen FROM client_status WHERE uuid = ?");
        if ($st && $st->bind_param('s', $uuid) && $st->execute() && ($rw = $st->get_result()->fetch_assoc())) {
            if (preg_match('/^(\d{2,5})\s*[xX×*]\s*(\d{2,5})$/', strval($rw['screen']), $m)) {
                $scrW = intval($m[1]); $scrH = intval($m[2]);
                $targetW = min(max($scrW, 480), 1080);
            }
        }
    } catch (Exception $eT) {}

    /* ============ 引擎 1: Imagick 优先 ============ */
    if (class_exists('Imagick')) {
        try {
            $im = new Imagick();
            $im->readImageBlob($bin);
            $w = $im->getImageWidth();
            $h = $im->getImageHeight();
            if ($w > 0 && $h > 0) {
                /* 防御: 异常大图先缩回 480 宽基准 (客户端正常路径已是 480, 不触发) */
                if ($w > 480) {
                    $th = max(1, intval($h * 480 / $w));
                    $im->resizeImage(480, $th, Imagick::FILTER_LANCZOS, 1);
                    $w = 480; $h = $th;
                }
                /* 变形防御: 图宽高比与屏幕宽高比偏差超 50% (旧版横屏设备传竖长图等)
                 * 时按屏幕比例压回正确形状 */
                if ($scrW > 0 && $scrH > 0) {
                    $imgRatio = $w / $h;
                    $scrRatio = $scrW / $scrH;
                    if ($imgRatio / $scrRatio > 1.5 || $scrRatio / $imgRatio > 1.5) {
                        $fixH = max(1, intval($w * $scrH / $scrW));
                        $im->resizeImage($w, $fixH, Imagick::FILTER_LANCZOS, 1);
                        $h = $fixH;
                    }
                }
                /* Lanczos 放大到设备原分辨率宽: 高质量重采样, 边缘干净无马赛克 */
                if ($w < $targetW) {
                    $uh = max(1, intval($h * $targetW / $w));
                    $im->resizeImage($targetW, $uh, Imagick::FILTER_LANCZOS, 1);
                }
                /* 智能轻度锐化: 仅此一次, 按局部亮度自适应增强边缘, 无暴力卷积白边 */
                $im->adaptiveSharpenImage(0.8, 0.6, Imagick::CHANNEL_ALL);
                /* WebP q95 优先 (同体积比 JPEG 更清晰), 编码/写盘失败回落 JPEG q95;
                 * 成功后清旧后缀文件防新旧并存 */
                $im->setImageFormat('webp');
                $im->setImageCompressionQuality(95);
                $saved = file_put_contents($file, $im->getImageBlob()) !== false;
                if ($saved) {
                    @unlink($dir . '/' . $uuid . '.jpg');
                } else {
                    $file = $dir . '/' . $uuid . '.jpg';
                    $im->setImageFormat('jpeg');
                    $im->setImageCompressionQuality(95);
                    $saved = file_put_contents($file, $im->getImageBlob()) !== false;
                    if ($saved) @unlink($dir . '/' . $uuid . '.webp');
                }
            }
            $im->destroy();
        } catch (Exception $e) {
            $saved = false;   /* Imagick 任一步异常 → 无缝切入 GD 兜底 */
        } catch (Throwable $t) {
            $saved = false;
        }
    }

    /* ============ 引擎 2: GD 兜底 (纯缩放, 不做任何锐化/去块增强) ============ */
    if (!$saved && function_exists('imagecreatefromstring')) {
        try {
            $im = @imagecreatefromstring($bin);
            if ($im !== false) {
                $w = imagesx($im);
                $h = imagesy($im);
                /* 防御: 异常大图先缩回 480 宽基准 */
                if ($w > 480) {
                    $th = max(1, intval($h * 480 / $w));
                    $im2 = imagescale($im, 480, $th, IMG_BICUBIC);
                    if ($im2 !== false) { imagedestroy($im); $im = $im2; $w = 480; $h = $th; }
                }
                /* 变形防御: 同 Imagick 策略, 比例偏差超 50% 按屏幕比例压回 */
                if ($scrW > 0 && $scrH > 0 && $w > 0 && $h > 0) {
                    $imgRatio = $w / $h;
                    $scrRatio = $scrW / $scrH;
                    if ($imgRatio / $scrRatio > 1.5 || $scrRatio / $imgRatio > 1.5) {
                        $fixH = max(1, intval($w * $scrH / $scrW));
                        $im2 = imagescale($im, $w, $fixH, IMG_BICUBIC);
                        if ($im2 !== false) { imagedestroy($im); $im = $im2; $h = $fixH; }
                    }
                }
                /* Bicubic 放大到设备原分辨率宽 */
                if ($w < $targetW) {
                    $uh = max(1, intval($h * $targetW / $w));
                    $im2 = imagescale($im, $targetW, $uh, IMG_BICUBIC);
                    if ($im2 !== false) { imagedestroy($im); $im = $im2; }
                }
                /* WebP q95 优先, 失败回落 JPEG q95 */
                if (function_exists('imagewebp')) {
                    $saved = @imagewebp($im, $file, 95);
                }
                if ($saved) {
                    @unlink($dir . '/' . $uuid . '.jpg');
                } else {
                    $file = $dir . '/' . $uuid . '.jpg';
                    $saved = imagejpeg($im, $file, 95);
                    if ($saved) @unlink($dir . '/' . $uuid . '.webp');
                }
                imagedestroy($im);
            }
        } catch (Exception $e) {
            $saved = false;
        } catch (Throwable $t) {
            $saved = false;
        }
    }

    /* ============ 保底: 两引擎全失败 → 原始字节直存 (客户端 JPEG 原样, 无二次编码损失) ============ */
    if (!$saved) {
        $saved = file_put_contents($dir . '/' . $uuid . '.jpg', $bin) !== false;
        if ($saved) @unlink($dir . '/' . $uuid . '.webp');
    }
    if (!$saved) {
        respond(array('success' => false, 'message' => '存储失败'), 500);
    }
    respond(array('success' => true, 'screen' => monScreenInfo($uuid, nowSec())));
}

/* 在线判定阈值: 60 秒心跳, 2.5 个周期无心跳判离线 */
define('MONITOR_ONLINE_MS', 150000);

/* 审计日志查询 (仅管理员): GET /api/monitor/audit?key=...&limit=N
 * 从 audit.log 尾部高效读取 N 行, 解析为 {ts, action, detail} 倒序返回 */
function handleMonitorAudit($query) {
    global $LOG_DIR;
    if (adminFailCheck(clientIp())) respond(array('success' => false, 'message' => '失败次数过多, IP 已被暂时封禁'), 429);
    if (!monitorAuth(strval(isset($query['key']) ? $query['key'] : ''))) {
        adminFail(clientIp());
        respond(array('success' => false, 'message' => '密钥错误'), 401);
    }
    adminFailClear(clientIp());
    $limit = intval(isset($query['limit']) ? $query['limit'] : 300);
    if ($limit < 1) $limit = 300;
    if ($limit > 2000) $limit = 2000;
    $file = $LOG_DIR . '/audit.log';
    $rows = array();
    if (is_file($file)) {
        /* 从文件末尾按块向前读, 行按 新->旧 收集, 取满 limit 即停 (日志可能乱序交错, 以文件物理顺序为准) */
        $lines = array();
        $fh = @fopen($file, 'rb');
        if ($fh) {
            fseek($fh, 0, SEEK_END);
            $size = ftell($fh);
            $chunk = 65536;
            $tail = '';
            while ($size > 0 && count($lines) < $limit + 2) {
                $read = min($chunk, $size);
                $size -= $read;
                fseek($fh, $size);
                $parts = explode("\n", fread($fh, $read) . $tail);
                /* 块尾的不完整行(前一块的开头)是 explode 的最后一个元素, 用 array_pop 挂起;
                 * array_shift 会把首行当 tail 丢弃, 日志行数少时(如清空后仅剩留痕)整条读不出来 */
                $tail = array_pop($parts);
                $lines = array_merge(array_reverse($parts), $lines);
            }
            fclose($fh);
        }
        foreach ($lines as $line) {
            if (count($rows) >= $limit) break;
            $line = trim($line);
            if ($line === '') continue;
            if (!preg_match('/^\[([^\]]+)\] \[[^\]]+\] \[AUDIT\] (\S+) (.*)$/', $line, $m)) continue;
            $d = json_decode($m[3], true);
            $rows[] = array('ts' => $m[1], 'action' => $m[2], 'detail' => is_array($d) ? $d : array('raw' => $m[3]));
        }
    }
    respond(array('success' => true, 'rows' => $rows, 'total' => count($rows)));
}
/* 清空审计日志: 仅管理员; 覆盖写空内容保留文件本身, 清空动作本身留痕 ("日志清空"条目) */
function handleMonitorAuditClear($body) {
    global $LOG_DIR;
    if (adminFailCheck(clientIp())) respond(array('success' => false, 'message' => '失败次数过多, IP 已被暂时封禁'), 429);
    if (!monitorAuth(strval(isset($body['key']) ? $body['key'] : ''))) {
        adminFail(clientIp());
        respond(array('success' => false, 'message' => '密钥错误'), 401);
    }
    adminFailClear(clientIp());
    $file = $LOG_DIR . '/audit.log';
    /* file_put_contents 写空内容成功时返回 0, 须用 !== false 判断 (0 是合法成功值) */
    $ok = @file_put_contents($file, '', LOCK_EX);
    if ($ok === false) {
        respond(array('success' => false, 'message' => '清空失败, 请重试'), 500);
    }
    auditLog('日志清空', array('by' => '管理员'));
    respond(array('success' => true));
}

function handleMonitorList($query) {
    global $CFG;
    $cip = clientIp();
    if (adminFailCheck($cip)) respond(array('success' => false, 'message' => '失败次数过多, IP 已被暂时封禁'), 429);
    if (!monitorAuth(isset($query['key']) ? $query['key'] : '')) {
        adminFail($cip);
        respond(array('success' => false, 'message' => '密钥错误'), 401);
    }
    adminFailClear($cip);
    $res = db()->query("SELECT * FROM client_status ORDER BY last_seen DESC LIMIT 200");
    $rows = array();
    while ($row = $res->fetch_assoc()) {
        $row['online'] = (nowMs() - intval($row['last_seen'])) < MONITOR_ONLINE_MS;
        $row['thumb_mtime'] = monThumbMtime($row['uuid']);   /* 缩略图版本号, 前端据此判断换图 */
        $row['screen_state'] = monScreenInfo($row['uuid'], nowSec());   /* 画面状态 (静止/黑屏) */
        $rows[] = $row;
    }
    respond(array('success' => true, 'devices' => $rows, 'serverTime' => nowSec()));
}

/* 缩略图文件版本: mtime 整数, 无图为 0 (webp 主存, jpg 兜底兼容) */
function monThumbMtime($uuid) {
    $u = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', strval($uuid)));
    if ($u === '') return 0;
    $f = __DIR__ . '/mon_thumbs/' . $u . '.webp';
    if (!is_file($f)) $f = __DIR__ . '/mon_thumbs/' . $u . '.jpg';
    return is_file($f) ? intval(filemtime($f)) : 0;
}

/* ============ 客户账号体系 ============ */
/* 规范用户名: 3-24位, 字母数字下划线 */
function monNormUser($u) {
    $u = trim(strval($u));
    if (!preg_match('/^[A-Za-z0-9_]{3,24}$/', $u)) return '';
    return strtolower($u);
}

/* 用户名黑名单: 精确匹配; 以 * 结尾的条目按前缀匹配 */
function monUserBlacklisted($u) {
    global $CFG;
    $bl = isset($CFG['MONU_NAME_BLACKLIST']) && is_array($CFG['MONU_NAME_BLACKLIST']) ? $CFG['MONU_NAME_BLACKLIST'] : array();
    foreach ($bl as $pat) {
        $pat = strtolower(trim(strval($pat)));
        if ($pat === '') continue;
        if (substr($pat, -1) === '*') {
            if (substr($pat, 0, -1) !== '' && strpos($u, substr($pat, 0, -1)) === 0) return true;
        } elseif ($u === $pat) {
            return true;
        }
    }
    return false;
}

/* 注册专用分钟级限频: 每 IP 每分钟 5 次 (独立状态键, 与秒级通用限频互不干扰) */
function monRegLimit($ip) {
    return withLock('rate_reg', function () use ($ip) {
        $map = loadState('rate_reg', null);
        $now = nowMs();
        if (!isset($map[$ip]) || !is_array($map[$ip]) || $now - $map[$ip]['start'] >= 60000) {
            $map[$ip] = array('start' => $now, 'count' => 0);
        }
        $map[$ip]['count']++;
        if (count($map) > 200) $map = array($ip => $map[$ip]);
        saveState('rate_reg', $map);
        return $map[$ip]['count'] <= 5;
    });
}

/* ============ 账号级防爆破: 连续失败 5 次锁定 15 分钟 ============ */
/* 防时间侧信道: 用户不存在时也执行一次等价 bcrypt 校验的固定假 hash */
define('MONU_FAKE_HASH', '$2y$10$9qP8kR2wN4xT7vB5cD3eFuJ1mS6hA0gY8lQ4zX2wV7nK5jH3fG1iO');

function monuLockCheck($u) {
    $map = loadState('monu_fail', 900000);
    $k = strtolower(trim(strval($u)));
    if (!isset($map[$k]) || !is_array($map[$k])) return false;
    return intval($map[$k]['count']) >= 5 && nowMs() < intval($map[$k]['until']);
}

function monuLockFail($u) {
    withLock('monu_fail', function () use ($u) {
        $map = loadState('monu_fail', 900000);
        $k = strtolower(trim(strval($u)));
        $now = nowMs();
        if (!isset($map[$k]) || !is_array($map[$k]) || $now >= intval($map[$k]['until'])) {
            $map[$k] = array('count' => 0, 'until' => $now + 900000);
        }
        $map[$k]['count']++;
        if ($map[$k]['count'] >= 5) $map[$k]['until'] = $now + 900000;
        saveState('monu_fail', $map);
    });
}

function monuLockClear($u) {
    withLock('monu_fail', function () use ($u) {
        $map = loadState('monu_fail', 900000);
        unset($map[strtolower(trim(strval($u)))]);
        saveState('monu_fail', $map);
    });
}

/* ============ CSRF: 登录令牌的 HMAC 绑定, 写操作必须携带 X-CSRF-Token 头 ============ */
function monCsrfOf($tk) {
    global $CFG;
    return hash_hmac('sha256', strval($tk), $CFG['MONITOR_KEY'] . '|monu-csrf');
}

/* 校验 X-CSRF-Token 头与 token 绑定, 失败返回 401 (前端 accExpired 逻辑自动重登) */
function monRequireCsrf($tk) {
    $hdr = strval(isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? $_SERVER['HTTP_X_CSRF_TOKEN'] : '');
    if ($hdr === '' || !hash_equals(monCsrfOf($tk), $hdr)) {
        respond(array('success' => false, 'message' => '登录已过期, 请重新登录', 'code' => 'CSRF'), 401);
    }
}

/* ============ 图形验证码: 5 分钟有效, 一次性作废, 无 GD 时算术题兜底 ============ */
function monCaptchaText() {
    $chars = 'abcdefghjkmnpqrstuvwxyz23456789';   /* 去除 0O1lIi 易混字符 */
    $s = '';
    for ($i = 0; $i < 4; $i++) $s .= $chars[random_int(0, strlen($chars) - 1)];
    return $s;
}

function monCaptchaStore($id, $text) {
    withLock('monu_cap', function () use ($id, $text) {
        $map = loadState('monu_cap', 300000);
        if (count($map) > 2000) $map = array();
        $map[$id] = array('text' => strtolower($text), 'expire' => nowMs() + 300000);
        saveState('monu_cap', $map);
    });
}

/* 一次性校验: 无论对错, 用过即删 (防重放爆破) */
function monCaptchaCheck($id, $text) {
    $ok = false;
    withLock('monu_cap', function () use ($id, $text, &$ok) {
        $map = loadState('monu_cap', 300000);
        $k = preg_replace('/[^0-9a-f]/', '', strval($id));
        if (isset($map[$k]) && is_array($map[$k])) {
            if (hash_equals(strval($map[$k]['text']), strtolower(trim(strval($text))))) $ok = true;
            unset($map[$k]);
            saveState('monu_cap', $map);
        }
    });
    return $ok;
}

/* 注册/登录前的验证码校验, 失败带 code=CAPTCHA 供前端刷新图片 */
function monCaptchaRequire($body) {
    $cid = preg_replace('/[^0-9a-f]/', '', strval(isset($body['captchaId']) ? $body['captchaId'] : ''));
    $ctext = strval(isset($body['captcha']) ? $body['captcha'] : '');
    if ($cid === '' || $ctext === '') respond(array('success' => false, 'message' => '请输入验证码', 'code' => 'CAPTCHA'), 400);
    if (!monCaptchaCheck($cid, $ctext)) respond(array('success' => false, 'message' => '验证码错误或已过期', 'code' => 'CAPTCHA'), 400);
}

/* 验证码图片: freedns 风格抗 OCR 设计 ——
 * 1) 空心轮廓字符: TTF 实心字画在 3x 高分辨率画布 → 波形扭曲(列+行位移) →
 *    提取 1px 轮廓线 → 下采样。OCR 依赖实心笔画分类, 空心细线+随机变形直接失效
 * 2) 雪花符号噪点: +/* 星形小符号(有结构, 自适应二值化过滤不掉) + 细像素噪点
 * 3) 正弦干扰粗线横穿字符区 + 虚线
 * 4) 全灰阶纠缠: 轮廓 40-140 / 噪点 60-230 / 干扰线 30-110 灰度域重叠,
 *    固定阈值二值化下字符与噪点同时出现或同时消失
 * 无 TTF 字体时回退: 单字符画布放大 + imagerotate (纯 GD, 无 freetype 依赖) */
function monCaptchaImg($text) {
    $w = 160; $h = 52;
    $img = imagecreatetruecolor($w, $h);
    $white = imagecolorallocate($img, 255, 255, 255);
    imagefilledrectangle($img, 0, 0, $w - 1, $h - 1, $white);
    $font = __DIR__ . '/fonts/captcha.ttf';
    $useTtf = function_exists('imagettftext') && is_file($font);

    /* 细像素噪点 (灰度全域) */
    for ($i = 0; $i < 320; $i++) {
        $g = random_int(60, 230);
        imagesetpixel($img, random_int(0, $w - 1), random_int(0, $h - 1), imagecolorallocate($img, $g, $g, $g));
    }
    /* 雪花/星形符号噪点 */
    for ($i = 0; $i < 46; $i++) {
        $g = random_int(90, 210);
        $c = imagecolorallocate($img, $g, $g, $g);
        $x = random_int(2, $w - 3); $y = random_int(2, $h - 3);
        $r = random_int(1, 3);
        imageline($img, $x - $r, $y, $x + $r, $y, $c);
        imageline($img, $x, $y - $r, $x, $y + $r, $c);
        if (random_int(0, 1)) {
            imageline($img, $x - 1, $y - 1, $x + 1, $y + 1, $c);
            imageline($img, $x - 1, $y + 1, $x + 1, $y - 1, $c);
        }
    }
    /* 干扰线: 随机 2-3 条 (1-2 条点状虚线 + 1 条细实线), 沿随机正弦路径分布 */
    $lineN = random_int(2, 3);
    $plan = array();
    for ($i = 0; $i < $lineN; $i++) {
        $plan[] = $i < $lineN - 1;   /* 前 lineN-1 条为虚点线 */
    }
    shuffle($plan);
    for ($i = 0; $i < $lineN; $i++) {
        $g = random_int(40, 130);
        $c = imagecolorallocate($img, $g, $g, $g);
        $amp = random_int(4, 9);
        $freq = random_int(6, 14) * 0.01;
        $ph = mt_rand() / mt_getrandmax() * 6.28;
        $y0 = random_int(8, $h - 8);
        if ($plan[$i]) {
            /* 虚点线: 沿正弦路径撒单像素点, 间隔 2-4px */
            for ($x = 0; $x < $w; $x += random_int(2, 4)) {
                $y = (int)($y0 + sin($x * $freq + $ph) * $amp);
                imagesetpixel($img, $x, $y, $c);
            }
        } else {
            /* 细实线: 分段小线段逼近正弦 */
            imagesetthickness($img, 1);
            $px = 0; $py = $y0;
            for ($x = 3; $x <= $w; $x += 3) {
                $y = (int)($y0 + sin($x * $freq + $ph) * $amp);
                imageline($img, $px, $py, $x, $y, $c);
                $px = $x; $py = $y;
            }
        }
    }

    /* 字符渲染 */
    $n = strlen($text);
    $slot = $w / $n;
    for ($i = 0; $i < $n; $i++) {
        $gch = random_int(30, 110);   /* 轮廓灰度, 与噪点灰度域重叠 */
        if ($useTtf) {
            /* 1. 高分辨率实心字符 (大字号, 画后按 bbox 裁掉旋转/扭曲留白) */
            $cw = 240; $chh = 280;
            $cimg = imagecreatetruecolor($cw, $chh);
            imagefilledrectangle($cimg, 0, 0, $cw - 1, $chh - 1, imagecolorallocate($cimg, 255, 255, 255));
            $size = random_int(110, 130);
            $ang = random_int(-20, 20);
            $ax = 55; $ay = 205;
            $bb = imagettfbbox($size, $ang, $font, $text[$i]);
            $bbMinX = min($bb[0], $bb[2], $bb[4], $bb[6]);
            $bbMaxX = max($bb[0], $bb[2], $bb[4], $bb[6]);
            $bbMinY = min($bb[1], $bb[3], $bb[5], $bb[7]);
            $bbMaxY = max($bb[1], $bb[3], $bb[5], $bb[7]);
            imagettftext($cimg, $size, $ang, $ax, $ay, imagecolorallocate($cimg, 0, 0, 0), $font, $text[$i]);
            /* 2a. 列位移波形扭曲 (轻曲度: 波长 78-157px, 字符内不足 1 个波) */
            $ampC = random_int(5, 9); $fc = random_int(4, 8) * 0.01;
            $pc = mt_rand() / mt_getrandmax() * 6.28;
            $timg = imagecreatetruecolor($cw, $chh);
            imagefilledrectangle($timg, 0, 0, $cw - 1, $chh - 1, imagecolorallocate($timg, 255, 255, 255));
            for ($x = 0; $x < $cw; $x++) {
                $dy = (int)(sin($x * $fc + $pc) * $ampC);
                if ($dy > 0) {
                    imagecopy($timg, $cimg, $x, $dy, $x, 0, 1, $chh - $dy);
                } else {
                    imagecopy($timg, $cimg, $x, 0, $x, -$dy, 1, $chh + $dy);
                }
            }
            /* 2b. 行位移波形扭曲 (轻曲度: 波长 63-126px) */
            $ampR = random_int(1, 3); $fr = random_int(5, 10) * 0.01;
            $pr = mt_rand() / mt_getrandmax() * 6.28;
            $rimg = imagecreatetruecolor($cw, $chh);
            imagefilledrectangle($rimg, 0, 0, $cw - 1, $chh - 1, imagecolorallocate($rimg, 255, 255, 255));
            for ($y = 0; $y < $chh; $y++) {
                $dx2 = (int)(sin($y * $fr + $pr) * $ampR);
                if ($dx2 > 0) {
                    imagecopy($rimg, $timg, $dx2, $y, 0, $y, $cw - $dx2, 1);
                } else {
                    imagecopy($rimg, $timg, 0, $y, -$dx2, $y, $cw + $dx2, 1);
                }
            }
            /* 3. 轮廓提取 (只跑 bbox+扭曲余量区域): ±2 偏移 4 点全墨 = 内部点跳过,
             *    边缘点涂 + 4 邻域膨胀, 下采样后轮廓仍清晰 */
            $m = 22;   /* 扭曲振幅余量 */
            $cx0 = max(2, (int)($ax + $bbMinX - $m));
            $cx1 = min($cw - 3, (int)($ax + $bbMaxX + $m));
            $cy0 = max(2, (int)($ay + $bbMinY - $m));
            $cy1 = min($chh - 3, (int)($ay + $bbMaxY + $m));
            $eimg = imagecreatetruecolor($cw, $chh);
            imagefilledrectangle($eimg, 0, 0, $cw - 1, $chh - 1, imagecolorallocate($eimg, 255, 255, 255));
            $ec = imagecolorallocate($eimg, $gch, $gch, $gch);
            for ($y = $cy0; $y < $cy1; $y++) {
                for ($x = $cx0; $x < $cx1; $x++) {
                    if (((imagecolorat($rimg, $x, $y) >> 16) & 0xFF) < 128) {
                        $up = ((imagecolorat($rimg, $x, $y - 2) >> 16) & 0xFF) < 128;
                        $dn = ((imagecolorat($rimg, $x, $y + 2) >> 16) & 0xFF) < 128;
                        $lf = ((imagecolorat($rimg, $x - 2, $y) >> 16) & 0xFF) < 128;
                        $rt = ((imagecolorat($rimg, $x + 2, $y) >> 16) & 0xFF) < 128;
                        if (!($up && $dn && $lf && $rt)) {
                            imagesetpixel($eimg, $x, $y, $ec);
                            imagesetpixel($eimg, $x + 1, $y, $ec);
                            imagesetpixel($eimg, $x - 1, $y, $ec);
                            imagesetpixel($eimg, $x, $y + 1, $ec);
                            imagesetpixel($eimg, $x, $y - 1, $ec);
                        }
                    }
                }
            }
            /* 4. 裁剪 bbox 后下采样贴回主画布 (字符本体充满槽位, 高度 42-47/52) */
            $bw = $cx1 - $cx0; $bh = $cy1 - $cy0;
            $dh = random_int(42, 47);
            $dw = (int)($dh * $bw / $bh);
            if ($dw > $slot - 2) {
                $dw = (int)($slot - 2);
                $dh = (int)($dw * $bh / $bw);
            }
            $small = imagecreatetruecolor($dw, $dh);
            imagecopyresampled($small, $eimg, 0, 0, $cx0, $cy0, $dw, $dh, $bw, $bh);
            /* 白色透明化: 干扰线从字符槽位穿过, 贴图只覆盖轮廓像素 */
            imagecolortransparent($small, imagecolorallocate($small, 255, 255, 255));
            imagecopy($img, $small, (int)($slot * $i + ($slot - $dw) / 2 + random_int(-1, 1)),
                (int)(($h - $dh) / 2 + random_int(-2, 2)), 0, 0, $dw, $dh);
            imagedestroy($cimg);
            imagedestroy($timg);
            imagedestroy($rimg);
            imagedestroy($eimg);
            imagedestroy($small);
        } else {
            $cw = 40; $ch = 56;
            $c = imagecreatetruecolor($cw, $ch);
            imagefilledrectangle($c, 0, 0, $cw, $ch, imagecolorallocate($c, 255, 255, 255));
            imagestring($c, 5, 14, 20, $text[$i], imagecolorallocate($c, $gch, $gch, $gch));
            $big = imagecreatetruecolor($cw * 2, $ch * 2);
            imagecopyresized($big, $c, 0, 0, 0, 0, $cw * 2, $ch * 2, $cw, $ch);
            $rot = imagerotate($big, random_int(-28, 28), imagecolorallocate($big, 255, 255, 255));
            imagecopy($img, $rot, (int)($slot * $i + 4), (int)($h / 2 - $ch), 0, 0,
                imagesx($rot), imagesy($rot));
            imagedestroy($c);
            imagedestroy($big);
            imagedestroy($rot);
        }
    }
    /* 字符上层再叠少量雪花, 部分遮挡笔画 */
    for ($i = 0; $i < 14; $i++) {
        $g = random_int(90, 200);
        $c = imagecolorallocate($img, $g, $g, $g);
        $x = random_int(2, $w - 3); $y = random_int(2, $h - 3);
        $r = random_int(1, 2);
        imageline($img, $x - $r, $y, $x + $r, $y, $c);
        imageline($img, $x, $y - $r, $x, $y + $r, $c);
    }
    ob_start();
    imagepng($img);
    $png = ob_get_clean();
    imagedestroy($img);
    return $png;
}

function handleMonuCaptcha() {
    $id = bin2hex(random_bytes(16));
    if (function_exists('imagecreatetruecolor')) {
        $text = monCaptchaText();
        monCaptchaStore($id, $text);
        $png = monCaptchaImg($text);
        respond(array('success' => true, 'captchaId' => $id, 'image' => 'data:image/png;base64,' . base64_encode($png)));
    }
    /* GD 不可用: 算术题兜底 (答案存 text 字段, 同机制校验) */
    $a = random_int(2, 9); $b = random_int(2, 9);
    monCaptchaStore($id, strval($a + $b));
    respond(array('success' => true, 'captchaId' => $id, 'question' => $a . ' + ' . $b . ' = ?'));
}

/* 令牌签发: 64位随机 hex, 有效期 30 天, 滑动续期 */
function monTokenIssue($userId) {
    $tk = bin2hex(random_bytes(32));
    $exp = nowMs() + 30 * 86400000;
    $st = dbAcc()->prepare("INSERT INTO monitor_tokens (token, user_id, expires_ms) VALUES (?,?,?)");
    if (!$st) return false;
    $st->bind_param('sii', $tk, $userId, $exp);
    $st->execute();
    return $tk;
}

/* 令牌校验: 返回 user_id 或 null; 剩余寿命 < 15 天时滑动续期到 30 天 */
function monTokenCheck($tk) {
    $tk = preg_replace('/[^0-9a-f]/', '', strval($tk));
    if (strlen($tk) !== 64) return null;
    $st = dbAcc()->prepare("SELECT user_id, expires_ms FROM monitor_tokens WHERE token = ?");
    if (!$st) return null;
    $st->bind_param('s', $tk);
    $st->execute();
    $row = $st->get_result()->fetch_assoc();
    if (!$row || intval($row['expires_ms']) < nowMs()) return null;
    if (intval($row['expires_ms']) - nowMs() < 15 * 86400000) {
        $up = dbAcc()->prepare("UPDATE monitor_tokens SET expires_ms = ? WHERE token = ?");
        if ($up) { $ne = nowMs() + 30 * 86400000; $up->bind_param('is', $ne, $tk); $up->execute(); }
    }
    return intval($row['user_id']);
}

/* 用户名是否已存在 */
function monUserExists($u) {
    $st = dbAcc()->prepare("SELECT 1 FROM monitor_users WHERE username = ?");
    if (!$st) return true;
    $st->bind_param('s', $u);
    $st->execute();
    return (bool)$st->get_result()->fetch_assoc();
}

/* 某账号绑定的 uuid 列表 */
function monUserUuids($userId) {
    $out = array();
    $st = dbAcc()->prepare("SELECT uuid FROM monitor_binds WHERE user_id = ? ORDER BY created_ms ASC");
    if (!$st) return $out;
    $st->bind_param('i', $userId);
    $st->execute();
    $res = $st->get_result();
    while ($r = $res->fetch_assoc()) $out[] = strval($r['uuid']);
    return $out;
}

/* uuid 是否已被任意账号绑定 */
function monUuidBound($uuid) {
    $st = dbAcc()->prepare("SELECT 1 FROM monitor_binds WHERE uuid = ?");
    if (!$st) return true;
    $st->bind_param('s', $uuid);
    $st->execute();
    return (bool)$st->get_result()->fetch_assoc();
}

/* 客户令牌认证: body/query 中 token -> user_id, 失败直接 respond 401 */
function monRequireToken($src) {
    $userId = monTokenCheck(strval(isset($src['token']) ? $src['token'] : ''));
    if (!$userId) respond(array('success' => false, 'message' => '登录已过期, 请重新登录'), 401);
    return $userId;
}

/* ============ 客户账号接口 ============ */
/* 注册: username + password -> 自动登录返回 token */
function handleMonuRegister($body) {
    global $CFG;
    if (empty($CFG['MONU_REG_OPEN'])) respond(array('success' => false, 'message' => '注册已暂停, 请联系管理员'), 403);
    monCaptchaRequire($body);
    $u = monNormUser(isset($body['username']) ? $body['username'] : '');
    $p = strval(isset($body['password']) ? $body['password'] : '');
    if ($u === '') respond(array('success' => false, 'message' => '用户名需 3-24 位字母/数字/下划线'), 400);
    if (monUserBlacklisted($u)) respond(array('success' => false, 'message' => '该用户名不可用'), 409);
    if (strlen($p) < 8 || strlen($p) > 32 || !preg_match('/[A-Za-z]/', $p) || !preg_match('/[0-9]/', $p)) {
        respond(array('success' => false, 'message' => '密码需 8-32 位, 且必须包含字母和数字'), 400);
    }
    if (monUserExists($u)) respond(array('success' => false, 'message' => '用户名已被注册'), 409);
    $hash = password_hash($p, PASSWORD_DEFAULT);
    $st = dbAcc()->prepare("INSERT INTO monitor_users (username, pass_hash, created_ms) VALUES (?,?,?)");
    if (!$st) respond(array('success' => false, 'message' => '注册失败'), 500);
    $st->bind_param('ssi', $u, $hash, nowMs());
    if (!$st->execute()) respond(array('success' => false, 'message' => '用户名已被注册'), 409);
    $id = intval(dbAcc()->insert_id);
    $tk = monTokenIssue($id);
    if ($tk === false) respond(array('success' => false, 'message' => '注册失败'), 500);
    respond(array('success' => true, 'token' => $tk, 'csrf' => monCsrfOf($tk), 'username' => $u));
}

/* 登录: username + password -> token; 账号级防爆破 + 时间侧信道防护 */
function handleMonuLogin($body) {
    monCaptchaRequire($body);
    $u = monNormUser(isset($body['username']) ? $body['username'] : '');
    $p = strval(isset($body['password']) ? $body['password'] : '');
    if ($u === '' || $p === '') respond(array('success' => false, 'message' => '请输入用户名和密码'), 400);
    /* 账号锁定: 连续失败 5 次后 15 分钟内拒绝 (不存在用户名同样计数, 文案无法用于枚举) */
    if (monuLockCheck($u)) respond(array('success' => false, 'message' => '账号已锁定, 请 15 分钟后再试'), 429);
    $st = dbAcc()->prepare("SELECT id, pass_hash FROM monitor_users WHERE username = ?");
    if (!$st) respond(array('success' => false, 'message' => '登录失败'), 500);
    $st->bind_param('s', $u);
    $st->execute();
    $row = $st->get_result()->fetch_assoc();
    if (!$row) {
        /* 防时间侧信道: 用户不存在也执行一次等价 bcrypt 计算 */
        password_verify($p, MONU_FAKE_HASH);
        monuLockFail($u);
        respond(array('success' => false, 'message' => '用户名或密码错误'), 401);
    }
    if (!password_verify($p, strval($row['pass_hash']))) {
        monuLockFail($u);
        respond(array('success' => false, 'message' => '用户名或密码错误'), 401);
    }
    monuLockClear($u);
    $tk = monTokenIssue(intval($row['id']));
    if ($tk === false) respond(array('success' => false, 'message' => '登录失败'), 500);
    respond(array('success' => true, 'token' => $tk, 'csrf' => monCsrfOf($tk), 'username' => $u));
}

/* 登出: 吊销 token */
function handleMonuLogout($body) {
    $tk = preg_replace('/[^0-9a-f]/', '', strval(isset($body['token']) ? $body['token'] : ''));
    if ($tk !== '') {
        $st = dbAcc()->prepare("DELETE FROM monitor_tokens WHERE token = ?");
        if ($st) { $st->bind_param('s', $tk); $st->execute(); }
    }
    respond(array('success' => true));
}

/* 修改密码: 登录态 + CSRF + 旧密码验证 -> 更新; 吊销该账号其他 token (当前会话保留);
 * 旧密码错误计入账号锁定 (防爆破, 与登录同构); 新密码规则与注册一致 */
function handleMonuChangePwd($body) {
    $userId = monRequireToken($body);
    $tk = preg_replace('/[^0-9a-f]/', '', strval(isset($body['token']) ? $body['token'] : ''));
    monRequireCsrf($tk);
    $old = strval(isset($body['oldPwd']) ? $body['oldPwd'] : '');
    $new = strval(isset($body['newPwd']) ? $body['newPwd'] : '');
    if ($old === '' || $new === '') respond(array('success' => false, 'message' => '请输入旧密码和新密码'), 400);
    if (strlen($new) < 8 || strlen($new) > 32 || !preg_match('/[A-Za-z]/', $new) || !preg_match('/[0-9]/', $new)) {
        respond(array('success' => false, 'message' => '新密码需 8-32 位, 且必须包含字母和数字'), 400);
    }
    if ($old === $new) respond(array('success' => false, 'message' => '新密码不能与旧密码相同'), 400);
    /* 账号锁定复用 (按用户名): 旧密码连续错 5 次 15 分钟锁定 */
    $st = dbAcc()->prepare("SELECT username, pass_hash FROM monitor_users WHERE id = ?");
    if (!$st) respond(array('success' => false, 'message' => '修改失败'), 500);
    $st->bind_param('i', $userId);
    $st->execute();
    $row = $st->get_result()->fetch_assoc();
    $st->close();
    if (!$row) respond(array('success' => false, 'message' => '账号不存在'), 404);
    $u = strval($row['username']);
    if (monuLockCheck($u)) respond(array('success' => false, 'message' => '账号已锁定, 请 15 分钟后再试'), 429);
    if (!password_verify($old, strval($row['pass_hash']))) {
        monuLockFail($u);
        respond(array('success' => false, 'message' => '旧密码错误'), 401);
    }
    monuLockClear($u);
    $hash = password_hash($new, PASSWORD_DEFAULT);
    $up = dbAcc()->prepare("UPDATE monitor_users SET pass_hash = ? WHERE id = ?");
    if (!$up) respond(array('success' => false, 'message' => '修改失败'), 500);
    $up->bind_param('si', $hash, $userId);
    if (!$up->execute()) respond(array('success' => false, 'message' => '修改失败'), 500);
    $up->close();
    /* 吊销该账号其他 token (当前会话保留, 其他已登录设备强制重新登录) */
    $rv = dbAcc()->prepare("DELETE FROM monitor_tokens WHERE user_id = ? AND token != ?");
    if ($rv) { $rv->bind_param('is', $userId, $tk); $rv->execute(); $rv->close(); }
    auditLog('修改密码', array('user' => maskId($u)));
    respond(array('success' => true, 'message' => '密码已修改, 其他设备已退出登录'));
}

/* 绑定设备: 校验 uuid 真实存在于 client_status, 且未被其他账号绑定 */
function handleMonuBind($body) {
    $userId = monRequireToken($body);
    $tk = preg_replace('/[^0-9a-f]/', '', strval(isset($body['token']) ? $body['token'] : ''));
    monRequireCsrf($tk);
    $uuid = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', strval(isset($body['uuid']) ? $body['uuid'] : '')));
    if ($uuid === '') respond(array('success' => false, 'message' => '请输入设备 UUID'), 400);
    $st = db()->prepare("SELECT 1 FROM client_status WHERE uuid = ?");
    if (!$st) respond(array('success' => false, 'message' => '绑定失败'), 500);
    $st->bind_param('s', $uuid);
    $st->execute();
    if (!$st->get_result()->fetch_assoc()) {
        respond(array('success' => false, 'message' => '未找到该 UUID 对应的设备'), 404);
    }
    if (monUuidBound($uuid)) respond(array('success' => false, 'message' => '该设备已被其他账号绑定'), 409);
    $ins = dbAcc()->prepare("INSERT IGNORE INTO monitor_binds (user_id, uuid, created_ms) VALUES (?,?,?)");
    if (!$ins) respond(array('success' => false, 'message' => '绑定失败'), 500);
    $ins->bind_param('isi', $userId, $uuid, nowMs());
    $ins->execute();
    respond(array('success' => true, 'uuid' => $uuid));
}

/* 解绑: 只能解自己账号的绑定 */
function handleMonuUnbind($body) {
    $userId = monRequireToken($body);
    $tk = preg_replace('/[^0-9a-f]/', '', strval(isset($body['token']) ? $body['token'] : ''));
    monRequireCsrf($tk);
    $uuid = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', strval(isset($body['uuid']) ? $body['uuid'] : '')));
    if ($uuid === '') respond(array('success' => false, 'message' => '缺少设备 UUID'), 400);
    $st = dbAcc()->prepare("DELETE FROM monitor_binds WHERE user_id = ? AND uuid = ?");
    if (!$st) respond(array('success' => false, 'message' => '解绑失败'), 500);
    $st->bind_param('is', $userId, $uuid);
    $st->execute();
    respond(array('success' => true));
}

/* 客户设备列表: 返回该账号绑定设备的完整状态 (与 list 一致, 含 thumb_mtime) */
function handleMonuDevices($query) {
    $userId = monRequireToken($query);
    $us = dbAcc()->prepare("SELECT username FROM monitor_users WHERE id = ?");
    if (!$us) respond(array('success' => false, 'message' => '查询失败'), 500);
    $us->bind_param('i', $userId);
    $us->execute();
    $uRow = $us->get_result()->fetch_assoc();
    $uuids = monUserUuids($userId);
    $devices = array();
    if (count($uuids) > 0) {
        $marks = implode(',', array_fill(0, count($uuids), '?'));
        $types = str_repeat('s', count($uuids));
        $st = db()->prepare("SELECT * FROM client_status WHERE uuid IN ($marks) ORDER BY last_seen DESC");
        if (!$st) respond(array('success' => false, 'message' => '查询失败'), 500);
        $st->bind_param($types, ...$uuids);
        $st->execute();
        $res = $st->get_result();
        while ($row = $res->fetch_assoc()) {
            $row['online'] = (nowMs() - intval($row['last_seen'])) < MONITOR_ONLINE_MS;
            $row['thumb_mtime'] = monThumbMtime($row['uuid']);
            unset($row['device_id']);
            $devices[] = $row;
        }
    }
    respond(array('success' => true, 'username' => strval($uRow ? $uRow['username'] : ''), 'devices' => $devices, 'serverTime' => nowSec()));
}

/* 客户设置设备状态: uuid 即凭证, status ∈ 挂机/离线/在线 (在线存空串)
 * 管理员模式: 携带监控密钥 key 时, 可用 deviceId 或 uuid 定位并修改任意设备 */
function handleMonitorSetStatus($body) {
    $status = strval(isset($body['status']) ? $body['status'] : '');
    if ($status === '在线') $status = '';
    if ($status !== '' && $status !== '挂机' && $status !== '离线') {
        respond(array('success' => false, 'message' => '状态仅支持: 在线 / 挂机 / 离线'), 400);
    }
    /* 管理员模式: body 带 key 才参与管理认证与防爆破计数; 客户 token 分支不受影响 */
    $isAdmin = false;
    if (isset($body['key']) && strval($body['key']) !== '') {
        $cip = clientIp();
        if (adminFailCheck($cip)) respond(array('success' => false, 'message' => '失败次数过多, IP 已被暂时封禁'), 429);
        if (!monitorAuth(strval($body['key']))) {
            adminFail($cip);
            respond(array('success' => false, 'message' => '密钥错误'), 401);
        }
        adminFailClear($cip);
        $isAdmin = true;
    }
    if ($isAdmin) {
        $deviceId = preg_replace('/[^A-Za-z0-9_\-\.]/', '', strval(isset($body['deviceId']) ? $body['deviceId'] : ''));
        $uuid = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', strval(isset($body['uuid']) ? $body['uuid'] : '')));
        if ($deviceId !== '') {
            $where = "device_id = ?";
            $keyVal = $deviceId;
        } elseif ($uuid !== '') {
            $where = "uuid = ?";
            $keyVal = $uuid;
        } else {
            respond(array('success' => false, 'message' => '需要 deviceId 或 uuid 定位设备'), 400);
        }
    } else {
        /* 客户模式: 必须登录且该设备绑定在此账号下 */
        $tk = preg_replace('/[^0-9a-f]/', '', strval(isset($body['token']) ? $body['token'] : ''));
        $userId = monTokenCheck($tk);
        if (!$userId) respond(array('success' => false, 'message' => '登录已过期, 请重新登录'), 401);
        monRequireCsrf($tk);
        $uuid = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', strval(isset($body['uuid']) ? $body['uuid'] : '')));
        if ($uuid === '') respond(array('success' => false, 'message' => '缺少设备 UUID'), 400);
        $bs = dbAcc()->prepare("SELECT 1 FROM monitor_binds WHERE user_id = ? AND uuid = ?");
        if (!$bs) respond(array('success' => false, 'message' => '设置失败'), 500);
        $bs->bind_param('is', $userId, $uuid);
        $bs->execute();
        if (!$bs->get_result()->fetch_assoc()) {
            respond(array('success' => false, 'message' => '该设备未绑定在此账号下'), 403);
        }
        $where = "uuid = ?";
        $keyVal = $uuid;
    }
    /* 先确认设备存在 (幂等设置时 UPDATE 的 affected_rows=0, 不能用它判断存在性) */
    $chk = db()->prepare("SELECT 1 FROM client_status WHERE " . $where);
    if (!$chk) respond(array('success' => false, 'message' => '设置失败'), 500);
    $chk->bind_param('s', $keyVal);
    $chk->execute();
    $exists = $chk->get_result()->fetch_assoc();
    $chk->close();
    if (!$exists) respond(array('success' => false, 'message' => '未找到该设备'), 404);
    $st = db()->prepare("UPDATE client_status SET status = ? WHERE " . $where);
    if (!$st) respond(array('success' => false, 'message' => '设置失败'), 500);
    $st->bind_param('ss', $status, $keyVal);
    $st->execute();
    $st->close();
    auditLog('状态修改', array('device' => maskId($keyVal), 'status' => $status === '' ? '在线' : $status,
        'by' => monActorLabel($body)));
    respond(array('success' => true, 'status' => $status));
}

/* ==================== 设备编辑器变量 (查看变量/修改变量) ==================== */
/* 认证三模式: 管理员 key (任意设备) / 客户 token (仅绑定设备) / 设备签名 (仅自己, 仅查看) */
/* 操作者身份标签 (审计用): key=管理员, token=账号名, 其余=设备 */
function monActorLabel($body) {
    if (isset($body['key']) && strval($body['key']) !== '') return '管理员';
    if (isset($body['token']) && strval($body['token']) !== '') {
        $userId = monTokenCheck(strval($body['token']));
        if ($userId) {
            $st = dbAcc()->prepare("SELECT username FROM monitor_users WHERE id = ?");
            if ($st) {
                $st->bind_param('i', $userId);
                $st->execute();
                $r = $st->get_result()->fetch_assoc();
                $st->close();
                if ($r) return '账号 ' . strval($r['username']);
            }
        }
        return '账号(未知)';
    }
    return '设备';
}
function monVarsAuth($body, $write) {
    $cip = clientIp();
    if (isset($body['key']) && strval($body['key']) !== '') {
        if (adminFailCheck($cip)) respond(array('success' => false, 'message' => '失败次数过多, IP 已被暂时封禁'), 429);
        if (!monitorAuth(strval($body['key']))) {
            adminFail($cip);
            respond(array('success' => false, 'message' => '密钥错误'), 401);
        }
        adminFailClear($cip);
        $uuid = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', strval(isset($body['uuid']) ? $body['uuid'] : '')));
        if ($uuid === '') respond(array('success' => false, 'message' => '缺少设备 UUID'), 400);
        return $uuid;
    }
    if (isset($body['token']) && strval($body['token']) !== '') {
        $tk = preg_replace('/[^0-9a-f]/', '', strval($body['token']));
        $userId = monTokenCheck($tk);
        if (!$userId) respond(array('success' => false, 'message' => '登录已过期, 请重新登录'), 401);
        if ($write) monRequireCsrf($tk);
        $uuid = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', strval(isset($body['uuid']) ? $body['uuid'] : '')));
        if ($uuid === '') respond(array('success' => false, 'message' => '缺少设备 UUID'), 400);
        $st = dbAcc()->prepare("SELECT 1 FROM monitor_binds WHERE user_id = ? AND uuid = ?");
        if (!$st) respond(array('success' => false, 'message' => '查询失败'), 500);
        $st->bind_param('is', $userId, $uuid);
        $st->execute();
        if (!$st->get_result()->fetch_assoc()) {
            respond(array('success' => false, 'message' => '该设备未绑定在此账号下'), 403);
        }
        return $uuid;
    }
    if ($write) respond(array('success' => false, 'message' => '修改变量需管理员密钥或客户登录'), 401);
    /* 设备签名认证: 设备只能查看自己的变量 */
    $v = monitorVerifySigned($body);
    $uuid = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', $v['uuid']));
    if ($uuid === '' || strlen($uuid) > 32) respond(array('success' => false, 'message' => '设备UUID无效'), 400);
    return $uuid;
}

function monVarsLoad($uuid) {
    $st = dbAcc()->prepare("SELECT view_var, edit_var_dev, edit_var, config_var_dev, config_var, updated_ms FROM monitor_vars WHERE uuid = ?");
    if (!$st) return null;
    $st->bind_param('s', $uuid);
    $st->execute();
    $row = $st->get_result()->fetch_assoc();
    $st->close();
    return $row;
}

/* 查看变量组 (只读) + 修改变量/配置变量内容组 (设备上报, 网页在此基础上修改) + 各自下发暂存 (网页保存, 设备拉取) */
/* 从数组 JSON 下发内容提取"上次修改"时间戳, 非数组/缺失返回 '' (与客户端 arrApplyServerEdit 同源) */
function monStampOf($content) {
    $arr = json_decode(strval($content), true);
    if (!is_array($arr)) return '';
    foreach ($arr as $it) {
        if (is_array($it) && strval(isset($it['name']) ? $it['name'] : '') === '上次修改') {
            return strval(isset($it['count']) ? $it['count'] : '');
        }
    }
    return '';
}

/* 变量内容摘要 (审计用): 数组按 "name=count; ..." 压缩, 非数组/解析失败退化为原文截断;
 * 截断用 PCRE /u 按 UTF-8 字符对齐 (不依赖 mbstring), 非法 UTF-8 兜底字节截断 */
function monVarsDigest($content, $maxLen = 500) {
    $s = strval($content);
    $arr = json_decode($s, true);
    if (is_array($arr)) {
        $parts = array(); $total = 0;
        foreach ($arr as $it) {
            $p = is_array($it)
                ? strval(isset($it['name']) ? $it['name'] : '') . '=' . strval(isset($it['count']) ? $it['count'] : '')
                : strval($it);
            $total += strlen($p) + 2;
            if ($total > $maxLen) { $parts[] = '...(截断)'; return implode('; ', $parts); }
            $parts[] = $p;
        }
        $s = implode('; ', $parts);
    }
    if (strlen($s) > $maxLen) {
        $cut = preg_replace('/^(.{0,' . $maxLen . '}).*$/us', '$1...(截断)', $s);
        $s = ($cut === null) ? substr($s, 0, $maxLen) . '...(截断)' : $cut;
    }
    return $s;
}

/* 新旧数组差异摘要 (审计用): 变更/新增/删除的字段清单, 非数组内容无法按字段对比返回 '';
 * "上次修改"为闭环机制字段 (每次保存必然刷新), 记录差异时过滤避免噪音 */
function monVarsDiff($old, $new, $maxItems = 15) {
    $o = json_decode(strval($old), true);
    $n = json_decode(strval($new), true);
    if (!is_array($o) || !is_array($n)) return '';
    $om = array(); $nm = array();
    foreach ($o as $it) {
        if (is_array($it) && isset($it['name']) && strval($it['name']) !== '上次修改') {
            $om[strval($it['name'])] = strval(isset($it['count']) ? $it['count'] : '');
        }
    }
    foreach ($n as $it) {
        if (is_array($it) && isset($it['name']) && strval($it['name']) !== '上次修改') {
            $nm[strval($it['name'])] = strval(isset($it['count']) ? $it['count'] : '');
        }
    }
    $parts = array();
    foreach ($nm as $k => $v) {
        if (!array_key_exists($k, $om)) $parts[] = '新增 ' . $k . '=' . $v;
        elseif ($om[$k] !== $v) $parts[] = $k . ': ' . $om[$k] . '->' . $v;
    }
    foreach ($om as $k => $v) {
        if (!array_key_exists($k, $nm)) $parts[] = '删除 ' . $k;
    }
    if (count($parts) > $maxItems) {
        $parts = array_slice($parts, 0, $maxItems);
        $parts[] = '...(更多省略)';
    }
    return implode('; ', $parts);
}

function handleMonitorVars($body) {
    if (!rateLimit(clientIp(), 60)) respond(array('success' => false, 'message' => '请求过于频繁'));
    $uuid = monVarsAuth($body, false);
    $row = monVarsLoad($uuid);
    /* 下发确认闭环: 客户端回传已应用内容的"上次修改"时间戳 (applied 文件锚点),
     * 与存储内容一致则该组返回空 (停发同内容); 用户保存新内容 => 新时间戳不匹配 => 自动恢复下发;
     * 非数组内容无时间戳, 客户端锚点存内容 SHA256, 同源哈希比对停发;
     * 每次请求即时比对, 幂等且零表结构改动 */
    $editAck = strval(isset($body['editAck']) ? $body['editAck'] : '');
    $cfgAck = strval(isset($body['configAck']) ? $body['configAck'] : '');
    $editOut = strval($row ? $row['edit_var'] : '');
    $cfgOut = strval($row ? $row['config_var'] : '');
    $editStopped = false;
    $cfgStopped = false;
    if ($editOut !== '' && $editAck !== '' &&
        (monStampOf($editOut) === $editAck || hash('sha256', $editOut) === $editAck)) {
        $editOut = '';
        $editStopped = true;
    }
    if ($cfgOut !== '' && $cfgAck !== '' &&
        (monStampOf($cfgOut) === $cfgAck || hash('sha256', $cfgOut) === $cfgAck)) {
        $cfgOut = '';
        $cfgStopped = true;
    }
    if ($editStopped || $cfgStopped) {
        /* 去噪: 心跳每轮都会例行确认已应用内容, 同一 ack 锚点只记首次审计,
         * 设备应用了新下发 (ack 变化) 才记新条目, 避免每 2 分钟刷一条重复确认 */
        $ackFile = $LOG_DIR . '/ack_' . md5($uuid) . '.json';
        $lastAck = json_decode(strval(@file_get_contents($ackFile)), true);
        $curAck = array('edit' => $editAck, 'cfg' => $cfgAck);
        if ($lastAck !== $curAck) {
            auditLog('下发确认', array('device' => maskId($uuid), 'by' => '设备', 'edit' => $editStopped ? 1 : 0, 'config' => $cfgStopped ? 1 : 0));
            @file_put_contents($ackFile, json_encode($curAck), LOCK_EX);
        }
    }
    respond(array(
        'success' => true,
        'uuid' => $uuid,
        'view' => strval($row ? $row['view_var'] : ''),
        'devEdit' => strval(isset($row['edit_var_dev']) ? $row['edit_var_dev'] : ''),
        'edit' => $editOut,
        'editStopped' => $editStopped,
        'devConfig' => strval(isset($row['config_var_dev']) ? $row['config_var_dev'] : ''),
        'config' => $cfgOut,
        'configStopped' => $cfgStopped,
        'updatedMs' => intval($row ? $row['updated_ms'] : 0),
    ));
}

/* 修改: 仅写下发暂存 (查看变量/设备上报内容组由设备上报, 网页只读); 内容为原始字符串, 64KB 限;
 * editVar → 修改变量, configVar → 配置变量, 单发或同发均可;
 * 前置: 设备上报过对应内容 (dev 列非空) 才允许修改下发 */
/* 数组下发内容确保带"上次修改"时间戳条目 (闭环依赖: 设备应用后锚点回传此值才停发;
 * 无该条目则 monStampOf 恒空 => 永不停发 => 状态页一直显示"有下发"); 已有则刷新,
 * 非数组原样返回 (走内容哈希闭环) */
function monEnsureStamp($content) {
    $arr = json_decode(strval($content), true);
    if (!is_array($arr)) return $content;
    $now = date('Y-m-d H:i:s');
    foreach ($arr as $i => $it) {
        if (is_array($it) && strval(isset($it['name']) ? $it['name'] : '') === '上次修改') {
            $arr[$i]['count'] = $now;
            return json_encode($arr, JSON_UNESCAPED_UNICODE);
        }
    }
    $arr[] = array('name' => '上次修改', 'count' => $now);
    return json_encode($arr, JSON_UNESCAPED_UNICODE);
}

function handleMonitorSetVars($body) {
    if (!rateLimit(clientIp(), 30)) respond(array('success' => false, 'message' => '请求过于频繁'));
    $uuid = monVarsAuth($body, true);
    $row = monVarsLoad($uuid);
    $hasEdit = isset($body['editVar']) && is_string($body['editVar']);
    $hasCfg = isset($body['configVar']) && is_string($body['configVar']);
    if (!$hasEdit && !$hasCfg) respond(array('success' => false, 'message' => '缺少修改内容'), 400);
    $empty = '';
    $now = nowMs();
    $respEdit = '';
    $respCfg = '';
    if ($hasEdit) {
        if (!$row || trim(strval(isset($row['edit_var_dev']) ? $row['edit_var_dev'] : '')) === '') {
            respond(array('success' => false, 'message' => '设备尚未上报修改变量内容, 暂不可修改'), 400);
        }
        $edit = strval($body['editVar']);
        if (strlen($edit) > 65536) respond(array('success' => false, 'message' => '内容超过 64KB 限制'), 400);
        $edit = monEnsureStamp($edit);   /* 数组无"上次修改"则兜底补, 防闭环死锁 */
        if (strlen($edit) > 65536) respond(array('success' => false, 'message' => '内容超过 64KB 限制'), 400);
        $st = dbAcc()->prepare("INSERT INTO monitor_vars (uuid, view_var, edit_var_dev, edit_var, config_var_dev, config_var, updated_ms) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE edit_var = VALUES(edit_var), updated_ms = VALUES(updated_ms)");
        if (!$st) respond(array('success' => false, 'message' => '保存失败'), 500);
        $st->bind_param('ssssssi', $uuid, $empty, $empty, $edit, $empty, $empty, $now);
        $st->execute();
        $st->close();
        auditLog('变量修改', array('device' => maskId($uuid), 'by' => monActorLabel($body), 'len' => strlen($edit),
            'diff' => monVarsDiff(isset($row['edit_var']) ? $row['edit_var'] : '', $edit),
            'content' => monVarsDigest($edit)));
        $respEdit = $edit;
    }
    if ($hasCfg) {
        if (!$row || trim(strval(isset($row['config_var_dev']) ? $row['config_var_dev'] : '')) === '') {
            respond(array('success' => false, 'message' => '设备尚未上报配置变量内容, 暂不可修改'), 400);
        }
        $cfg = strval($body['configVar']);
        if (strlen($cfg) > 65536) respond(array('success' => false, 'message' => '内容超过 64KB 限制'), 400);
        $cfg = monEnsureStamp($cfg);   /* 数组无"上次修改"则兜底补, 防闭环死锁 */
        if (strlen($cfg) > 65536) respond(array('success' => false, 'message' => '内容超过 64KB 限制'), 400);
        $st = dbAcc()->prepare("INSERT INTO monitor_vars (uuid, view_var, edit_var_dev, edit_var, config_var_dev, config_var, updated_ms) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE config_var = VALUES(config_var), updated_ms = VALUES(updated_ms)");
        if (!$st) respond(array('success' => false, 'message' => '保存失败'), 500);
        $st->bind_param('ssssssi', $uuid, $empty, $empty, $empty, $empty, $cfg, $now);
        $st->execute();
        $st->close();
        auditLog('配置变量修改', array('device' => maskId($uuid), 'by' => monActorLabel($body), 'len' => strlen($cfg),
            'diff' => monVarsDiff(isset($row['config_var']) ? $row['config_var'] : '', $cfg),
            'content' => monVarsDigest($cfg)));
        $respCfg = $cfg;
    }
    respond(array('success' => true, 'uuid' => $uuid, 'edit' => $respEdit, 'config' => $respCfg));
}

/* 管理员删除设备: 监控密钥认证 (与 setstatus 管理分支同构);
 * uuid 或 deviceId 任一定位; 级联清理: 客户账号绑定 (账号库) + 卡密 devices/fingerprints + 设备记录 + 缩略图 */
function handleMonitorDeviceDelete($body) {
    $cip = clientIp();
    if (adminFailCheck($cip)) respond(array('success' => false, 'message' => '失败次数过多, IP 已被暂时封禁'), 429);
    if (!monitorAuth(isset($body['key']) ? strval($body['key']) : '')) {
        adminFail($cip);
        respond(array('success' => false, 'message' => '密钥错误'), 401);
    }
    adminFailClear($cip);
    $deviceId = preg_replace('/[^A-Za-z0-9_\-\.]/', '', strval(isset($body['deviceId']) ? $body['deviceId'] : ''));
    $uuid = strtoupper(preg_replace('/[^0-9A-Fa-f\-]/', '', strval(isset($body['uuid']) ? $body['uuid'] : '')));
    if ($deviceId === '' && $uuid === '') respond(array('success' => false, 'message' => '需要 deviceId 或 uuid 定位设备'), 400);
    $where = $deviceId !== '' ? 'device_id = ?' : 'uuid = ?';
    $keyVal = $deviceId !== '' ? $deviceId : $uuid;
    $chk = db()->prepare("SELECT uuid FROM client_status WHERE " . $where);
    if (!$chk) respond(array('success' => false, 'message' => '查询失败'), 500);
    $chk->bind_param('s', $keyVal);
    $chk->execute();
    $row = $chk->get_result()->fetch_assoc();
    $chk->close();
    if (!$row) respond(array('success' => false, 'message' => '设备不存在'), 404);
    $rowUuid = strtoupper(strval($row['uuid']));
    if ($rowUuid !== '') {
        /* 1. 客户账号绑定 (独立账号库, 尽力清理) */
        $stB = dbAcc()->prepare("DELETE FROM monitor_binds WHERE uuid = ?");
        if ($stB) { $stB->bind_param('s', $rowUuid); $stB->execute(); $stB->close(); }
        /* 2. 卡密 devices 数组与 fingerprints 键清理 (uuid 已白名单清洗, LIKE 通配符不会出现) */
        db();
        $db = $GLOBALS['__db'];
        $needle = '%' . $rowUuid . '%';
        $stC = $db->prepare("SELECT code, devices, fingerprints FROM cards WHERE devices LIKE ? OR fingerprints LIKE ?");
        if ($stC) {
            $stC->bind_param('ss', $needle, $needle);
            $stC->execute();
            $resC = $stC->get_result();
            $up = $db->prepare("UPDATE cards SET devices = ?, fingerprints = ? WHERE code = ?");
            while ($crow = $resC->fetch_assoc()) {
                $devices = json_decode($crow['devices'], true);
                $fps = json_decode($crow['fingerprints'], true);
                if (!is_array($devices)) $devices = array();
                if (!is_array($fps)) $fps = array();
                $pos = array_search($rowUuid, $devices);
                if ($pos !== false) array_splice($devices, $pos, 1);
                if (array_key_exists($rowUuid, $fps)) unset($fps[$rowUuid]);
                if ($up) {
                    $nd = json_encode(array_values($devices));
                    $nf = json_encode($fps ? $fps : new stdClass());
                    $up->bind_param('sss', $nd, $nf, $crow['code']);
                    $up->execute();
                }
            }
            $stC->close();
        }
        /* 4. 缩略图 (uuid 已清洗, 无路径穿越风险) */
        @unlink(__DIR__ . '/mon_thumbs/' . $rowUuid . '.webp');
        @unlink(__DIR__ . '/mon_thumbs/' . $rowUuid . '.jpg');
    }
    /* 3. 设备记录 */
    dbExec("DELETE FROM client_status WHERE " . $where, array($keyVal));
    backupData();
    auditLog('设备删除', array('device' => maskId($rowUuid !== '' ? $rowUuid : $keyVal), 'by' => '管理员'));
    respond(array('success' => true));
}

/* ==================== 路由分发 ==================== */
$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
/* 兼容子目录部署: 去掉脚本所在目录前缀 */
$scriptDir = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/');
if ($scriptDir !== '' && $scriptDir !== '/' && strpos($path, $scriptDir) === 0) {
    $path = substr($path, strlen($scriptDir));
}
$query = $_GET;
$ip = clientIp();
$body = array();
if ($method === 'POST' || $method === 'PUT' || $method === 'DELETE') {
    $raw = file_get_contents('php://input');
    $decoded = json_decode($raw, true);
    if (is_array($decoded)) $body = $decoded;
}

if (ipBlacklisted($ip)) {
    respond(array('success' => false, 'message' => '访问被拒绝'), 403);
}
if (strpos($path, '/api/admin') === 0 && !ipWhitelisted($ip)) {
    respond(array('success' => false, 'message' => 'IP 不在白名单中'), 403);
}
if ($method === 'OPTIONS') {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-CSRF-Token');
    http_response_code(204);
    exit;
}

/* ---- 公开接口 ---- */
if ($method === 'GET' && $path === '/api/time') {
    if (!rateLimit($ip, $CFG['RATE_LIMIT_TIME'])) respond(array('success' => false, 'message' => '请求过于频繁'));
    respond(array('timestamp' => nowSec(), 'salt' => issueSalt()));
}
if ($method === 'POST' && ($path === '/api/verify' || $path === '/api/heartbeat')) {
    if (!rateLimit($ip, $CFG['RATE_LIMIT_API'])) respond(array('success' => false, 'message' => '请求过于频繁'));
    handleVerify($body, $path === '/api/heartbeat');
}

/* ---- 监控接口 ---- */
if ($path === '/api/monitor/report' || $path === '/api/monitor/list' || $path === '/api/monitor/setstatus' || $path === '/api/monitor/thumb' || $path === '/api/monitor/devicedel' || $path === '/api/monitor/vars' || $path === '/api/monitor/setvars' || $path === '/api/monitor/clearcounts' || $path === '/api/monitor/audit') {
    if ($method === 'POST' && $path === '/api/monitor/report') handleMonitorReport($body);
    if ($method === 'GET' && $path === '/api/monitor/list') handleMonitorList($query);
    if ($method === 'GET' && $path === '/api/monitor/audit') handleMonitorAudit($query);
    if ($method === 'POST' && $path === '/api/monitor/audit') handleMonitorAuditClear($body);
    if ($method === 'POST' && $path === '/api/monitor/setstatus') handleMonitorSetStatus($body);
    if ($method === 'POST' && $path === '/api/monitor/thumb') handleMonitorThumb($body);
    if ($method === 'POST' && $path === '/api/monitor/devicedel') handleMonitorDeviceDelete($body);
    if ($method === 'POST' && $path === '/api/monitor/vars') handleMonitorVars($body);
    if ($method === 'POST' && $path === '/api/monitor/setvars') handleMonitorSetVars($body);
    if ($method === 'POST' && $path === '/api/monitor/clearcounts') handleMonitorClearCounts($body);
}

/* ---- 客户账号接口 ---- */
if ($path === '/api/monu/register' || $path === '/api/monu/login' || $path === '/api/monu/devices' || $path === '/api/monu/bind' || $path === '/api/monu/unbind' || $path === '/api/monu/logout' || $path === '/api/monu/changepwd' || $path === '/api/monu/captcha') {
    if ($path === '/api/monu/register') {
        if (!monRegLimit($ip)) respond(array('success' => false, 'message' => '注册过于频繁, 请一分钟后再试'), 429);
    } else {
        if (!rateLimit($ip, 20)) respond(array('success' => false, 'message' => '请求过于频繁'));
    }
    if ($method === 'GET' && $path === '/api/monu/captcha') handleMonuCaptcha();
    if ($method === 'POST' && $path === '/api/monu/register') handleMonuRegister($body);
    if ($method === 'POST' && $path === '/api/monu/login') handleMonuLogin($body);
    if ($method === 'POST' && $path === '/api/monu/logout') handleMonuLogout($body);
    if ($method === 'POST' && $path === '/api/monu/changepwd') handleMonuChangePwd($body);
    if ($method === 'POST' && $path === '/api/monu/bind') handleMonuBind($body);
    if ($method === 'POST' && $path === '/api/monu/unbind') handleMonuUnbind($body);
    if ($method === 'GET' && $path === '/api/monu/devices') handleMonuDevices($query);
}

/* ---- 管理接口 ---- */
if (strpos($path, '/api/admin') === 0) {
    if (!rateLimit($ip, $CFG['RATE_LIMIT_ADMIN'])) respond(array('success' => false, 'message' => '请求过于频繁'));
    if (adminFailCheck($ip)) respond(array('success' => false, 'message' => '失败次数过多, IP 已被暂时封禁'), 429);
    if (!adminAuth()) {
        adminFail($ip);
        respond(array('success' => false, 'message' => '未授权'), 401);
    }
    adminFailClear($ip);

    if ($method === 'POST' && $path === '/api/admin/issue') handleAdminIssue($body);
    if ($method === 'GET' && $path === '/api/admin/list') handleAdminList($query);
    if ($method === 'GET' && $path === '/api/admin/stats') handleAdminStats();
    if ($method === 'GET' && $path === '/api/admin/logs') handleAdminLogs($query);
    if ($method === 'POST' && $path === '/api/admin/card') handleAdminCard($body);
    if ($method === 'POST' && $path === '/api/admin/batch') handleAdminBatch($body);
    if ($method === 'POST' && $path === '/api/admin/unbind') handleAdminUnbind($body);
    if ($method === 'POST' && $path === '/api/admin/note') handleAdminNote($body);
    if ($path === '/api/admin/blacklist') handleAdminBlacklist($method, $body);
    if ($path === '/api/admin/whitelist') handleAdminWhitelist($method, $body);
    respond(array('success' => false, 'message' => '未知管理接口'));
}

respond(array('success' => false, 'message' => '404 Not Found'), 404);
