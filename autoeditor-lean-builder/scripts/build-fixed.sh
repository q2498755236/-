#!/bin/bash
set -e

# ============================================================
# AutoEditor 精简版 APK 构建脚本 (修复版)
# 修复: -112 安装错误、签名方案、lib 目录保留
# ============================================================

TASK_ID="${1:-lean_$(date +%Y%m%d_%H%M%S)}"
CONFIG_JSON="${2:-/workspace/config.json}"
BASE_APK="${BASE_APK:-/workspace/base.apk}"
WORK_DIR="/workspace/build/${TASK_ID}"
OUT_DIR="/output/${TASK_ID}"
KEYSTORE="${KEYSTORE:-/keys/release.jks}"
KEYSTORE_PASS="${KEYSTORE_PASS:-android}"
KEY_ALIAS="${KEY_ALIAS:-release}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[BUILD]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

check_deps() {
    log "检查依赖..."
    [ -f "$BASE_APK" ] || error "基包不存在: $BASE_APK"
    [ -f "$CONFIG_JSON" ] || error "配置文件不存在: $CONFIG_JSON"
    command -v apktool >/dev/null || error "apktool 未安装"
    command -v python3 >/dev/null || error "python3 未安装"
    command -v aapt >/dev/null 2>&1 || warn "aapt 不可用，跳过 manifest 检查"
    log "  依赖检查通过"
}

parse_config() {
    log "解析配置..."
    PACKAGE_NAME=$(python3 -c "import json; print(json.load(open('$CONFIG_JSON')).get('package_name','com.autoeditor.lean'))")
    APP_NAME=$(python3 -c "import json; print(json.load(open('$CONFIG_JSON')).get('app_name','AutoEditor Lean'))")
    VERSION_CODE=$(python3 -c "import json; print(json.load(open('$CONFIG_JSON')).get('version_code',1))")
    VERSION_NAME=$(python3 -c "import json; print(json.load(open('$CONFIG_JSON')).get('version_name','1.0.0'))")
    USER_SCRIPTS_DIR=$(python3 -c "import json; d=json.load(open('$CONFIG_JSON')); print(d.get('scripts_dir','/workspace/scripts'))")
    ICON_DIR=$(python3 -c "import json; d=json.load(open('$CONFIG_JSON')); print(d.get('icon_dir',''))")
    log "  包名: $PACKAGE_NAME"
    log "  应用名: $APP_NAME"
    log "  版本: $VERSION_NAME ($VERSION_CODE)"
}

gen_keystore() {
    if [ ! -f "$KEYSTORE" ]; then
        log "生成临时签名密钥..."
        mkdir -p "$(dirname "$KEYSTORE")"
        keytool -genkey -v \
            -keystore "$KEYSTORE" -alias "$KEY_ALIAS" \
            -keyalg RSA -keysize 2048 -validity 10000 \
            -dname "CN=AutoEditor, OU=Lean, O=AutoEditor, L=Local, S=Local, C=CN" \
            -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" 2>/dev/null
    fi
}

