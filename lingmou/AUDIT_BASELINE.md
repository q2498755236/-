# 灵眸 v4 — AutoX V7 全项目静态审计

审计范围：解压后的 26 个文件，约 3206 行 JavaScript。
定位：该项目是 **AutoX V7 应用中的 Rhino/第一代引擎脚本**，不是 V7 第二代 Node.js API 项目。所有文件均为 `.js`，并使用 `threads`、`floaty`、XML/E4X、全局 `click()`/`captureScreen()` 等 Rhino API。

> 本报告为静态审计 + AutoX V7 文档接口核对，未在实际 Android/AutoX V7 设备上执行。

## P0 — 必须先修

### 1. ConfigManager 首次启动死锁
- 文件：`core/ConfigManager.js:81-120`
- `load()` 获取 `_lock` 后，在配置不存在时调用 `this.save()`；`save()` 再次获取同一个非可重入布尔锁。
- 结果：首次生成 `config.json` 时永久等待。
- 修法：在 `load()` 中仅设置默认值，退出锁后再保存；或改用 `threads.lock()` 的 `ReentrantLock`。

### 2. ConditionEngine 并行检查必崩
- 文件：`engine/ConditionEngine.js:112-138`
- 局部变量 `var threads = [];` 覆盖了 AutoX 全局 `threads` 模块，随后执行 `threads.start(...)`。
- 此处 `threads` 实际是数组，没有 `start()`。
- 修法：数组改名为 `workers`，并使用全局 `threads.start()`；完成计数使用 `threads.atomic()`。

### 3. ActionEngine 点击失败后的重试函数不存在
- 文件：`engine/ActionEngine.js:56-79`
- `click()` 异常时调用 `this._retry(...)`，但整个文件没有 `_retry` 方法。
- 结果：原本应该返回失败，反而会抛 `TypeError`。

### 4. PluginSystem 实际没有执行传入插件代码
- 文件：`plugin/PluginSystem.js:24-30`
- `wrapped` 字符串把 `" + code + "` 当成了字符串内容，而不是拼接变量。
- 插件工厂得到的是空函数体，用户插件代码没有真正注入。

### 5. OCREngine 与 AutoX V7 Rhino Paddle API 不兼容
- 文件：`vision/OCREngine.js:20-60`
- 当前使用 `paddle.createOCR()`、实例 `.detect()`、实例 `.release()`。
- AutoX V7 Rhino 文档接口是 `paddle.ocr(img)` / `paddle.ocrText(img)` / `paddle.release()`。
- 结果：OCR 初始化大概率直接异常并保持 `isReady() === false`。

### 6. 默认启动链没有初始化大部分核心模块
- 文件：`loader.js:153-200`
- `loader.start()` 仅初始化：Logger、MemoryManager、ScreenshotManager、GCManager、PerfStats、WatchDog、Scheduler、Floaty。
- 未初始化：ConfigManager、ThreadManager、ActionEngine、ConditionEngine、EventManager、FindEngine、OCREngine、FrameManager、ImageManager、TemplateManager、PluginSystem、Monitor、Replay、CacheManager、Compatibility。
- 结果：界面可能提示“框架启动成功”，但核心功能未就绪。

### 7. ThreadManager 单任务超时可能杀死整个脚本所有子线程
- 文件：`core/ThreadManager.js:55-70`
- 单个任务 interrupt 5 秒后仍未结束，就调用 `threads.shutDownAll()`。
- AutoX 文档定义该函数会停止所有通过 `threads.start()` 创建的子线程。
- 会连带杀死 Scheduler、GC、Perf、Monitor、Replay 等线程。

## P1 — 高优先级

### 8. “线程安全锁”并不线程安全
- 多文件：ConfigManager、ThreadManager、CacheManager、ActionEngine、ConditionEngine、EventManager、ScreenshotManager、ImageManager、TemplateManager、GCManager、PerfStats、Monitor、Replay。
- 全部采用 `while (_lock) sleep(); _lock = true`。
- 检查与赋值不是原子操作，两个线程可同时进入临界区。
- AutoX 本身提供 `threads.lock()` / `threads.atomic()`，应直接使用。

### 9. ScreenshotManager 的自动回收破坏调用方对象生命周期
- 文件：`vision/ScreenshotManager.js:20-46`
- 每次截图加入 `_activeBitmaps`，超过 10 张就回收最旧对象。
- 调用者持有的 Image/Bitmap 可能在其不知情时被回收。
- `captureAndConvert("bitmap")` 尤其危险：返回底层 Bitmap，但后续截图可能把对应 Image 回收。
- AutoX V7 文档还明确指出 `captureScreen()` 返回的截图不需要手工回收。

