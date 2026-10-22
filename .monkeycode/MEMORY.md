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

[分析故障原因永远不考虑旧版]
- Date: 2026-09-19
- Context: 排查网页变量显示问题时，模型反复把"客户端是旧版/未更新"列为怀疑方向，用户明确纠正
- Instructions:
  - 分析问题原因时永远不考虑"旧版本/未更新/需要重新部署"这类因素
  - 默认线上和设备端跑的都是最新代码，从代码逻辑、数据链路、配置正确性找原因

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
  - 该 PHP 构建无 mysqli_report() 函数（PHP 8.1+ 默认已抛 mysqli_sql_exception），php -S 进程需在扩展安装后重启才会加载扩展（mysqli/GD 均如此）；探测进程内扩展状态：放临时 php 文件到项目目录后 curl 访问（router.php 对存在的文件 return false 交给内置服务器执行）

[Project Knowledge Summary]
- Date: 2026-09-26
- Context: Discovered by Agent while 实现画面状态检测 (缩略图 dHash 对比 + 黑屏判定) 并本地协议测试
- Category: Testing Methods & Environment Configuration
- Instructions:
  - 画面状态协议：心跳/缩略图响应带 screen{state,static_sec,black_sec}（state ∈ normal/static/black），设备端写入变量"画面状态"（正常/静止N秒/黑屏N秒），列表接口每设备带 screen_state；状态文件在 /workspace/carddata/state/screen_{UUID}.json（设备管理系统在子目录，站点外数据目录是 /workspace/carddata）
  - 画面状态全链路测试脚本 /tmp/opencode/test_screen.php（13 项，复用签名函数 + multipart 构造）；列表接口必须 GET；秒级时间戳同秒内的变化检测断言用 hash 比对而非时间戳大于比较；测试残留数据每轮要备份清理，否则限频/首传判定失真
  - 本地模拟时间流逝：直接改 state 文件 json 的 changed_ts（-= 秒数）即可测静止判定，无需等待
  - monitor.js 部署源在 /workspace/设备管理系统/monitor.js（与线上一致，先 diff 再改）；工作区根目录 /workspace/monitor.js 是 9-19 旧版（55KB），改错地方会出现"本地改了线上没变"假象
  - 下发闭环排查链：网页保存（配置变量修改审计）→ monitor_vars 基线 → 设备 monFetchVars 拉取 → arrApplyServerEdit 应用 → applied 锚点回传 → 服务端停发；审计日志 audit.log 的"配置上发"多设备交替出现 = 上发配置互相覆盖基线串台；"上发配置=1"多设备共用会串，代码已加"未应用下发时暂停上发"防护（26-09-27）
  - 审计日志增强（26-09-27）：配置上发带 cfg/edit 内容摘要（name=count 压缩）；变量修改/配置变量修改带 diff（字段: 旧->新/新增/删除，过滤"上次修改"噪音）+ content 快照；摘要截断用 PCRE /u 按字符对齐，环境无 mbstring，禁用 mb_* 函数；本地测试审计在 /workspace/carddata/logs/audit.log（站点外，LOG_DIR=dirname(__DIR__)+'/carddata'）
  - "串台"结论（26-09-27）：服务端 monitor_vars 按 uuid 分行完全独立；所谓串=设备"上发配置=1"用本地旧值反复覆盖自己基线+业务脚本每轮重写变量，两台脚本同源默认值相同造成串的错觉；排查靠 audit.log 的上发摘要/diff 直接看值
  - 审计操作者身份（26-09-27）：auditLog 各点带 by 字段（管理员/账号 {username}/设备），monActorLabel 按 body 的 key/token 分类，token 经 monitor_users 查用户名；GET /api/monitor/audit?key=&limit=（仅 key 认证，尾部读取倒序返回）为管理员专属日志接口；status.html adminBar"日志"按钮（ACC_MODE 无入口）→ au-row 弹窗（时间/操作/操作者/设备/详情）
  - 日志噪音排查（26-10-08）：线上 audit.log 曾堆 5407 条"下发确认"（每心跳一条），根因 handleMonitorVars 函数头漏 `global $LOG_DIR` → ack 锚点文件拼成根路径 /ack_*.json 读写全败，去噪恒失效；教训：PHP 函数内用全局路径变量必须声明 global（auditLog 自己有声明所以日志文件正常可写，具迷惑性）；已修 + audit 接口加 action/exclude 过滤参数 + 按类型清理（POST audit body.action），前端操作日志弹窗加类型下拉与"清当前类"按钮
  - 客户查看绑定设备日志（26-10-08）：GET /api/monitor/audit 双认证——key=管理员全量、token=客户仅绑定设备；客户模式 devAllow=绑定 uuid 的 maskId 掩码集，行 detail.device 掩码不在集内即跳过，无 device 字段的行客户不可见；可选 uuid 参数单设备过滤，客户模式 uuid 不在绑定集返回 403"该设备未绑定在此账号下"；maskId 格式=前 8 字符+***；前端抽 renderAuditRows 共用，openDeviceLog 设备卡日志按钮，客户模式带 X-CSRF-Token header + accExpired 401 处理；本地验证：注册(需验证码,答案在 state/monu_cap.json)拿 token/csrf，bind 需 X-CSRF-Token header，绑定设备可见/未绑定403/不带uuid仅绑定集均通过；已部署 cmp 一致，线上探针 key+EAD4 过滤返回空正常
  - 排障坑：POST /api/monitor/vars 探针若不带 editAck/configAck，服务端 ack 比对必失败 → 恒返回完整下发内容+Stopped=false，看似"在发/未应用"实为正常；验证停发状态须带设备 applied 时间戳当 ack。设备在线但 devConfig 显示旧值+旧"上次修改"=业务脚本模板每轮重写配置数组所致（模板冻结时间戳从不变化，audit"下发确认"是应用成功的真实证据）——7F4A 26-10-11 排查实例：三次保存均 2-5 分钟内 ack 应用成功，网页"待应用定时时间"为假象
  - 上发覆盖保护（26-10-16）：report 接口 uploadCfg=1 反向覆盖基线前，monUploadAllowCover 比对设备上发"上次修改" vs 服务端基线——设备早于基线=未应用最新下发，跳过覆盖（仅更新 dev 镜像列）+ audit"上发跳过"，防离线/应用失败期间待下发被旧值冲掉；时间戳服务端 saveVars/monEnsureStamp 生成、设备原样带回，字符串比较即时间比较；非数组/无时间戳保持原覆盖逻辑兼容；config 单独上发覆盖也记"配置上发"审计（$upCfgAudited 标志防 edit+config 同发重复）；另修原有 bug：report 只带 configVarDev 不带 editVarDev/viewVar 时 config 分支用未定义 $empty → bind_param null → edit_backup NOT NULL 500（真实设备心跳全带字段从未触发），改用分支内 $emptyC；验证套件 /tmp/opencode/test_upload_protect.py（12 断言：设备签名 TOTP 本地可生成，base32 seed 在 config MONITOR_TOTP_SEED）
  - 部署坑（26-09-27）：byethost FTP 偶发上传截断（138KB 只传了 7KB 且返回 226 成功），必须回读 cmp 校验，不一致就重传；本地起两个 php -S（byethost-deploy 与 设备管理系统）共写 /workspace/carddata/logs/audit.log 会交错乱序，audit 尾部读取按物理行序取最新 limit 条；FTP 回读大文件也常 transfer closed（用 --retry-all-errors 重试 curl），HTTP GET 页面受 slowAES 挑战拖慢会超时、API POST JSON 不受挑战可直接探针，验证线上版本优先 API 探针+FTP cmp；线上探针用无流量设备 EAD4-CE4B-6EF7-BBCD（92B4/7F4A 是 1.2.0 真实设备，勿写测试数据）
  - 客户端版本号（26-09-27）：monitor.js MON_VERSION 常量随心跳 payload.ver 上报 → client_status.mon_ver 列（迁移数组幂等加列）→ list SELECT * 自动带出 → 设备卡"客户端"行显示（未上报显示"旧版(未上报)"）；升级 monitor.js 时同步改 MON_VERSION
  - 本地测试套件（26-09-27 全过）：test_screen(13)+test_audit_detail(17)+test_audit_actor(14)+test_monver(5)+test_configvar(20)；连跑需间隔 60s（setvars 限频 30/分）；测试 fixture 自清理约定——state 文件测试内 unlink 自己的产物，缩略图限频用 touch 拨老 mtime 绕开（不删除）；旧客户端 report 分支 INSERT 必须补全所有 NOT NULL 无默认值列（MySQL 严格模式）；monitor_vars 表加列时（26-10-05 备用项 edit_backup/config_backup）全库 7 处 INSERT 语句都要同步补列+bind_param 类型串（类型串长度必须等于变量个数，ssssssssi=8s+i），MariaDB/MySQL 的 TEXT 列都不用 DEFAULT 兜底、靠 INSERT 显式带列

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

