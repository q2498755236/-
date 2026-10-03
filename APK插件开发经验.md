# APK 插件 (OCR/YOLO) 开发经验

> 2026-09 开发 OCR/YOLO 插件 v7 → v15 全过程的实测经验。适用对象: 自动化编辑器的 APK 插件 (cn.autoeditor.pluginaction.*)。
> 相关源码: `/workspace/ocr-plugin-src/`，构建现场: `/tmp/opencode/ocrplugin/`。

## 一、插件架构 (v15 现状)

```
MainActivity (Activity + IPluginAction 双角色, 插件唯一入口)
 ├─ 构造函数里 addIAction() 注册 7 个动作类
 └─ onCreate: 插件说明页 (编辑器点开插件图标时显示)
ActionProxy (动作注册表 + 分发: actionList/actionArgs/results/onAction)
IAction 接口 (每个动作实现这 6 个方法)
 ├─ getName()          动作名 (中文, 编辑器列表显示)
 ├─ getArgs()          参数名 List (顺序即编辑器显示顺序)
 ├─ getOptions()       参数选项 Map (可返回 null)
 ├─ getResults()       结果名 List (输出变量名)
 └─ onAction(Map args, Bitmap screenshot)  执行体, 返回 Map(结果名→值)
BaseOcrAction (公共基类: str/parseInt/parseXYWH/crop + license() 门禁)
引擎层
 ├─ OcrEngine  → libnjocr.so (ncnn OCR, com.wubugncnn.njocr.OCRService native 接口)
 └─ YoloEngine → libyolo8.so (YOLO 检测 + license.cpp 授权算法)
```

7 个动作: OCR识别 / 区域OCR识别 / 查找文字 / 区域查找文字 / YOLO检测 / 存在文字(条件) / 存在目标(条件)。

## 二、编辑器接口契约 (硬性)

1. **动作名、参数名、结果名都是中文字符串常量**，定义在动作类顶部 `private static final String NAME/ARG_*/RESULT_*`，`getArgs()` 返回的 List 顺序即编辑器参数面板顺序。
2. **onAction 收到的 args 是 Map<String,String>**，一律当字符串处理; `screenshot` 是编辑器传入的全屏 Bitmap。
3. **返回值是 Map(结果名→值)**。条件动作 (存在文字/存在目标) 返回布尔语义的结果，供任务流程条件分支。
4. 改参数列表 (增删参数、改默认值) 后，**编辑器有本地缓存**，见第六节。

## 三、Context 与 so 加载陷阱 (最重要)

1. **宿主 Context 陷阱**: 编辑器宿主传入的 Context 会把 SharedPreferences 写到宿主包名下，导致插件 App 里激活的状态与编辑器运行时不同步。必须 `createPackageContext(PLUGIN_PACKAGE, CONTEXT_INCLUDE_CODE | CONTEXT_IGNORE_SECURITY)` 切回插件自己的 Context (LicenseGate.pluginCtx)。
2. **so 从插件包的 nativeLibraryDir 加载**: 编辑器运行时用 `pc.getApplicationInfo().nativeLibraryDir + "/libxxx.so"` 逐个 System.load，顺序: 先 `libc++_shared.so` 再业务 so。
3. **模型资产用插件包自己的 AssetManager**: `service.initModels(pc.getAssets())`，宿主的 assets 里没有模型。
4. so 加载和模型初始化都做 **单例 + synchronized + 失败原因缓存** (ensureReady)，首次动作时懒加载，失败返回 `{"status":500,...}` 而非抛异常。

## 四、参数设计经验

1. **参数统一字符串、宽松解析**: `parseXYWH("x,y,w,h")` 用 `split("[,，]")` 兼容全角逗号，`Double.parseDouble` 再截断成 int (容忍 "500.0")；解析失败返回 null 走全屏兜底，不给用户报错。
2. **v14 统一矩形坐标**: 所有输出统一 `rect="x,y,w,h"`、中心点 `center="x,y"`，OCR 识别格式 1=仅文字 / 2=count="x,y" / 3=count="x,y,w,h"，标准数组 `[{"name":"文字","count":".."}]`。
3. **v15 参数改版**: 区域OCR识别从旧版 5 参数 (左/上/右/下/识别格式) 改为 2 参数 (区域 `x,y,w,h` + 识别格式)，与查找文字系列对齐。
4. **Bitmap 内存**: 裁剪出的 region 用完 `recycle()`，注意 `region == screenshot` 时 (全屏兜底) 不回收。
5. **引擎输出 JSON 解析三层兜底**: raw→dataOf(status==200 取 data)→itemsOf(标准数组或单对象包成数组)→失败回退原始字符串，任何一层失败都不抛异常。

## 五、授权链路 (v13 无卡密防反, 代码保留可切回)

