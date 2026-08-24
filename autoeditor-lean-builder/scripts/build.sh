#!/bin/bash
set -e

# ============================================================
# AutoEditor 精简版 APK 构建脚本
# 保留: 无障碍/ADB/Root/Shizuku/OpenCV/YOLO/OCR/QuickJS/插件系统
# 剥离: 登录/支付/VIP/统计/Bugly/Umeng/云端API/插件市场
# ============================================================

TASK_ID="${1:-lean_$(date +%Y%m%d_%H%M%S)}"
CONFIG_JSON="${2:-/workspace/config.json}"
BASE_APK="${BASE_APK:-/workspace/base.apk}"
WORK_DIR="/workspace/build/${TASK_ID}"
OUT_DIR="/output/${TASK_ID}"
KEYSTORE="${KEYSTORE:-/keys/release.jks}"
KEYSTORE_PASS="${KEYSTORE_PASS:-android}"
KEY_ALIAS="${KEY_ALIAS:-release}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "${GREEN}[BUILD]${NC} $1"
}
warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}
error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# 检查依赖
check_deps() {
    log "检查依赖..."
    [ -f "$BASE_APK" ] || error "基包不存在: $BASE_APK"
    [ -f "$CONFIG_JSON" ] || error "配置文件不存在: $CONFIG_JSON"
    [ -f "$KEYSTORE" ] || warn "签名密钥不存在，将生成临时密钥"
    command -v apktool >/dev/null || error "apktool 未安装"
    command -v python3 >/dev/null || error "python3 未安装"
}

# 解析配置
parse_config() {
    log "解析配置..."
    PACKAGE_NAME=$(jq -r '.package_name // "com.autoeditor.lean"' "$CONFIG_JSON")
    APP_NAME=$(jq -r '.app_name // "AutoEditor"' "$CONFIG_JSON")
    VERSION_CODE=$(jq -r '.version_code // 1' "$CONFIG_JSON")
    VERSION_NAME=$(jq -r '.version_name // "1.0.0"' "$CONFIG_JSON")
    USER_SCRIPTS_DIR=$(jq -r '.scripts_dir // "/workspace/scripts"' "$CONFIG_JSON")
    ICON_DIR=$(jq -r '.icon_dir // ""' "$CONFIG_JSON")

    log "  包名: $PACKAGE_NAME"
    log "  应用名: $APP_NAME"
    log "  版本: $VERSION_NAME ($VERSION_CODE)"
}

# 生成临时签名密钥（如果没有）
gen_keystore() {
    if [ ! -f "$KEYSTORE" ]; then
        log "生成临时签名密钥..."
        mkdir -p "$(dirname "$KEYSTORE")"
        keytool -genkey -v \
            -keystore "$KEYSTORE" \
            -alias "$KEY_ALIAS" \
            -keyalg RSA -keysize 2048 -validity 10000 \
            -dname "CN=AutoEditor, OU=Lean, O=AutoEditor, L=Local, S=Local, C=CN" \
            -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" \
            2>/dev/null
    fi
}

# 反编译基包
decompile_apk() {
    log "反编译基包..."
    rm -rf "$WORK_DIR"
    mkdir -p "$WORK_DIR/src" "$OUT_DIR"
    apktool d -f -o "$WORK_DIR/src" "$BASE_APK"
    log "  反编译完成: $(du -sh "$WORK_DIR/src" | cut -f1)"
}

# 剥离非核心组件
strip_components() {
    log "剥离非核心组件..."

    python3 /opt/scripts/strip_apk.py "$WORK_DIR/src" "$CONFIG_JSON"

    log "  剥离完成"
}

# 修改 AndroidManifest
modify_manifest() {
    log "修改 AndroidManifest..."

    python3 /opt/scripts/modify_manifest.py \
        "$WORK_DIR/src/AndroidManifest.xml" \
        --package "$PACKAGE_NAME" \
        --app-name "$APP_NAME" \
        --version-code "$VERSION_CODE" \
        --version-name "$VERSION_NAME"

    log "  包名已修改为: $PACKAGE_NAME"
}

# 替换图标
replace_icons() {
    if [ -n "$ICON_DIR" ] && [ -d "$ICON_DIR" ]; then
        log "替换图标..."
        for dpi in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
            src="$ICON_DIR/ic_launcher_$dpi.png"
            dst="$WORK_DIR/src/res/mipmap-$dpi/ic_launcher.png"
            if [ -f "$src" ]; then
                mkdir -p "$(dirname "$dst")"
                cp "$src" "$dst"
                log "  替换 mipmap-$dpi"
            fi
        done
    else
        warn "未提供图标目录，使用默认图标"
    fi
}

