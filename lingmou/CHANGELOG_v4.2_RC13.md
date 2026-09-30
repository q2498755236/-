# v4.2 RC13 - ECA 分层事件引擎

基线：v4.2 RC12（画布 Studio，已退役至 legacy/）

## RC13 增补七：详情按钮改为内嵌详情面板

- 问题：详情按钮通过 startActivity 拉起编辑器，真机上受 Android 10+ 后台启动限制（各 ROM 表现不一）仍然无效。
- 修复：详情改为悬浮球内嵌运行详情面板（与日志面板同款 UI，100% 可靠），不再拉起编辑器。
- 详情内容：引擎状态、轮次、最近执行（按时间倒序最多 5 条，含层级标记/事件名/结果/步数/时刻，区分"条件不满足"与"中断"）。
- 交互：详情面板顶栏 ← 返回控制面板、刷新按钮即时重取；与日志面板互斥；点圆点全关（与日志行为一致）。
- `_bringToFront` 方法保留未删除，供未来有需要时使用。

## RC13 增补六：运行链路 bug 修复

- interval 触发 + 条件不满足时 lastRun 未更新：长间隔事件（如 60s+图色条件）退化为每轮重查、每轮截屏。修复：条件不满足同样记 lastRun（conditionPassed=false），间隔从检查时刻起算。
- foreground 边沿键从挂载在配置对象上的 `_key` 改为稳定事件 id：消除运行时字段污染触发器配置。
- 引擎 start() 重置 foreground 边沿状态与包名异常计数：重启后首次观测不触发，避免停止期间的界面切换导致启动立即误触发。
- 已排除：saveConfig 走 sanitize（lastRun/_key 不会写盘）；编辑器与引擎共享 config 引用（改动热生效）。

## RC13 增补五：无条件事件直接执行

- 问题：新建事件默认触发器为 `foreground`（前台边沿），未指定包名时仅在切换应用那一轮触发——"无条件、只有动作"的事件平时不执行。
- 修复：`newEvent` 默认触发器改为 `interval 1s`——无条件事件按周期直接执行动作。
- 触发器可编辑：事件编辑页新增「修改触发器」按钮，支持四种类型——定时（每 N 秒）/ 切换应用时 / 指定应用前台 / 控件出现时。
- 触发语义说明：触发器决定事件何时被检查，条件决定检查通过后是否执行；条件为空 = 跳过条件判定直接执行动作。
- 旧配置兼容：已有事件的触发器保持原样（sanitize 不改写）。

## RC13 增补四：悬浮球控制台

- 新增 `eca/FloatyBall.js`：小圆点常驻悬浮窗（floaty），颜色区分引擎状态——灰=停止、绿=运行、黄=暂停。
- 点击圆点展开控制面板：**详情 / 日志 / 启动 / 暂停 / 停止**；圆点可拖动（位移 > 8px 判定拖动，抬起未拖动视为点击）。
- 详情按钮：把编辑器界面（事件/条件/动作添加编辑）拉到前台（FLAG_ACTIVITY_REORDER_TO_FRONT）。
- 日志按钮：切换内嵌滚动日志面板（200 行缓冲，与编辑器日志同源，含清空/返回）。
- 暂停按钮自适应：运行中显示"暂停"、暂停中显示"恢复"；非法操作 toast 提示。
- EcaEngine 新增 pause/resume 语义：`pause()` 停止执行事件轮（循环分片等待保持待命，stop 可随时打断）、`resume()` 恢复、`getStatus()` 返回 stopped/running/paused。
- studio.js 接线：悬浮球持有编辑器进程内同一 engine 实例；appendLog 双写悬浮球日志；编辑器状态文案支持暂停态；exit 时关闭悬浮窗。
- 真机验证项：floaty 触摸拖动/点击判定、详情按钮拉前台、悬浮窗权限、暂停/恢复实际行为。
- 真机反馈修复（一）：控制面板按钮由 AppCompat button 改为 text 伪按钮（bg 色 + gravity center，64×26dp、11sp），消除固定尺寸 inset 裁字问题，面板整体收窄；启/停/暂停按钮加状态色底。

## RC13.1 一致性修复（Consistency Fix）

- VERSION.json：删除虚设声明 `AutoXCompat`、`AutoX7Compat`（无对应实现，loader 亦不加载；其余 13 个声明模块均实际存在，此前外部扫描报告的"ECA 模块缺失"系声明名无 .js 后缀导致的误报）。
- main.js：`eval(files.read(loaderPath))` → `require("./loader.js")`（栈信息完整、可调试定位；真机验证项）。
- 版本注释统一：27 个 JS 文件的 RC12/RC9 残留注释与运行时文案统一为 RC13（含 Floaty 浮窗、Monitor 面板、loader 启动 Toast）。
- project.json：packageName `com.lingmou.v41` → `com.lingmou.v42`；versionCode 422 → 423。
- EcaConfig.js 头注释"5 层事件"→"4 层"（层级精简同步遗漏）。
- 冒烟回归重建：smoke_rc13.js 63 项全过（EcaConfig 迁移/条件树 13 项、checkTree 语义 12 项、引擎 5 项、ActionRunner 21 项、VariableStore 5 项、静态一致性 7 项含 XML 平衡审计）。