### 10. FrameManager 30 帧缓存与 ScreenshotManager 10 张上限直接冲突
- `vision/FrameManager.js:19-44`
- FrameManager 声称保留 30 帧；但第 11 次截图后 ScreenshotManager 已开始回收最早帧。
- 因此帧数组中会保留已失效的 Image 引用。

### 11. ImageManager / TemplateManager 对同一个 Image 双重拥有、双重回收
- `TemplateManager.load()` 从 `ImageManager.load()` 得到同一个对象，然后两个模块各自缓存。
- 任一缓存淘汰/clear 都会直接 `.recycle()`，另一个缓存仍持有该对象。
- 后续可能返回已回收 Image。

### 12. ImageManager TTL 过期会泄漏旧图片
- 文件：`vision/ImageManager.js:37-69`
- 发现缓存过期后直接读取新图片并覆盖 `_cache[cacheKey]`。
- 覆盖前没有 recycle 老对象，旧 Image 引用丢失。

### 13. ImageManager/GCManager 的“对象池”实际上只是引用堆积
- `vision/ImageManager.js:76-101`
- `gc/GCManager.js:107-130`
- `recycle()`/`recycleImage()` 把对象 push 到 pool，但没有任何 acquire/reuse API。
- `recycleOldImages()` 只移除已经 recycled 的对象，不主动 recycle 活对象。
- 实际效果是延长 Image 生命周期，而不是复用。

### 14. ActionEngine 坐标存在二次缩放
- 文件：`engine/ActionEngine.js`
- `clickResult()` 接收图像识别得到的实际屏幕坐标后又调用 `click()`，`click()` 会按 1080×1920 再缩放一次。
- `scrollDown()/scrollUp()` 先按 `device.width/height` 计算实际坐标，再交给 `swipe()` 二次缩放。
- 非 1080×1920 设备上偏移明显。

### 15. ActionEngine 与 FindEngine 的结果结构不匹配
- `FindEngine.findImage()` 返回 AutoX `Point`（`x/y`）。
- `ActionEngine.clickResult()` 要求 `result.point`。
- 直接把找图结果交给 clickResult 会返回 false。

### 16. ActionEngine 数字按键代码实现错误
- `engine/ActionEngine.js:146-162`
- 参数名叫 `keyCode`，默认分支执行 `keyCode(keyCode)`，实际上是在尝试调用数字变量。
- AutoX 文档对应全局 API 为 `KeyCode(code)`（大写 K/C）。

### 17. Replay 的录制与播放数据模型完全不一致
- `ui/Replay.js:46-107`
- 录制只产生 `{type:"screenshot", data: Image}`。
- 播放只处理 `{type:"action", action: ...}`。
- 所以本模块自己录制的数据无法回放操作。

### 18. Replay 把原生 Image 放进 JSON 导出
- `ui/Replay.js:131-140`
- `_records` 中存的是截图 Image 对象，却整体 `JSON.stringify()`。
- 原生 Image 不是可持久化的动作数据结构，导出结果不可作为可靠 replay 文件。
- `getRecords()` 同样执行 JSON stringify/deep-copy，会有同类风险。

### 19. WatchDog 实际没有监控 Scheduler 心跳
- `watchdog/WatchDog.js:32-75`
- `_lastTick` 在 WatchDog 自己每次 `_check()` 后更新。
- Scheduler 从未调用 `WatchDog.tick()`。
- 因而它测的是“看门狗定时器自己是否延迟”，不是 Scheduler 是否卡死。

### 20. Scheduler 可为同一任务无限并发创建线程
- `engine/Scheduler.js:63-77`
- 异步任务到期就 `_threadMgr.start()`，没有 `running` 标志/重入保护。
- 若任务执行时间超过 interval，会不断产生同名并发任务。
- ThreadManager 的 `_maxThreads=16` 对 `start()` 没有限制；固定线程池只用于 `submit()`，而 Scheduler 根本不用 `submit()`。

### 21. EventManager.remove() 没有从树结构移除节点
- `engine/EventManager.js:65-73`
- 只从 `_events` 删除；`parent.children` 仍保留 node。
- `traverse()` 遍历的是 `tree.children`，所以已 remove 的事件仍可能继续执行。

### 22. EventManager timeout 只是写字段，没有真正超时
- `engine/EventManager.js:113-140`
- 写入 `node.timeoutAt`，之后完全没有读取/检查。
- `timeout` 统计也不会因此增加。

## P2 — 中优先级 / 架构完整性