[Project Knowledge Summary]
- Date: 2026-09-30
- Context: Discovered by Agent while implementing 灵眸编辑器复刻层 (lingmou/editor/) 与看门狗 httpProbe
- Category: Build Methods | Testing Methods
- Instructions:
  - 灵眸编辑器复刻冒烟: node /tmp/opencode/test_editor.js（66 项，含真实 最新.auto 装载与真实插件 12+34=46 全链路）；看门狗回归: node /tmp/opencode/test_watchdog.js（116 项）
  - 打包交付: cd /workspace && zip -r watchdog.zip watchdog/ -x "watchdog/.git*"；灵眸 zip 用 zip -r lingmou-editor.zip lingmou/ -x "lingmou/.git*"（-j 会拍平目录路径，勿用）
  - .auto 内插件 uuid 以 ZIP 内文件名为权威（气泡插件 JSON 内 mUUID 与文件名不一致，任务 T29 引用按文件名）；插件目录为 UTF-8 flag 的"插件/我的/<uuid>.json"，Java ZipInputStream 传 GBK charset 仅对无 flag entry 生效
  - 编辑器复刻语义推断项（CALIBRATE）清单在 lingmou/editor/README.md，真机对照后回填
  - node 冒烟绕过 runtime.start() 时需手动 vars.loadList() 与 host.loadAll()（白盒测试顺序）
