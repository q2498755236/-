# 自动化编辑器JS插件编写说明（整合版）

## 一、通用基础结构（工具必认）

### 1. 顶层函数定义

必须包含 `setup()` 和 `loop(action)` 两个函数，工具会自动识别，且避免使用 class/module/window 等语法，确保100%兼容：

- **setup()**：初始化函数，工具首次加载时仅执行1次，用于重置全局变量、初始化状态；
- **loop(action)**：核心执行函数，每次触发功能时调用，通过 action 参数区分不同功能。

### 2. 全局变量声明与初始化

- **用途**：跨 case 传递数据（如存储临时坐标、中间计算结果）；
- **声明位置**：在 setup() 和 loop(action) 之外的顶层（确保全插件可访问）；
- **初始化要求**：必须在 setup() 中重置，避免残留上一次执行的旧值。

**示例：**
```js
// 顶层声明全局变量
let chuandi = false;
let globalRateResult = 0;

function setup() {
    // 初始化全局变量，清空旧值
    chuandi = false;
    globalRateResult = 0;
    console.log('插件初始化完成（仅执行1次）');
}
```

### 3. switch-action 逻辑

通过 action 参数区分不同功能，每个 case 对应一个独立功能，逻辑模块化。

### 4. 全局异常捕获

用 try-catch 包裹 switch 逻辑，避免单个功能报错导致整个插件崩溃。

```js
function loop(action) {
    try {
        switch (action) {
            // 各case功能逻辑...
        }
    } catch (err) {
        console.error(`插件执行异常：${err.message}`);
        return false;
    }
}
```

---

## 二、数据处理规范（auto.getValue/auto.setValue）

### 1. 强制规则：仅支持字符串类型

auto.getValue 读取的参数、auto.setValue 存储的结果，本质都是字符串，非字符串类型必须手动转换：

**auto.getValue 读取后需按需求转成目标类型：**
```js
// 错误示例
const num = auto.getValue('数量');  // num是字符串"0"，非数字0

// 正确示例
const num = parseInt(auto.getValue('数量')) || 0;
```

**auto.setValue 存储前需将非字符串类型转成字符串：**
```js
// 错误示例
auto.setValue('结果', {x:100,y:200});  // 存储结果为"[object Object]"

// 正确示例
auto.setValue('结果', JSON.stringify({x:100,y:200}));
```

### 2. JSON对象处理：必须手动转译+try-catch

**输出JSON对象（auto.setValue 侧）：**
```js
case "动作类-存储多坐标": {
    const coordData = {
        main: "533,2103,80,87",
        sub: "533,2103,87,97",
        offset: "0,0,0,0-0,0"
    };
    const coordStr = JSON.stringify(coordData);
    auto.setValue("多坐标数据", coordStr);
    break;
}
```

**输入JSON对象（auto.getValue 侧）：**
```js
case "条件类-校验多坐标": {
    const coordStr = auto.getValue("多坐标数据") || "{}";
    let coordData = {};
    try {
        coordData = JSON.parse(coordStr);
    } catch (err) {
        console.error("JSON解析失败：", err.message);
        coordData = {};
    }
    const hasMainCoord = !!coordData.main;
    return hasMainCoord;
}
```

### 3. 数值转换：避坑+兜底处理

```js
// 整数场景
const maxCount = Math.floor(parseFloat(auto.getValue('最大数量'))) || 0;

// 保留小数场景
const rate = parseFloat(auto.getValue('通过率')) || 0;

// 非负整数场景
const times = Math.max(parseInt(auto.getValue('执行次数')) || 0, 0);
```

**错误写法需避免：**
```js
// 错误1：输入"0"时被当成空值
const wrong1 = parseInt(auto.getValue('数量')) || 10;

// 错误2：输入空字符串/"abc"时返回NaN
const wrong2 = parseInt(auto.getValue('数量'));
```

---

## 三、条件类与动作类 case 核心区别

### 1. 条件类 case

- **核心用途**：判断"是否满足条件"；
- **结果必须是纯布尔值**（true/false）；
- **必须 return 结果**；
- **不写 auto.setValue**，仅输出判断结果。

```js
case "条件类-判断数字是否大于10": {
    const inputNum = parseInt(auto.getValue('输入数字') || "0", 10);
    const isGreaterThan10 = inputNum > 10;
    console.log(isGreaterThan10);
    return isGreaterThan10;
}
```

### 2. 动作类 case

- **核心用途**：执行具体操作；
- **结果可为任意类型**；
- **必须写 auto.setValue** 存储结果；
- **用 break 结束**，无需 return。

```js
case "动作类-数字加5": {
    const inputNum = parseInt(auto.getValue('输入数字') || "0", 10);
    const result = inputNum + 5;
    auto.setValue("加5后的结果", result);
    console.log(`数字加5完成：${result}`);
    break;
}
```

---

## 四、日志打印规范

### 必须打印的内容
- 初始化信息：setup() 中打印"插件初始化完成"；
- 参数获取结果：打印实际值；
- 核心逻辑进度：关键步骤执行状态；
- 结果/异常：条件类打印布尔结果，动作类打印操作结果。

