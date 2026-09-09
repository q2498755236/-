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

## Entries

[AutoX v7 真机踩坑教训（ui.inflate / dialogs / XML）]
- Date: 2026-09-07
- Context: RC12-RC13 真机验证发现的 AutoX.js v7 兼容性问题
- Category: Troubleshooting & Debugging
- Instructions:
  - `ui.inflate` 字符串 XML 必须闭合根标签
  - inflate 根元素禁带布局属性（w="*" 等在无父容器时写 null LayoutParams 抛 NPE）——根 inflate 必须传父容器（build(parent) 模式，studio.js 传 ui.screenContainer）
  - dialogs.rawInput 禁用 input 参数；`<Switch>` 必须大写；按钮 minWidth="0dp"
  - 脚本目录路径不能含空格
  - UI 视图引用原则：ui.inflate 返回值直接持有引用使用，避免 getChildAt 返回原生 View 的 id 访问不确定性

[AutoX v7 paddle.ocrText 参数签名]
- Date: 2026-09-07
- Context: RC13 兼容性排查发现 ocrText 参数传错（boolean 误传为线程数位）
- Category: Troubleshooting & Debugging
- Instructions:
  - 正确签名：`paddle.ocrText(img[, cpuThreadNum=4, useSlim=true])`——第二参是数字线程数、第三参 boolean slim
  - paddle 全局 API 可能不可用，调用需 try/catch 防御（ReferenceError 兜底）
  - images.clip(img, x, y, w, h) → {Image} 为 Auto.js 4.1+ 标准 API，AutoX v7 可用但标注真机验证项

[构建与测试方法（node 冒烟）]
- Date: 2026-09-07
- Context: RC13 冒烟测试重建时确认的测试环境要点
- Category: Build Methods
- Instructions:
  - node 测 EcaConfig 需先 stub：global.engines（myEngine().getSource()）、global.java.io.File（getParent/getName）、global.files（join/exists/read/write/move/copy/isDir/createWithDirs）
  - eca/studio.js 用 AutoX "ui"; 模式内嵌 XML 字面量，node --check 前需把 ui.layout(...) XML 块抽掉（替换为 ui.layout('');）
  - eca/EventEditScreen 等页面的 XML 为拼接式（动态插值切断标签流），XML 平衡审计需退化为开闭计数对比，栈序审计仅适用于完整字面量
  - ActionRunner 的 toNum/literalValue/coordBox 是内部函数未导出，测试需通过 runVarAction/runReadAction 行为断言
  - 打包脚本：/tmp/opencode/pack_rc13.py（git ls-files --cached --others --exclude-standard，排除 legacy/、.monkeycode/、*.zip 自身；71 文件约 116K）
  - 冒烟测试：/tmp/opencode/smoke_rc13.js（63 项，含静态一致性检查）

[VERSION.json 声明一致性]
- Date: 2026-09-07
- Context: RC13.1 一致性修复，外部扫描报告误报"ECA 模块缺失"
- Category: Workflow & Collaboration
- Instructions:
  - VERSION.json modules 声明必须与实际文件一一对应（本次删除了虚设的 AutoXCompat/AutoX7Compat）
  - eca/ 模块声明名无 .js 后缀（仅 eca/studio.js 带），按声明名精确匹配文件名的扫描工具会误报缺失
