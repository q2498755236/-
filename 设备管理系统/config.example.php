<?php
/**
 * 设备管理系统 - 配置模板
 * 复制为 config.php 并填入真实值; config.php 已被 .gitignore 排除, 严禁提交
 */
return array(
    /* 响应签名主密钥 (卡密验证 TOTP/HMAC 依赖, 32 位随机大写字母数字) */
    'SECRET' => '',

    /* MySQL 连接 */
    'DB_HOST' => '127.0.0.1',
    'DB_NAME' => 'your_database',
    'DB_USER' => 'your_user',
    'DB_PASS' => 'your_password',
    'DB_PORT' => 3306,

    /* 客户账号独立库 (与卡密主库隔离; 留空则回落主库) */
    'ACC_DB_NAME' => '',

    /* 注册开关: false 后注册接口直接拒绝 (登录/绑定不受影响) */
    'MONU_REG_OPEN' => true,
    /* 用户名黑名单: 精确匹配; 以 * 结尾的条目按前缀匹配 */
    'MONU_NAME_BLACKLIST' => array('admin*', 'root', 'system', 'test*', 'guest', 'official', 'nexus', 'monitor', 'monkeycode', 'null', 'undefined', 'support', 'moderator', 'api'),

    /* 监控通道共享密钥 (客户端 monitor.js MONITOR_KEY 必须一致) */
    'MONITOR_KEY' => '',
    /* 监控管理 TOTP 种子 (Base32) */
    'MONITOR_TOTP_SEED' => '',
    /* 管理后台 Bearer 令牌 */
    'ADMIN_TOKEN' => '',
);