[Project Knowledge Summary]
- Date: 2026-09-19
- Context: Discovered by Agent while 集成数组条件插件到 monitor.js, 编辑器"添加条件"按钮一直灰
- Category: Environment Configuration
- Instructions:
  - 自动化编辑器识别插件"条件类"功能的硬性要求：loop() 的 default 分支和 catch 分支都必须 return false（所有执行路径有布尔兜底返回），否则整个插件被判定无功能，"添加条件"按钮灰、所有 case 都归入动作列表
  - 编辑器插件 case 范式（与 v2.js/时间段插件对齐）：case 名用双引号（case "条件类-xxx"），条件类 return 直接跟表达式调用（return condCheck(...)），动作类 return 字符串/数据（编辑器要求动作返回数据，undefined 会报"未返回数据"）
   - monitor.js 单文件集成多类 case：监控动作类（无 return 也被编辑器接受）、数组条件/动作类，新增功能时保持上述范式
   - 线上 REMOTE_ADDR 直传真实公网 IP（XFF 同值），免费主机偶发 http=0 超时属正常抖动，重跑即可

[Project Knowledge Summary]
- Date: 2026-09-21
- Context: Discovered by Agent while 排查 v15 插件参数改版后设备仍显示旧参数（用户确认为编辑器缓存）
- Category: Troubleshooting & Debugging
- Instructions:
  - 自动化编辑器对已安装 APK 插件（cn.autoeditor.pluginaction.*）的动作参数列表有本地缓存，覆盖安装新版插件后动作参数仍显示旧版（如"区域OCR识别"缓存了旧版 5 参数 左/上/右/下/识别格式，新版实际是 区域 x,y,w,h + 识别格式 2 参数）
  - 表现为"新版没落实"假象，先查编辑器缓存再查 APK 内容（dexdump 字符串可验证 APK 实际参数）
  - 处理：覆盖安装后重启编辑器，必要时在插件管理里重新勾选加载插件；任务里已添加的旧动作节点要删除重加

[Project Knowledge Summary]
- Date: 2026-09-19
- Context: Discovered by Agent while 排查设备端"查看变量"出现无法清除的 probe 脏值
- Category: Troubleshooting & Debugging
- Instructions:
  - 编辑器工具变量的值可能持久化脏数据（在变量面板清空、保存后一运行又恢复旧值），常规清空重置无效
  - 有效手段：删除该变量后新建同名变量，脏值随之消失
  - 排查此类问题时先区分三层来源：JS 代码写入点（rg 全部 setValue 调用）、编辑器原生层任务配置恢复、变量存储脏数据；前两层排除后再考虑第三层
  - 编辑器 auto.setValue/auto.getValue 在部分周期存在读写不可靠（写入失败被吞异常、跨周期读不到），跨事件持久化数据优先用文件存储（/sdcard 目录 + 回读验证），参考 monitor.js 的 monWrite/monRead
