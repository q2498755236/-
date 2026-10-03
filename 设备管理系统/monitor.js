/* ==================== 设备运行状态监控插件 (监控 + 数组功能合体版) ====================
 * 独立运行于自动化编辑器, 与卡密插件 (v2.js) 完全无关
 * 服务端查看页: https://2498755236.byethost7.com/status.html
 *
 * ---------------- 各 case 输入/输出变量总表 ----------------
 * 变量生效前提: 节点上先建输入/输出变量再 @全局变量 (手打未配置的变量名读
 *   null/写无效, 探针已验证); [输入] 节点输入变量 @全局变量 => getValue 读值;
 *   [输出] 节点输出变量 @全局变量 => setValue 写回该全局变量
 *
 * 动作类-监控上报 (别名: 上报运行状态/记录运行错误/重置监控计数, 等价)
 *   功能: 错误收集 + 重置检查 + 心跳上报设备状态 (默认 60 秒节流), 不做任务累计
 *   输入变量:
 *     错误信息    业务脚本写错误文本, 非空则错误计数 +1 并自动清空 (防重复计数)
 *     重置监控    填 '1' = 下一轮监控把任务/错误计数归零, 并写回 '0'
 *     上报时间    心跳节流秒数, 默认 60, 填 0 = 每次调用立即上报
 *     上发配置    填 1 = 设备为新配置源 (服务端以设备上报内容反向覆盖下发基线),
 *                 默认 0 = 正常下发流程; 多台设备共用一份配置时只留一台开 1,
 *                 其余必须填 0, 否则互相覆盖基线串台; 设备存在未应用的下发时
 *                 本周期自动暂停上发, 网页人工修改优先于设备上发
 *     修改变量    @全局变量, 其内容作为状态页"修改变量"可修改项的数据来源
 *     配置变量    @全局变量, 其内容作为状态页"配置变量"可修改项的数据来源
 *     查看变量    @全局变量, 其内容随心跳上传状态页只读展示
 *   输出变量:
 *     监控上报结果  上报汇总文本 (配一个即可消除"未返回数据"提示, 忽略不影响上报)
 *     状态          服务端回传设备状态 '在线'/'挂机'/'离线', 业务脚本 getValue 判断
 *     画面状态      服务端缩略图对比结果 '正常'/'静止(N秒)'/'黑屏(N秒)', 随心跳/缩略图
 *                   响应自动写入, 业务脚本 getValue 判断 (黑屏优先级高于静止)
 *     重置监控      清零后写回 '0' (与输入同名: @同一全局变量构成读写闭环)
 *     修改变量      输出 @与输入同一全局变量, 状态页下发经此写回落地
 *     配置变量      同上 (两组下发内容互相隔离)
 *
 * 动作类-累计任务执行
 *   功能: 走完整监控链 + 任务计数 +1 (任务数只在此动作累计)
 *   输入/输出变量: 与 动作类-监控上报 完全相同
 *
 * 动作类-立即上报
 *   功能: 被调用立即上报回传 (跳过心跳/缩略图节流, 不累计任务)
 *   输入/输出变量: 与 动作类-监控上报 完全相同
 *
 * 条件类-数组字段判断   判断数组内某条目字段是否符合条件, 返回 true/false
 *   输入变量:
 *     数组名      @数组全局变量
 *     匹配字段    按哪个字段定位条目, 默认 name
 *     匹配值      条目匹配值, 如 张三
 *     比较字段    要比较的字段, 默认 count
 *     判断条件    等于/不等于/大于/小于/包含/不包含/被包含
 *     比较值      阈值, 如 2
 *   输出变量: 无 (条件动作返回 true/false, 无需配输出)
 *
 * 动作类-数组字段自增 / 动作类-数组字段自减 / 动作类-数组字段自增自减
 *   功能: 对数组内某条目字段自增/自减并写回, 条目不存在自动新建;
 *         自增固定 +1 / 自减固定 -1 / 自增自减按步长正负
 *   输入变量:
 *     数组名      @数组全局变量
 *     匹配字段    默认 name
 *     匹配值      条目匹配值
 *     自增字段    要增减的字段, 默认 count
 *     步长        正数自增/负数自减, 默认 1
 *   输出变量:
 *     数组名      @同一数组全局变量 (必配, 否则写回不落地)
 *
 * 条件类-寻找数组   遍历数组全部条目 name 字段 (包含匹配), 命中返回 true
 *   输入变量: 数组名 @数组全局变量; 匹配值 条目匹配值
 *   输出变量: 无
 *
 * 条件类-时间段判断   定位数组条目, 取其比较字段值作为时间段字符串,
 *                     判断当前设备时间在内/外
 *   输入变量:
 *     数组名/匹配字段/匹配值   同 条件类-数组字段判断
 *     比较字段    取该字段值作为时间段 (如 "18:00-08:00"), 默认 count
 *     判断条件    填 内 (默认)/外 (兼容 在内/在外)
 *   时间格式: "18:00-08:00" (跨天)/"18-8"/"18:00-8" (简写自动补 :00)/含秒亦可;
 *             数组为空/条目不存在/格式无效 => false
 *   输出变量: 无
 *
 * 动作类-数组点击   两种模式 (优先级: 匹配库 > 匹配值)
 *   输入变量:
 *     数组名        @数组全局变量, 数据源格式 [{"name":"文字","count":"x,y,w,h"}..]
 *     匹配库        可选 @匹配库变量, 格式 [{"name":"萧何赠礼","count":3}]:
 *                   count = 剩余次数; 空置/非数字 (如"是") 按 1 次算, <=0 跳过
 *     匹配库方式    默认"是" = 检测: 一次执行按顺位分别点最多"点击"个命中且
 *                   count>0 的条目, 每条目点 1 次次数减 1 写回;
 *                   "否" = 不检测: count 不动, 只点顺位第一命中项 (一直点);
 *                   老配置 "name" 同为不检测
 *     点击          默认 1, 检测模式下一次执行最多点击的条目数
 *     匹配值        匹配库未配时走匹配值, 找 name 命中第一个条目点击;
 *                   支持 | 分隔多值按顺序优先 (如 张三|李四|王五)
 *     偏移x/偏移y   直接填数字, 默认 0, 支持负数; 点击区域整体平移,
 *                   补偿 OCR 坐标系偏差
 *   输出变量:
 *     匹配库        检测模式必配 @同一匹配库变量 (次数减 1 写回, 不配则次数不减)
 *   点击方式: 按 name 字符宽度等分切出匹配值所在字符格 (如 name=發發中 匹配 中
 *             => 只点"中"字那格), 调编辑器 click() 在格内中心点击
 *
 * 动作类-数组字符处理   净化数据源 (消除字符)
 *   输入变量:
 *     数组名      数据源 (@数组全局变量 或 @纯文本全局变量)
 *     消除字符    直接填内容, 标点/数字/任意文字, 填什么删什么
 *     格式        直接填, 默认 "数组" (按 JSON 数组解析净化每个条目 name);
 *                 填 "纯文本" = 数据源按纯文本整段消除
 *   输出变量:
 *     数组名      @任意全局变量, 写回目标由 @ 谁决定 (@谁写谁)
 *
 * 未返回数据 (探针真机已验证): 编辑器对动作节点的要求是"有输出"。
 *   配了输出变量且插件内 setValue 写了它 => 不报; 没配输出变量但插件
 *   return 了数据 => 也不报; 两者都无 => 报"未返回数据" (动作仍执行完)。
 *   监控动作类 case 会尝试写 '监控上报结果' 等输出变量: 节点上配一个
 *   输出变量 "监控上报结果" @任意全局变量 即可消除提示; 忽略也不影响上报。
 *
 * 存储模式 (与 v2.js 相同, 真机验证过):
 *   file.write/read 优先 (/sdcard/.mon_monitor/), 失败回退 auto 变量,
 *   写入后立即回读验证, 两级都失败时身份靠设备指纹派生, 保证稳定
 *   设备ID: 指纹式生成 (SHA256, 存储丢失也重算出同值)
 *   UUID:   随机生成 (文件 -> 变量 -> 都空随机生成, 写文件, 变量保底)
 *
 * 采集开关 (全部 false = 只用 v2.js 验证过的 API, 排查闪退用):
 *   MON_USE_SHELL  电量/内存 (auto.shell)
 *   MON_USE_SCREEN 屏幕开关 (auto.isScreenOn)
 *   MON_USE_PKG    前台应用 (Shell dumpsys -> currentPackage -> 根节点 -> 缓存 四级降级)
 *   MON_USE_VER    编辑器版本 (auto.clientVersion)
 *   注意: JS try-catch 拦不住 native 层崩溃, 只能用开关禁用
 *
 * 上报内容: 基础信息 (品牌型号/屏幕/DPI) + 运行数据 (任务/错误/时长)
 *           + 扩展项 (电量/充电状态/内存/屏幕开关/前台应用/编辑器版本, 单项失败自动降级)
 *           + 诊断项 (往返延迟/运行环境/Android版本/设备开机时长/磁盘可用/屏幕方向/心跳间隔)
 *           + 游戏进度 (金币/血量/层数/轮数, 读取 auto 变量 '金币' '血量' '层数' '轮数')
 *           屏幕分辨率走多级探测 monScreenSize: windowSize -> 截图 Mat ->
 *           shell "wm size" -> device 兜底 (device.width 旋转后不更新不可靠)
 *
 * 状态回传: 客户在状态页可将设备标记为 '挂机' 或 '离线', 服务端随心跳响应回传,
 * 插件写入 auto 变量 '状态' (取值: '在线' / '挂机' / '离线'),
 * 业务脚本用 auto.getValue('状态') 判断, 如 == '挂机' 暂停业务, == '离线' 结束任务。
 *
 * 编辑器变量同步 (内置, 随心跳自动执行, 无需配置 action):
 *   上报: '查看变量' 随心跳上传 (状态页只读展示); '修改变量' 的内容作为
 *         修改变量内容随心跳上传 (状态页可修改项的数据来源, 为空则网页不可修改);
 *         '配置变量' 同构第二组 (内容格式与修改变量一致, 网页可修改下发)
 *   下发: 状态页"修改变量/配置变量"保存后, 设备下个心跳拉取: 数组内容比对"上次修改"时间戳
 *         应用到数据源变量 (心跳内立即生效, 无需数组条件/动作触发);
 *         非数组内容直写对应变量 (业务脚本 auto.getValue 读取)
 *
 * 变量机制 (探针真机已验证): 插件内 auto.getValue/setValue 只认节点上配置的
 *   输入/输出变量名; 输入变量 @全局变量 传值进来, 输出变量 @全局变量 被
 *   setValue 覆盖写回; 手打未配置的变量名 getValue 返回 null、setValue 无效。
 *   故所有数据源变量必须"节点上先建输入/输出变量再 @全局变量"
 *   (各 case 所需变量清单见上方"各 case 输入/输出变量总表")
 *
 * 服务端同步闭环 (自动, 无需业务脚本桥接):
 *   '查看变量' 完全归业务脚本管理, 插件不覆盖;
 *   下发内容心跳内应用 (靠内容里的 {"name":"上次修改","count":时间戳}
 *   条目比对防重复; 服务端每次修改需更新该时间戳)
 * ================================================================ */

var MON_SERVER = 'https://2498755236.byethost7.com';
var MON_UA = 'Googlebot/2.1 (+http://www.google.com/bot.html)';
var MON_INTERVAL_SEC = 60;

/* ---------- 缩略图配置 (速度优先, 能看就行) ----------
 * 独立生效, 与 MON_USE_SHELL 无关; 任一步失败静默放弃本张 */
var MON_USE_THUMB = true;            /* 缩略图总开关 */
var MON_THUMB_INTERVAL_SEC = 120;    /* 上传节流 (与心跳独立) */
var MON_THUMB_WIDTH = 480;           /* 缩略图宽度像素 (PC 灯箱放大可看清, 体积约 80-150KB) */

/* TOTP 种子 (RFC 4648 Base32, XOR 混淆存储, 与卡密插件的种子相互独立)
 * 运行时 _unmask 还原; 服务端 config 保存明文 SEED 用于校验
 * 上报请求签名 = HMAC-SHA256(参数串, totp + 种子), 防抓包伪造与重放 */
var MON_TOTP_KEY = 'Mk7wQz9X';
var MON_TOTP_MASKED = '1838623e023c7819085d7427012d740078387840662363097e32753d024f6f1c';

/* ---------- 采集开关 (闪退排查) ----------
 * 全部 false 后插件只使用 v2.js 真机验证过的能力 (getValue/setValue/postJson/addHeader/file)
 * 若全关后仍闪退, 崩溃源在网络调用或编辑器本身; 若不闪退, 逐个打开定位崩溃源 */