### 打印原则
- 精简不冗余，避免重复打印完整JSON；
- 易读性优先，用"键值对"格式；
- 异常时仅保留 err.message。

---

## 五、偏移处理通用逻辑

### 偏移参数格式
统一格式：`参考区x,参考区y,参考区w,参考区h-目标点x,目标点y`

例：`0,0,0,0-0,0` 表示无偏移

### 核心处理步骤
1. **解析参数**：拆分"参考区"和"目标点"数据；
2. **修正宽高**：若参考区w/h≤0，替换为默认宽高；
3. **计算偏移**：通过参考区与目标点的差值，计算最终偏移坐标。

```js
case "条件类-计算偏移后坐标": {
    const originCoord = auto.getValue('原始坐标') || "100,100,80,87";
    const offsetParam = auto.getValue('偏移参数') || "0,0,0,0-0,0";
    const defaultW = 80, defaultH = 87;

    const [origX, origY] = originCoord.split(',').map(Number);
    let finalCoord = false;

    try {
        const [refPart, targetPart] = offsetParam.split('-');
        const [refX, refY, refW, refH] = refPart.split(',').map(Number);
        const [targetX, targetY] = targetPart.split(',').map(Number);

        const finalW = refW <= 0 ? defaultW : refW;
        const finalH = refH <= 0 ? defaultH : refH;

        const dx = refX - targetX;
        const dy = refY - targetY;
        finalCoord = `${origX + dx},${origY + dy},${finalW},${finalH}`;
        globalOffsetCoord = finalCoord;
    } catch (err) {
        console.error('偏移解析失败：', err.message);
    }

    console.log('是否计算出有效偏移坐标：', !!finalCoord);
    return !!finalCoord;
}
```

---

## 六、核心示例（整合场景）

### 极简模板
```js
let tempResult = 0;

function setup() {
    tempResult = 0;
    console.log('插件初始化完成（仅执行1次）');
}

function loop(action) {
    try {
        switch (action) {
            case "条件类-判断结果是否≥80": {
                const input = parseFloat(auto.getValue('输入数值') || "0");
                const isOk = input >= 80;
                console.log(isOk);
                return isOk;
            }
            case "动作类-计算数值乘2": {
                const input = parseFloat(auto.getValue('输入数值') || "0");
                tempResult = input * 2;
                auto.setValue("乘2结果", tempResult);
                console.log(`数值乘2完成：${tempResult}`);
                break;
            }
            default:
                console.error(`未知功能：${action}`);
                return false;
        }
    } catch (err) {
        console.error(`插件执行异常：${err.message}`);
        return false;
    }
}
```

### JSON+数值转换完整场景（通过率计算）
```js
let globalRateResult = 0;

function setup() {
    globalRateResult = 0;
    console.log('插件初始化完成（仅执行1次）');
}

function loop(action) {
    try {
        switch (action) {
            case "条件类-计算通过率": {
                const inputStr = auto.getValue('通过率配置') || '{"total":100,"pass":80}';
                let config = {};
                try {
                    config = JSON.parse(inputStr);
                } catch (err) {
                    config = { total: 0, pass: 0 };
                }
                const total = Math.max(parseInt(config.total) || 0, 0);
                const pass = Math.max(parseInt(config.pass) || 0, 0);
                const rate = total === 0 ? 0.0 : (pass / total * 100).toFixed(2);
                globalRateResult = parseFloat(rate);
                const isPass = globalRateResult >= 80;
                console.log("通过率是否达标：", isPass);
                return isPass;
            }
            case "动作类-存储结果": {
                auto.setValue("最终通过率(%)", globalRateResult.toString());
                const resultJSON = {
                    rate: globalRateResult,
                    status: globalRateResult >= 80 ? "达标" : "不达标",
                    updateTime: new Date().toLocaleString()
                };
                auto.setValue("通过率详细结果", JSON.stringify(resultJSON));
                break;
            }
            default:
                console.error(`未知功能：${action}`);
                return false;
        }
    } catch (err) {
        console.error(`插件执行异常：${err.message}`);
        return false;
    }
}
```

---

## 七、核心避坑清单

1. 用 auto.getValue 前先明确"转什么类型"，避免直接用原始字符串计算；
2. 用 auto.setValue 前先判断"是否非字符串"，必须转译后再存储；
3. 数值转换必加 `||0` 兜底，JSON转换必加 try-catch；
4. 全局变量必须在 setup() 中初始化，防止旧值残留；
5. 条件类必 return 布尔值，动作类必 auto.setValue；
6. 日志打印聚焦关键信息，不冗余，优先"键值对"格式。

---

## 八、模板使用说明

1. **新增功能**：在 switch 中新增 case，区分"条件类"和"动作类"；
2. **参数获取**：统一用 auto.getValue('工具参数名')，并按类型转译；
3. **偏移逻辑复用**：修改 defaultW 和 defaultH 为实际宽高；
4. **工具适配**：直接复制代码到自动化编辑器，无需额外修改。