[Project Knowledge Summary]
- Date: 2026-09-21
- Context: OCR插件 native 授权算法验证（license.cpp 手写 SHA1/SHA256/HMAC/TOTP）
- Category: Build Methods
- Instructions:
  - 主机对拍 C++ 算法：sed 切出 license.cpp 算法段（1-252 行，删 191-197 的 j2s 与 jni/log include），追加 harness main() 用 g++ 编译，与 Python hmac/hashlib 输出逐行 diff
  - 对拍覆盖：TOTP(counter)、请求签名(key=totp+salt+SECRET)、响应验签(key=hex(HMAC-SHA256("response_salt_v2", code+SECRET)) 二次 HMAC)、SHA1/SHA256 已知向量("abc")
  - 手写 HMAC 传 key 长度必须 strlen 字面量核对（曾因写死 15 截断 "response_salt_v2"(16B) 导致验签必败）
  - license.cpp 时钟用 CLOCK_REALTIME 对齐 Unix 毫秒时间戳（nativeSetSession 的 deadline）
  - OCR 插件 APK 构建现场在 /tmp/opencode/ocrplugin（src + keys/release.jks，密钥口令 android）；工具链 /tmp/opencode/androidsdk/android-14（d8/zipalign/apksigner）+ androidsdk/android-34/android.jar
  - 重打包流程：javac -source 8 -target 8 -bootclasspath android.jar → d8 --release --lib android.jar --output <已存在的目录>（目录必须先 mkdir）→ cp v14.apk 后 unzip 只替换 classes.dex 再 zip 回去 → zipalign -f -p 4 → apksigner sign --ks release.jks

[Project Knowledge Summary]
- Date: 2026-09-21
- Context: Discovered by Agent while 设备管理系统新增"配置变量"后做本地协议测试
- Category: Environment Configuration
- Instructions:
  - 设备管理系统目录（/workspace/设备管理系统）本地测试：config.php（被 gitignore，测试值）指向本地库 device_mon_test，起服务 cd /workspace/设备管理系统 && php -S 127.0.0.1:3010 router.php
  - 本地 MySQL root 仅 auth_socket（mysql -uroot 走 socket 可连，TCP 127.0.0.1 连不上）；测试用专用 TCP 账号 montest/montest_pwd（仅授权 device_mon_test 库）
  - CLI PHP 无 curl 扩展，测试脚本用 file_get_contents + stream context 发 POST
  - 监控协议测试样例（TOTP+HMAC 签名心跳/vars/setvars 全链路 20 项）在 /tmp/opencode/test_configvar.php，可复制改 BASE 复用

[Project Knowledge Summary]
- Date: 2026-09-22
- Context: Discovered by Agent while 探针插件真机实测编辑器变量机制并做 monitor.js 数组功能一跳改造
- Category: Environment Configuration
- Instructions:
  - 编辑器插件变量机制已探针真机验证，完整结论记录在 /workspace/编辑器插件变量机制.md，写任何编辑器插件前先读该文档
  - 核心规则：auto.getValue/setValue 只认节点上配置的输入/输出变量名；输入 @全局变量 传值（拿到的是值），输出 @全局变量 被 setValue 覆盖写回；手打未配置变量名读得 null、写不落地
  - 动作类节点必须配输出变量并写它（或插件内 return 数据），否则编辑器报"未返回数据"；click("x,y[,w,h]") 全局函数可用
  - monitor.js 已按此机制完成一跳改造（数组功能输入变量 数组名、写回同名输出变量），旧"手打变量名两跳"设计已废弃

[Project Knowledge Summary]
- Date: 2026-09-23
- Context: Discovered by Agent while 排查"上发配置反向覆盖未生效+网页编辑底稿与显示脱节"问题
- Category: Operations & Deployment
- Instructions:
  - 服务端更新部署后浏览器可能缓存旧 status.html，验证前必须强刷（Ctrl+Shift+R / 清站点缓存），否则误判"改了没效果"
  - FTP 部署命令：curl -T 文件 ftp://ftp.byethost7.com/htdocs/ --user b7_42937516:xxj19991218
  - 网页变量弹窗显示用 dev 列（设备上报），编辑底稿由 editStopped（服务端 ack 比对结果）驱动选择：停发取设备内容、待应用取基线；判断新旧优先 ack 结果而非"上次修改"时间戳（设备端数组可能不带时间戳条目）
