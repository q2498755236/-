# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[thinking 标签内使用简体中文]
- Date: 2026-08-25
- Context: 用户明确要求将此作为全局行为配置
- Instructions:
  - thinking 标签内必须全程使用简体中文
  - 禁止在 thinking 标签内出现任何英文单词、短语或句子
  - 专有名词（如技术术语、品牌名、函数名等）不受此限制

[深度思考开头格式]
- Date: 2026-08-25
- Context: 用户要求每次深度思考以固定句式开头
- Instructions:
  - 每次进入 thinking 标签时，必须以"好了，我现在要用全局视角来思考这个问题"作为开头

[Project Knowledge Summary]
- Date: 2026-09-17
- Context: Discovered by Agent while performing 卡密服务端部署到 ByetHost 并迁移 MySQL
- Category: Operations & Deployment
- Instructions:
  - 线上地址 https://2498755236.byethost7.com（PHP 版服务端 index.php + MySQL），管理后台 /admin.html，Bearer admin123456
  - ByetHost FTP: ftp.byethost7.com，账号 b7_42937516；MySQL: sql210.byethost7.com，库 b7_42937516_cardkey；连接凭据在 htdocs/config.php（FTP 上传覆盖即可更新）
  - ByetHost 有 slowAES JS 挑战（返回 302/HTML + __test cookie）：curl 默认 UA 直接被拒（空回复），需带浏览器 UA 或用 test_client.php 的 solveChallenge() 解题；v2.js 已内置挑战自动解题（_solveChallenge，AES-128-CBC/NoPadding + javax.crypto）
  - 测试命令: php /tmp/opencode/test_client.php [BASE]（29 项协议测试，BASE 缺省本地 127.0.0.1:3000）
  - 本地 PHP 服务: cd /workspace/byethost-deploy && php -S 127.0.0.1:3000 router.php（后台终端管理）；本地库 cardkey_test（用户 cardkey/cardkey_test_pwd），config.php 本地指向它
  - 存量 11 张卡卡密数据在 /workspace/cards.json；MySQL 版首次请求会自动从 cards.json 导入（仅 cards 表为空时执行迁移）
  - 该 PHP 构建无 mysqli_report() 函数（PHP 8.1+ 默认已抛 mysqli_sql_exception），php -S 进程需在扩展安装后重启才会加载 mysqli

[Project Knowledge Summary]
- Date: 2026-09-18
- Context: Discovered by Agent while implementing 客户账号体系 (注册/登录/绑定 UUID 查看设备)
- Category: Operations & Deployment
- Instructions:
  - 客户账号数据存独立库 b7_42937516_account（monitor_users/monitor_tokens/monitor_binds 三表，与卡密主库 b7_42937516_cardkey 隔离），由 config 的 ACC_DB_NAME 键控制；本地未配置时回落主库存表
  - 账号三表在 dbAcc() 首次调用时自动建表（幂等），monitor_binds.uuid 有 UNIQUE 约束（一台设备只能绑一个账号）
  - 客户视图改为账号制：注册/登录 → /api/monu/* 六接口（register/login/devices/bind/unbind/logout，限频 20），旧 /api/monitor/query 裸 uuid 接口已删除
  - 客户设置状态走 token+绑定校验（handleMonitorSetStatus 客户分支），未绑定设备 403、未登录 401
  - 登录令牌 64 位 hex 存 DB（内存 token 在虚拟主机 CGI 不可靠），30 天有效期，剩余 <15 天滑动续期
  - 线上验证域名以 /workspace/monitor.js 第 39 行 MON_SERVER 为准（https://2498755236.byethost7.com），带 UA 'Googlebot/2.1 (+http://www.google.com/bot.html)'

[Project Knowledge Summary]
- Date: 2026-09-18
- Context: Discovered by Agent while fixing .htaccess 部署引发的线上 API 全 404/401 故障
- Category: Operations & Deployment
- Instructions:
  - 线上 ByetHost (LiteSpeed) 的 .htaccess 必须包含 Authorization 透传规则，否则 Bearer 管理接口全部 401（CGI 不透传该头）：RewriteCond %{HTTP:Authorization} ^(.*) + RewriteRule ^ - [E=HTTP_AUTHORIZATION:%1]
  - .htaccess 路由核心：RewriteCond !-f !-d + RewriteRule ^ index.php [QSA,L]（非真实文件统一进 index.php 内部路由）；改 .htaccess 前先备份线上原版
  - 线上 carddata 状态目录回退在站内 htdocs/carddata/state/（站点外目录不可写），HTTP 已被 .htaccess 拦截（carddata 403）；FTP 清理状态文件用"上传临时 PHP 脚本→curl 触发→脚本自删"模式
  - 管理员防爆破 (admin_fail 3 次锁 30 分钟) 会把测试脚本负向用例计入失败：连续跑多轮 test_client 可能触发 429 封禁，需 FTP 清 carddata/state/admin_fail.json 后重测
  - 线上 REMOTE_ADDR 直传真实公网 IP（XFF 同值），免费主机偶发 http=0 超时属正常抖动，重跑即可