var MON_USE_SHELL = true;    /* 电量/内存 (auto.shell) */
var MON_USE_SCREEN = true;   /* 屏幕开关 (auto.isScreenOn) */
var MON_USE_PKG = true;      /* 前台应用 (Shell优先四级降级, 见 monPostReport) */
var MON_USE_VER = true;      /* 编辑器版本 (auto.clientVersion) */
var MON_VERSION = '1.1.0';   /* 插件版本号, 随心跳上报 (payload.ver), 网页设备卡"客户端"行显示 */

/* ---------- 持久化路径与兜底变量名 ---------- */
var MON_DIR = '/sdcard/.mon_monitor';
var MON_ID_FILE = MON_DIR + '/device_id.dat';        /* 兜底变量: mon_device_id */
var MON_SALT_FILE = MON_DIR + '/device_salt.dat';    /* 兜底变量: mon_device_salt */
var MON_UUID_FILE = MON_DIR + '/uuid.dat';           /* 兜底变量: mon_uuid */
var MON_TASK_FILE = MON_DIR + '/task_count.dat';     /* 兜底变量: mon_task_count */
var MON_ERR_FILE = MON_DIR + '/error_count.dat';     /* 兜底变量: mon_error_count */
var MON_LASTERR_FILE = MON_DIR + '/last_error.dat';  /* 兜底变量: mon_last_error */
var MON_PKG_CACHE_FILE = MON_DIR + '/last_pkg.dat';  /* 兜底变量: mon_last_pkg (前台应用缓存保底) */
var MON_LASTREP_FILE = MON_DIR + '/last_report.dat'; /* 兜底变量: mon_last_report */
var MON_PENDING_FILE = MON_DIR + '/edit_pending.dat'; /* 服务端下发暂存 (文件, auto 变量在部分周期读写不可靠) */
var MON_CFG_PENDING_FILE = MON_DIR + '/config_pending.dat'; /* 配置变量下发暂存 (与修改变量暂存隔离, 防两组下发内容互相覆盖) */
var MON_THUMB_LAST_FILE = MON_DIR + '/last_thumb.dat'; /* 兜底变量: mon_last_thumb */
var MON_THUMB_FILE = MON_DIR + '/t.jpg';             /* 缩略图临时文件 */

/* 本周期内存缓存 (跨周期不保证保留, 身份可随时重算所以无影响) */
var monStartSec = 0;
var monLoopCount = 0;   /* 内存全局: 本周期动作调用计数, 第一次强制心跳+截图 */
var monLastReportMs = 0;
var monScreenMatDim = null;   /* 最近一次截屏 Mat 的 {w,h} (真实屏幕分辨率, 供 monScreenSize 探测) */
var monLastRtMs = 0;          /* 上次心跳往返延迟 ms (本次发出后更新, 下次随 payload 上报) */
var monBatStatus = 0;         /* 充电状态: 0未知 1充电中 2放电中 3已满 (monBattery 解析顺带) */

/* ---------- 安全读取工具: 任何异常都返回 fallback, 绝不抛出 ---------- */
function gv(key, fb) {
    try {
        var v = auto.getValue(key);
        return (v === undefined || v === null) ? (fb === undefined ? '' : fb) : String(v);
    } catch (e) {
        return fb === undefined ? '' : fb;
    }
}

function sv(key, val) {
    try { auto.setValue(key, String(val)); } catch (e) {}
}

function slog(msg) {
    try { console.log(String(msg).slice(0, 300)); } catch (e) {}
}