### 23. requestScreenCapture 被重复申请
- `main.js`、`Compatibility.requestPermissions()`、`ScreenshotManager.init()` 都会请求截图权限。
- AutoX V7 文档说明 requestScreenCapture 仅需执行一次。

### 24. loader 与 main 的入口职责冲突
- `loader.js` 文件末尾自动 `init()` + `start()`。
- `main.js` 又假定 `global.LingMou` 已存在，但自己没有加载 loader。
- 若 main 是入口，会直接抛 `Must run through loader.js`；若 loader 是入口，则 main 基本没有作用。

### 25. 缺少 project.json
- 当前压缩包根目录没有 `project.json`。
- 若目标是 AutoX 的“项目/打包工程”，这不是完整项目结构；只能作为脚本目录使用，或需要补项目配置并明确 main。

### 26. `config.example.js` 实际是 JSON，不是合法 JavaScript
- 文件内容是裸 `{ "debug": false, ... }`。
- 作为 `.js` 解析会 SyntaxError。
- 应命名为 `config.example.json`。

### 27. 示例配置与 ConfigManager DEFAULTS 不一致
- `config.example.js` 有 `action/condition/gc/monitor`。
- ConfigManager 默认值没有这些节。
- Action/Condition/GC/Monitor 也没有统一从 ConfigManager 加载配置。
- 因此很多 config.json 配置即使写了也不会生效。

### 28. Logger 配置未接入
- Config 默认 `logLevel: "info"`，Logger 内部默认却是 WARN (`_level=2`)。
- loader 没调用 `logger.setLevel(config.get("logLevel"))`。
- loader WatchDog 回调还有一次 `logger.warn()` 参数数量错误。

### 29. Monitor CPU 指标实际取的是电池电量
- `ui/Monitor.js:96-106`
- `data.cpu = device.getBattery()`。
- CPU 告警等于“电量 > 80%”告警。
- FPS 配置存在，但完全没有采集 `data.fps`。

### 30. 大量声明的功能开关没有实现
- ActionEngine：maxRetry/retryDelay/parallel/gesture anti-detect 等。
- ConditionEngine：lazy/priority。
- EventManager：tree/priority/depth timeout 等部分功能。
- GCManager：critical GC、object pool、leak detect（且启用 leak detect 后会调用不存在的 `checkLeaks()`）。
- PerfStats：auto export/reportFormat。
- Monitor：FPS/network/temperature/process。
- Replay：compress/exportFormat/enableLoop 等。
- TemplateManager：autoLoad。

### 31. start() 失败没有回滚已经启动的模块
- loader.start() 依次启动 GC、Perf、WatchDog、Scheduler 等。
- 后续任一步骤异常时 catch 只返回 false，不 stop 已启动线程/定时器。

### 32. stop() 生命周期覆盖不完整
- Replay 只 `stopPlay()`，没有 `stopRecord()`。
- ImageManager 的自动回收 interval 没有 stop API。
- FrameManager/Condition/Event/Cache/Plugin 等没有统一 cleanup。
- `events.removeAllListeners()` 又过于全局，可能移除与 LingMou 无关的监听。

## 建议修复顺序

1. 重做入口与生命周期：`main.js` 唯一入口，loader 只负责注册/装载，不自动 start。
2. 修 ConfigManager 锁与真正初始化 ConfigManager。
3. 改 ThreadManager：`threads.lock()`；删除单任务 `threads.shutDownAll()`；统一线程归属；Scheduler 使用受控池/运行标志。
4. 修 ConditionEngine `threads` 变量覆盖与并行超时语义。
5. 修 ActionEngine `_retry`、Point 接口、坐标体系、`KeyCode()`。
6. 按 AutoX V7 Rhino API 重写 OCR。
7. 重构 Screenshot/Image/Template/Frame 的资源所有权：明确谁创建、谁释放；截图不要做隐藏式自动回收。
8. 重做 Replay：记录动作事件，不记录 20 FPS Image 对象；持久化纯 JSON action+delay。
9. 修 WatchDog，把 Scheduler 心跳明确传给 WatchDog。
10. 最后清理未实现 config/统计字段，并补 project.json / config.example.json。

## 当前结论

- **作为概念框架：结构清楚，模块边界已经形成。**
- **作为可稳定运行的 AutoX V7 Rhino 项目：目前不合格。**
- 默认启动可能出现“灵眸v4已启动”，但这不能证明视觉、动作、OCR、条件、事件、插件、回放等核心能力可用。
- 建议先完成 P0 + P1 后再做真机集成测试。