[Project Knowledge Summary]
- Date: 2026-09-23
- Context: Discovered by Agent while 重做验证码抗 OCR 方案 (灰度纠缠+明暗交替)
- Category: Build Methods
- Instructions:
  - 验证码抗 OCR 离线评估法: 本地装 php-gd + tesseract-ocr, 用正则从 index.php 切出 monCaptchaImg/monCaptchaText eval 渲染 20 张, Python PIL 多阈值二值化连通域统计 + tesseract psm7/psm6 + "最优阈值二值化后再 OCR"闭环测命中率; 评估样本目录每轮换新, 旧样本会混入统计
  - 抗 OCR 核心组合: 背景随机灰度色块 70-190 + 每字符先采样落点背景灰度(9点均值), 浅底画深字/深底画亮字(差>=70 保证人眼可读), 明暗交替使全局单阈值二值化失效; 配 TTF 旋转±28°+ghost重影+正弦逐列扭曲+800全域噪点+55字符区同灰度集中噪点
  - 坑: 字符区集中噪点 clamp 上限写死旧值会把亮字区噪点压成深灰盖住字符, clamp 必须跟随字符灰度
  - 线上验证码 TTF 路径依赖 htdocs/fonts/captcha.ttf (DejaVuSans-Bold), function_exists('imagettftext') 为假时自动回退单字符画布 imagerotate; 实测 ByetHost 支持.imagettftext
[Project Knowledge Summary]
- Date: 2026-09-23
- Context: Discovered by Agent while 复刻 freedns 风格验证码时线上 500 排查
- Category: Operations & Deployment
- Instructions:
  - ByetHost FTP 上传大文件可能被静默截断（curl 进度 100% 只是发送侧，服务器实收 7KB/114KB 曾发生），部署后必须下载回读 cmp 校验，不一致重传；status.html 等大文件同理
  - freedns 风格验证码实现：TTF 实心字画 200x260 高分辨率画布 → 列+行正弦扭曲（波长 52-105px，频率过高会揉碎字符）→ 轮廓提取（±2 偏移 4 点全墨=内部跳过，边缘点涂+4邻域膨胀）→ imagecopyresampled 下采样贴回
  - 轮廓提取逻辑曾写反（写成"任一偏移非墨就跳过"=只涂内部点），正确逻辑是"全墨才 continue"；诊断法：单字符分阶段渲染（solid/warp/edge/small）拼图排查
  - ByetHost PHP 8.4.25 GD 性能足够（单字符全流程 11ms），验证码 500 根因排查用"伪造 REQUEST_URI include index.php + register_shutdown_function 打印 error_get_last"探针，display_errors 线上是关的

[Project Knowledge Summary]
- Date: 2026-10-03
- Context: Discovered by Agent while 排查"编辑配置下发命令跨设备串台"问题
- Category: Troubleshooting & Debugging | Operations & Deployment
- Instructions:
  - 设备监控系统管理密钥 732b5df1cd7204c10948cd5b63c28e28（status.html 页头说明里用户输入）；status.html 客户模式输设备 UUID 查看
  - ByetHost 挑战捷径：UA 用 Googlebot/2.1 (+http://www.google.com/bot.html)（即设备端 MON_UA）直接免挑战，无需解 __test cookie；解法可用 openssl enc -d -aes-128-cbc 解单块
  - "编辑配置混命令"排查结论（三因素叠加，服务端 monitor_vars 按 uuid 隔离无串行）：1) 两台设备业务脚本同源、配置默认值相同（如定时时间 00:10:00-23:55:00），A 被下发的值恰为 B 默认值时看似"命令跑到 B"；2) 业务脚本每轮重写"配置变量"冲掉已应用的下发（ack 已回传服务端停发，下发改不动，用户会重复保存）；3) status.html openVars 弹窗 fetch 无守卫竞态（已修：VARS_SEQ 序号守卫 + closeModal 失效，过期响应丢弃），慢主机上先点 A 后点 B 时 A 响应后到会用 A 数据渲染 B 标题弹窗，编辑保存即真串台
  - audit.log 的"下发确认"会因 ack 锚点不稳定每 2 分钟刷屏（一次拉 2000 条才见变量修改记录），排障时先按 action 过滤再分析

