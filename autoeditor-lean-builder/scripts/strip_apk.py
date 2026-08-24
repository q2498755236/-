#!/usr/bin/env python3
"""
AutoEditor APK 精简脚本
保留引擎，剥离商业/统计/云端组件
"""

import sys
import os
import json
import shutil
from pathlib import Path

# ============ 配置 ============

# 要从 AndroidManifest.xml 移除的 Activity 和服务
REMOVE_ACTIVITIES = [
    # 支付/VIP
    "cn.autoeditor.mobileeditor.activitys.PayActivity",
    "cn.autoeditor.mobileeditor.activitys.BuyVipActivity2",
    "cn.autoeditor.mobileeditor.activitys.BuyBalanceActivity",
    # 账号系统
    "cn.autoeditor.mobileeditor.activitys.LoginActivity",
    "cn.autoeditor.mobileeditor.activitys.RegisterActivity",
    "cn.autoeditor.mobileeditor.activitys.WalletActivity",
    "cn.autoeditor.mobileeditor.activitys.TransactionActivity",
    "cn.autoeditor.mobileeditor.activitys.VerifyCodeListActivity",
    # 课程/市场
    "cn.autoeditor.mobileeditor.activitys.CourseActivity",
    "cn.autoeditor.mobileeditor.activitys.CourseWebViewActivity",
    "cn.autoeditor.mobileeditor.activitys.PluginMarketActivity",
    "cn.autoeditor.mobileeditor.activitys.ManagerForPlugin",
    # 打包模块（由服务端替代）
    "cn.autoeditor.mobileeditor.activitys.PackListActivity",
    "cn.autoeditor.mobileeditor.activitys.PackListActivity8",
    "cn.autoeditor.mobileeditor.activitys.PackTaskActivity",
    # 上传/其他
    "cn.autoeditor.mobileeditor.activitys.UploadActivity",
    "cn.autoeditor.mobileeditor.activitys.OcrServiceSetting",
    "cn.autoeditor.mobileeditor.activitys.HotUpdateSetActivity",
    "cn.autoeditor.mobileeditor.activitys.BuyVipActivity",
    "cn.autoeditor.mobileeditor.activitys.BuyBalanceActivity",
]

# 要从 AndroidManifest.xml 移除的 Receiver/Service
REMOVE_SERVICES = [
    # Bugly
    "com.tencent.bugly.beta.tinker.TinkerResultService",
    "com.tencent.bugly.beta.tinker.TinkerPatchService",
]

# 要移除的权限（云端/统计相关）
REMOVE_PERMISSIONS = [
    "android.permission.READ_PHONE_STATE",  # 设备信息（统计用）
]

# 要移除的 meta-data
REMOVE_META = [
    "BUGLY_APPID",
    "BUGLY_APP_CHANNEL",
    "BUGLY_ENABLE_DEBUG",
    "UMENG_APPKEY",
    "UMENG_CHANNEL",
]

# 要删除的 smali 包路径（相对 smali/ 目录）
REMOVE_SMALI_PACKAGES = [
    # 商业 Activity
    "cn/autoeditor/mobileeditor/activitys/PayActivity",
    "cn/autoeditor/mobileeditor/activitys/BuyVipActivity",
    "cn/autoeditor/mobileeditor/activitys/BuyVipActivity2",
    "cn/autoeditor/mobileeditor/activitys/BuyBalanceActivity",
    "cn/autoeditor/mobileeditor/activitys/LoginActivity",
    "cn/autoeditor/mobileeditor/activitys/RegisterActivity",
    "cn/autoeditor/mobileeditor/activitys/WalletActivity",
    "cn/autoeditor/mobileeditor/activitys/TransactionActivity",
    "cn/autoeditor/mobileeditor/activitys/VerifyCodeListActivity",
    "cn/autoeditor/mobileeditor/activitys/CourseActivity",
    "cn/autoeditor/mobileeditor/activitys/CourseWebViewActivity",
    "cn/autoeditor/mobileeditor/activitys/PluginMarketActivity",
    "cn/autoeditor/mobileeditor/activitys/ManagerForPlugin",
    "cn/autoeditor/mobileeditor/activitys/PackListActivity",
    "cn/autoeditor/mobileeditor/activitys/PackTaskActivity",
    "cn/autoeditor/mobileeditor/activitys/UploadActivity",
    "cn/autoeditor/mobileeditor/activitys/OcrServiceSetting",
    "cn/autoeditor/mobileeditor/activitys/HotUpdateSetActivity",
    # 云端 API 调用层（可选，如果其他类强引用则保留）
    # "cn/autoeditor/mobileeditor/network",
]

