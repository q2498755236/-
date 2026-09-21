<?php
/* 本地测试专用 router (php -S 127.0.0.1:3000 router.php) */
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path !== '/' && is_file(__DIR__ . $path)) {
    return false; /* 静态文件 (admin.html / index.html) 直接返回 */
}
$_SERVER['SCRIPT_NAME'] = '/';
require __DIR__ . '/index.php';
