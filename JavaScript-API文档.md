# 自动化编辑器-JavaScript文档

## 关于

此文档介绍的是自动化编辑器自带的一些JavaScript方法，更多JavaScript方法介绍请参考[菜鸟教程](https://www.runoob.com/js/js-intro.html)。

自动化编辑器添加JavaScript方法：添加动作-->变量-->执行JS代码

JS可以直接使用自动化编辑器中符合变量名规范的变量，自动化编辑器中创建的名称不符合规范的变量是不能在JS中使用的，如纯数字名称的变量、或者数字开头的变量等等。自动化编辑器中的变量默认是字符串和数字(纯数字内容)，如果一个变量内容为数字，但是需要以字符串在js中处理，变量名称需要用S开头，代表这个变量只能是字符串。

### 变量名规范
- 变量必须以字母开头
- 变量也能以 $ 和 _ 符号开头（不过我们不推荐这么做）
- 变量名称对大小写敏感（y 和 Y 是不同的变量）

## OpenCV

自动化编辑器现已支持大部分opencv方法，目前支持的方法列表如下，可以通过auto.getImageInfo和auto.captureScreenMat获取编辑器的截图和屏幕截图：

imread, imwrite, imshow, absdiff, findContours, drawContours, matFromArray, split, merge, rectangle, cvtColor, matchTemplate, minMaxLoc, inRange, resize, warpAffine, getAffineTransform, warpPerspective, threshold, adaptiveThreshold, filter2D, boxFilter, blur, GaussianBlur, medianBlur, contourArea, boundingRect, bilateralFilter, Canny, approxPolyDP, mean, fitEllipse, convexHull, convexityDefects, flip, rotate, erode, dilate, morphologyEx, pyrUp, pyrDown, Scharr, Sobel, bitwise_and, bitwise_not, bitwise_or, bitwise_xor, copyMakeBorder, countNonZero, arcLength, minAreaRect, minEnclosingCircle, minEnclosingTriangle, line, circle, hconcat, addWeighted, convertScaleAbs, Laplacian, getStructuringElement

## 全局函数

### click
点击一个位置(区域)

**示例：** `click("100，100，400，500")`

| 参数 | 类型 | 描述 |
|------|------|------|
| region | String | 点击区域,格式 x,y[,w,h] w和h可以省略 |
| time(可选) | Number | 点击时长，单位毫秒，默认为30毫秒左右 |

### sleep
停顿一段时间

**示例：** `sleep(3)`

| 参数 | 类型 | 描述 |
|------|------|------|
| second | Number | 停顿时间，单位秒，支持小数点 |

### swipe
滑动

**示例：** `swipe("100,100,10,10",0.5,1,"300,400",0)`

| 参数 | 类型 | 描述 |
|------|------|------|
| region | String | 滑动点位置格式为 x,y[w,h] |
| pressTime | Number | 此点按下（停顿）时间，单位秒 |
| duration | Number | 滑动到下一个点的时间，单位秒 |

以上三个参数为一组，可重复添加，最后一组不需要duration

### touchDown
模拟按下操作,无障碍环境下运行不支持多点

**示例：** `touchDown(100,200)`

| 参数 | 类型 | 描述 |
|------|------|------|
| x | Number | 按下点x坐标 |
| y | Number | 按下点y坐标 |
| id(可选) | Number | 多点触摸id，默认为0 |

### touchMove
模拟滑动到指定位置,调用前需调用touchDown

**示例：** `touchMove(100,200,200)`

| 参数 | 类型 | 描述 |
|------|------|------|
| x | Number | 指定位置x坐标 |
| y | Number | 指定y坐标 |
| duration | Number | 滑动时间,单位毫秒 |
| id(可选) | Number | 多点触摸id，默认为0 |

### touchUp
模拟抬起操作

**示例：** `touchUp()`

| 参数 | 类型 | 描述 |
|------|------|------|
| id(可选) | Number | 多点触摸id，默认为0 |

### updateFrame
更新屏幕截图，后续图色相关方法将在此次截取的屏幕上进行查找操作

**版本要求：** 仅支持版本 **4.1** 及以上

**示例：** `updateFrame()`

### loadJS
加载js代码，加载后可使用js中的所有方法和变量

**版本要求：** 仅支持版本 **4.1.9** 及以上。纯代码模式下使用

**示例：** `loadJS("name")`

### keyEvent
模拟系统按键

**版本要求：** 仅支持版本 **4.1.15** 及以上

**示例：**
```js
keyEvent("back");      //模拟系统返回
keyEvent("home");      //模拟home按键
keyEvent("recents");   //模拟最近任务按键
keyEvent(66);          //模拟输入法确认按键
```

### createWebView
创建一个webview，可以显示网页

**版本要求：** 仅支持安卓版本 **4.3.2** 及以上

**示例：**
```js
let view = createWebView();
view.loadUrl("http://www.autoeditor.cn");
view.show();
```

| 参数 | 类型 | 描述 |
|------|------|------|
| url | string | 加载网页地址，支持在线或本地页面 |
| config | json | 窗口相关配置 |

**config字段：**
| 名称 | 描述 |
|------|------|
| hasTitleBar | 是否包含标题栏 |
| size | 窗口大小，格式为 宽x高[单位] |
| position | 窗口位置，格式为 x,y[单位] |
| border | 窗口边框大小 |
| resizeable | 窗口是否可调整大小 |
| disable-cache | 是否禁用网页缓存，默认false |

**WebView方法：**
| 方法 | 说明 |
|------|------|
| show() | 显示网页窗口 |
| close() | 关闭窗口 |
| getId() | 获取窗口id |
| connected() | 窗口是否与编辑器建立消息通讯 |
| loadUrl(url) | 加载网页地址 |
| loadData(data) | 加载网页内容 |
| poseMessage(msg) | 给网页发送消息 |
| onmessage(msg) | 回调方法，收到网页消息时调用 |
| onconnected | 通讯连接时调用 |
| ondisconnect | 通讯断开时调用 |

**网页中通过引用 `http://www.autoeditor.cn/autoeditor/auto.ui.1.1.js` 可使用全局对象 autoBridge：**
| 方法 | 说明 |
|------|------|
| show() | 显示网页窗口 |
| close() | 关闭窗口 |
| hide() | 隐藏窗口 |
| updateConfig(config) | 更新窗口配置 |
| getRect() | 获取窗口位置及大小 |
| postMessage(msg) | 给编辑器发送消息 |
| eval(code) | 在编辑器js引擎执行代码 |
| onmessage(msg) | 收到编辑器消息时调用 |
| onopen | 连接成功后调用 |
| onstop | 任务停止时调用 |

### getWebView
获取webview，一般用于js代码动作中

**版本要求：** 仅支持安卓版本 **4.3.2** 及以上

**示例：**
```js
let view = createWebView();
view.loadUrl("http://www.autoeditor.cn");
view.show();
let id = view.getId();
auto.setValue("webviewId", id);
// 通过id获取webview实例
let view2 = getWebView(webviewId);
view2.postMessage("测试消息");
```

| 参数 | 类型 | 描述 |
|------|------|------|
| id | string | webview窗口的id |

---

## auto对象

### capture
截取当前屏幕

**示例：** `auto.capture("/sdcard/test.png")`

| 参数 | 类型 | 描述 |
|------|------|------|
| path | String | 保存图片路径 |

### captureScreenMat
截取当前屏幕的Mat对象

**示例：** `let mat = auto.captureScreenMat()`

| 参数 | 类型 | 描述 |
|------|------|------|
| region(可选) | String | 截取屏幕范围，默认全屏 |

### shell
执行shell命令

**示例：**
```js
auto.shell("ls /sdcard");
auto.shell("su", "input keyevent 4");  //使用root权限
```

| 参数 | 类型 | 描述 |
|------|------|------|
| cmd | String | 执行的命令 |
| input(可选) | String | 输入的内容 |

### adbShell
执行adb shell命令（电脑版）

**版本要求：** 仅支持电脑版本 **3.0.4** 及以上

**示例：** `auto.adbShell("ls /sdcard")`

### browse
调用默认浏览器打开链接

**示例：** `auto.browse("http://www.autoeditor.cn")`

### toast
弹出一条消息（仅安卓）

**示例：**
```js
auto.toast("显示了一条消息");
auto.toast("显示了一条消息", 0, 0);  //左上角显示
```

### sendEmail
发送邮件

**示例：** `auto.sendEmail("my@autoeditor.cn","auth_code", "your@qq.com","标题","正文")`

**返回值：** 1成功, -1参数错误, -2邮箱格式错误, -3授权码不正常, -4未知错误

### setValue
设置自动化编辑器变量的内容

> 注意：在JavaScript代码中，用"="给自动化编辑器的变量赋值是不生效的

**示例：**
```js
var newValue = "123";
auto.setValue("变量名称", newValue);
```

### getClip
获取系统剪切板内容（安卓10+需使用编辑器输入法）

### setClip
设置系统剪切板内容

### getColor
获取编辑器中创建的颜色，返回#号开头的RGB颜色

### getImageInfo
获取编辑器中创建的截图，返回图片的Mat对象

### launchApp
启动应用

**示例：**
```js
auto.launchApp("自动化编辑器");
auto.launchApp("cn.autoeditor.mobileeditor");
```

### startActivity
根据参数构造Intent并启动Activity

**示例：**
```js
auto.startActivity("android.settings.SETTINGS");
auto.startActivity("android.settings.APPLICATION_DETAILS_SETTINGS","package:cn.autoeditor.mobileeditor");
```

### log
在回放中输出日志

### findOne
获取一个节点

**示例：**
```js
var node = auto.findOne();
console.log("id:"+node.id);
console.log("text:"+node.text);

var target = {"text":"自动化编辑器"};
var node = auto.findOne(null, target);
```

**返回结果：** id, text, class_name, package_name

### findNodes
获取所有匹配的节点，返回数组

### wakeUp
唤醒屏幕

### isScreenOn
返回设备屏幕是否点亮

### input
输入文字

**示例：** `auto.input("输入内容", true)`

### findLabel
查找指定标签，返回JSON对象

### findWindow
查找窗口（电脑端），返回json数组

### searchWindow
模糊查找窗口（电脑端）

### getCurrentWindow
获取当前操作窗口句柄（电脑端）

### setCurrentWindow
设置当前窗口句柄（电脑端）

### setForegroundWindow
将窗口设置为前台窗口（电脑端）

### resetCurrentWindow
重置当前窗口句柄（电脑端）

### setWindowSize
设置窗口大小（电脑端）

### moveWindow
移动窗口位置（电脑端）

### getWindowRect
获取指定窗口大小和位置（电脑端）

### getClientRect
获取窗口除标题栏和边框的大小位置（电脑端）

### setWindowClientSize
设置窗口客户区域大小（电脑端）

### ocr
识别指定区域内文字内容

**版本要求：** 仅支持版本 **4.1** 及以上

支持三种图像处理模式：普通模式、阈值二值化模式和颜色过滤模式

**返回值：** code(0成功), msg, result数组

### getEnv
获取当前运行环境

**返回值：** 无障碍、HID、adb、root

### clientVersion
获取编辑器版本号

### listPackage
获取当前应用列表

### finish
结束任务

### breakLoop
中断循环

### dispatchGesture
执行手势操作

### playbackInfo
添加图片查找信息到回放

### install
安装应用

### taskMode
获取当前任务窗口模式（电脑端）

### jsLock / jsUnlock
同步锁/解锁（电脑端）

### checkSelfPermission
判断是否有指定权限

### currentPackage
获取当前前台应用

---

## http对象

### addHeader
为下一次http请求添加header

### get
HTTP GET请求

### post
HTTP POST请求

### postJson
HTTP POST请求，Content-Type为application/json

### upload
上传文件

### download
下载文件

### setTimeout
设置读取超时时间（秒）

### fetch_sync
简化版同步fetch方法

---

## File对象

### touch
创建文件

### remove / delete
删除文件(目录)

### mkdir
创建文件夹

### read
读取文件内容

### readLine
读取一行内容

### write
写入文件

### copy
复制文件

### move
移动文件

### listFile
列出文件列表

### exist
文件是否存在

---

## Device对象

| 属性 | 说明 |
|------|------|
| device.model | 获取设备型号 |
| device.brand | 获取设备品牌 |
| device.product | 获取设备名称 |
| device.width | 获取屏幕宽度 |
| device.height | 获取屏幕高度 |
| device.dpi | 获取屏幕DPI |

---

## notification对象

### getNewest
获取最新一条消息（后进先出）

### getLast
获取最后一条消息（最多保存30条）

### getExtra
获取通知消息内容（title, text, subText等）

### packageName
获取发送通知的应用包名

### postTime
获取通知发送时间戳

### startIntent
启动通知带的intent

### checkPermission
检查通知权限

### requestPermission
打开通知权限页面

---

## image对象

### toBase64
截图转base64

### save
保存当前截图

### find
查找指定图片

### exist
图片是否存在

### rawData
获取当前截图图像数据

### click
点击一个截图

### update
更新指定截图

### updateWithImage
使用图片更新指定截图

---

## Color对象

### get
获取屏幕指定位置颜色值

### find
获取范围内指定颜色坐标

### count
获取指定范围内指定颜色数量

---

## Audio对象

### notification
播放通知音

### ringtone
播放铃声

### play
播放音乐文件

### stop
停止播放

### playing
是否正在播放

---

## 界面 (AutoView)

AutoView是一个自定义Android视图框架，支持动态创建浮动窗口。

### AutoView主要方法
| 方法 | 说明 |
|------|------|
| show() | 显示浮动窗口 |
| close() | 关闭窗口 |
| move(x, y) | 移动窗口 |
| setSize(w, h) | 设置尺寸（-1铺满，-2自适应） |
| addLine() | 添加水平布局行 |
| addTextView() | 添加文本组件 |
| addImageView() | 添加图片组件 |
| getTitleBar() | 获取标题栏 |
| setDragWith(with) | 设置拖拽方式 |

### AutoTitleBar方法
| 方法 | 说明 |
|------|------|
| setTitle(title) | 设置标题 |
| setTextColor(color) | 设置标题颜色 |
| addButton(svg) | 添加按钮 |
| setVisibility(visible) | 显示/隐藏 |

### AutoLayout方法
| 方法 | 说明 |
|------|------|
| addTextView(text) | 添加文本视图 |
| addImageView(svg, w, h) | 添加SVG图片 |
| addRectView(w, h) | 添加矩形视图 |
| setBackgroundColor(color) | 设置背景色 |

---

## settings对象

### put
设置或修改指定设置项的值

### get
获取指定设置项当前的值

### canWrite
检查是否有写入配置权限