# 要删除的第三方 SDK 包
REMOVE_SDK_PACKAGES = [
    "com/umeng",           # Umeng 统计
    "com/tencent/bugly",   # Bugly 崩溃
]

# 要删除的 native 库
REMOVE_NATIVE_LIBS = [
    "libBugly.so",
    "libBugly_Native.so",
    "libumeng-spy.so",
]

# 要删除的资源
REMOVE_ASSETS = [
    # "bdocr.zip",  # OCR 保留
    "guide_cut.gif",
    "policy.txt",
    "ui.md",
]


def remove_manifest_components(manifest_path):
    """从 AndroidManifest.xml 移除商业组件声明"""
    import xml.etree.ElementTree as ET

    ET.register_namespace('android', 'http://schemas.android.com/apk/res/android')
    tree = ET.parse(manifest_path)
    root = tree.getroot()
    ns = {'android': 'http://schemas.android.com/apk/res/android'}

    removed = []

    # 移除 Activity
    for activity in root.findall('.//activity'):
        name = activity.get('{http://schemas.android.com/apk/res/android}name')
        if name in REMOVE_ACTIVITIES:
            activity.getparent().remove(activity)
            removed.append(f"Activity: {name}")

    # 移除 Service
    for service in root.findall('.//service'):
        name = service.get('{http://schemas.android.com/apk/res/android}name')
        if name in REMOVE_SERVICES:
            service.getparent().remove(service)
            removed.append(f"Service: {name}")

    # 移除 Receiver (Bugly Tinker)
    for receiver in root.findall('.//receiver'):
        name = receiver.get('{http://schemas.android.com/apk/res/android}name')
        if name and ('bugly' in name.lower() or 'tinker' in name.lower()):
            receiver.getparent().remove(receiver)
            removed.append(f"Receiver: {name}")

    # 移除 Provider (Bugly)
    for provider in root.findall('.//provider'):
        name = provider.get('{http://schemas.android.com/apk/res/android}name')
        if name and 'bugly' in name.lower():
            provider.getparent().remove(provider)
            removed.append(f"Provider: {name}")

    # 移除权限
    for perm in root.findall('uses-permission'):
        name = perm.get('{http://schemas.android.com/apk/res/android}name')
        if name in REMOVE_PERMISSIONS:
            root.remove(perm)
            removed.append(f"Permission: {name}")

    # 移除 meta-data
    for meta in root.findall('.//meta-data'):
        name = meta.get('{http://schemas.android.com/apk/res/android}name')
        if name in REMOVE_META:
            meta.getparent().remove(meta)
            removed.append(f"Meta-data: {name}")

    # 移除 application 级别的 meta-data
    app = root.find('application')
    if app is not None:
        for meta in app.findall('meta-data'):
            name = meta.get('{http://schemas.android.com/apk/res/android}name')
            if name in REMOVE_META:
                app.remove(meta)
                removed.append(f"App Meta-data: {name}")

    tree.write(manifest_path, encoding='utf-8', xml_declaration=True)
    return removed


