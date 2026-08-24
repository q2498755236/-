#!/bin/bash
# 检查 APK 兼容性（解决 -112 错误）

APK="$1"
[ -z "$APK" ] && echo "Usage: check-apk.sh <apk>" && exit 1

echo "========================================"
echo "  APK 兼容性检查"
echo "========================================"
echo ""

# 1. 检查签名方案
echo "[1] 签名方案检查..."
apksigner verify -v "$APK" 2>&1 | grep -E "(v1|v2|v3|v4)" || echo "  签名验证失败"
echo ""

# 2. 检查 Native 库架构
echo "[2] Native 库架构..."
unzip -l "$APK" | grep "lib/" | awk '{print $4}' | cut -d'/' -f1-2 | sort -u
echo ""

# 3. 检查 minSdkVersion
echo "[3] SDK 版本要求..."
aapt dump badging "$APK" 2>/dev/null | grep -E "sdkVersion|targetSdkVersion" || echo "  aapt 不可用"
echo ""

# 4. 检查 AndroidManifest 关键服务
echo "[4] 核心服务声明..."
aapt dump xmltree "$APK" AndroidManifest.xml 2>/dev/null | grep -E "AutoEditorAccessibilityService|AutoNotificationListenerService" || echo "  aapt 不可用"
echo ""

# 5. 文件完整性
echo "[5] 文件完整性..."
unzip -t "$APK" 2>&1 | tail -3
echo ""

echo "========================================"
echo "  检查完成"
echo "========================================"