LicenseGate.check() 当前**直接 return null 放行** (无卡密版)；完整验证链路保留在 checkReal()，随时可切回:

```
/api/time 取服务器时间戳
→ native 计算 TOTP(counter) + 请求签名 (key = totp + salt + SECRET)
→ POST /api/verify {code, fp, nonce, salt, totp, ts, sign}
→ 响应验签 (对 data 二次 HMAC)
→ token 存插件包 SharedPreferences, 20 分钟缓存, 过期重新在线验证
→ YoloJni.nativeSetSession(token, deadline) 推给 native 层
```

native 层 (license.cpp) **手写 SHA1/SHA256/HMAC/TOTP**，无 openssl 依赖。对拍验证方法:
- 用 sed 切出算法段 (1-252 行，删 j2s 与 jni/log include)，追加 harness `main()` 用 g++ 编译，与 Python `hmac/hashlib` 输出逐行 diff。
- 对拍覆盖: TOTP(counter)、请求签名、响应验签、SHA1/SHA256 已知向量 ("abc")。
- **坑**: 手写 HMAC 传 key 长度必须与 strlen 字面量核对，曾因写死 15 截断 `"response_salt_v2"` (16 字节) 导致验签必败。
- 时钟用 `CLOCK_REALTIME` 对齐 Unix 毫秒时间戳 (nativeSetSession 的 deadline)。

服务端地址硬编码 `https://2498755236.byethost7.com`，UA 用 `Googlebot/2.1` 绕 ByetHost 的 slowAES 挑战 (curl 默认 UA 会被 302 拒)。

## 六、编辑器缓存坑 (v15 排查结论)

覆盖安装新版 APK 后，编辑器对插件动作参数列表有**本地缓存**，旧参数仍显示 (表现为"新版没落实"假象):

1. 先用 dexdump 验证 APK 实际内容 (确认改版已打进包里): `dexdump -d classes.dex | grep -A5 参数名` 或看字符串池。
2. 处理: 覆盖安装后**重启编辑器**，必要时在插件管理里重新勾选加载插件；**任务里已添加的旧动作节点要删除重加** (旧节点的参数快照不会自动更新)。

## 七、构建打包流程 (全程命令行, 无 Gradle)

构建现场 `/tmp/opencode/ocrplugin/` (src + keys/release.jks，密钥口令 android)；工具链 `/tmp/opencode/androidsdk/`:

```
# 1. 编译 (android-34 的 android.jar 作 bootclasspath)
javac -source 8 -target 8 -bootclasspath androidsdk/android-34/android.jar \
      -d classes $(find src -name "*.java")

# 2. dex (d8; 输出目录必须先存在)
mkdir -p dexout && d8 --release --lib androidsdk/android-34/android.jar \
      --output dexout classes/**/*.class

# 3. 换包: cp 基准 apk → 解压只替换 classes.dex → zip 回去
#    (多 dex 时 classes2.dex... 同理; resources.arsc/AndroidManifest 不动)

# 4. 对齐 + 签名
zipalign -f -p 4 in.apk aligned.apk
apksigner sign --ks keys/release.jks --ks-pass pass:android aligned.apk
```

- 签名后 apk 体积与历史版本一致 (约 36MB，模型资产占大头)。
- `.idsig` 是 apksigner 生成的签名文件，一并入库。
- 验证安装: adb install / 真机覆盖安装后进编辑器插件管理确认版本。

## 八、版本演进记录

| 版本 | 变化 |
|------|------|
| v7/v11 | 原始带卡密授权版 (LicenseGate.checkReal 全链路) |
| v13 | 无卡密防反: check() 直接放行，验证代码保留 |
| v14 | 统一矩形坐标 (rect="x,y,w,h" / center="x,y")，输出标准化 |
| v15 | 区域参数改版: 区域 x,y,w,h + 识别格式 2 参数 (替代左/上/右/下 5 参数) |

各版本 APK 在 `/workspace/`: v7.apk / v11.apk / v13-无卡密防反.apk / v14.apk / v15.apk / OCR插件.apk (最新交付版)。

## 九、调试经验

1. **真机日志优先**: 设备端 `auto.log()` 输出 + native `__android_log_print` (tag: LicenseNative 等)，logcat 过滤。
2. **参数没生效先查缓存** (第六节)，再查 dex 内容，最后才怀疑代码。
3. **编辑器变量机制**见《编辑器插件变量机制.md》: APK 插件的 getResults() 结果名即编辑器输出变量名，onAction 返回 Map 的 key 必须与之完全一致才会回填。
4. **条件动作** (存在文字/存在目标) 返回布尔，编辑器"添加条件"列表才能出现；纯动作类若 getResults 为空会报"未返回数据"提示 (不影响执行)。
