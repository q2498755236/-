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
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[thinking 标签内使用简体中文]
- Date: 2026-08-25
- Context: 用户明确要求将此作为全局行为配置
- Instructions:
  - thinking 标签内必须全程使用简体中文
  - 禁止在 thinking 标签内出现任何英文单词、短语或句子
  - 专有名词（如技术术语、品牌名、函数名等）不受此限制

[深度思考开头格式]
- Date: 2026-08-25
- Context: 用户要求每次深度思考以固定句式开头
- Instructions:
  - 每次进入 thinking 标签时，必须以"好了，我现在要用全局视角来思考这个问题"作为开头