# AutoEditor 精简版 APK 构建系统

保留核心自动化引擎，剥离所有商业/云端/统计功能。

## 保留组件

| 组件 | 状态 | 说明 |
|------|------|------|
| 无障碍服务 | 保留 | AutoEditorAccessibilityService |
| ADB 支持 | 保留 | libadb.so + ShellRunnerRpcService |
| Root 支持 | 保留 | ShellRunnerRpcService (/system/bin/su) |
| Shizuku | 保留 | libshizuku.so + rish + rish_shizuku.dex |
| 图像识别 | 保留 | libopencv_java3.so + libyolov4.so |
| OCR | 保留 | libocr-library.so + libpaddle_light_api_shared.so + bdocr.zip |
| 脚本引擎 | 保留 | libquickjs.so + AutoWebView |
| 插件系统 | 保留 | JSPluginInfo + EditorJSPluginAction |
| 手势系统 | 保留 | GestureInfo + GestureGroup + RunnerServer |
| 动作/条件 | 保留 | Editor*Action / Editor*Condition 全系列 |

## 剥离组件

- 登录/注册/支付/VIP/余额/CDKey
- Bugly 崩溃上报
- Umeng 行为统计
- 插件市场/课程系统
- 云端 API 调用
- 打包模块（由本构建系统替代）

## 快速开始

### 1. 准备环境

```bash
# 克隆/下载本仓库
cd autoeditor-lean-builder

# 放置原 AutoEditor APK 作为基包
cp /path/to/autoeditor.apk ./base.apk

# 创建签名密钥（首次运行自动生成，或手动创建）
keytool -genkey -v -keystore ./keys/release.jks -alias release \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=AutoEditor, OU=Lean, O=AutoEditor, L=Local, S=Local, C=CN" \
  -storepass android -keypass android
```

### 2. 配置构建参数

复制示例配置并修改：

```bash
cp config.json.example config.json
```

编辑 `config.json`：

```json
{
  "package_name": "com.myapp.automation",
  "app_name": "我的自动化工具",
  "version_code": 1,
  "version_name": "1.0.0",
  "scripts_dir": "/workspace/scripts",
  "icon_dir": "/workspace/icons"
}
```

### 3. 准备用户脚本

```bash
mkdir -p user_scripts
cp /path/to/your/script.js user_scripts/
```

### 4. 准备图标（可选）

```bash
mkdir -p icons
# 命名规范: ic_launcher_mdpi.png, ic_launcher_hdpi.png, ...
cp /path/to/icon_48.png icons/ic_launcher_mdpi.png
cp /path/to/icon_72.png icons/ic_launcher_hdpi.png
cp /path/to/icon_96.png icons/ic_launcher_xhdpi.png
cp /path/to/icon_144.png icons/ic_launcher_xxhdpi.png
cp /path/to/icon_192.png icons/ic_launcher_xxxhdpi.png
```

### 5. 构建

```bash
# Docker Compose 方式（推荐）
docker-compose up --build

# 或 Docker 直接运行
docker build -t autoeditor-lean-builder .
docker run --rm \
  -v $(pwd)/base.apk:/workspace/base.apk:ro \
  -v $(pwd)/config.json:/workspace/config.json:ro \
  -v $(pwd)/user_scripts:/workspace/scripts:ro \
  -v $(pwd)/icons:/workspace/icons:ro \
  -v $(pwd)/keys:/keys:rw \
  -v $(pwd)/output:/output:rw \
  autoeditor-lean-builder /workspace/config.json
```

### 6. 获取产物

构建完成后，APK 位于：

```
./output/lean_YYYYMMDD_HHMMSS/final.apk
```

## 目录结构

```
autoeditor-lean-builder/
├── Dockerfile                 # 构建环境镜像
├── docker-compose.yml         # 一键部署配置
├── config.json.example        # 配置示例
├── base.apk                   # 原 AutoEditor APK（基包）
├── keys/
│   └── release.jks            # 签名密钥
├── user_scripts/              # 用户 JS 脚本
│   └── main.js
├── icons/                     # 应用图标
│   ├── ic_launcher_mdpi.png
│   ├── ic_launcher_hdpi.png
│   └── ...
├── output/                    # 构建输出
│   └── lean_20260824_013000/
│       └── final.apk
└── scripts/                   # 构建脚本（内置在镜像中）
    ├── build.sh               # 主构建脚本
    ├── strip_apk.py           # APK 精简脚本
    ├── modify_manifest.py     # Manifest 修改
    └── verify_apk.py          # APK 验证
```

## 手动构建流程

如果不使用 Docker，需要手动安装：

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y openjdk-17-jdk python3 python3-pip jq imagemagick apksigner zipalign

# 安装 apktool
wget https://bitbucket.org/iBotPeaches/apktool/downloads/apktool_2.9.3.jar -O /usr/local/bin/apktool.jar
wget https://raw.githubusercontent.com/iBotPeaches/Apktool/master/scripts/linux/apktool -O /usr/local/bin/apktool
chmod +x /usr/local/bin/apktool

# 安装 Python 依赖
pip3 install lxml beautifulsoup4

# 运行构建
./scripts/build.sh config.json
```

## 验证清单

构建完成后，APK 应包含：

- [x] `libeditor_native.so` — 原生引擎
- [x] `libopencv_java3.so` + `libyolov4.so` — 图像识别
- [x] `libocr-library.so` + `libpaddle_light_api_shared.so` — OCR
- [x] `libquickjs.so` — 脚本引擎
- [x] `libshizuku.so` + `assets/rish` + `assets/rish_shizuku.dex` — Shizuku
- [x] `libadb.so` — ADB 支持
- [x] `AutoEditorAccessibilityService` 声明 — 无障碍
- [x] `AutoNotificationListenerService` 声明 — 通知监听
- [x] `assets/pack_info.json` — 用户配置
- [x] `assets/scripts/` — 用户脚本
- [x] 不应包含 `libBugly.so`、`libumeng-spy.so` 等统计库
- [x] 不应包含 PayActivity、LoginActivity 等商业页面

## 注意事项

1. **基包来源**：需要原 AutoEditor APK 作为基包，构建系统在此基础上修改
2. **签名一致性**：如果用户之前安装过你的应用，新 APK 必须使用相同签名
3. **包名唯一性**：每个应用应有独立的 package_name，避免冲突
4. **权限声明**：精简版保留了所有运行环境权限，安装时仍需用户授权
5. **OCR 模型**：`bdocr.zip` 较大（2.8MB），如不需要 OCR 可在配置中禁用

## License

本构建工具仅供学习研究使用，请遵守原软件的许可协议。