## RC13 增补三：层级精简 + 取值动作 + 变量修改 + 条件树

### 层级精简（5 层 → 4 层）

- 通用层精简为两个：**L1 通用** + **L5 通用低**，移除 L3 中部通用。
- 遍历序列简化：**L1→L2→L5→L4**。
- 旧配置兼容：sanitize 自动将 midEvents 事件并入 topEvents（原顺序保留）。

### 条件树（AND/OR/括号）

- 条件结构升级：平铺数组 → 树 `{logic: "and"|"or", items: [...]}`，items 内为叶子条件或嵌套组。
- 语义：AND 全过才成立、OR 任一过即成立（均短路）；**AND 优先于 OR**，括号由嵌套组表达。
- 旧配置平铺数组自动迁移为 AND 根组；嵌套最深 2 层括号，超深剔除。
- 事件编辑页：根逻辑一键切换（全部满足/满足任一）；组行支持 [切逻辑][+条件][+组][删除]；缩进可视化层级。

### 新增取值动作（3 种，touchedUI 全 false）

- **OCR 取值** `ocr_read`：区域 x,y,w,h 截屏裁剪 → paddle.ocrText（AutoX v7 Paddle API）→ 全文或 numberOnly 提取首个数字（如「体力：120/500」→ 120）→ 存入变量。
- **节点取值** `node_text`：按文本/描述包含匹配找控件（findOne 300ms 超时）→ 取节点文本存入变量。
- **保存坐标** `save_coord`：模板图片位置（找图包围盒）/ 颜色位置 / 节点位置 → `{x, y, w, h, cx, cy}`（cx/cy 为中心点）存入变量，供点击或 JS 动作引用。

### 新增变量修改动作（4 种，仅操作普通变量）

- **变量赋值** `var_set`：直接输入（数字串自动转 number，空文本保持 string）或复制其他变量。
- **变量自增/自减** `var_inc` / `var_dec`：当前值与步长均须为数字，否则动作失败带原因。
- **变量重置** `var_reset`：恢复配置初始值（VariableStore 快照 _initial）；未定义初始值的变量重置即删除。
- 配置变量运行时只读：对配置变量执行修改动作报错提示。

### 测试

- 引擎冒烟 70 项（4 槽位序列重校 + midEvents 迁移断言）。
- 条件/变量扩展冒烟 149 项（新增条件树语义 13 项：用户示例 (金币=1 and 血量=2) or 层数=3、AND 优先、嵌套两层、深度上限、引擎全链路；变量修改 14 项；OCR 9 项含全屏/0宽高/负坐标边界；节点/坐标 8 项）。
- core 回归 4 项 + XML 平衡审计 16 处，全部通过。

### 兼容性核查与修复

- paddle.ocrText 签名核对官方文档修正：(img, cpuThreadNum=4, useSlim=true)，原误传布尔作线程数。
- images.clip(img,x,y,w,h) 官方文档确认存在，OCR 区域裁剪后 clip 图在 finally 中回收。
- OCR 空区域支持全屏识别（与编辑器「可空=全屏」提示一致）；0/负宽高提前拒绝。
- 消除 getChildAt+id 取视图的脆弱用法（AutoX 原生 View 无 id 属性访问保证）：EventEditScreen/ScreenEditScreen 改为持有 inflate 返回的包装引用。
- 事件条件防御性归一化：极旧平铺数组在编辑页渲染前迁移为 AND 根组。

## RC13 增补二：空文本与数字 0 区分

- 变量默认值不填（空文本 ""）与 0（number）严格区分：类型保持、往返保持、判断语义正确（空文本仅支持等于）。
- VariableScreen 默认值输入：显示「(空文本)」占位；留空确认时弹确认框（空文本 or 取消）。

## RC13 增补一：条件类型扩展（4 种）+ 变量体系

### 新增条件类型（事件条件链）

- **图色条件** `image_color`：找图（模板图片路径 + 相似度阈值 0~1 + 可选区域）或找色（#RRGGBB + 色差阈值 0~255 + 可选区域）。截图权限懒申请（首次图色判定时 requestScreenCapture，被拒缓存不再弹窗）；截屏每事件缓存一次，事件执行动作后立即失效重截；模板图按路径缓存，脚本退出统一 recycle。
- **变量条件** `variable`：判断普通变量。变量值为数字：等于/不等于/大于/小于/包含/不包含/被包含（包含族按字符串语义）；变量值为文字：仅等于。
- **JS 条件** `js`：`new Function("rule", "vars", code)` 隔离执行，必须 return 纯布尔值（非布尔/异常均不成立）。
- **配置变量条件** `config_variable`：语义同变量条件，读配置变量（运行时只读）。

### 变量体系（新增「变量」页）