/* 业务变量安全读数 (金币/血量/层数/轮数等, 由业务脚本写入) */
function num(k) {
    var v = Number(gv(k, '0'));
    return isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/* ==================== 文件存储层 (抄自 v2.js 真机验证过的实现) ==================== */
function monFileMkdir(path) {
    if (typeof file !== 'undefined') {
        if (typeof file.mkdir === 'function') { try { file.mkdir(path); return; } catch (e) {} }
        if (typeof file.mkdirs === 'function') { try { file.mkdirs(path); return; } catch (e) {} }
    }
    if (typeof File !== 'undefined') {
        try { File.mkdir(path); } catch (e) {}
    }
}

function monFileWrite(path, content) {
    if (typeof file !== 'undefined' && typeof file.write === 'function') {
        try { file.write(path, content); return true; } catch (e) {}
    }
    if (typeof File !== 'undefined' && typeof File.write === 'function') {
        try { File.write(path, content); return true; } catch (e) {}
    }
    return false;
}

function monFileRead(path) {
    var warned = monFileReadWarned[path];
    var garbage = false; /* 读到 [object 垃圾或抛异常: API 形态异常, 值得诊断 */
    var info = typeof file !== 'undefined' ? ('file.read=' + typeof file.read + ' readText=' + typeof file.readText) : 'file对象不存在';
    /* 判定 (真机日志校准: file.read=function readText=undefined):
     * null/undefined = 文件不存在的常规形态 (如无错误时 last_error.dat 未写过), 静默返回空;
     * 空串 = 空文件合法内容 (重置场景 monWrite 写过空串), 直接返回;
     * [object 垃圾/抛异常 = API 异常, 继续尝试其他形态, 全失败才诊断 */
    if (typeof file !== 'undefined') {
        if (typeof file.read === 'function') {
            try {
                var v = file.read(path);
                if (v === undefined || v === null) return '';
                var s = String(v);
                if (s.indexOf('[object') !== 0) return s;
                garbage = true;
            } catch (e) { garbage = true; }
        }
        if (typeof file.readText === 'function') {
            try {
                var t = file.readText(path);
                if (t === undefined || t === null) return '';
                var st = String(t);
                if (st.indexOf('[object') !== 0) return st;
                garbage = true;
            } catch (e) { garbage = true; }
        }
    }
    if (typeof File !== 'undefined') {
        if (typeof File.read === 'function') {
            try {
                var v2 = File.read(path);
                if (v2 === undefined || v2 === null) return '';
                var s2 = String(v2);
                if (s2.indexOf('[object') !== 0) return s2;
                garbage = true;
            } catch (e) { garbage = true; }
        }
        if (typeof File.readText === 'function') {
            try {
                var t2 = File.readText(path);
                if (t2 === undefined || t2 === null) return '';
                var st2 = String(t2);
                if (st2.indexOf('[object') !== 0) return st2;
                garbage = true;
            } catch (e) { garbage = true; }
        }
    }
    if (garbage && !warned) {
        monFileReadWarned[path] = true;
        try {
            slog('文件读取失败(一次性诊断): ' + path + ' [' + info + ']');
        } catch (e) {}
    }
    return '';
}
var monFileReadWarned = {};

/* 读: 文件优先, auto 变量兜底 */
function monRead(path, varName) {
    var v = monFileRead(path);
    if (v) return v.trim();
    return gv(varName).trim();
}

/* 写: 文件优先并回读验证, 失败回退 auto 变量(同样带回读验证), 返回是否两级成功之一 */
function monWrite(path, varName, content) {
    content = String(content);
    var idx = path.lastIndexOf('/');
    var dir = idx > 0 ? path.substring(0, idx) : '';
    if (dir) monFileMkdir(dir);
    if (monFileWrite(path, content)) {
        if (monFileRead(path) === content) return true;
    }
    try {
        auto.setValue(varName, content);
        return gv(varName) === content;
    } catch (e) {
        return false;
    }
}

/* 读数值: 非法/缺失一律返回 >= 0 的整数 */
function monReadNum(path, varName) {
    var v = Number(monRead(path, varName) || '0');
    return isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/* ==================== 纯 JS SHA-1 + HMAC (抄自 v2.js, TOTP 依赖) ==================== */
function _sha1Raw(msg) {
    var h0 = 0x67452301;
    var h1 = 0xEFCDAB89;
    var h2 = 0x98BADCFE;
    var h3 = 0x10325476;
    var h4 = 0xC3D2E1F0;
    var ml = msg.length * 8;
    var padded = msg + String.fromCharCode(0x80);
    while (padded.length % 64 !== 56) {
        padded += String.fromCharCode(0);
    }
    var hi = Math.floor(ml / 0x100000000);
    var lo = ml >>> 0;
    padded += String.fromCharCode(
        (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
        (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff
    );
    var w = new Array(80);
    for (var blockStart = 0; blockStart < padded.length; blockStart += 64) {
        var i;
        for (i = 0; i < 16; i++) {
            var j = blockStart + i * 4;
            w[i] = ((padded.charCodeAt(j) & 0xff) << 24) |
                   ((padded.charCodeAt(j + 1) & 0xff) << 16) |
                   ((padded.charCodeAt(j + 2) & 0xff) << 8) |
                   (padded.charCodeAt(j + 3) & 0xff);
        }
        for (i = 16; i < 80; i++) {
            var n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = (n << 1) | (n >>> 31);
        }
        var a = h0, b = h1, c = h2, d = h3, e = h4;
        for (i = 0; i < 80; i++) {
            var f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6; }
            var temp = ((a << 5) | (a >>> 27)) + f + e + k + w[i];
            e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
        }
        h0 = (h0 + a) | 0;
        h1 = (h1 + b) | 0;
        h2 = (h2 + c) | 0;
        h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0;
    }
    function toHex(n) {
        var s = '';
        for (var i = 7; i >= 0; i--) {
            s += ((n >>> (i * 4)) & 0xf).toString(16);
        }
        return s;
    }
    return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
}

function _hexToBytes(hex) {
    var out = '';
    for (var i = 0; i < hex.length; i += 2) {
        out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return out;
}

function _hmacSha1Bytes(messageBytes, keyBytes) {
    var blockSize = 64;
    var k = keyBytes;
    if (k.length > blockSize) {
        k = _hexToBytes(_sha1Raw(k));
    }
    while (k.length < blockSize) {
        k += String.fromCharCode(0);
    }
    var oPad = '', iPad = '';
    for (var i = 0; i < blockSize; i++) {
        var kb = k.charCodeAt(i) & 0xff;
        oPad += String.fromCharCode(kb ^ 0x5c);
        iPad += String.fromCharCode(kb ^ 0x36);
    }
    return _hexToBytes(_sha1Raw(oPad + _hexToBytes(_sha1Raw(iPad + messageBytes))));
}

/* HMAC-SHA256 (抄自 v2.js, 请求签名用) */
function _hmacSha256(message, key) {
    var blockSize = 64;
    var hasWide = false;
    for (var i = 0; i < key.length; i++) {
        if (key.charCodeAt(i) > 0xff) { hasWide = true; break; }
    }
    var keyStr = hasWide ? _utf8Bytes(key) : key;
    var keyBytes = [];
    for (var i = 0; i < keyStr.length; i++) {
        keyBytes.push(keyStr.charCodeAt(i) & 0xff);
    }
    if (keyBytes.length > blockSize) {
        var keyHash = _sha256(keyStr);
        keyBytes = [];
        for (var i = 0; i < keyHash.length; i += 2) {
            keyBytes.push(parseInt(keyHash.substr(i, 2), 16));
        }
    }
    while (keyBytes.length < blockSize) {
        keyBytes.push(0);
    }
    var oKeyPad = '', iKeyPad = '';
    for (var i = 0; i < blockSize; i++) {
        oKeyPad += String.fromCharCode(keyBytes[i] ^ 0x5c);
        iKeyPad += String.fromCharCode(keyBytes[i] ^ 0x36);
    }
    return _sha256(oKeyPad + _hexToBytes(_sha256(iKeyPad + _utf8Bytes(message), true)), true);
}

/* ==================== 标准 TOTP (RFC 6238, 抄自 v2.js) ==================== */
function _base32Decode(input) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    var cleaned = String(input).toUpperCase().replace(/[=\s-]/g, '');
    var bits = 0;
    var value = 0;
    var out = '';
    for (var i = 0; i < cleaned.length; i++) {
        var idx = alphabet.indexOf(cleaned.charAt(i));
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out += String.fromCharCode((value >> bits) & 0xff);
        }
    }
    return out;
}

function _intToBytes8(n) {
    var out = '';
    for (var i = 7; i >= 0; i--) {
        out += String.fromCharCode(Math.floor(n / Math.pow(256, i)) & 0xff);
    }
    return out;
}

var _secretCache = '';
var _secretBytesCache = '';

function _totp(secretBase32, serverTime) {
    if (_secretCache !== secretBase32 || !_secretBytesCache) {
        _secretCache = secretBase32;
        _secretBytesCache = _base32Decode(secretBase32);
    }
    var secretBytes = _secretBytesCache;
    var counter = Math.floor(serverTime / 30);
    var msg = _intToBytes8(counter);
    var hmac = _hmacSha1Bytes(msg, secretBytes);
    var offset = hmac.charCodeAt(hmac.length - 1) & 0x0f;
    var bin = ((hmac.charCodeAt(offset) & 0x7f) << 24) |
              (hmac.charCodeAt(offset + 1) << 16) |
              (hmac.charCodeAt(offset + 2) << 8) |
              (hmac.charCodeAt(offset + 3));
    var code = bin % 1000000;
    return ('00000' + code).substr(-6);
}

/* 种子混淆还原 (XOR + Hex, 抄自 v2.js) */
function _unmask(hex, key) {
    var out = '';
    for (var i = 0; i < hex.length; i += 2) {
        var c = parseInt(hex.substr(i, 2), 16);
        out += String.fromCharCode(c ^ key.charCodeAt((i / 2) % key.length));
    }
    return out;
}

function _monSeed() {
    return _unmask(MON_TOTP_MASKED, MON_TOTP_KEY);
}

function _genNonce() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var result = '';
    for (var i = 0; i < 16; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/* ==================== 纯 JS SHA-256 (抄自 v2.js, 真机验证过) ==================== */
var _SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function _utf8Bytes(message) {
    var out = '';
    for (var i = 0; i < message.length; i++) {
        var c = message.charCodeAt(i);
        if (c < 0x80) {
            out += String.fromCharCode(c);
        } else if (c < 0x800) {
            out += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c < 0xd800 || c >= 0xe000) {
            out += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else {
            i++;
            c = 0x10000 + (((c & 0x3ff) << 10) | (message.charCodeAt(i) & 0x3ff));
            out += String.fromCharCode(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return out;
}

function _sha256(message, rawBytes) {
    function rotateRight(n, x) {
        return (x >>> n) | (x << (32 - n));
    }
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var k = _SHA256_K;
    var msg = rawBytes ? message : _utf8Bytes(message);
    var msgLen = msg.length * 8;
    var blocks = [];
    for (var i = 0; i < msg.length; i++) {
        var idx = i >> 2;
        if (blocks[idx] === undefined) blocks[idx] = 0;
        blocks[idx] |= (msg.charCodeAt(i) << (24 - (i % 4) * 8));
    }
    var padIdx = msg.length >> 2;
    if (blocks[padIdx] === undefined) blocks[padIdx] = 0;
    blocks[padIdx] |= 0x80 << (24 - (msg.length % 4) * 8);
    var totalBlocks = ((msg.length + 8 >> 6) + 1) * 16;
    for (var i = blocks.length; i < totalBlocks; i++) {
        if (blocks[i] === undefined) blocks[i] = 0;
    }
    blocks[totalBlocks - 1] = msgLen;
    for (var i = 0; i < blocks.length; i += 16) {
        var w = new Array(64);
        for (var t = 0; t < 16; t++) {
            w[t] = blocks[i + t] || 0;
        }
        for (var t = 16; t < 64; t++) {
            var s0 = rotateRight(7, w[t - 15]) ^ rotateRight(18, w[t - 15]) ^ (w[t - 15] >>> 3);
            var s1 = rotateRight(17, w[t - 2]) ^ rotateRight(19, w[t - 2]) ^ (w[t - 2] >>> 10);
            w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
        }
        var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (var t = 0; t < 64; t++) {
            var S1 = rotateRight(6, e) ^ rotateRight(11, e) ^ rotateRight(25, e);
            var ch = (e & f) ^ (~e & g);
            var temp1 = (h + S1 + ch + k[t] + w[t]) | 0;
            var S0 = rotateRight(2, a) ^ rotateRight(13, a) ^ rotateRight(22, a);
            var maj = (a & b) ^ (a & c) ^ (b & c);
            var temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    function toHex(n) {
        var s = '', v;
        for (var i = 7; i >= 0; i--) {
            v = (n >>> (i * 4)) & 0xf;
            s += v.toString(16);
        }
        return s;
    }
    return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
}

/* ==================== 设备身份 (指纹式, 同设备永远稳定) ==================== */

/* 稳定盐:
 * 1. 文件/变量里已有盐 -> 直接用 (真机文件可靠, 防同型号设备碰撞)
 * 2. 生成随机盐, 且文件级持久化验证成功 -> 用随机盐 (跨周期稳定)
 * 3. 文件不可用 -> 派生盐 (从设备参数计算, 同设备永远重算出同值;
 *    代价是同型号同分辨率设备指纹相同, 极端降级场景可接受, 与 v2.js 兜底同级)
 * 注意: auto 变量兜底写入不作为盐的可信持久层 (跨周期可能丢失, 真机已验证),
 *       仅在读取时做历史兼容 */
function monStableSalt(devRaw) {
    var s = monFileRead(MON_SALT_FILE).trim();
    if (s.length >= 16) return s;
    s = gv('mon_device_salt').trim();
    if (s.length >= 16) return s;
    var chars = 'abcdef0123456789';
    var rnd = '';
    for (var i = 0; i < 32; i++) {
        rnd += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    var idx = MON_SALT_FILE.lastIndexOf('/');
    if (idx > 0) monFileMkdir(MON_SALT_FILE.substring(0, idx));
    if (monFileWrite(MON_SALT_FILE, rnd) && monFileRead(MON_SALT_FILE) === rnd) {
        return rnd;
    }
    return _sha256('mon_fp_v1:' + devRaw).substring(0, 32);
}

/* 随机 UUID: XXXX-XXXX-XXXX-XXXX (16 位大写 hex) */
function monGenUuid() {
    var chars = '0123456789ABCDEF';
    var u = '';
    for (var i = 0; i < 16; i++) {
        u += chars.charAt(Math.floor(Math.random() * 16));
    }
    return u.substring(0, 4) + '-' + u.substring(4, 8) + '-' + u.substring(8, 12) + '-' + u.substring(12, 16);
}

/* 确保设备ID与UUID就绪, 返回 [deviceId, uuid]; 任何周期调用都安全 */
function monEnsureIdentity() {
    var devRaw = '';
    try {
        devRaw = (device.brand || '') + '|' + (device.model || '') + '|' + (device.product || '') +
                 '|' + (device.width || '') + '|' + (device.height || '') + '|' + (device.dpi || '');
    } catch (e) {
        devRaw = 'unknown';
    }
    if (String(devRaw).replace(/\|/g, '').length < 2) devRaw = devRaw + '|' + 'nodevice';

    var salt = monStableSalt(devRaw);
    var fp = _sha256(devRaw + '|' + salt).toUpperCase().substring(0, 24);

    /* 设备ID: 已持久化的优先 (老设备兼容), 否则用指纹, 写回持久化 */
    var id = monRead(MON_ID_FILE, 'mon_device_id');
    if (!id || !/^[A-Za-z0-9_\-\.]{4,64}$/.test(id)) {
        id = 'M' + fp;
        monWrite(MON_ID_FILE, 'mon_device_id', id);
    }

    /* UUID: 文件 -> mon_uuid 变量 -> uuid 变量 -> 都空随机生成;
     * 探针机制: 未配置在节点上的变量名 getValue null / setValue 无效,
     * mon_uuid 未配置时两级全空 -> 每次重启换新 UUID (换项目后文件落地失败即触发);
     * uuid 是监控节点标准输出变量 (必配), 作为最可靠的变量兜底与保底写入点;
     * 文件读到但内容非法时打内容诊断 (长度+不可见字符显形), 定位 file.read 返回形态 */
    var uuid = '';
    var uuidRaw = monFileRead(MON_UUID_FILE);
    if (uuidRaw) {
        uuid = String(uuidRaw).trim();
        if (!/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(uuid)) {
            slog('UUID文件内容异常: len=' + uuid.length + ' head=' +
                 uuid.slice(0, 40).replace(/[^\x20-\x7E]/g, '?'));
            uuid = '';
        }
    }
    if (!uuid || !/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(uuid)) uuid = gv('mon_uuid').trim();
    if (!uuid || !/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(uuid)) uuid = gv('uuid').trim();
    if (!uuid || !/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(uuid)) uuid = monGenUuid();
    monWrite(MON_UUID_FILE, 'uuid', uuid);
    if (monFileRead(MON_UUID_FILE).trim() !== uuid) {
        slog('身份文件未落地: ' + MON_UUID_FILE + ' (file API 读写失败, 已回退编辑器变量 uuid 保底)');
    }

    /* 同步到变量, 业务脚本可读; uuid 写失败不影响上报 */
    sv('mon_device_id', id);
    sv('mon_uuid', uuid);
    sv('uuid', uuid);
    return [id, uuid];
}

/* ==================== 扩展采集 (全部有开关 + 降级) ==================== */
function monBattery() {
    if (!MON_USE_SHELL) { monBatStatus = 0; return 255; }
    try {
        var out = String(auto.shell('dumpsys battery') || '');
        var m = out.match(/level:\s*(\d+)/);
        if (m) {
            var lv = parseInt(m[1], 10);
            if (lv >= 0 && lv <= 100) {
                /* 充电状态: dumpsys status 1=未知 2=充电 3=放电 4=未充 5=满
                 * 映射 0未知 1充电中 2放电中 3已满 (与 level 同一次输出, 零额外开销) */
                var ms = out.match(/status:\s*(\d+)/);
                var st = ms ? parseInt(ms[1], 10) : 0;
                monBatStatus = st === 2 ? 1 : ((st === 3 || st === 4) ? 2 : (st === 5 ? 3 : 0));
                return lv;
            }
        }
    } catch (e) {}
    monBatStatus = 0;
    return 255;
}

/* Android 版本: getprop 两行 (release + sdk), 排查兼容性/API 差异; shell 降级空串 */
function monAndroidVer() {
    if (!MON_USE_SHELL) return '';
    try {
        var out = String(auto.shell('getprop ro.build.version.release; getprop ro.build.version.sdk') || '').slice(0, 200);
        var lines = out.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
        if (lines.length >= 2) return (lines[0] + ' API ' + lines[1]).slice(0, 24);
        if (lines.length === 1) return lines[0].slice(0, 24);
    } catch (e) {}
    return '';
}

/* 设备开机时长 (秒): /proc/uptime 第一字段, 判断云机是否被重置/重启 */
function monDeviceUptime() {
    if (!MON_USE_SHELL) return 0;
    try {
        var out = String(auto.shell('cat /proc/uptime') || '').slice(0, 100);
        var m = out.match(/^\s*([\d.]+)/);
        if (m) return Math.floor(parseFloat(m[1], 10));
    } catch (e) {}
    return 0;
}

/* /sdcard 可用空间 (MB): df 数据行第 4 列 available (1K blocks), 云机磁盘满会引发各种玄学问题 */
function monDiskAvailMb() {
    if (!MON_USE_SHELL) return 0;
    try {
        var out = String(auto.shell('df /sdcard') || '').slice(0, 500);
        var lines = out.split(/\r?\n/);
        for (var i = 1; i < lines.length; i++) {
            var c = lines[i].trim().split(/\s+/);
            if (c.length >= 4 && /^\d+$/.test(c[3])) return Math.floor(parseInt(c[3], 10) / 1024);
        }
    } catch (e) {}
    return 0;
}

function monMem() {
    if (!MON_USE_SHELL) return [0, 0];
    try {
        var out = String(auto.shell('cat /proc/meminfo') || '');
        var mt = out.match(/MemTotal:\s*(\d+)\s*kB/);
        var ma = out.match(/MemAvailable:\s*(\d+)\s*kB/);
        if (mt) {
            return [Math.floor(parseInt(mt[1], 10) / 1024), ma ? Math.floor(parseInt(ma[1], 10) / 1024) : 0];
        }
    } catch (e) {}
    return [0, 0];
}

/* ==================== 上报 (TOTP + 签名, 方案对齐 v2.js 方案 B) ==================== */
function monPostReport() {
    var nowSec = Math.floor(Date.now() / 1000);
    var ident = monEnsureIdentity();
    var mem = monMem();
    /* 上发暂停依据: 存在未应用的数组下发暂存, 或非数组下发交付失败的 hold 标记 */
    var upHold = monRead(MON_PENDING_FILE, 'mon_edit_pending') !== '' ||
                 monRead(MON_CFG_PENDING_FILE, 'mon_config_pending') !== '' ||
                 monRead(MON_PENDING_FILE + '.hold', 'mon_edit_pending_hold') === '1' ||
                 monRead(MON_CFG_PENDING_FILE + '.hold', 'mon_config_pending_hold') === '1';
    if (upHold) slog('上发配置: 有未应用下发, 本周期暂停上发');
    var screenOn = 2;
    if (MON_USE_SCREEN) {
        try { var on = auto.isScreenOn(); screenOn = on ? 1 : 0; } catch (e) {}
    }
    /* 前台应用: Shell 优先 + 多级降级容灾 (管道真机兼容性未验证, 各级失败自动下沉, 全程无阻塞) */
    var foreground = '';
    if (MON_USE_PKG) {
        /* 1. Shell: dumpsys window 取 mCurrentFocus 行, 正则解析包名;
         * 输出限长 2000 字符防云机超大返回撑爆内存 */
        try {
            var shOut = String(auto.shell('dumpsys window | grep mCurrentFocus') || '').slice(0, 2000);
            var mPkg = shOut.match(/mCurrentFocus=Window\{[^}]*?\s((?:[A-Za-z_][\w]*\.)+[A-Za-z_][\w]*)/);
            if (mPkg && mPkg[1] && mPkg[1].indexOf('.') > 0) {
                foreground = mPkg[1].slice(0, 120);
                slog('前台应用[Shell]: ' + foreground);
            } else {
                slog('前台应用[Shell失败] 无焦点行或包名解析失败, 降级到API');
            }
        } catch (eS) {
            slog('前台应用[Shell异常] ' + String(eS && eS.message ? eS.message : eS).slice(0, 80) + ', 降级到API');
        }
        /* 2. API: auto.currentPackage */
        if (!foreground) {
            try {
                var ap = String(auto.currentPackage() || '').slice(0, 120);
                if (ap) { foreground = ap; slog('前台应用[API]: ' + foreground); }
                else { slog('前台应用[API失败] 返回空, 降级到节点'); }
            } catch (eA) {
                slog('前台应用[API异常] ' + String(eA && eA.message ? eA.message : eA).slice(0, 80) + ', 降级到节点');
            }
        }
        /* 3. 节点: 根节点 package_name (两种属性名形态兼容) */
        if (!foreground) {
            try {
                var rn = auto.findOne();
                var pn = rn ? String(rn.package_name || rn.packageName || '') : '';
                if (pn) { foreground = pn.slice(0, 120); slog('前台应用[节点]: ' + foreground); }
                else { slog('前台应用[节点失败] 根节点无包名, 降级到缓存'); }
            } catch (eN) {
                slog('前台应用[节点异常] ' + String(eN && eN.message ? eN.message : eN).slice(0, 80) + ', 降级到缓存');
            }
        }
        /* 4. 缓存保底: 供连续多轮全失败场景维持上报值 */
        if (!foreground) {
            var cached = monRead(MON_PKG_CACHE_FILE, 'mon_last_pkg');
            if (cached) { foreground = cached.slice(0, 120); slog('前台应用[缓存保底] 使用 ' + foreground); }
            else { slog('前台应用[缓存保底] 无缓存可用, 本轮放弃'); }
        }
        /* 缓存更新: 前三级任一成功即写回, 供下次完全失败时兜底 */
        if (foreground) monWrite(MON_PKG_CACHE_FILE, 'mon_last_pkg', foreground);
    }
    var editorVer = '';
    if (MON_USE_VER) {
        try { editorVer = String(auto.clientVersion() || '').slice(0, 40); } catch (e) {}
    }
    /* 心跳间隔: 与上次上报时刻 (mon_last_report, monDoAll 在本函数返回后写入, 读到的是上一轮) 差值, 判断心跳是否规律; 首次为 0 */
    var lastRepSec = parseInt(monRead(MON_LASTREP_FILE, 'mon_last_report') || '0', 10) || 0;
    var hbGapSec = lastRepSec > 0 ? Math.max(0, nowSec - lastRepSec) : 0;
    /* 运行环境: 无障碍/HID/adb/root (文档已支持, 纯 JS 零开销) */
    var envStr = '';
    try { envStr = String(auto.getEnv() || '').slice(0, 64); } catch (eV) {}
    /* TOTP + nonce + 签名: 防抓包伪造与重放 (签名覆盖身份与时间因子) */
    var seed = _monSeed();
    var nonce = _genNonce();
    var totp = _totp(seed, nowSec);
    var signParams = 'deviceId=' + ident[0] + '&uuid=' + ident[1] +
                     '&nonce=' + nonce + '&timestamp=' + nowSec + '&totp=' + totp;
    var sign = _hmacSha256(signParams, totp + seed);
    /* 上报修改变量内容: '修改变量'(或其指向变量)的内容 (网页可修改项的数据来源, 为空则网页不可修改) */
    var arrName = arrResolveName();
    var devEdit = '';
    if (arrName !== '') {
        var arrRaw = auto.getValue(arrName);
        if (arrRaw !== undefined && arrRaw !== null) devEdit = String(arrRaw);
    }
    /* 上报配置变量内容: '配置变量' 的内容 (网页第二组可修改项的数据来源, 为空则网页不可修改) */
    var devCfg = '';
    var cfgRaw = auto.getValue('配置变量');
    if (cfgRaw !== undefined && cfgRaw !== null) devCfg = String(cfgRaw);
    slog('上报: 修改变量=' + (arrName === '' ? '(未配置)' : arrName) + ' 修改变量内容=' + (devEdit === '' ? '(空)' : devEdit.length + 'B') +
         ' 配置变量内容=' + (devCfg === '' ? '(空)' : devCfg.length + 'B'));
    var payload = {
        deviceId: ident[0],
        uuid: ident[1],
        timestamp: nowSec,
        nonce: nonce,
        totp: totp,
        sign: sign,
        model: '',
        brand: '',
        product: '',
        screen: '',
        dpi: 0,
        taskCount: monReadNum(MON_TASK_FILE, 'mon_task_count'),
        errorCount: monReadNum(MON_ERR_FILE, 'mon_error_count'),
        lastError: monRead(MON_LASTERR_FILE, 'mon_last_error').slice(0, 240),
        uptimeSec: Math.max(nowSec - monStartSec, 0),
        note: gv('mon_note').slice(0, 240),
        battery: monBattery(),
        memTotalMb: mem[0],
        memAvailMb: mem[1],
        screenOn: screenOn,
        foregroundPkg: foreground,
        editorVer: editorVer,
        rtMs: monLastRtMs,
        env: envStr,
        androidVer: monAndroidVer(),
        ver: MON_VERSION,
        deviceUptimeSec: monDeviceUptime(),
        diskAvailMb: monDiskAvailMb(),
        orientation: '',
        hbGapSec: hbGapSec,
        batStatus: monBatStatus,
        gold: num('金币'),
        hp: num('血量'),
        floor: num('层数'),
        round: num('轮数'),
        /* 查看变量随心跳上报 (网页只读展示) */
        viewVar: gv('查看变量').slice(0, 65536),
        /* 修改变量内容随心跳上报 (网页可修改项的数据来源) */
        editVarDev: devEdit.slice(0, 65536),
        /* 配置变量内容随心跳上报 (网页第二组可修改项的数据来源) */
        configVarDev: devCfg.slice(0, 65536),
        /* 上发配置: 1=设备为新配置源 (服务端以设备上报内容反向覆盖下发基线);
         * 有未应用/未交付的下发时自动暂停 (uploadCfg=0), 防止设备旧内容覆盖基线
         * 冲掉网页人工修改 — 全部应用交付后恢复上发 (upHold 在 payload 构建前计算) */
        uploadCfg: (parseInt(auto.getValue('上发配置'), 10) === 1 && !upHold) ? 1 : 0
    };
    try {
        payload.model = String(device.model || '');
        payload.brand = String(device.brand || '');
        payload.product = String(device.product || '');
        /* 屏幕分辨率: 多级探测 (windowSize/capture/wm/device), device.width 不实时 */
        var ss = monScreenSize();
        payload.screen = (ss.w || 0) + 'x' + (ss.h || 0);
        /* 屏幕方向: 由分辨率宽高比推断, 辅助 UI 分析 */
        payload.orientation = ss.w > ss.h ? 'landscape' : (ss.w < ss.h ? 'portrait' : (ss.w > 0 ? 'square' : ''));
        if (ss.src) slog('屏幕分辨率[' + ss.src + ']: ' + payload.screen);
        payload.dpi = Math.max(Math.floor(parseFloat(device.dpi) || 0), 0);
    } catch (e2) {}
    try { http.addHeader('User-Agent', MON_UA); } catch (e3) {}
    /* 两参数形式, 与卡密插件 v2.js 真机验证过的用法一致;
     * 往返延迟: 前后 Date.now() 差值 (本周期算出, 下一周期随 payload.rtMs 上报);
     * mon_last_report 由调用方 monDoAll 在返回后写, 此处计算的心跳间隔基于上一轮 */
    var t0 = Date.now();
    var res = http.postJson(MON_SERVER + '/api/monitor/report', payload);
    monLastRtMs = Math.max(0, Date.now() - t0);
    return typeof res === 'string' ? res : (res && res.body) || JSON.stringify(res);
}

/* 拉取服务端变量 (网页端"修改变量/配置变量"组的下发内容), 数组写对应暂存并应用, 非数组直写对应变量;
 * 下发闭环: 请求体带 editAck/configAck (applied 文件里已应用的"上次修改"时间戳),
 * 服务端与存储内容比对一致则该组返回空 (停发同内容), 用户保存新内容 => 新时间戳自动恢复下发 */
function monFetchVars() {
    var nowSec = Math.floor(Date.now() / 1000);
    var ident = monEnsureIdentity();
    var seed = _monSeed();
    var nonce = _genNonce();
    var totp = _totp(seed, nowSec);
    var signParams = 'deviceId=' + ident[0] + '&uuid=' + ident[1] +
                     '&nonce=' + nonce + '&timestamp=' + nowSec + '&totp=' + totp;
    var sign = _hmacSha256(signParams, totp + seed);
    try { http.addHeader('User-Agent', MON_UA); } catch (e0) {}
    var res = http.postJson(MON_SERVER + '/api/monitor/vars', {
        deviceId: ident[0],
        uuid: ident[1],
        timestamp: nowSec,
        nonce: nonce,
        totp: totp,
        sign: sign,
        /* 下发确认回传: 已成功应用的"上次修改"时间戳 (applied 文件锚点),
         * 服务端比对一致则停发该组同内容, 形成下发闭环 */
        editAck: monRead(MON_PENDING_FILE + '.applied', 'mon_edit_pending_applied'),
        configAck: monRead(MON_CFG_PENDING_FILE + '.applied', 'mon_config_pending_applied')
    });
    var body = typeof res === 'string' ? res : (res && res.body) || '';
    try {
        var j = JSON.parse(String(body));
        if (j && j.success) {
            var edit = String(j.edit || '');
            var cfg = String(j.config || '');
            if (edit === '' && cfg === '') return 'empty';
            var syncOne = function (content, name, pFile, pVar, tag) {
                /* 数组 JSON 写暂存, 由下发应用比对"上次修改"时间戳后写回数据源变量
                 * (防心跳反复拉取覆盖本地自增); 非数组内容直写对应变量 (业务脚本自用约定) */
                var isArr = false;
                try { if (Array.isArray(JSON.parse(content))) isArr = true; } catch (e1) {}
                if (isArr) {
                    if (!monWrite(pFile, pVar, content)) slog('暂存写入失败: ' + tag);
                    /* 心跳内立即应用 (比对"上次修改"时间戳), 不依赖数组条件/动作的执行时机 */
                    try { arrApplyServerEdit(name, pFile, pVar); } catch (eA) { slog(tag + ' 下发应用异常: ' + (eA && eA.message ? eA.message : eA)); }
                    return 'pending:' + content.length + 'B';
                }
                sv(name, content);
                /* 非数组内容闭环: 回读一致才写锚点 (内容 SHA256, 服务端同源哈希比对后停发);
                 * 写不落地不写锚点 + 置 hold 标记 (上发暂停依据), 服务端下轮重新下发重试 */
                var chkN = gv(name);
                if (chkN === content) {
                    try { monWrite(pFile + '.applied', pVar + '_applied', _sha256(content)); } catch (eH) {}
                    try { monWrite(pFile + '.hold', pVar + '_hold', '0'); } catch (eH2) {}
                    return 'ok:' + content.length + 'B';
                }
                try { monWrite(pFile + '.hold', pVar + '_hold', '1'); } catch (eH3) {}
                slog(tag + ' 写入失败 (回读不符), 保留待下轮重试');
                return 'retry:' + content.length + 'B';
            };
            var rEdit = edit === '' ? '-' : syncOne(edit, arrResolveName(), MON_PENDING_FILE, 'mon_edit_pending', '修改变量');
            var rCfg = cfg === '' ? '-' : syncOne(cfg, cfgResolveName(), MON_CFG_PENDING_FILE, 'mon_config_pending', '配置变量');
            return '修改变量:' + rEdit + ' 配置变量:' + rCfg;
        }
        return 'fail:' + String((j && j.message) || '').slice(0, 60);
    } catch (e) { return 'parse-fail'; }
}

/* ==================== 缩略图 (截屏->缩放->imwrite->shell base64->上传) ====================
 * opencv 封装签名文档未给出, resize/imwrite 均做多形态兼容尝试;
 * 任一步失败返回空串放弃本张, 不影响心跳
 * 资源回收: Mat 是 native 内存 (全屏可达数 MB), release 后才真正归还;
 * 临时文件上传后立即删除; MON_USE_SHELL 关闭时整链跳过 (依赖 shell base64) */
function monMatRelease(m) {
    /* 编辑器 cv 文档: mat.delete() 释放原生内存, 防崩溃的关键 */
    if (!m) return;
    try { if (typeof m.delete === 'function') { m.delete(); return; } } catch (e) {}
    try { if (typeof m.release === 'function') { m.release(); return; } } catch (e2) {}
    try { if (typeof m.free === 'function') m.free(); } catch (e3) {}
}

function monFileExists(path) {
    if (typeof file !== 'undefined') {
        if (typeof file.exists === 'function') { try { return !!file.exists(path); } catch (e) {} }
        if (typeof file.exist === 'function') { try { return !!file.exist(path); } catch (e) {} }
    }
    if (typeof File !== 'undefined') {
        if (typeof File.exists === 'function') { try { return !!File.exists(path); } catch (e) {} }
        if (typeof File.exist === 'function') { try { return !!File.exist(path); } catch (e) {} }
    }
    return false;
}

function monTryImwrite(f, mat) {
    /* cv 文档样例: saveOk = cv.imwrite(path, mat, [IMWRITE_JPEG_QUALITY, q]) 有返回值; 以返回值+文件存在双判 */
    var isJpg = f.indexOf('.jpg') >= 0 || f.indexOf('.jpeg') >= 0;
    var ok = false;
    try { if (typeof cv !== 'undefined' && cv && cv.imwrite) { ok = isJpg ? !!cv.imwrite(f, mat, [cv.IMWRITE_JPEG_QUALITY, 80]) : !!cv.imwrite(f, mat); } } catch (e0) {}
    if (ok || monFileExists(f)) return true;
    try { if (typeof cv !== 'undefined' && cv && cv.imwrite) ok = !!cv.imwrite(mat, f); } catch (e2) {}   /* 反序兜底 */
    if (ok || monFileExists(f)) return true;
    try { if (typeof auto !== 'undefined' && auto.imwrite) ok = !!auto.imwrite(f, mat); } catch (e3) {}
    if (ok || monFileExists(f)) return true;
    try { ok = !!imwrite(f, mat); } catch (e4) {}
    return ok || monFileExists(f);
}

/* resize 自适应: 真机证实 cv.resize 为 OpenCV Java 签名 (src, dst, Size)
 * 返回 [结果Mat, 失败描述]; 结果为 null 时描述各形态异常 */
function monTryResize(mat, w, h) {
    var tags = [];
    var cvOK = false;
    try { cvOK = (typeof cv !== 'undefined' && cv && typeof cv.resize === 'function'); } catch (eN) {}
    if (!cvOK) {
        /* cv 不可用时退回 auto/全局/Mat 形态 */
        try { var a = auto.resize(mat, w, h); if (a) return [a, '']; } catch (eA) { tags.push('A(auto):' + String(eA && eA.message ? eA.message : eA).slice(0, 40)); }
        try { var b = resize(mat, w, h); if (b) return [b, '']; } catch (eB) { tags.push('B(global):' + String(eB && eB.message ? eB.message : eB).slice(0, 40)); }
        try { var c = mat.resize(w, h); if (c) return [c, '']; } catch (eC) { tags.push('C(mat):' + String(eC && eC.message ? eC.message : eC).slice(0, 40)); }
        return [null, tags.join(' ')];
    }
    /* E': cv.resize(src, dst, dsize, fx, fy, INTER_AREA), dst=clone; 6参为文档标准用法, 3参兜底(真机已验证) */
    var d = null;
    try { d = mat.clone(); } catch (eCl) { d = null; }
    if (!d) return [null, 'clone不可用'];
    try {
        try { cv.resize(mat, d, new cv.Size(w, h), 0, 0, cv.INTER_AREA); return [d, '']; } catch (eE6) { tags.push('E6(6参):' + String(eE6 && eE6.message ? eE6.message : eE6).slice(0, 50)); }
        try { cv.resize(mat, d, new cv.Size(w, h)); return [d, '']; } catch (eE) { tags.push('E(new Size):' + String(eE && eE.message ? eE.message : eE).slice(0, 50)); }
        /* K: dst 用空 Mat 重建 */
        var d2 = null;
        try { d2 = new cv.Mat(); } catch (eK0) { d2 = null; }
        if (d2) {
            try { cv.resize(mat, d2, new cv.Size(w, h)); monMatRelease(d); return [d2, '']; } catch (eK) { tags.push('K(newMat):' + String(eK && eK.message ? eK.message : eK).slice(0, 60)); monMatRelease(d2); d2 = null; }
        }
        monMatRelease(d); d = null;
    } catch (eX) { tags.push('X:' + String(eX && eX.message ? eX.message : eX).slice(0, 40)); monMatRelease(d); d = null; }
    return [null, tags.join(' ')];
}

/* 编辑器 cv 方法探测: opencv 方法挂在哪个命名空间由真机日志告知 */
function monProbeCv(mat) {
    var out = [];
    /* 1. cv / image 命名空间的方法枚举 (限 25 条防日志截断) */
    var holders = [];
    try { if (typeof cv !== 'undefined' && cv) holders.push(['cv', cv]); } catch (e1) {}
    try { if (typeof image !== 'undefined' && image) holders.push(['image', image]); } catch (e2) {}
    for (var h = 0; h < holders.length; h++) {
        var hk = [];
        try {
            for (var k in holders[h][1]) {
                if (/resiz|pyr|scale|img|mat|imread|imwrit|cvt|size|flip|rotat/i.test(k)) {
                    hk.push(k + '(' + typeof holders[h][1][k] + ')');
                    if (hk.length >= 25) break;
                }
            }
        } catch (e3) { hk.push('枚举失败:' + String(e3 && e3.message ? e3.message : e3).slice(0, 30)); }
        slog('缩略图[探测' + holders[h][0] + '] ' + hk.join(', '));
    }
    /* 2. auto 对象上与图像相关的方法名 */
    try {
        for (var k2 in auto) {
            if (/resiz|pyr|scale|img|mat|imread|imwrit|cvt|flip|rotat/i.test(k2)) out.push('auto.' + k2 + '(' + typeof auto[k2] + ')');
        }
    } catch (eA) { out.push('auto枚举失败:' + String(eA && eA.message ? eA.message : eA).slice(0, 40)); }
    slog('缩略图[探测auto] ' + out.join(', '));
    /* 3. Mat 实例可用方法名 (限 30 条防日志截断) */
    if (mat) {
        var mk = [];
        try {
            for (var k3 in mat) { mk.push(k3 + '(' + typeof mat[k3] + ')'); if (mk.length >= 30) break; }
        } catch (eM) { mk.push('mat枚举失败:' + String(eM && eM.message ? eM.message : eM).slice(0, 40)); }
        slog('缩略图[探测mat] ' + mk.join(', '));
    }
    return out;
}

/* 屏幕分辨率多级探测 (device.width/height 不可靠不实时, 旋转后不更新):
 * 1. windowSize (编辑器实时窗口尺寸) -> 2. 截图 Mat 尺寸 (所见即所得, 缩略图
 * 截屏时缓存 monScreenMatDim) -> 3. shell "wm size" (系统显示状态) ->
 * 4. device 兜底; 返回 {w, h, src: 来源标签}, 全部失败 w=h=0 */
function monScreenSize() {
    var out = { w: 0, h: 0, src: '' };
    /* 1. windowSize: 兼容对象 {width,height} 与数组 [w,h] 两种返回形态 */
    try {
        var ws = null;
        if (typeof windowSize === 'function') ws = windowSize();
        else if (typeof auto !== 'undefined' && auto && typeof auto.windowSize === 'function') ws = auto.windowSize();
        var ww = 0, wh = 0;
        if (ws && ws.width && ws.height) { ww = ws.width; wh = ws.height; }
        else if (ws && ws.length >= 2) { ww = ws[0]; wh = ws[1]; }
        if (ww > 50 && wh > 50) { out.w = ww; out.h = wh; out.src = 'windowSize'; }
    } catch (e1) {}
    /* 2. 截图 Mat 尺寸 (本周期缩略图链路截屏时已缓存) */
    if (!out.w) {
        try {
            var md = monScreenMatDim;
            if (md && md.w > 50 && md.h > 50) { out.w = md.w; out.h = md.h; out.src = 'capture'; }
        } catch (e2) {}
    }
    /* 3. shell "wm size": 输出形如 "Physical size: 1080x2340" */
    if (!out.w && MON_USE_SHELL) {
        try {
            var so = String(auto.shell('wm size') || '');
            var mS = so.match(/(\d{2,5})\s*x\s*(\d{2,5})/i);
            if (mS && parseInt(mS[1], 10) > 50 && parseInt(mS[2], 10) > 50) {
                out.w = parseInt(mS[1], 10); out.h = parseInt(mS[2], 10); out.src = 'wm';
            }
        } catch (e3) {}
    }
    /* 4. device 兜底 (原链路) */
    if (!out.w) {
        try { out.w = device.width || 0; out.h = device.height || 0; out.src = 'device'; } catch (e4) {}
    }
    return out;
}

function monThumbSmallFile() {
    /* cv 缩图链路: captureScreenMat -> cv.resize -> imwrite 落盘, 返回文件路径; 失败返回 '' */
    var mat = null, small = null, f = '';
    try {
        try { mat = auto.captureScreenMat(); } catch (eCap) { slog('缩略图[1截屏]异常: ' + (eCap && eCap.message ? eCap.message : eCap)); mat = null; }
        if (!mat) { slog('缩略图[1截屏]返回空: 检查编辑器截屏权限/授权弹窗'); return ''; }
        /* 空Mat检查 (cols/rows 无效会引发 resize "input size is zero") */
        var matOk = false;
        try { matOk = !!(mat.cols && mat.rows); } catch (eV) { matOk = true; }   /* cols不可访问时放行, 让resize自判 */
        /* 记录截图真实分辨率 (所见即所得, 供 monScreenSize 探测屏幕用) */
        if (matOk) { try { monScreenMatDim = { w: mat.cols || 0, h: mat.rows || 0 }; } catch (eS) {} }
        if (!matOk) { monMatRelease(mat); mat = null; slog('缩略图[1截屏]空Mat: 尺寸为0'); return ''; }
        var w = MON_THUMB_WIDTH;
        var h = Math.floor(w * 2.16);   /* 常见手机竖屏比例, 服务端会按真实比例再缩 */
        /* 横竖屏分开处理: cv.resize 为强制尺寸, 横图按竖比例 resize 会拉变形;
         * 按 Mat 实际宽高选目标方向, 尺寸读不到时保持竖序优先+反序兜底 */
        var mW = 0, mH = 0;
        try { mW = mat.cols || 0; mH = mat.rows || 0; } catch (eDim) { mW = 0; mH = 0; }
        var r1 = (mW > 0 && mH > 0 && mW > mH) ? monTryResize(mat, h, w) : monTryResize(mat, w, h);
        var small = r1[0];
        if (!small && mW <= 0 && mH <= 0) { r1 = monTryResize(mat, h, w); small = r1[0]; }
        /* 速度优先: 缩放失败直接放弃, 不上传全尺寸图; 顺带探测编辑器 cv 方法挂在哪 (须在 Mat 释放前) */
        if (!small) {
            try { monProbeCv(mat); } catch (eP) { slog('缩略图[探测]异常: ' + (eP && eP.message ? eP.message : eP)); }
            monMatRelease(mat); mat = null;
            slog('缩略图[2缩放]失败: ' + r1[1]);
            return '';
        }
        monMatRelease(mat); mat = null;   /* 全屏 Mat 立即归还 */
        f = MON_THUMB_FILE;
        if (!monTryImwrite(f, small)) {
            f = MON_DIR + '/t.png';
            if (!monTryImwrite(f, small)) {
                monMatRelease(small); small = null;
                slog('缩略图[3编码]失败: imwrite jpg/png 均未落盘');
                return '';
            }
        }
        monMatRelease(small); small = null;   /* 像素数据已落盘, 归还 */
        return f;
    } catch (e0) {
        slog('缩略图[?]异常: ' + (e0 && e0.message ? e0.message : e0));
        return '';
    } finally {
        monMatRelease(small);
        monMatRelease(mat);
    }
}

function monMakeThumbFile() {
    /* 双链路: 优先 cv 缩图 (15-30KB 快传); 失败退 auto.capture 全屏直传 (文档: auto.capture(path) 一步落盘, 大但稳) */
    var f = monThumbSmallFile();
    if (f) return f;
    try {
        auto.capture(MON_THUMB_FILE);
        if (monFileExists(MON_THUMB_FILE)) { slog('缩略图: cv链路失败, capture全屏兜底OK'); return MON_THUMB_FILE; }
        slog('缩略图[兜底]capture落盘失败');
    } catch (eC) { slog('缩略图[兜底]capture异常: ' + (eC && eC.message ? eC.message : eC)); }
    return '';
}

function monThumbUpload() {
    /* http.upload multipart 直传文件, 省掉 shell base64 (体积小 33%, 不依赖 shell) */
    var nowSec = Math.floor(Date.now() / 1000);
    var ident = monEnsureIdentity();
    var f = monMakeThumbFile();
    if (!f) return '';
    var seed = _monSeed();
    var nonce = _genNonce();
    var totp = _totp(seed, nowSec);
    var signParams = 'deviceId=' + ident[0] + '&uuid=' + ident[1] +
                     '&nonce=' + nonce + '&timestamp=' + nowSec + '&totp=' + totp;
    var sign = _hmacSha256(signParams, totp + seed);
    var data = {
        deviceId: ident[0],
        uuid: ident[1],
        timestamp: String(nowSec),
        nonce: nonce,
        totp: totp,
        sign: sign
    };
    var files = {};
    var baseName = f.indexOf('/t.png') >= 0 ? 't.png' : 't.jpg';
    files[baseName] = f;
    try { http.addHeader('User-Agent', MON_UA); } catch (e3) {}
    var res = http.upload(MON_SERVER + '/api/monitor/thumb', data, files);
    try { auto.shell('rm -f ' + f); } catch (eF) {}   /* 上传后清理临时文件 */
    return typeof res === 'string' ? res : (res && res.body) || '';
}

/* 服务端画面状态下发 (缩略图 dHash 对比 + 黑屏检测) 写入输出变量 '画面状态'
 * 值格式: 正常 | 静止(N秒) | 黑屏(N秒), 业务脚本 auto.getValue('画面状态') 读取判断 */
function monApplyScreen(rj) {
    try {
        var s = rj && rj.screen;
        if (!s || typeof s !== 'object') return;
        var txt;
        if (s.state === 'black') txt = '黑屏(' + Math.max(0, Number(s.black_sec) || 0) + '秒)';
        else if (s.state === 'static') txt = '静止(' + Math.max(0, Number(s.static_sec) || 0) + '秒)';
        else txt = '正常';
        sv('画面状态', txt);
    } catch (e) {}
}

/* 缩略图节流入口: 上报动作内调用, 120s 一张; force=true 时跳过节流 (首次必截)
 * 独立开关, 链路内部失败自动放弃本张 */
function monMaybeThumb(force) {
    if (!MON_USE_THUMB) return;
    try {
        var now = Date.now();
        var last = Number(monRead(MON_THUMB_LAST_FILE, 'mon_last_thumb') || '0');
        if (!force && last > 0 && now - last < MON_THUMB_INTERVAL_SEC * 1000 - 2000) return;
        monWrite(MON_THUMB_LAST_FILE, 'mon_last_thumb', String(now));
        var r = monThumbUpload();
        var ok = String(r).indexOf('"success":true') >= 0;
        var skipped = ok && String(r).indexOf('"skipped":true') >= 0;
        sv('监控缩略图结果', ok ? (skipped ? 'ok (服务端限频跳过)' : 'ok') : (r ? String(r).slice(0, 120) : '截图或编码失败'));
        slog('缩略图: ' + (ok ? (skipped ? '服务端限频内跳过 (图未更新)' : '成功') : (r ? '失败 ' + String(r).slice(0, 60) : '截图或编码失败')));
        /* 缩略图响应携带最新画面状态 (对比刚完成, 结果最及时) */
        if (ok && !skipped) { try { monApplyScreen(JSON.parse(String(r))); } catch (eS) {} }
    } catch (e) {}
}

/* ==================== 动作入口 ====================
 * 合并动作: 一次调用 = 错误收集 + 重置检查 + 心跳(含缩略图);
 * countTask=true (仅 动作类-累计任务执行) 才做任务累计
 * force=true (动作类-立即上报): 跳过 60s 心跳节流与 120s 缩略图节流,
 * 被调用立即上报回传, 不影响正常心跳节奏 (上次上报时间照常刷新)
 * 官方规范: auto.setValue 存结果 + break 结束, 无 return
 * 编辑器需导入: 输出 监控上报结果/状态/uuid; 输入 错误信息/重置监控(可选);
 *              输入 上报时间(可选, 心跳节流秒数, 默认 60, 0=每次调用立即上报);
 *              输入 上发配置(可选, 填 1 = 设备为新配置源, 服务端反向保存设备变量) */
function monDoAll(force, countTask) {
    var now = Date.now();
    var parts = [];
    /* 1. 任务累计: 仅 动作类-累计任务执行 (countTask=true) 触发, 其他动作不计数 */
    if (countTask) {
        var t = monReadNum(MON_TASK_FILE, 'mon_task_count') + 1;
        monWrite(MON_TASK_FILE, 'mon_task_count', String(t));
        parts.push('任务' + t);
        slog('任务累计: ' + t);
    }
    /* 2. 错误收集: '错误信息' 非空则计一次并清空 (防同一错误重复计数) */
    var msg = gv('错误信息');
    var ec = monReadNum(MON_ERR_FILE, 'mon_error_count');
    if (msg) {
        ec += 1;
        monWrite(MON_ERR_FILE, 'mon_error_count', String(ec));
        monWrite(MON_LASTERR_FILE, 'mon_last_error', msg.slice(0, 240));
        slog('错误累计: ' + ec + ' 最新: ' + msg.slice(0, 60));
        try { auto.setValue('错误信息', ''); } catch (eC) {}
        parts.push('错误' + ec);
    }
    /* 3. 重置指令: 业务脚本写 '重置监控'='1', 下一轮监控动作清零并写回 '0' */
    if (gv('重置监控') === '1') {
        monWrite(MON_TASK_FILE, 'mon_task_count', '0');
        monWrite(MON_ERR_FILE, 'mon_error_count', '0');
        monWrite(MON_LASTERR_FILE, 'mon_last_error', '');
        try { auto.setValue('重置监控', '0'); } catch (eR) {}
        slog('监控计数已重置 (任务/错误归零)');
        parts = ['任务0', '错误0'];
    }
    /* 4. 心跳上报 (节流默认 60s, 输入变量 上报时间 可改秒数, 0=每次调用立即上报;
     *    本周期第一次调用或 force=true 时强制上报, 含状态/uuid 写入与缩略图) */
    monLoopCount += 1;
    var firstCall = (monLoopCount === 1);
    var cfgSec = parseInt(auto.getValue('上报时间'), 10);
    if (isNaN(cfgSec) || cfgSec < 0) cfgSec = MON_INTERVAL_SEC;
    var lastRep = Number(monRead(MON_LASTREP_FILE, 'mon_last_report') || '0');
    if (force || cfgSec <= 0) slog('立即上报: 跳过心跳节流');
    if (!force && cfgSec > 0 && !firstCall && lastRep > 0 && now - lastRep < cfgSec * 1000 - 2000) {
        slog('心跳: 跳过 (距上次 < ' + cfgSec + 's)');
        parts.push('心跳跳过');
    } else {
        if (firstCall) slog('首次调用: 强制心跳+截图');
        /* 先拉取并应用网页下发 (数组内容比对"上次修改"时间戳后写回), 再上报, 本周期即带上新值;
         * 上发配置=1 也统一拉取: 服务端按 applied 锚点闭环停发已应用内容, 正常返回空;
         * 有未应用的下发时, 本周期上报自动暂停上发 (见 monPostReport), 防止设备旧内容
         * 反向覆盖基线把网页人工修改冲掉 (多设备同开上发时的串台拉锯根因) */
        try {
            var vr = monFetchVars();
            if (vr !== 'empty') slog('变量同步: ' + vr);
        } catch (eV) { slog('变量同步异常: ' + (eV && eV.message ? eV.message : eV)); }
        var resp = monPostReport();
        var ok = String(resp).indexOf('"success":true') >= 0;
        monWrite(MON_LASTREP_FILE, 'mon_last_report', String(now));
        parts.push(ok ? '心跳ok' : '心跳失败');
        slog('心跳上报: ' + (ok ? '成功' : '失败 ' + String(resp).slice(0, 100)));
        /* 服务端回传客户标记的设备状态, 写入变量 '状态' 供业务脚本判断;
         * 清零指令 (管理员状态页下发, 服务端已消费置 0): 本周期计数归零, 下次心跳上报 0 */
        try {
            var rj = JSON.parse(String(resp));
            if (rj && rj.success) {
                var st = String(rj.status || '').trim();
                sv('状态', st === '' ? '在线' : st);
                /* 服务端画面状态: 随心跳兜底下发 (缩略图响应为主通道) */
                monApplyScreen(rj);
                if (rj.resetCmd) {
                    monWrite(MON_TASK_FILE, 'mon_task_count', '0');
                    monWrite(MON_ERR_FILE, 'mon_error_count', '0');
                    monWrite(MON_LASTERR_FILE, 'mon_last_error', '');
                    try { auto.setValue('重置监控', '0'); } catch (eR) {}
                    slog('收到服务端清零指令: 任务/错误归零');
                    parts.push('清零');
                }
            }
        } catch (e2) {}
        monMaybeThumb(force || firstCall);
    }
    /* 5. 汇总写入结果变量 (单变量, 编辑器只导这一个就能看到全部结果) */
    var lastErr = monRead(MON_LASTERR_FILE, 'mon_last_error') || '';
    var summary = 'ok: ' + parts.join(' ') + (lastErr ? ' | 最近错误: ' + lastErr.slice(0, 40) : '');
    sv('监控上报结果', summary.slice(0, 200));
    slog('监控上报结果: ' + summary);
}

/* ==================== 数组变量条件/动作 (集成) ====================
 * 输入变量 (节点上建输入变量后 @全局变量, 编辑器把值传给插件):
 *   数组名      @数组全局变量 (插件一跳读值, 全部数组 case 共用);
 *               自增自减类写回需再建同名输出变量 "数组名" @同一全局变量
 *   匹配字段    按哪个字段定位条目, 默认 name
 *   匹配值      条目匹配值, 如 张三
 *   比较字段    条件类: 要比较的字段, 默认 count
 *   判断条件    条件类: 等于/不等于/大于/小于/包含/不包含/被包含
 *   比较值      条件类: 阈值, 如 2
 *   自增字段    动作类: 要自增自减的字段, 默认 count
 *   步长        动作类: 正数自增/负数自减, 默认 1
 * 功能清单:
 *   条件类-数组字段判断   判断数组内某条目字段是否符合条件, 返回 true/false
 *   动作类-数组字段自增   对数组内某条目字段自增并写回, 条目不存在自动新建
 *   动作类-数组字段自减   对数组内某条目字段自减并写回, 条目不存在自动新建
 *   动作类-数组字段自增自减 兼容旧配置: 步长正数自增/负数自减
 *   条件类-寻找数组       遍历数组全部条目 name 字段 (包含匹配), 命中返回 true
 *   动作类-数组点击       匹配库模式: 遍历匹配库([{"name":..,"count":..}]) 按
 *                         顺序用其 count ("x,y,w,h" 或 "x,y") 调编辑器 click()
 *                         点击; 匹配库方式 默认"是"=检测: 一次执行按顺位分别
 *                         点最多"点击"个(默认1) count>0 的条目, 各点1次减1写
 *                         回输出变量"匹配库", count 空置/非数字按1次, <=0跳过;
 *                         填"否"=不检测只点顺位第一命中项; 匹配库未配置或
 *                         数组名为空走匹配值模式;
 *                         输入变量 偏移x/偏移y (缺省0, 支持负数) 平移点击区域
 *   动作类-数组字符处理   输入变量 消除字符 (填什么删什么) + 格式 (默认数组,
 *                         纯文本按文本执行), 净化数据; 输出"数组名"@任意变量
 * 数据格式: [{"name":"李四","count":4},{"name":"张三","count":2}] */

/* 数据源变量名 (固定): 编辑器 @引用 传值, 手打变量名无效 (探针已验证),
 * "修改变量/配置变量"为节点输入/输出变量名, @ 对应全局变量即完成读写闭环 */
function arrResolveName() {
    return '修改变量';
}

/* 配置变量数据源: 与 arrResolveName 同构 (固定 '配置变量') */
function cfgResolveName() {
    return '配置变量';
}

/* 应用服务端下发: 暂存内容 (monFetchVars 写入) 为数组 JSON 时写入数据源变量。
 * 修改变量与配置变量各组独立暂存 (pendingFile/pendingVar 缺省为修改变量组);
 * 防重复双锚点: 1) applied 文件记录已应用的"上次修改"时间戳 (业务脚本写回变量
 * 会冲掉数组内"上次修改"条目导致重复应用, 文件锚点不受影响);
 * 2) 本地数组内"上次修改"条目比对 (兼容保留, 命中时补录文件锚点);
 * 时间戳一致即跳过并清暂存; 应用成功后把时间戳记入 applied 文件 */
function arrApplyServerEdit(varName, pendingFile, pendingVar) {
    var pFile = pendingFile || MON_PENDING_FILE;
    var pVar = pendingVar || 'mon_edit_pending';
    var aFile = pFile + '.applied';
    var aVar = pVar + '_applied';
    var edit = monRead(pFile, pVar);
    if (String(edit).trim() === '') return;
    edit = String(edit);
    var fresh = null;
    try {
        var parsed = JSON.parse(edit);
        if (Array.isArray(parsed)) fresh = parsed;
    } catch (e0) {}
    if (fresh === null) { monWrite(pFile, pVar, ''); return; }
    var stampNew = arrFind(fresh, 'name', '上次修改');
    var stampKey = stampNew ? String(stampNew.count) : '';
    /* 锚点1: applied 文件 (优先; 业务脚本覆盖数据源变量也不受影响) */
    if (stampKey !== '') {
        var applied = String(monRead(aFile, aVar) || '');
        if (applied === stampKey) {
            monWrite(pFile, pVar, '');
            slog('下发跳过 (已应用过): ' + varName + ' 上次修改=' + stampKey);
            return;
        }
    }
    /* 锚点2: 本地数组内"上次修改"条目 (兼容保留) */
    var cur = null;
    var raw = auto.getValue(varName);
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
        try {
            var parsedCur = JSON.parse(String(raw));
            if (Array.isArray(parsedCur)) cur = parsedCur;
        } catch (e1) {}
    }
    if (cur !== null && stampKey !== '') {
        var stampCur = arrFind(cur, 'name', '上次修改');
        if (stampCur !== null && String(stampCur.count) === stampKey) {
            monWrite(aFile, aVar, stampKey);
            monWrite(pFile, pVar, '');
            return;
        }
    }
    auto.setValue(varName, edit);
    var chk = gv(varName);
    if (chk === edit) {
        /* 回读一致才算应用成功: 清暂存 + 写锚点 (服务端据此停发) */
        monWrite(pFile, pVar, '');
        if (stampKey !== '') monWrite(aFile, aVar, stampKey);
        slog('已应用服务端下发变量: ' + varName + ' (' + edit.length + 'B, 上次修改=' + (stampNew ? stampNew.count : '无') + ')');
    } else {
        /* 编辑器部分周期 setValue 写不落地 (探针结论): 不写锚点、暂存保留,
         * 下轮心跳服务端重新下发重试, 防止"假应用"导致网页显示回退旧值 */
        slog('下发应用写入失败 (回读=' + (chk === '' ? '空' : chk.length + 'B') + ' != ' + edit.length + 'B), 保留待下轮重试: ' + varName);
    }
}

/* 一跳读取数组输入变量 "数组名" (@数组全局变量): 返回数组, 失败/为空返回 null */
function arrLoad() {
    var raw = auto.getValue('数组名');
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    try {
        var arr = JSON.parse(String(raw));
        return Array.isArray(arr) ? arr : null;
    } catch (e) {
        slog('数组解析失败: ' + String(raw).slice(0, 60));
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

/* 时间段字符串解析: "18:00-08:00"/"18-8"/"18:00-8"/"18:00:00-08:00:00"
 * 简写自动补全 ":00"; 全角"－"/"："先转半角; 起终均转分钟数, 无效返回 null;
 * 起终相同 (如 8-8) 视为零长度, 恒在外 */
function timeRangeParse(s) {
    var str = String(s === undefined || s === null ? '' : s).trim()
        .replace(/－/g, '-').replace(/：/g, ':');
    if (str === '') return null;
    var parts = str.split('-');
    if (parts.length !== 2) return null;
    var toMin = function (p) {
        p = String(p).trim();
        if (p === '') return NaN;
        var seg = p.split(':');
        var h = parseInt(seg[0], 10);
        if (isNaN(h) || h < 0 || h > 23) return NaN;
        var m = seg.length > 1 ? parseInt(seg[1], 10) : 0;
        if (isNaN(m) || m < 0 || m > 59) return NaN;
        return h * 60 + m;
    };
    var a = toMin(parts[0]);
    var b = toMin(parts[1]);
    if (isNaN(a) || isNaN(b)) return null;
    return { s: a, e: b };
}

/* 当前分钟是否在时间段内: 起终相同 (如 8-8) 视为零长度, 恒在外;
 * 起<终同天内; 起>终跨天 (>=起 或 <=终) */
function timeInRange(nowMin, range) {
    if (!range) return false;
    if (range.s === range.e) return false;
    if (range.s < range.e) return nowMin >= range.s && nowMin <= range.e;
    return nowMin >= range.s || nowMin <= range.e;
}

/* 行内精确点击区域计算: count 包围盒 ("x,y[,w,h]") 内按字符宽度等分,
 * 切出匹配值所在的字符格, 返回 "x,y,w,h" 区域字符串 (编辑器在区域中心点击);
 * 无 w/h (纯单点) 或无法推算时退回包围盒原样/原点 */
function clickPointInBox(name, matchVal, box) {
    var p = box.split(/[，,]/);
    if (p.length < 2) return null;
    var x = parseFloat(p[0]), y = parseFloat(p[1]);
    var w = p.length >= 3 ? parseFloat(p[2]) : 0;
    var h = p.length >= 4 ? parseFloat(p[3]) : 0;
    if (isNaN(x) || isNaN(y)) return null;
    if (isNaN(w) || w <= 0) w = 0;
    if (isNaN(h) || h <= 0) h = 0;
    var idx = matchVal === '' ? -1 : name.indexOf(matchVal);
    if (idx >= 0 && name.length > 0 && w > 0) {
        var cw = w / name.length;
        var gw = Math.max(Math.round(cw * matchVal.length), 1);
        return Math.round(x + idx * cw) + ',' + Math.round(y) + ',' + gw + ',' + Math.max(Math.round(h), 1);
    }
    if (w > 0 && h > 0) return Math.round(x) + ',' + Math.round(y) + ',' + Math.round(w) + ',' + Math.round(h);
    return Math.round(x) + ',' + Math.round(y);
}

/* 逐字符删除: 从 s 中删掉 chars 里出现的每个字符 (标点/数字/任意文字, 填什么删什么) */
function stripChars(s, chars) {
    var out = s;
    for (var i = 0; i < chars.length; i++) {
        var ch = chars.charAt(i);
        if (ch !== '') out = out.split(ch).join('');
    }
    return out;
}

/* 匹配库列表挑选: 按列表顺序收集前 limit 个 name 命中且坐标有效的条目;
 * checkCnt=true (检测模式) 时 count 空置/非数字按 1 次, count<=0 的条目跳过;
 * 返回 [{item: 列表项, name: 匹配值, cnt: 次数, hit: 数据源条目}, ...] */
function multiPickList(srcArr, list, limit, checkCnt) {
    var out = [];
    for (var i = 0; i < list.length && out.length < limit; i++) {
        var it = list[i];
        if (!it || typeof it !== 'object') continue;
        var nm = String(it.name === undefined ? '' : it.name).trim();
        if (nm === '') continue;
        var cnt = parseInt(it.count, 10);
        if (isNaN(cnt)) cnt = 1;
        if (checkCnt && cnt <= 0) continue;
        for (var j = 0; j < srcArr.length; j++) {
            var sj = srcArr[j];
            if (sj && typeof sj === 'object' &&
                String(sj.name === undefined ? '' : sj.name).indexOf(nm) >= 0) {
                var hc = String(sj.count === undefined ? '' : sj.count).trim();
                if (hc === '' || !/^[0-9,，\s]+$/.test(hc)) continue;
                out.push({ item: it, name: nm, cnt: cnt, hit: sj });
                break;
            }
        }
    }
    return out;
}

/* 点击偏移: 输入变量 偏移x/偏移y (直接填数字或 @变量), 缺省 0, 支持负数;
 * 用于手动补偿 OCR 坐标系与实际点击位置的偏差 */
function clickOffset() {
    var ox = parseInt(auto.getValue('偏移x'), 10);
    var oy = parseInt(auto.getValue('偏移y'), 10);
    return [isNaN(ox) ? 0 : ox, isNaN(oy) ? 0 : oy];
}

/* 对 "x,y[,w,h]" 区域串应用偏移: 只平移 x/y, w/h 与区域模式保持不变 */
function ptShift(pt, dx, dy) {
    if (pt === null || (dx === 0 && dy === 0)) return pt;
    var p = pt.split(/[，,]/);
    if (p.length < 2) return pt;
    var out = [Math.round(parseFloat(p[0]) + dx), Math.round(parseFloat(p[1]) + dy)];
    for (var i = 2; i < p.length; i++) out.push(Math.round(parseFloat(p[i])));
    return out.join(',');
}

/* 偏移非零时生成日志后缀 */
function offSuffix(off) {
    return (off[0] === 0 && off[1] === 0) ? '' : ' (偏移 ' + off[0] + ',' + off[1] + ')';
}

/* 自增/自减共用实现: inc=true 加, false 减; 步长取绝对值, 条目不存在自动新建。
 * 写回走输出变量 "数组名" (节点须配置输出变量 @同一数组全局变量) */
function arrIncDec(inc) {
    var kField = auto.getValue('匹配字段') || 'name';
    var mVal = auto.getValue('匹配值') || '';
    var iField = auto.getValue('自增字段') || 'count';
    var step = parseInt(auto.getValue('步长') || '1', 10);
    if (isNaN(step)) step = 1;
    step = Math.abs(step);
    var arr = arrLoad();
    if (arr === null) arr = [];
    var it = arrFind(arr, kField, mVal);
    if (it === null) {
        var fresh = {};
        fresh[kField] = mVal;
        fresh[iField] = inc ? step : -step;
        arr.push(fresh);
        it = fresh;
    } else {
        var cur = parseInt(it[iField], 10);
        if (isNaN(cur)) cur = 0;
        it[iField] = inc ? cur + step : cur - step;
    }
    auto.setValue('数组名', JSON.stringify(arr));
    slog((inc ? '自增' : '自减') + ': ' + mVal + ' 的 ' + iField + ' => ' + it[iField] + ' (步长 ' + step + ')');
    return it[iField];
}

function loop(action) {
    try {
        switch (action) {
            case '动作类-监控上报':
                monDoAll();
                break;
            case '动作类-上报运行状态':
                monDoAll();
                break;
            /* 仅此动作任务计数 +1 (其余动作只走错误/重置/心跳链) */
            case '动作类-累计任务执行':
                monDoAll(false, true);
                break;
            case '动作类-记录运行错误':
                monDoAll();
                break;
            case '动作类-重置监控计数':
                monDoAll();
                break;
            /* 动作类: 被调用立即执行一次完整监控上报 (错误/重置检查 + 心跳 +
             * 缩略图 + 服务端回传写'状态'), 跳过 60s 心跳节流与 120s 缩略图节流 */
            case '动作类-立即上报':
                monDoAll(true);
                break;
            /* 条件类: 判断数组内某条目字段是否符合条件, 返回 true/false
             * 范式对齐时间段插件: case 双引号 + 块内单一 return 在末尾 + 失败路径不提前 return */
            case "条件类-数组字段判断": {
                var keyField = auto.getValue('匹配字段') || 'name';
                var matchVal = auto.getValue('匹配值') || '';
                var cmpField = auto.getValue('比较字段') || 'count';
                var cond = auto.getValue('判断条件') || '等于';
                var cmpVal = auto.getValue('比较值') || '';
                var res = false;
                var arr = arrLoad();
                if (arr === null) {
                    slog('数组为空或解析失败 (检查输入变量 数组名 是否已@数组变量)');
                } else {
                    var it = arrFind(arr, keyField, matchVal);
                    if (it === null) {
                        slog('未找到条目: ' + keyField + '=' + matchVal);
                    } else {
                        res = condCheck(cond, it[cmpField], cmpVal);
                    }
                }
                slog('条件判断: ' + matchVal + ' 的 ' + cmpField + '=' + cond + ' ' + cmpVal + ' => ' + res);
                return res;
            }
            /* 条件类: 取数组条目 (匹配字段=匹配值) 的比较字段值作为时间段字符串,
             * 判断当前时间(设备本地)在内/外; 跨天 (18:00-08:00) 与简写 (18-8) 均可;
             * 判断条件: 内(默认)/外 (兼容 在内/在外); 数组/条目/格式异常 => false */
            case "条件类-时间段判断": {
                var keyFieldT = auto.getValue('匹配字段') || 'name';
                var matchValT = auto.getValue('匹配值') || '';
                var cmpFieldT = auto.getValue('比较字段') || 'count';
                var condT = String(auto.getValue('判断条件') || '内');
                var resT = false;
                var arrT = arrLoad();
                if (arrT === null) {
                    slog('数组为空或解析失败 (检查输入变量 数组名 是否已@数组变量)');
                } else {
                    var itT = arrFind(arrT, keyFieldT, matchValT);
                    if (itT === null) {
                        slog('未找到条目: ' + keyFieldT + '=' + matchValT);
                    } else {
                        var rangeT = timeRangeParse(itT[cmpFieldT]);
                        if (rangeT === null) {
                            slog('时间段格式无效: ' + matchValT + ' 的 ' + cmpFieldT + '=' + itT[cmpFieldT] + ' (例 18:00-08:00 / 18-8)');
                        } else {
                            var ndT = new Date();
                            var inT = timeInRange(ndT.getHours() * 60 + ndT.getMinutes(), rangeT);
                            resT = (condT.indexOf('外') >= 0) ? !inT : inT;
                        }
                    }
                }
                slog('时间段判断: ' + matchValT + ' 的 ' + cmpFieldT + '=' + (itT ? itT[cmpFieldT] : '-') + ' 条件=' + condT + ' => ' + resT);
                return resT;
            }
            /* 动作类: 数组内某条目字段自增, 写回输出变量"数组名"; 条目不存在时自动新建 (步长取绝对值, 默认 1) */
            case "动作类-数组字段自增": {
                return arrIncDec(true);
            }
            /* 动作类: 数组内某条目字段自减, 写回输出变量"数组名"; 条目不存在时自动新建 (步长取绝对值, 默认 1) */
            case "动作类-数组字段自减": {
                return arrIncDec(false);
            }
            /* 兼容旧动作名: 步长正数自增/负数自减 */
            case "动作类-数组字段自增自减": {
                var kField = auto.getValue('匹配字段') || 'name';
                var mVal = auto.getValue('匹配值') || '';
                var iField = auto.getValue('自增字段') || 'count';
                var step = parseInt(auto.getValue('步长') || '1', 10);
                if (isNaN(step)) step = 1;
                var arr2 = arrLoad();
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
                auto.setValue('数组名', JSON.stringify(arr2));
                slog('自增自减: ' + mVal + ' 的 ' + iField + ' => ' + it2[iField] + ' (步长 ' + step + ')');
                break;
            }
            /* 条件类: 输入变量 数组名(@数组全局变量)+匹配值, 遍历数组全部条目 name 字段
             * (包含匹配), 任一条目命中返回 true */
            case "条件类-寻找数组": {
                var fV = String(auto.getValue('匹配值') || '').trim();
                var fRes = false;
                var fArr = arrLoad();
                if (fArr !== null && fV !== '') {
                    for (var fi = 0; fi < fArr.length; fi++) {
                        var fit = fArr[fi];
                        if (fit && typeof fit === 'object' &&
                            String(fit.name === undefined ? '' : fit.name).indexOf(fV) >= 0) {
                            fRes = true;
                            break;
                        }
                    }
                }
                slog('寻找数组: name含"' + fV + '" => ' + fRes);
                return fRes;
            }
            /* 动作类: 输入变量 数组名(@数组全局变量)+匹配值+匹配库(@匹配库变量)+匹配库方式+点击,
             * 匹配库格式 [{"name":"萧何赠礼","count":3}]:
             * 匹配库方式 默认"是"=检测, count 为剩余次数, 一次执行按顺位分别点
             * 最多"点击"个 (默认 1) 命中且 count>0 的条目, 每条目点 1 次后次数
             * 减1写回输出变量"匹配库" (节点须配置输出变量 @同一匹配库变量,
             * 否则次数不会减少); count 空置/非数字 (如"是") 按 1 次算, 写回覆盖
             * 为数字; count<=0 跳过; 匹配库方式 填"否"=不检测, count 不动不写回,
             * 只点顺位第一命中项 (优先级高的一直点, 老配置 name 同为不检测);
             * 匹配库未配置或数组名为空时走匹配值逻辑 (找 name 命中的第一个条目),
             * 不点整个 count 区域: 按 name 字符宽度等分切出匹配值所在字符格区域
             * (如 name=發發中 匹配 中 => 只点"中"字那格, 编辑器在区域中心点击),
             * 调编辑器 click() 点击一次; 只输出日志, 返回日志字符串 */
            case "动作类-数组点击": {
                var cArr = arrLoad();
                var libRaw = auto.getValue('匹配库');
                var libArr = null;
                if (libRaw !== undefined && libRaw !== null && String(libRaw).trim() !== '') {
                    try {
                        var la = JSON.parse(String(libRaw));
                        libArr = Array.isArray(la) ? la : null;
                    } catch (eL) {
                        slog('数组点击: 匹配库解析失败, 走匹配值 (' + String(libRaw).slice(0, 40) + ')');
                    }
                }
                if (libArr !== null && cArr !== null && libArr.length > 0) {
                    /* 匹配库方式: 默认"是"=检测 (count 为次数, 点后减1写回输出
                     * 变量"匹配库", 必配否则次数不减; count 空置/非数字按 1 次,
                     * <=0 跳过), 一次执行按顺位分别点最多"点击"个条目 (各点1次);
                     * 填"否"=不检测 (count 不动不写回, 老配置 name 同为不检测),
                     * 只点顺位第一命中项, 优先级高的一直点。
                     * 点击: 默认 1, 检测模式下一次执行最多点击的条目数 */
                    var mRaw1 = String(auto.getValue('匹配库方式') || '').trim();
                    var mChk = !(mRaw1 === '否' || mRaw1 === 'name');
                    var mDef = parseInt(auto.getValue('点击'), 10);
                    if (isNaN(mDef) || mDef < 1) mDef = 1;
                    var mPicks = multiPickList(cArr, libArr, mChk ? mDef : 1, mChk);
                    if (mPicks.length > 0) {
                        var mOff = clickOffset();
                        var mNames = [];
                        for (var mi = 0; mi < mPicks.length; mi++) {
                            var mp = mPicks[mi];
                            var mhName = String(mp.hit.name === undefined ? '' : mp.hit.name);
                            var mhCnt = String(mp.hit.count === undefined ? '' : mp.hit.count).trim();
                            var mPt = ptShift(clickPointInBox(mhName, mp.name, mhCnt), mOff[0], mOff[1]);
                            if (mPt === null) {
                                slog('数组点击: 匹配库 ' + mp.name + ' 坐标解析失败 (' + mhCnt + ')');
                                continue;
                            }
                            try { click(mPt); } catch (eC2) { slog('数组点击异常: ' + (eC2 && eC2.message ? eC2.message : eC2)); }
                            if (mChk) {
                                mp.item.count = mp.cnt - 1;
                                slog('数组点击: ' + mp.name + ' @ [' + mhName + '|' + mhCnt + '] => ' + mPt + ', 剩余 ' + (mp.cnt - 1) + offSuffix(mOff));
                            } else {
                                slog('数组点击: ' + mp.name + ' @ [' + mhName + '|' + mhCnt + '] => ' + mPt + ' (不检测count)' + offSuffix(mOff));
                            }
                            mNames.push(mp.name);
                        }
                        if (mNames.length > 0) {
                            if (mChk) auto.setValue('匹配库', JSON.stringify(libArr));
                            return '已点击' + (mNames.length > 1 ? ' ' + mNames.length + ' 项' : '') + ': ' + mNames.join(',');
                        }
                    } else {
                        slog('数组点击: 匹配库无可用条目 (全未命中或次数用完), 走匹配值');
                    }
                }
                var cV = String(auto.getValue('匹配值') || '').trim();
                /* 匹配值多值: | 分隔按填写顺序优先匹配 (如 萧何|韩信|张良),
                 * 逐个值按数组顺序找第一个 name 命中条目, 命中即用该值切格点击 */
                var cList = cV === '' ? [] : cV.split('|');
                var cHit = null, cVal = '';
                if (cArr !== null && cList.length > 0) {
                    for (var ck = 0; ck < cList.length && cHit === null; ck++) {
                        var cv1 = cList[ck].trim();
                        if (cv1 === '') continue;
                        for (var ci = 0; ci < cArr.length; ci++) {
                            var cit = cArr[ci];
                            if (cit && typeof cit === 'object' &&
                                String(cit.name === undefined ? '' : cit.name).indexOf(cv1) >= 0) {
                                cHit = cit;
                                cVal = cv1;
                                break;
                            }
                        }
                    }
                }
                var cCnt = cHit === null ? '' : String(cHit.count === undefined ? '' : cHit.count).trim();
                if (cCnt === '' || !/^[0-9,，\s]+$/.test(cCnt)) {
                    slog('数组点击: 未找到 ' + cV + ' 或坐标无效 (' + (cCnt === '' ? '空' : cCnt) + ')');
                    return '未点击: ' + (cHit === null ? '未找到 ' + cV : '坐标无效 ' + cCnt);
                }
                var cName = String(cHit.name === undefined ? '' : cHit.name);
                var cOff = clickOffset();
                var cPt = ptShift(clickPointInBox(cName, cVal, cCnt), cOff[0], cOff[1]);
                if (cPt === null) {
                    slog('数组点击: 坐标解析失败 (' + cCnt + ')');
                    return '未点击: 坐标解析失败 ' + cCnt;
                }
                try { click(cPt); } catch (eC) { slog('数组点击异常: ' + (eC && eC.message ? eC.message : eC)); }
                slog('数组点击: ' + cVal + ' @ [' + cName + '|' + cCnt + '] => ' + cPt + offSuffix(cOff) + (cList.length > 1 ? ' (多值优先级命中)' : ''));
                return '已点击: ' + cVal + ' => ' + cPt;
            }
            /* 动作类: 输入变量 数组名(@数据源变量)+消除字符(直接输入内容)+格式(直接填, 默认数组),
             * 格式=数组 (默认): 数据源按 JSON 数组解析, 每个条目 name 逐字符删除
             * 消除字符 (填什么删什么) 后 trim, 结果 JSON 写回输出变量"数组名";
             * 格式=纯文本: 数据源按纯文本执行, 整段文本逐字符消除后 trim 写回;
             * 输出只有一个变量"数组名", 写回目标由用户 @ 任意全局变量决定 (@谁写谁) */
            case "动作类-数组字符处理": {
                var sFmt = String(auto.getValue('格式') === undefined || auto.getValue('格式') === null ? '' : auto.getValue('格式')).trim() || '数组';
                var sSrc = auto.getValue('数组名');
                if (sSrc === undefined || sSrc === null || String(sSrc).trim() === '') {
                    slog('字符处理: 数据源为空 (检查输入变量 数组名 是否已@变量)');
                    return '未处理: 数据源为空';
                }
                var sRaw = auto.getValue('消除字符');
                var sChars = String(sRaw === undefined || sRaw === null ? '' : sRaw);
                if (sFmt === '纯文本') {
                    var sTxt = stripChars(String(sSrc), sChars).trim();
                    auto.setValue('数组名', sTxt);
                    slog('字符处理(纯文本): 消除[' + sChars + '] => [' + sTxt.slice(0, 80) + '], 已写回输出变量 数组名');
                    return '已处理: ' + sTxt.slice(0, 80);
                }
                var sArr = null;
                try {
                    var sa = JSON.parse(String(sSrc));
                    sArr = Array.isArray(sa) ? sa : null;
                } catch (eS) {}
                if (sArr === null) {
                    slog('字符处理: 数组解析失败 (检查数据源是否为数组 JSON, 或改格式=纯文本)');
                    return '未处理: 解析失败';
                }
                var sNames = [];
                for (var si = 0; si < sArr.length; si++) {
                    var sit = sArr[si];
                    if (!sit || typeof sit !== 'object') continue;
                    sit.name = stripChars(String(sit.name === undefined ? '' : sit.name), sChars).trim();
                    sNames.push(sit.name);
                }
                auto.setValue('数组名', JSON.stringify(sArr));
                slog('字符处理(数组): 消除[' + sChars + '] => [' + sNames.join(' | ') + '], 已写回输出变量 数组名');
                return '已处理: ' + sNames.join(' | ');
            }
            default:
                slog('未知功能: ' + action);
                return false;
        }
    } catch (err) {
        slog('插件执行异常: ' + (err && err.message ? err.message : err));
        try { auto.setValue('mon_last_error', String(err && err.message ? err.message : err).slice(0, 240)); } catch (e2) {}
        return false;
    }
}

/* ==================== 初始化 ==================== */
function setup() {
    try { if (typeof auto === 'undefined' || typeof http === 'undefined') { slog('监控插件警告: 缺少 auto/http 全局对象'); return; } } catch (e0) {}
    try {
        monStartSec = Math.floor(Date.now() / 1000);
        monLoopCount = 0;   /* 每次插件启动重新计数, 首次调用强制心跳+截图 */
        var ident = monEnsureIdentity();
        slog('监控插件初始化完成, 设备标识: ' + ident[0] + ', 设备UUID: ' + ident[1] + ', 上报间隔: ' + MON_INTERVAL_SEC + 's');
        slog('>>> 设备UUID已写入变量 uuid, 业务脚本可用 auto.getValue(\'uuid\') 读取');
        slog('>>> 查询本设备状态请访问状态页并输入 UUID: ' + ident[1]);
    } catch (e) {
        slog('监控初始化异常(已忽略): ' + e.message);
    }
    /* 环境健康检查: 数组点击功能依赖编辑器配置的输入变量 (一跳传值机制),
     * 两个核心变量全空说明编辑器侧未配置或未导入, 提前明确告知避免上线后排查 */
    try {
        if (gv('修改变量') === '' && gv('配置变量') === '') {
            slog('>>> 环境警告: 输入变量"修改变量"与"配置变量"均为空, 数组点击功能将无法匹配目标! 请检查编辑器中本节点的输入变量配置 (数组点击 case 需这两个变量)');
        }
    } catch (eH) {}
}
