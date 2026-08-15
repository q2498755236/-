// 自动化编辑器 - 字符工具插件
// 支持功能：字符串拼接、分割、替换、截取、去空格、大小写转换、查找、重复

function setup() {
    console.log('字符工具插件初始化完成（仅执行1次）');
}

function loop(action) {
    try {
        switch (action) {

            // 1. 字符串拼接
            case "字符串拼接": {
                function concatStrings(str1, str2, str3 = "", separator = "") {
                    const strList = [str1, str2, str3].filter(str => str !== "");
                    return strList.join(separator);
                }
                let 字符串1 = auto.getValue('字符串1') || "";
                let 字符串2 = auto.getValue('字符串2') || "";
                let 字符串3 = auto.getValue('字符串3') || "";
                let 连接符 = auto.getValue('连接符') || "";
                let 结果 = concatStrings(字符串1, 字符串2, 字符串3, 连接符);
                console.log(`拼接结果: ${结果}`);
                auto.setValue("拼接结果", 结果);
                break;
            }

            // 2. 字符串分割
            case "字符串分割": {
                function splitString(str, delimiter, targetIndex = -1) {
                    if (!str) return targetIndex === -1 ? [] : null;
                    const parts = str.split(delimiter);
                    if (targetIndex === -1) return parts.join(',');
                    if (targetIndex < 0 || targetIndex >= parts.length) {
                        console.error('指定索引超出范围');
                        return null;
                    }
                    return parts[targetIndex];
                }
                let 原始字符串 = auto.getValue('原始字符串') || "";
                let 分割符 = auto.getValue('分割符') || "";
                let 目标索引 = parseInt(auto.getValue('目标索引') || -1);
                let 结果 = splitString(原始字符串, 分割符, 目标索引);
                if (结果 !== null) {
                    console.log(`分割结果: ${结果}`);
                    auto.setValue("分割结果", 结果);
                }
                break;
            }

            // 3. 字符串替换
            case "字符串替换": {
                function replaceString(str, oldSub, newSub, replaceAll = false) {
                    if (!str) return "";
                    if (replaceAll) {
                        const reg = new RegExp(oldSub.replace(/[.*+?^${}()|[\]\]/g, '\$&'), 'g');
                        return str.replace(reg, newSub);
                    }
                    return str.replace(oldSub, newSub);
                }
                let 源字符串 = auto.getValue('源字符串') || "";
                let 旧子串 = auto.getValue('旧子串') || "";
                let 新子串 = auto.getValue('新子串') || "";
                let 全部替换 = auto.getValue('全部替换') === "是";
                let 结果 = replaceString(源字符串, 旧子串, 新子串, 全部替换);
                console.log(`替换结果: ${结果}`);
                auto.setValue("替换结果", 结果);
                break;
            }

            // 4. 字符串截取
            case "字符串截取": {
                function sliceString(str, startIndex = 0, length = -1) {
                    if (!str) return "";
                    const strLen = str.length;
                    let actualStart = startIndex < 0 ? Math.max(strLen + startIndex, 0) : Math.min(startIndex, strLen);
                    let endIndex = length === -1 ? strLen : Math.min(actualStart + length, strLen);
                    return str.slice(actualStart, endIndex);
                }
                let 目标字符串 = auto.getValue('目标字符串') || "";
                let 起始索引 = parseInt(auto.getValue('起始索引') || 0);
                let 截取长度 = parseInt(auto.getValue('截取长度') || -1);
                let 结果 = sliceString(目标字符串, 起始索引, 截取长度);
                console.log(`截取结果: ${结果}`);
                auto.setValue("截取结果", 结果);
                break;
            }

            // 5. 字符串去空格
            case "字符串去空格": {
                function trimString(str, trimType = "前后") {
                    if (!str) return "";
                    switch (trimType) {
                        case "前后": return str.trim();
                        case "全部": return str.replace(/\s+/g, '');
                        case "前面": return str.trimStart();
                        case "后面": return str.trimEnd();
                        default:
                            console.error('仅支持前后/全部/前面/后面');
                            return str;
                    }
                }
                let 待去空格字符串 = auto.getValue('待去空格字符串') || "";
                let 去空格类型 = auto.getValue('去空格类型') || "前后";
                let 结果 = trimString(待去空格字符串, 去空格类型);
                console.log(`去空格结果: ${结果}`);
                auto.setValue("去空格结果", 结果);
                break;
            }

            // 6. 大小写转换
            case "大小写转换": {
                function changeCase(str, caseType = "全小写") {
                    if (!str) return "";
                    switch (caseType) {
                        case "全大写": return str.toUpperCase();
                        case "全小写": return str.toLowerCase();
                        case "首字母大写": return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
                        default:
                            console.error('仅支持全大写/全小写/首字母大写');
                            return str;
                    }
                }
                let 待转换字符串 = auto.getValue('待转换字符串') || "";
                let 转换类型 = auto.getValue('转换类型') || "全小写";
                let 结果 = changeCase(待转换字符串, 转换类型);
                console.log(`转换结果: ${结果}`);
                auto.setValue("转换结果", 结果);
                break;
            }

            // 7. 字符串查找
            case "字符串查找": {
                function findSubstring(str, subStr, findLast = false) {
                    if (!str || !subStr) return -1;
                    return findLast ? str.lastIndexOf(subStr) : str.indexOf(subStr);
                }
                let 主字符串 = auto.getValue('主字符串') || "";
                let 待查子串 = auto.getValue('待查子串') || "";
                let 查找末次 = auto.getValue('查找末次') === "是";
                let 结果 = findSubstring(主字符串, 待查子串, 查找末次);
                if (结果 === -1) {
                    console.log('未找到子串');
                    auto.setValue("子串索引", -1);
                } else {
                    console.log(`子串索引: ${结果}`);
                    auto.setValue("子串索引", 结果);
                }
                break;
            }

            // 8. 重复字符串
            case "重复字符串": {
                function repeatString(str, times = 1) {
                    if (!str) return "";
                    const repeatTimes = Math.max(parseInt(times), 0);
                    return str.repeat(repeatTimes);
                }
                let 基础字符串 = auto.getValue('基础字符串') || "";
                let 重复次数 = parseInt(auto.getValue('重复次数') || 1);
                let 结果 = repeatString(基础字符串, 重复次数);
                console.log(`重复结果: ${结果}`);
                auto.setValue("重复结果", 结果);
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
