<?php
/* 集成冒烟测试: 漂移自愈 + 下发内容审计 全链路 (php -S 127.0.0.1:3000 router.php) */
$BASE = 'http://127.0.0.1:3010';
$KEY = 'LOCALMONKEY123';
$SEED = 'JBSWY3DPEHPK3PXP';
$UUID = '11EB-A1B2-C3D4-E5F6-AABB';
$DEV = 'test-dev-01';
$LOG = '/workspace/carddata/logs/audit.log';

function b32dec($b32) {
    $alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $b32 = strtoupper(preg_replace('/[=\s\-]/', '', $b32));
    $bits = 0; $val = 0; $out = '';
    for ($i = 0, $n = strlen($b32); $i < $n; $i++) {
        $idx = strpos($alpha, $b32[$i]);
        if ($idx === false) continue;
        $val = ($val << 5) | $idx; $bits += 5;
        if ($bits >= 8) { $out .= chr(($val >> ($bits - 8)) & 0xff); $bits -= 8; }
    }
    return $out;
}
function totp($seed, $ts) {
    $key = b32dec($seed);
    $c = intdiv($ts, 30);
    $bin = pack('N2', ($c >> 32) & 0xffffffff, $c & 0xffffffff);
    $h = hash_hmac('sha1', $bin, $key, true);
    $off = ord(substr($h, -1)) & 0x0f;
    $v = ((ord($h[$off]) & 0x7f) << 24) | (ord($h[$off+1]) << 16) | (ord($h[$off+2]) << 8) | ord($h[$off+3]);
    return str_pad(strval($v % 1000000), 6, '0', STR_PAD_LEFT);
}
function post($path, $data) {
    global $BASE;
    $ctx = stream_context_create(array('http' => array(
        'method' => 'POST',
        'header' => "Content-Type: application/json\r\n",
        'content' => json_encode($data),
        'ignore_errors' => true,
        'timeout' => 10,
    )));
    $raw = file_get_contents($BASE . $path, false, $ctx);
    return json_decode(strval($raw), true);
}
function devAuth($deviceId, $uuid) {
    global $SEED;
    $ts = time();
    $t = totp($SEED, $ts);
    $nonce = 'n' . bin2hex(random_bytes(8));
    $sign = hash_hmac('sha256',
        'deviceId=' . $deviceId . '&uuid=' . $uuid . '&nonce=' . $nonce . '&timestamp=' . $ts . '&totp=' . $t,
        $t . $SEED);
    return array('deviceId' => $deviceId, 'uuid' => $uuid, 'timestamp' => $ts, 'totp' => $t, 'nonce' => $nonce, 'sign' => $sign);
}
function auditLines($from) {
    global $LOG;
    $all = file(strval($LOG), FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    return array_slice(is_array($all) ? $all : array(), $from);
}
function countType($lines, $type) {
    $n = 0;
    foreach ($lines as $l) if (strpos($l, '[AUDIT] ' . $type . ' ') !== false) $n++;
    return $n;
}
function db() {
    return new mysqli('127.0.0.1', 'montest', 'montest_pwd', 'device_mon_test', 3306);
}
function dbRow($sql) {
    global $__tdb;
    $__tdb = db();
    $st = $__tdb->prepare($sql);
    $st->execute();
    $r = $st->get_result()->fetch_assoc();
    $st->close();
    return $r;
}
$PASS = 0; $FAIL = 0;
function check($name, $cond) {
    global $PASS, $FAIL;
    if ($cond) { $PASS++; echo "PASS  $name\n"; }
    else { $FAIL++; echo "FAIL  $name\n"; }
}

/* ---- 准备: 清测试设备行 + 锚点文件, 记 audit 基线 ---- */
$db = db();
$db->query("DELETE FROM monitor_vars WHERE uuid = '$UUID'");
$db->query("DELETE FROM client_status WHERE device_id = '$DEV'");
$db->query("DELETE FROM monitor_nonces");
$db->close();
foreach (array('sent_', 'ack_') as $p) {
    $f = '/workspace/carddata/logs/' . $p . md5($UUID) . '.json';
    if (is_file($f)) @unlink($f);
}
$base = count(file($LOG, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: array());

$newCfg = json_encode(array(
    array('name' => '定时时间', 'count' => '00:20'),
    array('name' => '上次修改', 'count' => '2026-10-01 00:00:00'),
), JSON_UNESCAPED_UNICODE);
$oldCfg = json_encode(array(
    array('name' => '定时时间', 'count' => '00:10'),
    array('name' => '上次修改', 'count' => '2026-10-01 00:00:00'),
), JSON_UNESCAPED_UNICODE);

/* ---- T0: 设备首次上报初始内容 (setvars 前置) ---- */
$r = post('/api/monitor/report', array_merge(devAuth($DEV, $UUID), array(
    'configVarDev' => $oldCfg, 'battery' => 80,
)));
check('T0 report success', !empty($r['success']));

/* ---- T1: 管理员保存基线 → 配置变量修改审计 ---- */
$r = post('/api/monitor/setvars', array('key' => $KEY, 'uuid' => $UUID, 'configVar' => $newCfg));
check('T1 setvars success', !empty($r['success']));
$r = post('/api/monitor/setvars', array('key' => $KEY, 'uuid' => $UUID, 'configVar' => $newCfg));
check('T1 重复保存仅刷新时间戳', !empty($r['success']));
$lines = auditLines($base);
check('T1 审计含 配置变量修改', countType($lines, '配置变量修改') >= 1);
$row = dbRow("SELECT config_var, resend_ms FROM monitor_vars WHERE uuid = '$UUID'");
$stamp1 = '';
$arr = json_decode(strval($row['config_var']), true);
foreach ((array)$arr as $it) if (strval($it['name']) === '上次修改') $stamp1 = strval($it['count']);
check('T1 基线时间戳已刷新且非空', $stamp1 !== '' && $stamp1 !== '2026-10-01 00:00:00');
check('T1 resend_ms=0', intval($row['resend_ms']) === 0);

/* ---- T2: 设备 vars 拉取 (ack 空) → 下发内容审计 ---- */
$r = post('/api/monitor/vars', devAuth($DEV, $UUID));
check('T2 vars success', !empty($r['success']));
check('T2 config 下发非空', strval($r['config']) !== '');
check('T2 configStopped=false', empty($r['configStopped']));
$lines = auditLines($base);
check('T2 审计含 下发内容', countType($lines, '下发内容') === 1);
$sentFile = '/workspace/carddata/logs/sent_' . md5($UUID) . '.json';
check('T2 sent 锚点文件落盘', is_file($sentFile));
$sent = json_decode(strval(file_get_contents($sentFile)), true);
check('T2 sent 锚点为 时间戳:SHA256 派生值', preg_match('/^.+:[0-9a-f]{64}$/', strval(isset($sent['cfg']) ? $sent['cfg'] : '')) === 1);

/* ---- T3: 同内容再拉 → 去噪无新条目 ---- */
$r = post('/api/monitor/vars', devAuth($DEV, $UUID));
check('T3 重复下发仍返回内容', strval($r['config']) !== '');
$lines = auditLines($base);
check('T3 下发内容 去噪仍为 1 条', countType($lines, '下发内容') === 1);

/* ---- T4: 带 ack → 停发 + 下发确认审计 ---- */
$r = post('/api/monitor/vars', array_merge(devAuth($DEV, $UUID), array('configAck' => $stamp1)));
check('T4 configStopped=true', !empty($r['configStopped']));
check('T4 config 输出为空', strval($r['config']) === '');
$lines = auditLines($base);
check('T4 审计含 下发确认', countType($lines, '下发确认') >= 1);

/* ---- T5: 设备 report 旧内容 (本地回滚) → 漂移重发立即触发 ---- */
sleep(1);   /* monEnsureStamp 秒级时间戳, 隔 1s 保证 T5 重打值 ≠ T1 值 */
$r = post('/api/monitor/report', array_merge(devAuth($DEV, $UUID), array(
    'configVarDev' => $oldCfg, 'battery' => 80,
)));
check('T5 report success', !empty($r['success']));
$row = dbRow("SELECT config_var, config_var_dev, resend_ms FROM monitor_vars WHERE uuid = '$UUID'");
$arr = json_decode(strval($row['config_var']), true);
$stamp2 = '';
foreach ((array)$arr as $it) if (strval($it['name']) === '上次修改') $stamp2 = strval($it['count']);
check('T5 基线时间戳被重打', $stamp2 !== '' && $stamp2 !== $stamp1);
check('T5 resend_ms > 0', intval($row['resend_ms']) > 0);
check('T5 镜像=设备旧内容', strpos(strval($row['config_var_dev']), '"00:10"') !== false);
$lines = auditLines($base);
check('T5 审计含 漂移重发', countType($lines, '漂移重发') === 1);

/* ---- T6: 限频窗口内再 report → 不再触发 ---- */
$r = post('/api/monitor/report', array_merge(devAuth($DEV, $UUID), array(
    'configVarDev' => $oldCfg, 'battery' => 80,
)));
$row = dbRow("SELECT config_var, resend_ms FROM monitor_vars WHERE uuid = '$UUID'");
$arr = json_decode(strval($row['config_var']), true);
$stamp3 = '';
foreach ((array)$arr as $it) if (strval($it['name']) === '上次修改') $stamp3 = strval($it['count']);
check('T6 基线时间戳未变 (限频)', $stamp3 === $stamp2);
$lines = auditLines($base);
check('T6 漂移重发 仍为 1 条', countType($lines, '漂移重发') === 1);

/* ---- T7: 人工 setvars → resend_ms 清零; 再 report → 再次触发 ---- */
$r = post('/api/monitor/setvars', array('key' => $KEY, 'uuid' => $UUID, 'configVar' => $newCfg));
check('T7 setvars success', !empty($r['success']));
$row = dbRow("SELECT resend_ms FROM monitor_vars WHERE uuid = '$UUID'");
check('T7 人工保存清零 resend_ms', intval($row['resend_ms']) === 0);
$r = post('/api/monitor/report', array_merge(devAuth($DEV, $UUID), array(
    'configVarDev' => $oldCfg, 'battery' => 80,
)));
$lines = auditLines($base);
check('T7 重新计时后再触发 (共 2 条)', countType($lines, '漂移重发') === 2);

/* ---- T8: 存量死锁自愈——基线数组缺"上次修改" → 下发时自动补并回写 ---- */
$noStamp = json_encode(array(array('name' => '定时时间', 'count' => '00:30')), JSON_UNESCAPED_UNICODE);
$tdb = db();
$st8 = $tdb->prepare("UPDATE monitor_vars SET config_var = ?, resend_ms = 0 WHERE uuid = ?");
$st8->bind_param('ss', $noStamp, $UUID);
$st8->execute();
$st8->close();
$tdb->close();
$r = post('/api/monitor/vars', devAuth($DEV, $UUID));
$cfgOut8 = strval($r['config']);
check('T8 下发内容已补时间戳', strpos($cfgOut8, '上次修改') !== false);
$row = dbRow("SELECT config_var FROM monitor_vars WHERE uuid = '$UUID'");
$arr8 = json_decode(strval($row['config_var']), true);
$stamp8 = '';
foreach ((array)$arr8 as $it) if (strval($it['name']) === '上次修改') $stamp8 = strval($it['count']);
check('T8 补后基线回写落库', $stamp8 !== '');
$lines = auditLines($base);
check('T8 审计含 基线补时间戳', countType($lines, '基线补时间戳') >= 1);
/* ack 补后的时间戳 → 应停发, 闭环恢复 */
$r = post('/api/monitor/vars', array_merge(devAuth($DEV, $UUID), array('configAck' => $stamp8)));
check('T8 补后闭环停发 (configStopped)', !empty($r['configStopped']));

/* ---- 汇总: 打印新审计行 ---- */
echo "\n---- 新增审计行 ----\n";
foreach (auditLines($base) as $l) echo $l . "\n";
echo "\n==== $PASS passed, $FAIL failed ====\n";
exit($FAIL > 0 ? 1 : 0);
