# 灵眸编辑器复刻层 (editor/)

对齐自动化编辑器 (cn.autoeditor.mobileeditor v4.3.6) 的任务格式与运行时语义, 让灵眸直接运行编辑器导出的 .auto 任务。

## 模块

| 文件 | 职责 |
|------|------|
| EditorVars.js | 变量表 (var_list 按 id 引用, name 为显示名; S 前缀强制字符串) |
| AutoBridge.js | auto 对象 + 全局函数桥 (getValue/setValue/click/sleep(秒)/swipe/keyEvent...) |
| JsPluginHost.js | JS 插件宿主 (eval 工厂, setup/loop, 参数上下文优先 getValue, 结果从变量读回) |
| AutoTask.js | .auto 解包装载 (ZIP: script.json + image/ + 插件目录; image_list/gesture_group_list 映射) |
| EditorRuntime.js | 解释器 (通用事件 -> 场景轮询 -> 默认场景 -> 通用低; 条件组评估 + 动作分发) |
| EditorServer.js | HTTP 控制口 127.0.0.1:11243 (/console 免白名单, /run code 分支直接跑, /stop//sync 白名单) |
| EditorTray.js | 悬浮窗托盘 (编辑器形态: 后台仅悬浮窗, 灰=停止 绿=运行) |
| EditorScreen.js | 任务页面 (.auto 列表/导入/运行/控制口开关, 组装全链路) |

## 执行语义 (对齐逆向结果)

- 入口: studio.js 顶部"编辑器"按钮 -> EditorScreen; 托盘常驻可启停
- 任务目录: `/sdcard/灵眸/auto/*.auto` (导入后解包到 `auto/extracted/<名>/`)
- 单轮顺序: common_event (无条件动作, disabled 跳过) -> scene_list (scene_event 找图触发 -> scene_event.action_list + event_list 条件动作) -> default_scene -> common_event_low
- 动作: 1点击坐标变量 2找图点击 3变量运算 4找图赋值 11按键 12自定义代码 14随机数 16启动应用 22手势 29插件调用; 每动作前执行 postpone 秒延迟
- 条件: 1找图 2变量比较 3变量存在 5嵌套组 7找色计数
- 插件: 文件名即 uuid (权威, JSON 内 mUUID 可能不一致); 参数经 auto.getValue 注入, 结果经 auto.setValue 写回
- js_code: 仅注入代码中出现的变量名作 var 前导 (读生效); 写必须 auto.setValue

## 真机验证清单

1. EditorScreen 导入 最新.auto (2.2MB script.json, 23 场景 4046 变量 3 插件 863 图)
2. 控制口开启后 `curl http://127.0.0.1:11243/console` 返回 `{"code":0,"port":11243}`
3. /run code 分支: base64 脚本直接执行
4. 托盘运行/停止、运行中图标变绿
5. T12 js_code 含 padStart (ES2017) 在 Rhino 的兼容性
6. 找图/找色经灵眸 ImageService (sim 阈值传参) 实际命中率

## CALIBRATE (语义推断, 待真机对照)

- T3 变量运算 action 数字枚举: 1加 2减 3乘 4除 5取余
- T11 按键数字枚举: 1返回 2主页 3最近任务
- 条件 type=2 变量比较 state 枚举: 0等 1不等 2包含 3不包含 4大于 5小于
- 条件 type=7 找色计数: 命中写 count_id 变量 1/0
- T4 找图赋值坐标格式 "x,y"
- loop_interval 单位按毫秒 (30 -> 30ms 轮询)
- default_scene 兜底时机 (现按条件命中执行)

## 测试

`node /tmp/opencode/test_editor.js` — 66 项 (含真实 最新.auto 装载、真实插件 12+34=46 全链路、控制口路由)