def remove_smali_packages(src_dir):
    """删除 smali 目录下的指定包"""
    removed = []
    smali_dirs = [d for d in os.listdir(src_dir) if d.startswith('smali')]

    for smali_dir in smali_dirs:
        smali_path = os.path.join(src_dir, smali_dir)
        if not os.path.isdir(smali_path):
            continue

        for pkg in REMOVE_SMALI_PACKAGES + REMOVE_SDK_PACKAGES:
            pkg_path = os.path.join(smali_path, pkg)
            if os.path.exists(pkg_path):
                shutil.rmtree(pkg_path)
                removed.append(f"smali/{pkg}")

    return removed


def remove_native_libs(src_dir):
    """删除 native 库"""
    removed = []
    lib_dir = os.path.join(src_dir, 'lib')
    if not os.path.exists(lib_dir):
        return removed

    for arch in os.listdir(lib_dir):
        arch_path = os.path.join(lib_dir, arch)
        if not os.path.isdir(arch_path):
            continue
        for lib in REMOVE_NATIVE_LIBS:
            lib_path = os.path.join(arch_path, lib)
            if os.path.exists(lib_path):
                os.remove(lib_path)
                removed.append(f"lib/{arch}/{lib}")

    return removed


def remove_assets(src_dir):
    """删除多余 assets"""
    removed = []
    assets_dir = os.path.join(src_dir, 'assets')
    if not os.path.exists(assets_dir):
        return removed

    for asset in REMOVE_ASSETS:
        asset_path = os.path.join(assets_dir, asset)
        if os.path.exists(asset_path):
            if os.path.isdir(asset_path):
                shutil.rmtree(asset_path)
            else:
                os.remove(asset_path)
            removed.append(f"assets/{asset}")

    return removed


def patch_application_smali(src_dir):
    """移除 Application.onCreate 中的 SDK 初始化代码"""
    patched = []
    smali_dirs = [d for d in os.listdir(src_dir) if d.startswith('smali')]

    for smali_dir in smali_dirs:
        app_smali = os.path.join(src_dir, smali_dir, 
            'cn/autoeditor/mobileeditor/AutoEditorApplication.smali')
        if os.path.exists(app_smali):
            with open(app_smali, 'r') as f:
                content = f.read()

            # 标记是否修改
            original = content

            # 移除 Bugly.init 调用
            content = content.replace('Bugly', '#Bugly#removed')
            content = content.replace('com/tencent/bugly', '#bugly#removed')

            # 移除 Umeng 初始化
            content = content.replace('UMConfigure', '#UMConfigure#removed')
            content = content.replace('com/umeng', '#umeng#removed')

            # 移除云端 API 初始化（如果有明显的 init 调用）
            # 这里只做标记，实际 smali 语法复杂，建议手动检查

            if content != original:
                with open(app_smali, 'w') as f:
                    f.write(content)
                patched.append("AutoEditorApplication.smali (SDK init removed)")

    return patched


def main():
    if len(sys.argv) < 2:
        print("Usage: strip_apk.py <src_dir> [config.json]")
        sys.exit(1)

    src_dir = sys.argv[1]
    config_path = sys.argv[2] if len(sys.argv) > 2 else None

    print("[STRIP] 开始剥离非核心组件...")

    # 1. 修改 AndroidManifest
    manifest = os.path.join(src_dir, 'AndroidManifest.xml')
    if os.path.exists(manifest):
        removed = remove_manifest_components(manifest)
        for r in removed:
            print(f"  [-] {r}")

    # 2. 删除 smali 包
    removed = remove_smali_packages(src_dir)
    for r in removed:
        print(f"  [-] {r}")

    # 3. 删除 native 库
    removed = remove_native_libs(src_dir)
    for r in removed:
        print(f"  [-] {r}")

    # 4. 删除 assets
    removed = remove_assets(src_dir)
    for r in removed:
        print(f"  [-] {r}")

    # 5. 修补 Application
    patched = patch_application_smali(src_dir)
    for p in patched:
        print(f"  [~] {p}")

    print("[STRIP] 剥离完成")


if __name__ == '__main__':
    main()
