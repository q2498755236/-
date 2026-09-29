# 看门狗 WatchDog (AutoX.js v7)

独立运行于 AutoX.js v7 的设备看门狗, 与设备管理系统服务端 (ByetHost, 与自动化编辑器插件 monitor.js 同一服务端) 对接。与编辑器插件共享 `/sdcard/.mon_monitor/` 设备身份文件, 服务端状态页 (status.html) 同一台设备只显示一个身份卡片。

## 功能

- **双通道客户端存活判定** (checkMode 可单用可共用):
  - `local` 本地进程检测: `shell ps -A` 查看护目标包名, 看不到进程时用无障碍窗口列表兜底 (悬浮窗形态应用如点击器: 拉起后本体在后台仅悬浮窗显示, 窗口存在即判活, 防止 hidepid 下无限误拉), 判死即拉起 (`app.launchPackage`)
  - `server` 服务端心跳判定: 轮询 `GET /api/monitor/list?key=MONITOR_KEY` 取本机 `last_seen`, 超过阈值 (默认 180s) 判定客户端失联即拉起编辑器。编辑器进程在但插件死掉的情况只有这条通道能发现
  - `both` 双用: 任一通道判死即恢复 (默认)
- **看护时间段**: 启用后只在时段内执行拉起/重启判定 (支持跨天如 22:00-06:00), 时段外仅心跳上报。UI 可设置
- **AutoX 内脚本看护** (可选, 默认不用): `engines.all()` 检测 AutoX 引擎内脚本, 消失即重启。业务脚本若已打包为独立 APK, 请填到看护目标 App 列表 (与编辑器 APK 同样按包名看护)
- **无障碍看护**: 服务未开启时记录错误上报 (Android 限制无法静默自启, 仅告警)
- **心跳上报**: TOTP + HMAC-SHA256 签名 (Googlebot UA), 上报电量/内存/屏幕/前台应用 + 看门狗状态摘要 (note/editorVer 字段)。HTTP 层为 AutoX.js v7 API (`http.postJson(url, data, { headers })`, 响应经 `body.string()` 取文本)——与自动化编辑器 monitor.js 的 http API (addHeader + 纯字符串 body) 是两套接口, 不可混用
- **变量下发**: 网页端"修改变量"内容落盘 `/sdcard/.mon_monitor/edit_vars.json`, 供编辑器侧读取
- **画面冻结检测** (freezeWatch, 默认开): 每 freezeSampleSec (20s) 采样一次目标包前台窗口的无障碍控件树快照 (className/text/desc/bounds 拼接后 FNV-1a 哈希), 连续 freezeThresholdTimes (3) 次无变化判定冻结 -> force-stop + 拉起恢复。豁免条件: 在 overlayPkgs 悬浮窗应用列表 / 目标包不在前台 / 息屏 / 刚拉起宽限期 freezeGraceSec (60s) / 快照取不到 (游戏 SurfaceView 等, 连续 5 次仅告警)。`freezePixelFallback=true` 时快照取不到会改用截屏像素指纹 (中心 4x4 采样点灰度, 需 MediaProjection 授权, selfRevive 拉起后授权失效该通道自动停用)
- **悬浮窗形态应用支持** (overlayPkgs, UI 可设): 点击器等"拉起后本体在后台仅悬浮窗显示"的应用, 在此列表的包名跳过本地进程判定与冻结检测, 由服务端心跳判定兜底——避免 hidepid 下 ps 看不到进程 + 窗口兜底不可用时无限误拉。旧配置字段 freezeExcludePkg 自动迁移
- **自保活**: 主循环/哨兵双线程心跳文件互监控, 主循环僵死连续 2 次触发 selfRevive (新引擎拉起自身, 旧脚本从脚本线程正常 `exit()`)
- **重启风暴保护**: 连续拉起失败进入指数退避 (10s 起步, 上限 10 分钟), 错误计入服务端共享 error_count

## 部署

1. AutoX.js v7 导入 `watchdog/` 目录 (路径无空格), 打开 `main.js`
2. 填写看护目标 App (UI 文本框, 每行一个: `包名` 或 `包名|名称`, 也兼容 JSON 数组) 与服务端 list 密钥 (`monitorKey`, 即服务端 config.php 的 `MONITOR_KEY`; 留空则停用心跳判定通道)
3. 点"保存配置"再点"启动看护"
4. 配置文件在 `/sdcard/.watchdog/config.json`, 也可直接编辑 (运行中每轮自动热加载)

## 注意

- **日志**: 所有报错输出到 AutoX 控制台 (UI 点"日志"按钮打开, 错误为红色 `console.error`) 并落盘 `/sdcard/.watchdog/log.txt` (带时间戳, 超 200KB 自动截断保留末尾 50KB)——控制台关闭后仍可查看文件
- **logcat 桥接**: Java 层线程崩溃 (如 `Attempt to invoke virtual method...`) 脚本 try-catch 拦不住、也进不了 AutoX 日志——看门狗每 30 秒 dump 本 App 的 logcat 错误缓冲, 把 `FATAL/Exception/Unable to/Attempt to invoke` 等崩溃栈以 `[logcat]` 前缀桥接进 log.txt (增量去重)
- AutoX ui 模式下 `setInterval` 回调运行在 UI 线程, 同步 http 请求会报错 `Synchronous http request is not allowed in UI thread`——本项目的看护/上报/冻结检测循环全部运行在 `threads.start` 工作线程 (分段 sleep 保证停止后 500ms 内退出), UI 线程零网络调用
- 服务端 `/api/monitor/list` 有 key 防爆破: key 错误连续 3 次会触发看门狗侧暂停轮询 10 分钟 (防 IP 封禁), 请确保 key 与服务端一致
- 心跳判定阈值应不小于服务端 MONITOR_ONLINE_MS (150s), 建议 180s 起
- 本地进程检测依赖 `ps -A` 输出包含目标包名, 部分 ROM (hidepid) 看不到其他应用进程时该通道自动降级为"未知", 由心跳通道兜底
- 挂机/离线状态是业务脚本侧语义, 看门狗不消费该状态; 看护启停只由本地看护时间段控制
- 真机未验证项: `ps -A` 输出格式、floaty/console 在各 ROM 的表现、selfRevive 二次拉起时序
- 冻结检测真机验证点: `auto.windowRoots()` 各 ROM 窗口列表与 `packageName()` 过滤、`am force-stop` 无 root 时是否生效 (失败时退化为仅拉起, 恢复力度打折)、游戏类 SurfaceView 应用控件树为空会被豁免只告警
- **shell 权限**: ps/force-stop 默认走普通 shell。AutoX 的 `shell(cmd, true)` (root 模式) 在无 root 设备上内部 `Process` 为 null 时会抛 Java 线程 NPE (`void java.lang.Process.destroy() on a null object reference`), JS try-catch 拦不住, 表现为随机弹错——所以 root shell 仅在配置 `useRootShell: true` 且设备有稳定 root 时启用 (config.json 手动改)
