# 灵眸 LingMou v4.2 RC13 会话上下文总结

（截至 2026-09-09，供后续会话接续使用）

## Goal
- 灵眸 LingMou v4.2 RC13（AutoX.js v7）迭代：RC13.1 一致性 + 悬浮球控制台 + 无条件事件直接执行 + 三轮真机反馈修复均完成；第三轮运行链路深度排查已完成（5 个真 bug 修复，冒烟 126 项通过，包 md5=8337d037）

## Constraints & Preferences
- 目标环境 AutoX.js v7 开源版；真实代码 → node 冒烟 → 真机验证 → 升版本
- AutoX v7 真机教训（见同目录 MEMORY.md）：`ui.inflate` 字符串 XML 闭合根标签；根元素禁带布局属性；dialogs.rawInput 禁用 input；`<Switch>` 大写；按钮 minWidth="0dp"；脚本目录无空格
- AutoX v7 API 已核实：`paddle.ocrText(img[, cpuThreadNum=4, useSlim=true])` 需 try/catch；images.clip(img,x,y,w,h)；requestScreenCapture()/captureScreen()；images.findImage threshold 0~1 相似度（默认 0.9）、findColor threshold 0~255 色差（默认 4）
- 变量语义：默认空文本 ""≠数字 0；纯数字串存 number；数字值→7 运算符全量、文字值→仅 eq；JS 条件必须 return 纯布尔
- 条件树：AND 优先于 OR；嵌套最深 2 层
- 层级：L1→L2→L5→L4；L2 需命中界面标识；L4 仅 executedAny=false 进入
- 代码风格 ES5 var + prototype；studio.js XML literal 需抽掉后 node 校验；node 测需 stub global.files/engines/java
- 悬浮球：text 伪按钮（bg 色 + gravity center，64×26dp、11sp）；状态色灰=停止/绿=运行/黄=暂停
- Feature Implementer skill（.monkeycode/specs 工作流）不适用——目录不存在，用户选择继续"真机反馈→修复"流程

## Progress
### Done
- **增补五：无条件事件直接执行**——newEvent 默认 trigger 改 interval 1s；EventEditScreen 加「修改触发器」按钮 + _editTrigger（定时 N 秒/切换应用/指定应用前台/控件出现 4 类型）；冒烟 98 项过
- **增补六：运行链路 bug 修复**——① interval 条件不满足也写 lastRun（conditionPassed:false，防长间隔事件退化每轮截屏）；② foreground 边沿键改用稳定事件 id（_triggerPass(trigger, lastRun, eventId)，不再污染 trigger 配置对象）；③ start() 重置 _lastPkgMap/_nullPkgCount；冒烟 107 项过
- **增补七：详情按钮改内嵌详情面板**——放弃 startActivity（Android 10+ 后台启动限制），改悬浮球内嵌运行详情面板（状态/轮次/最近执行时间倒序最多 5 条，与日志面板互斥，点圆点全关）；冒烟 117 项过
- **增补八：运行链路深度排查修复（5 个真 bug）**——
  1. 严重：waitSeconds 真睡后又忙等同时长（wait 10s 实际等 20s）→ 睡眠与忙等互斥
  2. 高：selectorExists 用 global[fnName] 取 AutoX 选择器不可靠 → 改直接标识符 + typeof（text_exists/widget_exists 可能永远不成立，取决于 ROM）
  3. 中：NodeRuntime.key 无障碍未就绪抛 ReferenceError → 逐键 typeof 检查，返回"无障碍服务不可用"
  4. 低：wait 动作 600s 上限静默截断 → 统一 3600s 并显式报错
  5. 中：OCR region 越界抛 OpenCV 异常 → 起点超屏直接报错、部分越界自动收缩到屏幕内
  - 已排查无问题：ActionRunner（复制变量/数字语义/坐标对象）、VariableStore（sync 引用替换）、tap/long_click/swipe/text 的 AutoX API 用法