[Project Knowledge Summary]
- Date: 2026-10-03
- Context: Discovered by Agent while 排查客户端 1.2.0 比 1.1.0 闪退严重
- Category: Troubleshooting & Debugging | Build Methods
- Instructions:
  - 1.1.0→1.2.0 的 monitor.js 增量仅 91 行：新增「画面静止秒」变量 + 缩略图改为"先行"（从心跳后挪到心跳前）+ 心跳失败写 -2
  - 闪退根因：1.2.0 缩略图先行 = 每次心跳前连续同步 http.upload(慢图)+postJson(vars)+postJson(report)，慢主机单周期可拖到 51s（线上实测 7F4A 缩略图-心跳间隔 51s 后崩溃）；主线程被慢上传长时间阻塞
  - 修复（26-10-03）：monThumbUpload 改 http.upload 回调式异步（autox 系支持第 4 参 callback），发起即返回不阻塞心跳；截屏/120s 节流仍同步，结果/日志/画面状态/删临时文件全放回调，临时文件必须在回调里删（提前删上传读不到）；monMaybeThumb 移除返回值处理。已在部署源改 + FTP 部署回读 cmp 一致，设备端需重启任务重载 monitor.js 生效
  - 插件的 slog 只 console.log 不落盘，崩溃现场无日志可查，只能靠线上心跳/缩略图时间戳快照佐证
  - 设备端 http 超时：编辑器 http 支持 http.setTimeout(N)（v2.js 647 行有用例），同步请求可设超时兜底
[User Instruction Summary]
- Date: 2026-09-24
- Context: 讨论云机诊断项采集方案时 (Android版本/启动时长/存储空间原本各拟用 Java API)
- Instructions:
  - monitor.js 插件开发禁止 Java 互操作 (Packages/SystemClock/StatFs/android.os.* 一律不要), 需要系统能力时优先纯 JS API (auto.*), 无 API 时用 auto.shell 命令替代 (getprop/cat /proc/uptime/df/dumpsys)

[Project Knowledge Summary]
- Date: 2026-10-18
- Context: 7F4A "定时时间 00:10 反复出现"排查 (用户设备死机闪退重启后配置不统一质疑)
- Category: Troubleshooting & Debugging
- Instructions:
  - 判别设备数组变化来源的指纹法: 看镜像"上次修改"时间戳——服务端下发=整包替换带当次基线新时间戳; 本地脚本模板重写=冻结在模板固化时的旧值; 服务端 10-17 后没发过的旧时间戳版本=本地留存内容
  - **"00 错误下发"根因 (用户长期反馈)**: 编辑弹窗 stopped=true 时底稿取设备上报内容 (editVarsForm), 设备数组被本地回滚/脚本改写成旧值后, 用户改其他字段保存即把设备旧值整包固化入基线误下发; 修复=devDiverged 标记+红色警告条+saveVars 前 window.confirm 强制确认 (5e14bb5, 26-10-18 已部署)
  - 编辑器日志"上报 xx→xx"归因的是动作执行链 (monitor.js 的 vars 拉取+应用在心跳上报动作内), 服务端下发和脚本写回都可能显示为"上报", 不能仅凭日志归因断定来源, 必须叠加时间戳指纹
  - monitor_vars 的 edit_backup/config_backup 列是网页"备用槽草稿"(backup1/backup2 字段, 2831 行注释, 与下发隔离), 不是基线历史备份, 勿当基线变更证据
  - 长度比对陷阱: PHP strlen 按字节 (UTF-8 中文 3 字节), Python len 按字符, 384B(PHP)≈291 字符(Python)是同一内容, 跨语言比对长度先统一口径
  - 打破停发重发基线: 管理员 key 调 setvars 原样回传 config_var (monEnsureStamp 刷新"上次修改") → 设备 ack 不匹配自动重拉应用; 7F4A 实测 30s 内应用+镜像追平+下发确认闭环
  - 停发判定只看设备 applied 文件 ack, 设备本地数组被回滚服务端无感 (ack 不回传数组内容)——镜像≠基线且 applied==基线=闭环盲区; 已落地服务端自愈 (26-10-18, monDriftResend): report 上报 configVarDev 时比对镜像与基线语义 diff (monVarsDiff 过滤"上次修改"), 超过 MON_DRIFT_RESEND_SEC=1800s 未收敛则 monEnsureStamp 重打基线时间戳自动重发, monitor_vars.resend_ms 限频防拉锯 (人工 setvars 保存清零重新计时), 审计类型"漂移重发"(by=系统, 含 devStamp/baseStamp/diff)
  - 审计链判别下发来源 (26-10-18): 变量修改/配置变量修改(触发来源) → 下发内容(vars 实际下发, sent_ 锚点存 时间戳:SHA256 派生值去噪, 含全文快照) → 下发确认(设备应用) → 漂移重发(异常自愈); 出现"下发内容"而无近期触发来源审计 = 异常下发, 逐条可溯源
  - **数组基线缺"上次修改"=下发闭环永久死锁 (26-10-19 定位, 7F4A/92B4 最新不落盘)**: 设备端 arrApplyServerEdit 仅在 stampKey 非空时写 applied 锚点, 基线数组缺该条目 => ack 永远空 => 服务端永远重发, 编辑页最新值一直"在途"; 入口是 uploadCfg=1 上发覆盖直接把设备原始数组写进基线 (业务脚本重写数组会冲掉该条目); 修复 aa7537b: 覆盖写入时基线副本 monEnsureStamp + vars 下发前兜底补并回写 (审计'基线补时间戳'), 存量死锁一次自愈
  - **镜像兜底 (26-10-19, fb4e821)**: ack 不匹配但设备上报镜像与基线严格字面相等 => 判定已应用停发 (审计'下发确认' by=系统 + reason 标注); 治设备端 applied 锚点丢失/写不进 (7F4A) 或回滚后锚点仍命中原内容 "永远跳过、服务端永远重发" (92B4 类); 线上验证 config 通道两台均停发; edit 通道若仍有真实字段差异 (赠礼计数设备比基线小) 属正常在途, 需设备端日志确认应用情况
  - 设备端排查线: 编辑器日志 grep "变量同步:"/"已应用服务端下发变量"/"下发跳过 (已应用过)"/"下发应用写入失败"; 出现"下发跳过"而服务端仍重发 = 锚点1 命中但本地变量已被改写, 需设备端修复锚点1 的内容校验

