/* ==================== 数组变量条件/动作插件 ====================
 * 用法: 整个文件复制到编辑器插件代码即可。
 * 工具里调用 loop("条件类-数组字段判断") / loop("动作类-数组字段自增自减")。
 *
 * 需要在编辑器里配置的工具变量 (auto.getValue 读取):
 *   数组变量名  要读写的数组变量, 如 人物配置
 *   匹配字段    按哪个字段定位条目, 默认 name
 *   匹配值      条目匹配值, 如 张三
 *   比较字段    条件类: 要比较的字段, 默认 count
 *   判断条件    条件类: 等于/不等于/大于/小于/包含/不包含/被包含
 *   比较值      条件类: 阈值, 如 2
 *   自增字段    动作类: 要自增自减的字段, 默认 count
 *   步长        动作类: 正数自增/负数自减, 默认 1
 *
 * 数据格式 (数组变量内容):
 *   [{"name":"李四","count":4},{"name":"张三","count":2}]
 * ================================================================ */

function setup() {
    console.log('数组变量插件初始化完成');
}

/* 安全读取并解析数组变量: 返回数组, 失败/为空返回 null */
function arrRead(varName) {
    var raw = auto.getValue(varName);
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    try {
        var arr = JSON.parse(String(raw));
        return Array.isArray(arr) ? arr : null;
    } catch (e) {
        console.log('数组解析失败: ' + varName);
        return null;
    }
}

/* 按字段定位第一个匹配条目: 返回条目对象或 null */
function arrFind(arr, keyField, matchVal) {
    for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        if (it && typeof it === 'object' && String(it[keyField]) === String(matchVal)) return it;
    }
    return null;
}

/* 通用条件比较: 双侧可转数值时按数值比较, 否则按字符串比较 */
function condCheck(cond, fieldVal, cmpVal) {
    var fv = String(fieldVal === undefined || fieldVal === null ? '' : fieldVal);
    var cv = String(cmpVal === undefined || cmpVal === null ? '' : cmpVal);
    var fn = parseFloat(fv), cn = parseFloat(cv);
    var numeric = fv.trim() !== '' && cv.trim() !== '' && !isNaN(fn) && !isNaN(cn);
    if (cond === '等于') return numeric ? fn === cn : fv === cv;
    if (cond === '不等于') return numeric ? fn !== cn : fv !== cv;
    if (cond === '大于') return numeric && fn > cn;
    if (cond === '小于') return numeric && fn < cn;
    if (cond === '包含') return fv.indexOf(cv) >= 0;
    if (cond === '不包含') return fv.indexOf(cv) < 0;
    if (cond === '被包含') return fv !== '' && cv.indexOf(fv) >= 0;
    return false;
}

function loop(action) {
    try {
        switch (action) {
            /* 条件类: 张三的 count 是否大于 2 => true/false */
            case "条件类-数组字段判断": {
                var varName = auto.getValue('数组变量名') || '';
                var keyField = auto.getValue('匹配字段') || 'name';
                var matchVal = auto.getValue('匹配值') || '';
                var cmpField = auto.getValue('比较字段') || 'count';
                var cond = auto.getValue('判断条件') || '等于';
                var cmpVal = auto.getValue('比较值') || '';
                var arr = arrRead(varName);
                if (arr === null) { console.log('数组为空或解析失败: ' + varName); return false; }
                var it = arrFind(arr, keyField, matchVal);
                if (it === null) { console.log('未找到条目: ' + keyField + '=' + matchVal); return false; }
                var ok = condCheck(cond, it[cmpField], cmpVal);
                console.log('条件判断: ' + matchVal + ' 的 ' + cmpField + '=' + it[cmpField] + ' ' + cond + ' ' + cmpVal + ' => ' + ok);
                return ok;
            }
            /* 动作类: 张三的 count 自增/自减步长, 写回原变量; 条目不存在时自动新建 */
            case "动作类-数组字段自增自减": {
                var aName = auto.getValue('数组变量名') || '';
                var kField = auto.getValue('匹配字段') || 'name';
                var mVal = auto.getValue('匹配值') || '';
                var iField = auto.getValue('自增字段') || 'count';
                var step = parseInt(auto.getValue('步长') || '1', 10);
                if (isNaN(step)) step = 1;
                var arr2 = arrRead(aName);
                if (arr2 === null) arr2 = [];
                var it2 = arrFind(arr2, kField, mVal);
                if (it2 === null) {
                    var fresh = {};
                    fresh[kField] = mVal;
                    fresh[iField] = step;
                    arr2.push(fresh);
                    it2 = fresh;
                } else {
                    var cur = parseInt(it2[iField], 10);
                    if (isNaN(cur)) cur = 0;
                    it2[iField] = cur + step;
                }
                auto.setValue(aName, JSON.stringify(arr2));
                console.log('自增自减: ' + mVal + ' 的 ' + iField + ' => ' + it2[iField] + ' (步长 ' + step + ')');
                break;
            }
            default:
                console.log('未知功能: ' + action);
                return false;
        }
    } catch (err) {
        console.log('插件执行异常: ' + (err && err.message ? err.message : String(err)));
        return false;
    }
}
