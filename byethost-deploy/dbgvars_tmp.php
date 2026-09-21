<?php
/* 临时诊断脚本: 查 monitor_vars 三列存储状态, 输出后自删 */
$cfg = require __DIR__ . '/config.php';
$accDb = !empty($cfg['ACC_DB_NAME']) ? $cfg['ACC_DB_NAME'] : $cfg['DB_NAME'];
$db = @new mysqli($cfg['DB_HOST'], $cfg['DB_USER'], $cfg['DB_PASS'], $accDb, intval($cfg['DB_PORT']));
if ($db->connect_error) { echo 'DB-FAIL'; exit; }
$db->set_charset('utf8mb4');
$res = $db->query("SELECT uuid, LENGTH(view_var) AS v_len, LENGTH(edit_var_dev) AS d_len, LEFT(edit_var_dev, 60) AS d_head, LENGTH(edit_var) AS e_len, LEFT(edit_var, 60) AS e_head, updated_ms FROM monitor_vars WHERE edit_var != '' OR edit_var_dev != '' LIMIT 5");
if ($res === false) { echo 'QUERY-FAIL: ' . $db->error; exit; }
while ($row = $res->fetch_assoc()) {
    echo json_encode($row, JSON_UNESCAPED_UNICODE) . "\n";
}
if ($res->num_rows === 0) echo "ALL-EMPTY\n";
$db->close();
@unlink(__FILE__);