decompile_apk() {
    log "反编译基包..."
    rm -rf "$WORK_DIR"
    mkdir -p "$WORK_DIR/src" "$OUT_DIR"
    apktool d -f --no-res -o "$WORK_DIR/src" "$BASE_APK"
    log "  反编译完成"

    # 检查 lib 目录
    if [ -d "$WORK_DIR/src/lib" ]; then
        log "  Native 库:"
        for arch_dir in "$WORK_DIR/src/lib"/*/; do
            arch=$(basename "$arch_dir")
            count=$(ls "$arch_dir"/*.so 2>/dev/null | wc -l)
            log "    $arch: $count 个 .so"
        done
    else
        warn "  未找到 lib 目录，基包可能没有 native 库"
    fi
}

strip_components() {
    log "剥离非核心组件..."
    python3 /opt/scripts/strip_apk.py "$WORK_DIR/src" "$CONFIG_JSON"
    log "  剥离完成"
}

modify_manifest() {
    log "修改 AndroidManifest..."
    python3 /opt/scripts/modify_manifest.py \
        "$WORK_DIR/src/AndroidManifest.xml" \
        --package "$PACKAGE_NAME" \
        --app-name "$APP_NAME" \
        --version-code "$VERSION_CODE" \
        --version-name "$VERSION_NAME"
}

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
        warn "  未提供图标目录，使用默认图标"
    fi
}

inject_scripts() {
    log "注入用户脚本..."
    mkdir -p "$WORK_DIR/src/assets/scripts"
    if [ -d "$USER_SCRIPTS_DIR" ]; then
        cp -r "$USER_SCRIPTS_DIR"/* "$WORK_DIR/src/assets/scripts/" 2>/dev/null || true
        count=$(ls -1 "$WORK_DIR/src/assets/scripts/" 2>/dev/null | wc -l)
        log "  已注入 $count 个文件"
    fi
}

generate_pack_info() {
    log "生成 pack_info.json..."
    scripts_json="[]"
    if [ -d "$WORK_DIR/src/assets/scripts" ]; then
        scripts_json=$(find "$WORK_DIR/src/assets/scripts" -name "*.js" -type f 2>/dev/null | \
            sed "s|$WORK_DIR/src/assets/scripts/||" | \
            python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
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
  "permissions": ["INTERNET","ACCESSIBILITY_SERVICE","SYSTEM_ALERT_WINDOW","FOREGROUND_SERVICE","WAKE_LOCK","VIBRATE"],
  "features": {"accessibility":true,"adb":true,"root":true,"shizuku":true,"opencv":true,"yolo":true,"ocr":true,"quickjs":true,"plugins":true},
  "config": {"auto_start":false,"show_float":true,"ocr_enabled":true,"yolo_enabled":true,"offline_mode":true}
}
EOF
    log "  pack_info.json 已生成"
}

build_apk() {
    log "构建 APK..."
    # 关键修复: 使用 -c 保留原始签名信息，避免资源重建问题
    apktool b -c -o "$OUT_DIR/unsigned.apk" "$WORK_DIR/src"
    log "  未签名 APK: $(du -sh "$OUT_DIR/unsigned.apk" | cut -f1)"
}

align_apk() {
    log "Zipalign 对齐..."
    zipalign -v 4 "$OUT_DIR/unsigned.apk" "$OUT_DIR/aligned.apk"
    log "  对齐完成"
}

sign_apk() {
    log "签名 APK (v1+v2+v3)..."
    # 关键修复: 强制 v1+v2+v3 全方案签名
    apksigner sign \
        --ks "$KEYSTORE" \
        --ks-pass pass:"$KEYSTORE_PASS" \
        --key-pass pass:"$KEYSTORE_PASS" \
        --v1-signing-enabled true \
        --v2-signing-enabled true \
        --v3-signing-enabled true \
        --out "$OUT_DIR/final.apk" \
        "$OUT_DIR/aligned.apk"
    log "  签名完成"
}

verify_apk() {
    log "验证 APK..."
    python3 /opt/scripts/verify_apk.py "$OUT_DIR/final.apk"

    echo ""
    echo "========================================"
    echo "  构建完成"
    echo "========================================"
    echo "  产物: $OUT_DIR/final.apk"
    echo "  大小: $(du -sh "$OUT_DIR/final.apk" | cut -f1)"
    echo "  MD5:  $(md5sum "$OUT_DIR/final.apk" | cut -d' ' -f1)"
    echo "========================================"
}

cleanup() {
    log "清理临时文件..."
    rm -f "$OUT_DIR/unsigned.apk" "$OUT_DIR/aligned.apk"
}

main() {
    echo "========================================"
    echo "  AutoEditor 精简版 APK 构建 (修复版)"
    echo "========================================"
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