- 包演进 md5：256b3cae→679c4dc5→114abae3→**8337d037**（当前，71 文件 122358 字节）；冒烟 **126 项全过**（新增 K1-K9 回归组）
- **GitHub 备份**：zip + MEMORY.md + 本文件已上传至仓库 `q2498755236/-` 的 `灵眸/` 文件夹（Contents API，token 已在会话中暴露需提醒用户轮换）

### In Progress
- (none)

### Blocked
- (none)

## Key Decisions
- **详情=悬浮球内嵌面板，彻底放弃 startActivity**：Android 10+ 后台启动限制不可控；内嵌面板复用日志面板模式必成
- 无条件事件语义：触发器决定何时检查、条件为空=直接执行；默认 interval 1s；旧配置触发器不动
- lastRun 统一口径：动作完成与条件不满足均写（conditionPassed 区分），interval 从检查时刻起算
- foreground 边沿键用 ev.id（稳定 ID），不挂运行时字段到 trigger 配置
- 点圆点=全关（含详情面板），与 B3 日志行为一致
- var_set src="copy" 时 params.value 存来源变量名；save_coord 存 {x,y,w,h,cx,cy}；saveConfig 经 sanitize 保证盘面干净
- selectorExists 风格与引擎默认实现一致（直接标识符 + typeof），双端兼容（node global 属性即全局变量、Rhino typeof 未定义标识符安全）

## Next Steps
1. 真机复测（用户执行）：
   - 详情面板打开/刷新/返回
   - 无条件事件 1 秒执行
   - 60s+ 间隔且条件不满足的事件不刷屏、不每轮截屏
   - 引擎重启首轮无触发日志
   - 含「等待 3 秒」条件的事件用秒表对比：触发到动作执行应约 3 秒（修复前约 6 秒）
   - 文本存在条件此前一直"不成立"的，现在应正常命中
   - OCR 在不同分辨率设备上不再报"OCR 异常"
2. 复测通过后升版本（RC13.1 → 正式或继续迭代）