[Project Knowledge Summary]
- Date: 2026-10-18
- Context: 本地集成冒烟测试 (漂移自愈+下发内容审计 27 项断言全过)
- Category: Environment Configuration | Testing Methods
- Instructions:
  - 本地测试服务器端口: 3010=设备管理系统 当前代码 (php -S 127.0.0.1:3010 router.php); 3000=byethost-deploy 旧目录; 另有 3011 为历史遗留进程, 连错端口会误判"密钥错误"
  - state 共享陷阱: 设备管理系统 与 byethost-deploy 的 dirname 都是 /workspace, 共用 /workspace/carddata/state——3000 上密钥连错 3 次会封禁 127.0.0.1, 3010 同被封; 测试前清 admin_fail.json/rate.json (写 '{}')
  - 回归测试: 设备管理系统/mon_smoke_test.php, 服务器起后直接 `php mon_smoke_test.php`, TOTP+HMAC 签名已内置
  - 测试设备 UUID 必须纯 hex+连字符: 服务端 preg_replace('/[^0-9A-Fa-f\-]/') 清洗, 含 T/S 等字母的 "TEST-xxx" 会被截断成查不到的 uuid
  - monEnsureStamp 时间戳秒级精度, 断言时间戳变化需 sleep(1) 隔开

[User Instruction Summary]
- Date: 2026-10-22
- Context: 用户要求删除客户状态标记的 10 小时自动过期重置
- Instructions:
  - 客户在状态页标记的 挂机/离线 状态必须持久保留, 由客户手动改回, 服务端不得自动过期清空 (66f873a 已删 monMarkStatus, report/list/binds 三处直读 status 列, status.html 提示文案同步改); status_ms 列仅作标记时间记录, 不再参与过期判定

[Project Knowledge Summary]
- Date: 2026-10-22
- Context: 镜像兜底语义分支上线 (4a941d7) 与线上验证
- Category: Troubleshooting & Debugging | Build Methods
- Instructions:
  - 镜像兜底已升级双分支 (monVarsMirrorEq): 1=字面相等 / 2=语义相等 (两侧均为数组 JSON 且去"上次修改"章后逐字段一致, monVarsDiff 顺序无关); 设备镜像 pretty JSON+缺章与紧凑基线字面永不相等, edit 通道必须有语义分支才能停发
  - 线上验证: 7F4A edit+config 双通道语义停发触发 (审计 reason"仅时间戳/格式差异"), 55s 后设备端 ack 回传闭环; 92B4 config 走字面分支; EAD4 edit 真实差异 (赠礼计数) 照常下发不受影响
  - 审计"下发确认"by=系统 时 edit/config 值仅表示该通道是否被镜像兜底停发, 值为 0 可能是正常 ack 闭环或本就无在途, 判读勿混淆
  - 测试注意: 同一设备连续两次停发的"下发确认"会被 ack 去噪吞掉 (curAck 不变), T10 审计断言前需先带陈旧 ack 请求一次制造 ack 变化
  - 客户状态标记 (挂机/离线) 永久保留由客户手动改回 (66f873a 已删 10 小时自动过期 monMarkStatus)

