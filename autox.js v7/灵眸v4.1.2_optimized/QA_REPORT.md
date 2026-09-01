# 灵眸 v4.1.2 静态回归报告

## 本轮验证通过

- `project.json`、`config.example.json` JSON 解析通过。
- 除 E4X UI 文件外，全部 JavaScript 通过 `node --check` 语法检查。
- `ui/Floaty.js`、`ui/Monitor.js` 将 E4X XML 布局替换为占位表达式后，其余 JavaScript 结构检查通过。
- loader 对应 23 个注册模块全部存在。
- 静态检查到的 `API.require("模块").方法()` 直接调用均能在目标模块找到对应方法。
- 未发现运行代码调用 `threads.shutDownAll()`。
- 未发现 `var threads = []` 覆盖 AutoX 全局线程模块。
- 未发现旧 `paddle.createOCR()` 接口。
- 未发现 `while (_lock)` 布尔自旋锁。
- Replay 不再截图录制 Image，而是持久化纯 `action + delay` JSON。
- Monitor 不再使用电池值冒充 CPU。
- `main.js` 是唯一入口；`loader.js` 不再自启动。

## v4.1.2 追加回归点

- OCR 在 Paddle 缺失时默认降级，不再使整个框架启动失败；`ocrRequired=true` 可启用严格模式。
- Scheduler WatchDog 重启过程中不会把未完成任务错误标记为空闲，避免同任务重入。
- EventManager `once` 删除路径受锁保护。
- Replay 禁止同时录制和播放，避免回放动作重新进入录制队列。
- Floaty 工作线程创建失败会关闭已经创建的窗口并返回失败。
- ConfigManager 从磁盘读取配置后也执行 schema 归一化。
- main 读取配置后才决定是否申请悬浮窗权限。

## 仍需真机验证

静态回归不能替代目标 Android / AutoX V7 真机测试。建议重点验证：

1. E4X `floaty.window()` 布局在你的 V7 构建上的解析；
2. 截图授权弹窗与横竖屏切换；
3. Paddle OCR 模块是否安装、模型加载和 `paddle.release()` 行为；
4. Android 版本是否允许读取 `/proc/stat`；若不允许 CPU 会显示 `--`，不会伪造数据；
5. `project.json` 打包和升级安装行为；
6. 长时间运行下 ThreadManager 活跃数、ImageManager 缓存和 Java heap 曲线；
7. 被中断的第三方/业务函数是否正确响应 `Thread.interrupt()`。