## Critical Context
- `_triggerPass(trigger, lastRun, eventId)`（EcaEngine.js:288）：foreground 未指定包=切换下降沿（首测不触发）、指定包=上升沿；边沿状态 `_lastPkgMap[eventId||"fg_anon"]`；getCurrentPackage() null 计 `_nullPkgCount`（10 次告警）；interval 需 seconds>0 且 now-lastRun.time≥seconds*1000；lastRun 字段 `{time, ok, conditionPassed, actionsDone, message}`
- `_execEvent`：trigger→条件→动作；条件不满足也写 lastRun；`var self = this` 在 runActions 前；动作后 imageService.invalidate()
- start() 重置：`_lastPkgMap={}`、`_nullPkgCount=0`；stopRequested 即时 getStatus()=stopped
- newEvent：`{id, name, enabled:true, trigger:{type:"interval",params:{seconds:1}}, conditions:{logic:"and",items:[]}, actions:[], lastRun:null}`
- FloatyBall 详情面板：detailPanel XML（btnDetailBack/btnDetailRefresh/detailText/detailScroll）；_showDetail(show) 与 _showLog 互斥；_buildDetail() 遍历 cfg.topEvents/screens[].events/lowEvents 收 lastRun 非空项按 time 降序取 5；refresh() 三面板互斥可见性（`panelShown && !logShown && !detailShown`）
- ConditionChecker.waitSeconds（增补八修复后）：睡眠 if/else 忙等互斥、上限 3600s、200ms 分片、stopRequested 中断返回 {pass:false}
- ConditionChecker.selectorExists：textContains/descContains 直接标识符 + typeof function 检查，无值或无函数返回 false
- NodeRuntime.key：back/home/recents 逐键 typeof 检查，未就绪返回"无障碍服务不可用（按键 X 不存在）"；wait 上限 3600000ms 显式报错；sleepStoppable 上限 3600000
- ImageService.ocrRegion：region 起点 >= 屏宽/屏高直接报"OCR 区域超出屏幕范围"；部分越界 rw/rh 按剩余空间收缩；`_denied` 永久标记保留（防弹窗轰炸）
- 冒烟 /tmp/opencode/smoke_rc13.js **126 项**：A EcaConfig/B checkTree/C 引擎/D ActionRunner/E VariableStore/F 静态/G pause/H 悬浮球（H16-H24 详情）+I1-I9（默认触发器/端到端）+J1-J9（lastRun/边沿键/start 重置；60s 间隔需 now≥60000）+K1-K9（key 提示/wait 上限/selectorExists/waitSeconds 互斥/ocrRegion 收缩与越界）
- NodeRuntime 真机 API 映射：tap→click(x,y)、long_click→press(x,y,d)、swipe→swipe(x1,y1,x2,y2,d)、text→setText(value)、key→back/home/recents 全局函数
- ImageService：findTemplate threshold 0~1、findColorHere threshold 0~255；截屏每事件缓存+动作后 invalidate
- EcaEngine DI：logger/getCurrentPackage/isTextExists/isDescExists/now/imageService/variableStore/findNode；threads/sleep 为 AutoX 全局
- 真机验证累积清单（未复测项）：OCR 取值（paddle 4 线程）、条件组 UI 按钮、getChildAt 修复保存路径、悬浮球拖动/点击判定、暂停/恢复、停止即时变灰、日志双写、详情面板、无条件事件执行、60s 间隔不刷屏、重启边沿重置、wait 实时序、text_exists 命中、跨分辨率 OCR
- VERSION.json/project.json：4.2.0-rc13 / 423 / com.lingmou.v42
- 打包脚本 /tmp/opencode/pack_rc13.py：git ls-files --cached --others --exclude-standard，排除 legacy/、.monkeycode/、*.zip；71 文件
- GitHub 上传脚本 /tmp/opencode/upload_q.py：Contents API，token 走 GH_TOKEN 环境变量，目标 q2498755236/- 灵眸/ 文件夹

## Relevant Files
- `/workspace/eca/EcaEngine.js`：引擎（_triggerPass:288 eventId 签名、_execEvent lastRun 双写、start 重置边沿）
- `/workspace/eca/FloatyBall.js`：悬浮球（detailPanel 内嵌详情、_buildDetail/_flushDetail、三面板互斥）
- `/workspace/eca/studio.js`：编辑器入口（_initFloatyBall、appendLog 双写、saveConfig→EcaConfig.save）
- `/workspace/eca/EcaConfig.js`：newEvent 默认 interval 1s、sanitize 条件树/触发器（save 先 sanitize）
- `/workspace/eca/EventEditScreen.js`：_editTrigger 触发器编辑 4 类型
- `/workspace/core/NodeRuntime.js`：真机动作 API 映射（增补八：key typeof 检查、wait 3600s）
- `/workspace/eca/ImageService.js`：图色服务（增补八：ocrRegion 越界收缩/报错）
- `/workspace/eca/ConditionChecker.js`：条件检查器（增补八：waitSeconds 互斥、selectorExists 标识符）
- `/workspace/eca/ActionRunner.js`：runActions（本轮已审无问题）
- `/workspace/eca/VariableStore.js`：变量存储（本轮已审健康）
- `/tmp/opencode/smoke_rc13.js`：126 项冒烟
- `/tmp/opencode/pack_rc13.py`：打包脚本
- `/tmp/opencode/upload_q.py`：GitHub 上传脚本
- `/workspace/LingMou_v4.2_RC13_ECA_AutoX7.zip`：交付包（md5=8337d037fff0821236ca29f9120272c8）
- `/workspace/CHANGELOG_v4.2_RC13.md`：RC13.1+增补四~八章节
- `/workspace/.monkeycode/MEMORY.md`：AutoX 教训+构建/测试方法
- `/workspace/VERSION.json` / `/workspace/project.json`：4.2.0-rc13 / 423 / com.lingmou.v42