[Project Knowledge Summary]
- Date: 2026-10-22
- Context: 设备端锚点1语义校验修复 (f767abe) 与 main 合并
- Category: Workflow & Collaboration | Troubleshooting & Debugging
- Instructions:
  - main 已与 feature 分支同步 (523648b): 含设备管理系统全套修复 + lingmou/灵眸 逆向成果 + maa 资源; 后续在 feature 分支开发, 阶段性合并回 main
  - 设备端 arrApplyServerEdit 双锚点现已要求"章相同 且 arrSemanticEq(本地,下发)"才跳过, 本地被业务脚本改写/损坏时重新应用基线 (f767abe); 设备端生效需重新加载 monitor.js 插件
  - 设备端 JS 决策流测试: 设备管理系统/monitor_apply_test.js, `node monitor_apply_test.js` (mock auto/monRead/monWrite 内存环境, 从 monitor.js 源码切函数 eval, 8 场景 9 断言); 改 arrApplyServerEdit/arrSemanticEq 后必跑
  - JS 语义比较用 for-in (Rhino 兼容), 代码库既有风格也是 for-in

[Project Knowledge Summary]
- Date: 2026-10-22
- Context: 三台设备缩略图 22 小时不更新 — 定位为 byethost WAF 拦截 multipart
- Category: Troubleshooting & Debugging | Environment Configuration
- Instructions:
  - **根因**: byethost 的 openresty WAF 拦截 multipart 文件上传, http.upload 一律返回 403 (HTML, 非 PHP); JSON POST 放行。设备心跳/vars 走 postJson 全部正常, 只有缩略图坏 => 三台在同一分钟停更 = 服务端统一因素, 不是截图/前台/设备问题
  - 端到端取证方法: 拉线上 config.php 取 MONITOR_TOTP_SEED (全局单 seed, 所有设备共用), 用 Python 算 TOTP(30s/B32)+HMAC-SHA256 构造真实签名请求; multipart 403 vs base64 JSON 200 对比即定因
  - 修复 (c519bbc): 设备端 monThumbUpload 改 shell base64 + http.postJson(img 字段, 服务端原有兜底链路), threads 子线程发送, 版本 1.2.3; 服务端无需改动
  - 诊断信号对照: report JSON 200 + thumb multipart 403 = WAF; report 和 thumb 都 400/401 = 签名; 都 500 = PHP/存储
  - 线上 mon_thumbs 文件 mtime 与 list 的 thumb_mtime 一致可判断"最后成功落盘时刻"; screen_state.static_sec 只表示服务端最后比对时刻距今, 不等于最后上传时刻
  - 设备端 mock 测试: 设备管理系统/monitor_thumb_test.js (9 断言: threads/URL/img 去空白/签名齐备/无 files/结果变量/删临时文件/画面状态/base64 过短放弃)

[Project Knowledge Summary]
- Date: 2026-10-22
- Context: WAF 拦截规则边界实测 (决定性实验)
- Category: Environment Configuration | Troubleshooting & Debugging
- Instructions:
  - **WAF 判定依据是 Content-Type 头, 不是请求体**: Content-Type 以 multipart/ 开头 (大小写不敏感, 不论有无 boundary/有无 file 字段/体积/URL/UA/HTTP还是HTTPS) 一律被 openresty 403 拒绝, PHP 完全不执行 (403 响应头无 PHP 特征, 只有 Server: openresty + 最小头)
  - 反证: 请求体是 multipart 内容但 Content-Type 写 text/plain / application/json / x-www-form-urlencoded => 200 正常通过; 说明只查头
  - 无效绕过尝试: X-Requested-With / Origin+Referer 同域 / Accept: json / Expect: 100-continue / Transfer-Encoding: chunked / X-Forwarded-For / multipart/mixed / multipart/related / 换 UA (Googlebot/Android/curl/空) 全部仍 403
  - 因 PHP 仅在 Content-Type 为 multipart/form-data 时解析 $_FILES, "假头+真体" 方案对服务端无用, 只能改 JSON+base64 (c519bbc 已实施)
  - 线上 post_max_size >= 9MB (2100/4000/9000KB JSON 均能到 PHP 返 "图像数据无效"), 服务端自身限制是 handleMonitorThumb 的 strlen(img) <= 2000000
  - 服务端图像链路健壮性已验证: 合法 PNG 200 / 伪造 SOI-EOI 噪声 JPEG 200 (走原始字节直存) / 头对但内容坏 200, 判失败只靠 200 vs 400/500
  - 探测脚本用完必须清理线上 mon_thumbs/{uuid}.webp|jpg (服务端 UUID 清洗会去掉字母如 TST, 文件名形如 0-XXXXXXXX)
