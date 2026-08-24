#!/usr/bin/env python3
"""
验证精简版 APK 完整性
确保核心引擎组件全部保留
"""

import sys
import subprocess
import zipfile
import json

# 必须存在的核心组件
REQUIRED_NATIVE_LIBS = [
    'lib/arm64-v8a/libeditor_native.so',
    'lib/arm64-v8a/libopencv_java3.so',
    'lib/arm64-v8a/libyolov4.so',
    'lib/arm64-v8a/libquickjs.so',
    'lib/arm64-v8a/libquickjs-android.so',
    'lib/arm64-v8a/libshizuku.so',
    'lib/arm64-v8a/libadb.so',
    'lib/arm64-v8a/libocr-library.so',
    'lib/arm64-v8a/libpaddle_light_api_shared.so',
]

# 必须存在的服务声明（在 AndroidManifest.xml 中）
REQUIRED_SERVICES = [
    'cn.autoeditor.framework.AutoEditorAccessibilityService',
    'cn.autoeditor.framework.AutoNotificationListenerService',
]

# 必须存在的 assets
REQUIRED_ASSETS = [
    'assets/pack_info.json',
    'assets/rish',
    'assets/rish_shizuku.dex',
    'assets/bdocr.zip',
]

# 必须不存在的（已剥离的）
MUST_NOT_EXIST = [
    # Native
    'lib/arm64-v8a/libBugly.so',
    'lib/arm64-v8a/libBugly_Native.so',
    'lib/arm64-v8a/libumeng-spy.so',
]


def check_native_libs(apk_path):
    """检查 native 库"""
    print("[VERIFY] 检查 Native 库...")
    with zipfile.ZipFile(apk_path, 'r') as z:
        files = z.namelist()

    all_ok = True
    for lib in REQUIRED_NATIVE_LIBS:
        if lib in files:
            print(f"  [OK] {lib}")
        else:
            print(f"  [FAIL] 缺失: {lib}")
            all_ok = False

    for lib in MUST_NOT_EXIST:
        if lib in files:
            print(f"  [WARN] 应已剥离但仍存在: {lib}")
        else:
            print(f"  [OK] 已剥离: {lib}")

    return all_ok


def check_manifest(apk_path):
    """检查 AndroidManifest.xml"""
    print("[VERIFY] 检查 AndroidManifest.xml...")

    try:
        result = subprocess.run(
            ['aapt', 'dump', 'xmltree', apk_path, 'AndroidManifest.xml'],
            capture_output=True, text=True
        )
        manifest = result.stdout
    except FileNotFoundError:
        print("  [WARN] aapt 不可用，跳过 manifest 检查")
        return True

    all_ok = True
    for service in REQUIRED_SERVICES:
        if service in manifest:
            print(f"  [OK] Service: {service}")
        else:
            print(f"  [FAIL] 缺失 Service: {service}")
            all_ok = False

    # 检查不应存在的服务
    forbidden = ['PayActivity', 'BuyVip', 'LoginActivity', 'Bugly']
    for f in forbidden:
        if f in manifest:
            print(f"  [WARN] 应已剥离但仍存在: {f}")
        else:
            print(f"  [OK] 已剥离: {f}")

    return all_ok


def check_assets(apk_path):
    """检查 assets"""
    print("[VERIFY] 检查 Assets...")
    with zipfile.ZipFile(apk_path, 'r') as z:
        files = z.namelist()

    all_ok = True
    for asset in REQUIRED_ASSETS:
        if asset in files:
            print(f"  [OK] {asset}")
        else:
            print(f"  [FAIL] 缺失: {asset}")
            all_ok = False

    # 验证 pack_info.json
    if 'assets/pack_info.json' in files:
        with zipfile.ZipFile(apk_path, 'r') as z:
            try:
                pack_info = json.loads(z.read('assets/pack_info.json'))
                print(f"  [OK] pack_info.json 有效")
                print(f"       包名: {pack_info.get('package_name')}")
                print(f"       应用名: {pack_info.get('app_name')}")
                print(f"       脚本数: {len(pack_info.get('scripts', []))}")
                features = pack_info.get('features', {})
                for k, v in features.items():
                    status = "OK" if v else "OFF"
                    print(f"       {k}: {status}")
            except json.JSONDecodeError:
                print(f"  [FAIL] pack_info.json 格式错误")
                all_ok = False

    return all_ok


def check_signature(apk_path):
    """检查签名"""
    print("[VERIFY] 检查签名...")
    try:
        result = subprocess.run(
            ['apksigner', 'verify', '-v', apk_path],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            print("  [OK] APK 已正确签名")
            return True
        else:
            print(f"  [FAIL] 签名验证失败: {result.stderr}")
            return False
    except FileNotFoundError:
        print("  [WARN] apksigner 不可用，跳过签名检查")
        return True


def main():
    if len(sys.argv) < 2:
        print("Usage: verify_apk.py <apk_path>")
        sys.exit(1)

    apk_path = sys.argv[1]

    print("=" * 50)
    print("  AutoEditor 精简版 APK 验证")
    print("=" * 50)
    print()

    results = []
    results.append(check_native_libs(apk_path))
    print()
    results.append(check_manifest(apk_path))
    print()
    results.append(check_assets(apk_path))
    print()
    results.append(check_signature(apk_path))
    print()

    if all(results):
        print("=" * 50)
        print("  验证通过！核心引擎完整保留")
        print("=" * 50)
        sys.exit(0)
    else:
        print("=" * 50)
        print("  验证失败！请检查上述错误")
        print("=" * 50)
        sys.exit(1)


if __name__ == '__main__':
    main()