- 配置新增 `variables: {runtime: {}, config: {}}`：
  - 普通变量：初始值入 config.json，运行时 JS 动作可 `vars.set` 改写（内存态，重启回初始值）。
  - 配置变量：仅能在变量页编辑，运行时 JS 只读（`vars.getConfig`）。
- JS 动作/JS 条件统一注入 `vars` 沙箱：`get/set/getConfig/list`。
- 工具栏新增「变量」按钮；VariableScreen 双分区管理（增删改，纯数字串自动存为 number）。
- 引擎与变量存储解耦：VariableStore.sync 保留活跃运行值，仅补新增/清删除。

### 新增模块

- eca/VariableStore.js：变量存储 + JS 沙箱。
- eca/ImageService.js：截图权限/截屏缓存/找图找色（依赖注入，node 可测）。
- eca/VariableScreen.js：变量管理页。

### 测试

- 新增条件扩展冒烟 82 项（变量全运算符语义、文字值仅等于、JS 布尔强校验、图色命中/未命中/区域/阈值/权限拒绝缓存、模板缓存、截屏失效、引擎端到端变量链路、配置往返）。
- 原有 RC13 引擎 68 项 + core 回归 4 项不受影响，全部通过。

## 模型重构

画布拖拽模型 → **ECA 分层事件模型**：

- 4 层优先级配置：L1 通用 / L2 自定义界面（标识条件）/ L4 默认界面 / L5 通用低。
- 固定遍历序列：**L1→L2→L5→L4**（L4 仅本轮前序槽位全部无执行时进入）。
- 双运行模式：
  - **顺序模式**（流水线）：全序列走完，每槽位执行所有触发事件。
  - **单事件模式**（抢断）：任一事件执行且含界面操作（touchedUI）即中止本轮跳回 L1；纯计算（wait/log/标记 noUI 的 JS 动作）不抢断。
- 触发器：进入界面（包名边沿）、控件出现（文本电平）、定时（间隔）。
- 事件 = 触发器 + 条件链（AND 短路）+ 动作序列（tap/长按/滑动/输入/按键/等待/日志/JS 动作）。
- JS 动作：`new Function("rule", code)` 隔离执行，注入 rule 上下文；可标记纯计算。

## 新增 eca/ 模块

### eca/studio.js
- `"ui";` 入口：工具栏（模式切换/引擎启停/状态）+ 屏幕容器 + 底部日志面板（RC12 真机验证方案：scroll+text、200 行缓冲、暂停/清空）。

### eca/EcaConfig.js
- 单文件 eca/config.json（原子写：tmp→move 失败降级直写；损坏备份 .bad 回退默认）。
- sanitize 未知字段清洗 + validate；71 项 node 冒烟覆盖往返深等。

### eca/EcaEngine.js
- 单线程固定序列遍历引擎；runOnce 可测试入口返回槽位轨迹。
- foreground 边沿：指定包=匹配上升沿；未指定包=任意包名变化（首次观测不触发）。
- currentPackage 异常捕获 + 连续 10 次失败提示无障碍服务。

### eca/ActionRunner.js
- 动作序列执行：参数转换（seconds→ms 等）、touchedUI 聚合、异常即停、stopRequested 每步轮询。

### eca/ConditionChecker.js
- text_exists/widget_exists/wait；AND 短路；wait 分片响应停止。

### eca/MainScreen.js
- 5 层分区列表；L2 界面分组（折叠/排序/启停）；事件条目（触发摘要/上移下移/删除/启停/点击编辑）。

### eca/EventEditScreen.js / eca/ScreenEditScreen.js
- 事件三段式编辑（触发器/条件/动作 + JS 动作含纯计算标记）；界面编辑（名称/标识条件/启停/删除）。
- 表单：dialogs.rawInput（禁 input 防表达式求值）+ 顺序字段询问 + 数字校验。

## 框架集成

- main.js 拉起路径 studio/studio.js → eca/studio.js。
- core/NodeRuntime.js 新增 executeAction(type, params, ctx) 单动作导出入口。

## 画布退役（→ legacy/，打包排除）

- 迁移 12 文件：CanvasView/GraphCanvasState/FlowEditorState/FlowGraphManager/StudioController/NodeRegistry/NodeLibrary/PropertyPanel/FlowIO/FlowExecutor/studio.js/StudioApp。
- 无残留引用；RC12 画布冒烟测试随之退役，由 RC13 回归套件（/tmp/opencode/smoke_core13.js + smoke_eca.js，70 项）替代。

## AutoX v7 兼容性核查（实施前完成）

- currentPackage()/textContains().exists()/descContains().exists()/files.move 官方文档确认可用。
- Switch 控件用大写 `<Switch>` + on("check")；JS 动作多行输入用 inputType="textMultiLine"。
- currentPackage 无障碍未开时抛异常（非返回 null）——引擎已 try/catch 防御。

## 版本
- VERSION.json → 4.2.0-rc13 / RC13-ECA-Engine
- project.json versionCode → 422
