# 灵眸 v4.1.2 Optimized

面向 AutoX V7 Rhino/第一代引擎的静态优化版。

## 启动

项目入口为 `main.js`。不要直接运行 `loader.js`。

`main.js` 统一负责：
- 无障碍服务检查；
- 一次性申请截图权限；
- 一次性申请悬浮窗权限；
- 加载 `loader.js`；
- 启动框架。

## v4.1.2 关键变化

- ConfigManager 使用 `threads.lock()`，修复首次配置死锁。
- ThreadManager 只 interrupt 自己创建的线程，不再用 `threads.shutDownAll()`。
- Scheduler 增加 running 防重入；真正向 WatchDog 发送心跳。
- ActionEngine 修复重试、Point 兼容、坐标二次缩放、数字 KeyCode。
- ConditionEngine 修复 `threads` 变量覆盖。
- OCR 改为 AutoX V7 Rhino 的 `paddle.ocr()` / `paddle.ocrText()` / `paddle.release()`。
- ScreenshotManager 不再隐藏回收调用方图片。
- ImageManager 是文件图片缓存的唯一 owner；TemplateManager 不再 recycle 同一对象。
- Replay 改为 `action + delay` 纯 JSON。
- Monitor CPU 从 `/proc/stat` 计算，不再把电量当 CPU。
- 插件代码真实注入执行，并限制默认插件目录；不再宣称存在真正 sandbox。
- 启动失败会回滚已启动模块。
- 新增 `project.json`，示例配置改为 `config.example.json`。

## 兼容性说明

这是静态重构版本，未在你的具体 Android 设备与 AutoX V7 构建上做真机回归。
特别需要真机验证：
- E4X 浮窗布局；
- Paddle OCR 可用性与模型加载；
- `/proc/stat` 在目标 Android 版本上的读取权限；
- `project.json` 的打包字段是否与你使用的 AutoX V7 构建完全一致。
