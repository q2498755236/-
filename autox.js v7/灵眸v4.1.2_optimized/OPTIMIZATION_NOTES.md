# v4.1.2 审计项处理对照

## 已处理 P0
1. ConfigManager 首次启动死锁：已改为 `threads.lock()`，保存移到锁外。
2. ConditionEngine `var threads=[]` 覆盖：已改 workers + 真实锁。
3. ActionEngine `_retry` 不存在：已重写统一 retry。
4. PluginSystem 未执行 code：已修正 Function 注入。
5. OCREngine Paddle API：已改为 `paddle.ocr/ocrText/release`。
6. 启动链漏 init：loader.start() 明确初始化全部核心模块。
7. 单任务超时 `threads.shutDownAll()`：已删除，只 interrupt owned thread。

## 已处理 P1
- 布尔自旋锁：替换为 `threads.lock()`。
- ScreenshotManager 隐藏回收：删除图片池。
- FrameManager 与截图池冲突：只保存帧元数据。
- Image/Template 双重 ownership：ImageManager 唯一持有缓存 Image。
- Image TTL 覆盖泄漏：过期/淘汰前 recycle。
- 伪对象池：删除。
- Action 坐标二次缩放：默认屏幕坐标；结果点击强制 raw。
- FindEngine Point 与 ActionEngine：clickResult 支持直接 Point。
- KeyCode：数字分支使用 `KeyCode()`。
- Replay：改纯动作 JSON。
- WatchDog：Scheduler 主动 tick。
- Scheduler：running 防同任务重入。
- EventManager.remove：同步从父 children 删除。
- Event timeout：执行前实际检查 timeoutAt。

## 已处理 P2
- requestScreenCapture：集中到 main.js。
- main/loader 冲突：main 唯一入口，loader 不自启。
- project.json：已补。
- config.example.js：改为 config.example.json。
- 配置默认值：统一。
- Logger：接入 logLevel，并允许单参数日志调用。
- Monitor CPU：读取 /proc/stat；FPS 默认关闭，可注入 provider。
- 启动失败：回滚。
- stop 生命周期：覆盖各模块，不再 `events.removeAllListeners()`。

## 仍需真机验证
- AutoX V7 具体构建对 `new Function`、E4X、Paddle 模块的表现。
- Android 新版本是否允许读取 `/proc/stat`。
- `project.json` 打包字段在你的 AutoX V7 版本上是否需要额外 launchConfig。

## v4.1.2 追加收口
- OCR 改为默认可选能力；Paddle 缺失时降级，不再拖垮整个框架；`ocrRequired=true` 可恢复严格模式。
- OCR 支持 `cpuThreadNum/useSlim/modelPath` 对应 V7 Rhino Paddle 接口。
- Scheduler 重启不再把仍运行的任务错误标成 idle，避免 WatchDog 恢复后同任务重复执行。
- EventManager once 节点删除路径加锁。
- Replay 禁止录制与播放同时进行，避免回放动作被再次录制形成反馈。
- Floaty 工作线程创建失败时回滚已创建窗口。
- main.js 先读取配置，只在 UI 需要时申请悬浮窗权限。
- ConfigManager 对从磁盘加载的配置也执行 schema 归一化，避免非法值绕过 set() 校验。
