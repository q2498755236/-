# v4.2 RC12 - Studio UI 真实现

基线：v4.2 RC11.6

## 核心原则
本轮全部为真实代码实现，无新增占位模块。核心层通过 25 项自动化冒烟测试
（/tmp 冒烟脚本：图操作、连线规则、条件分支执行、序列化往返、撤销/重做、端口命中）。

## 新增：Studio 可视化编辑器（AutoX.js v7 UI 模式）

### studio/studio.js
- `"ui";` 模式入口，ui.layout 完整布局：顶部工具栏 / 左侧节点库 / 中部画布 / 右侧属性面板 / 底部 `<console>` 日志。

### studio/StudioApp.js
- 装配控制器、画布、节点库、属性面板、文件 IO；新建/打开/保存/运行/停止/撤销/重做/删除/缩放全部接线。

### studio/CanvasView.js
- canvas 控件 on("draw") 真实绘制：网格、连线+箭头、节点（类型配色/名称/类型小字）、端口圆点、选中描边、运行高亮。
- touch_down/touch_move/touch_up 真实交互：点选节点、拖动节点、空白平移、从出口端口拖出连线（兼容 MotionEvent 与 {x,y} 两种回调形态）。

### studio/NodeLibrary.js
- 基于 NodeRegistry 动态生成节点库按钮，点击即在画布添加节点。

### studio/PropertyPanel.js
- 选中节点渲染名称+参数表单（数字校验），应用后回写图数据。

### studio/FlowIO.js
- 流程 JSON 持久化到 flows/ 目录（列表/保存/读取）。

## 重写：核心层（此前均为占位）

### core/NodeRegistry.js（新）
- 9 种节点类型定义：start/tap/long_click/swipe/text/key/wait/log/condition（condition 含 yes/no 双出口）。

### core/FlowGraphManager.js（重写）
- 节点/连线完整 CRUD、连线规则（同端口唯一出线、禁自环、端口合法性）、findEntry、validate（悬空连线/未知类型/多 start）、serialize/deserialize（带清洗）、快照/恢复。

### core/GraphCanvasState.js（重写）
- zoom(0.4~2.5)/offset、世界坐标⇄屏幕坐标互转、节点矩形与端口坐标计算。

### core/FlowEditorState.js（重写）
- 选中、运行状态、runningNodeId、undo/redo 快照栈（上限 50）。

### core/NodeRuntime.js（重写）
- 节点→AutoX.js v7 全局 API 真实映射：click/press/swipe/setText/back/home/recents/sleep/text().exists()；wait 支持分片停止；异常捕获返回结构化结果。

### core/FlowExecutor.js（重写）
- 图校验→入口定位→沿连线游走执行；condition 走 yes/no 分支；步数上限 500 防死循环；stopRequested 外部停止；节点进入/日志回调。

### core/StudioController.js（重写）
- 组合图/视图/编辑状态/执行器：添加节点自动接选中节点空闲出口、删除、移动、连线、参数、undo/redo、run/stop。

## 修复

### main.js / loader.js
- 删除残留的顶层 `;ui;`（eval 环境下 ReferenceError: ui is not defined 的直接来源）。
- main.js 在框架启动成功后按 ui.studioEnabled 配置自动拉起 studio/studio.js（engines.execScriptFile，缺文件时记日志）。

### core/ConfigManager.js
- 默认配置新增 ui.studioEnabled: true，并注册 "ui.studioEnabled" 校验项。

### core/NodeRuntime.js
- 修复 condition 处理器局部变量遮蔽 AutoX 全局 text() 选择器导致的 TypeError。

### core/FlowEditorState.js + StudioController
- 修复 redo 失效：pushUndo 会清空 redo 栈，redo 流程改用 pushUndoKeepRedo 保留待重做快照。

## 真机回归修复（AutoX.js v7 实测反馈）

### studio/studio.js
- 底部日志面板 `<console>` → 原生 `<scroll>+<text>`：AutoX v7 的 UI inflate 无 "console" 控件类，原写法抛 InflateException: ClassNotFoundException: android.widget.console。
- 手机窄屏适配：左栏 84→64dp、右栏 170→128dp、两排按钮全部去 88dp 默认最小宽（minWidth=0 + padding 压缩）+ 画布上排 scroll 兜底；节点库按钮 12→10sp。

### studio/StudioApp.js
- 日志通道改为 appendLog 缓冲（200 行、自动滚底），替代 console.setConsole 绑定。
- dialogs.input → dialogs.rawInput：input 会把输入文本当 JS 表达式 eval，输入纯文本抛 ReferenceError 并终止 UI 脚本；对话框回调包 ui.run + try/catch 加固。

### studio/CanvasView.js
- pointOf 兼容历史点数组形态（AutoX canvas touch 回调实际传 [{x,y},...]），修复触摸交互全失效；首次触摸打参数形态探针日志。
- 端口可见性：入口 4→6dp、出口 5→7dp 加白描边环，触摸半径 14→22。
- draw 异常日志带 3 层堆栈，便于真机定位。

### core/Logger.js
- ensureDir 误用 files.createWithDirs(目录) 会把 logs 建成文件导致 app.log 写入报 ENOENTDIR；改为 createWithDirs(logs/.keep) 建目录，异常状态自动降级写根目录 app.log。

### core/FlowGraphManager.js
- addNode 强制 start 类型唯一（重复添加返回 null），UI 层 toast 提示；新增 findNodesByType。

### 全局
- 28 处 RC11.6 残留文案统一为 RC12（Floaty 浮窗/Monitor/loader 等）。

## 版本
- VERSION.json → 4.2.0-rc12 / RC12-Studio-UI
- project.json versionCode → 421
