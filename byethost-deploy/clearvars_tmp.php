<?php
/* 临时清理脚本: 清空 monitor_vars.edit_var 测试残留, 执行后自删 */
$cfg = require __DIR__ . '/config.php';
$accDb = !empty($cfg['ACC_DB_NAME']) ? $cfg['ACC_DB_NAME'] : $cfg['DB_NAME'];
$db = @new mysqli($cfg['DB_HOST'], $cfg['DB_USER'], $cfg['DB_PASS'], $accDb, intval($cfg['DB_PORT']));
if ($db->connect_error) { echo 'DB-FAIL'; exit; }
$db->set_charset('utf8mb4');
$res = $db->query("UPDATE monitor_vars SET edit_var = ''");
echo $res === false ? 'UPDATE-FAIL' : 'CLEARED rows=' . $db->affected_rows;
$db->close();
@unlink(__FILE__);