# 注入用户脚本
inject_scripts() {
    log "注入用户脚本..."
    mkdir -p "$WORK_DIR/src/assets/scripts"

    if [ -d "$USER_SCRIPTS_DIR" ]; then
        cp -r "$USER_SCRIPTS_DIR"/* "$WORK_DIR/src/assets/scripts/" 2>/dev/null || true
        log "  已注入 $(ls -1 "$WORK_DIR/src/assets/scripts/" 2>/dev/null | wc -l) 个脚本"
    else
        warn "脚本目录不存在: $USER_SCRIPTS_DIR"
    fi
}

# 生成 pack_info.json
generate_pack_info() {
    log "生成 pack_info.json..."

    # 收集脚本列表
    scripts_json="[]"
    if [ -d "$WORK_DIR/src/assets/scripts" ]; then
        scripts_json=$(find "$WORK_DIR/src/assets/scripts" -name "*.js" -type f | \
            sed "s|$WORK_DIR/src/assets/scripts/||" | \
            jq -R -s -c 'split("\n")[:-1]')
    fi

    cat > "$WORK_DIR/src/assets/pack_info.json" <<EOF
{
  "package_name": "$PACKAGE_NAME",
  "app_name": "$APP_NAME",
  "version_code": $VERSION_CODE,
  "version_name": "$VERSION_NAME",
  "build_time": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "build_type": "lean",
  "scripts": $scripts_json,
  "permissions": [
    "INTERNET",
    "ACCESSIBILITY_SERVICE",
    "SYSTEM_ALERT_WINDOW",
    "FOREGROUND_SERVICE",
    "WAKE_LOCK",
    "VIBRATE"
  ],
  "features": {
    "accessibility": true,
    "adb": true,
    "root": true,
    "shizuku": true,
    "opencv": true,
    "yolo": true,
    "ocr": true,
    "quickjs": true,
    "plugins": true
  },
  "config": {
    "auto_start": false,
    "show_float": true,
    "ocr_enabled": true,
    "yolo_enabled": true,
    "offline_mode": true
  }
}
EOF
    log "  pack_info.json 已生成"
}

# 构建 APK
build_apk() {
    log "构建 APK..."
    apktool b -o "$OUT_DIR/unsigned.apk" "$WORK_DIR/src"
    log "  未签名 APK: $(du -sh "$OUT_DIR/unsigned.apk" | cut -f1)"
}

# 对齐
align_apk() {
    log "Zipalign 对齐..."
    zipalign -v 4 "$OUT_DIR/unsigned.apk" "$OUT_DIR/aligned.apk"
    log "  对齐完成"
}

# 签名
sign_apk() {
    log "签名 APK..."
    apksigner sign \
        --ks "$KEYSTORE" \
        --ks-pass pass:"$KEYSTORE_PASS" \
        --key-pass pass:"$KEYSTORE_PASS" \
        --out "$OUT_DIR/final.apk" \
        "$OUT_DIR/aligned.apk"
    log "  签名完成"
}

# 验证
verify_apk() {
    log "验证 APK 完整性..."

    python3 /opt/scripts/verify_apk.py "$OUT_DIR/final.apk"

    if [ $? -eq 0 ]; then
        log "${GREEN}验证通过！${NC}"
    else
        error "验证失败"
    fi

    # 输出信息
    echo ""
    echo "========================================"
    echo "  构建完成"
    echo "========================================"
    echo "  产物: $OUT_DIR/final.apk"
    echo "  大小: $(du -sh "$OUT_DIR/final.apk" | cut -f1)"
    echo "  MD5:  $(md5sum "$OUT_DIR/final.apk" | cut -d' ' -f1)"
    echo "  包名: $PACKAGE_NAME"
    echo "========================================"
}

# 清理
cleanup() {
    log "清理临时文件..."
    rm -rf "$WORK_DIR"
    rm -f "$OUT_DIR/unsigned.apk" "$OUT_DIR/aligned.apk"
}

# 主流程
main() {
    echo "========================================"
    echo "  AutoEditor 精简版 APK 构建"
    echo "========================================"
    echo ""

    check_deps
    parse_config
    gen_keystore
    decompile_apk
    strip_components
    modify_manifest
    replace_icons
    inject_scripts
    generate_pack_info
    build_apk
    align_apk
    sign_apk
    verify_apk
    cleanup

    log "全部完成！"
}

main "$@"
