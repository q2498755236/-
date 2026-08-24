#!/usr/bin/env python3
"""
修改 AndroidManifest.xml：包名、应用名、版本号
"""

import sys
import argparse
import xml.etree.ElementTree as ET


def modify_manifest(manifest_path, package_name=None, app_name=None, 
                    version_code=None, version_name=None):
    """修改 AndroidManifest.xml"""

    ET.register_namespace('android', 'http://schemas.android.com/apk/res/android')
    tree = ET.parse(manifest_path)
    root = tree.getroot()
    ns = {'android': 'http://schemas.android.com/apk/res/android'}

    # 1. 修改 package 属性
    if package_name:
        old_package = root.get('package')
        root.set('package', package_name)
        print(f"  [+] package: {old_package} -> {package_name}")

    # 2. 修改版本号
    if version_code:
        root.set('{http://schemas.android.com/apk/res/android}versionCode', str(version_code))
        print(f"  [+] versionCode: {version_code}")

    if version_name:
        root.set('{http://schemas.android.com/apk/res/android}versionName', version_name)
        print(f"  [+] versionName: {version_name}")

    # 3. 修改应用名称
    if app_name:
        app = root.find('application')
        if app is not None:
            # 查找或创建 label 属性
            label_key = '{http://schemas.android.com/apk/res/android}label'
            old_label = app.get(label_key)

            # 如果 label 引用的是字符串资源，修改 strings.xml
            if old_label and old_label.startswith('@string/'):
                string_name = old_label.replace('@string/', '')
                strings_path = manifest_path.replace('AndroidManifest.xml', 
                    'res/values/strings.xml')
                if modify_strings_xml(strings_path, string_name, app_name):
                    print(f"  [+] app_name (strings.xml): {string_name} -> {app_name}")
            else:
                app.set(label_key, app_name)
                print(f"  [+] app_name: {old_label} -> {app_name}")

    # 4. 修改 provider authorities（如果有）
    if package_name:
        for provider in root.findall('.//provider'):
            auth = provider.get('{http://schemas.android.com/apk/res/android}authorities')
            if auth and '.' in auth:
                old_auth = auth
                # 替换 authority 中的旧包名
                parts = auth.split('.')
                if len(parts) >= 2:
                    # 简单替换：假设 authority 包含原包名
                    # 实际可能需要更复杂的映射
                    pass

    tree.write(manifest_path, encoding='utf-8', xml_declaration=True)
    print("  [+] AndroidManifest.xml 已保存")


def modify_strings_xml(strings_path, name, value):
    """修改 strings.xml 中的指定字符串"""
    if not os.path.exists(strings_path):
        return False

    tree = ET.parse(strings_path)
    root = tree.getroot()

    modified = False
    for string in root.findall('string'):
        if string.get('name') == name:
            string.text = value
            modified = True
            break

    if modified:
        tree.write(strings_path, encoding='utf-8', xml_declaration=True)

    return modified


def main():
    parser = argparse.ArgumentParser(description='Modify AndroidManifest.xml')
    parser.add_argument('manifest', help='Path to AndroidManifest.xml')
    parser.add_argument('--package', help='New package name')
    parser.add_argument('--app-name', help='New application name')
    parser.add_argument('--version-code', type=int, help='New version code')
    parser.add_argument('--version-name', help='New version name')

    args = parser.parse_args()

    modify_manifest(
        args.manifest,
        package_name=args.package,
        app_name=args.app_name,
        version_code=args.version_code,
        version_name=args.version_name
    )


if __name__ == '__main__':
    import os
    main()
