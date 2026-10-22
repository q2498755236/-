const fs = require("fs");
const src = fs.readFileSync(__dirname + "/monitor.js", 'utf8');
function cut(startMark, endMark) {
    const i = src.indexOf(startMark);
    if (i < 0) throw new Error('not found: ' + startMark);
    const j = src.indexOf(endMark, i);
    if (j < 0) throw new Error('end not found: ' + endMark);
    return src.slice(i, j);
}
const code = [
    cut('function slog(', '\nfunction monRead('),
    cut('function arrFind(', '\nfunction '),
    cut('function arrSemanticEq(', '/* 应用服务端下发:'),
    cut('function arrApplyServerEdit(', '\n/* 一跳读取数组输入变量'),
].join('\n');
/* mock 设备环境 (先于 eval, 供被测函数引用) */
const store = {};
var logs = [];
var auto = {
    getValue: function (k) { return store[k]; },
    setValue: function (k, v) { store[k] = String(v); }
};
var __fs = {};
var slog = function (m) { logs.push(m); };
eval(code);
/* 覆盖为内存版文件系统 (eval 声明的 monRead/monWrite 在本作用域可直接重赋值) */
monRead = function (path, name) { var f = __fs[path] || {}; return f[name] === undefined ? '' : String(f[name]); };
monWrite = function (path, name, v) { var f = __fs[path] || (__fs[path] = {}); f[name] = String(v); };
var gv = function (k, fb) { var v = store[k]; return (v === undefined || v === null) ? (fb === undefined ? '' : fb) : String(v); };

function resetEnv() {
    for (var k in store) delete store[k];
    __fs = {};
    logs = [];
    auto.getValue = function (k) { return store[k]; };
    auto.setValue = function (k, v) { store[k] = String(v); };
}
const BASE = JSON.stringify([{name:'萧何赠礼',count:3},{name:'抢红包',count:'抢'},{name:'上次修改',count:'T1'}]);
const CHANGED = JSON.stringify([{name:'萧何赠礼',count:1},{name:'抢红包',count:'抢'},{name:'上次修改',count:'T1'}]);
let t = 0, f = 0;
function ck(name, cond) { if (cond) { t++; console.log('PASS', name); } else { f++; console.log('FAIL', name, '| logs:', logs.join(' // ')); } }

/* S1: 锚点命中+本地语义等 => 跳过 */
resetEnv();
__fs['p.applied'] = {mon_edit_pending_applied: 'T1'};
store['修改变量'] = BASE;
__fs['p'] = {mon_edit_pending: BASE};
arrApplyServerEdit('修改变量', 'p', 'mon_edit_pending');
ck('S1 跳过且清暂存', __fs['p'].mon_edit_pending === '' && store['修改变量'] === BASE);

/* S2: 锚点命中+本地被业务改写 => 重新应用基线 */
resetEnv();
__fs['p.applied'] = {mon_edit_pending_applied: 'T1'};
store['修改变量'] = CHANGED;
__fs['p'] = {mon_edit_pending: BASE};
arrApplyServerEdit('修改变量', 'p', 'mon_edit_pending');
ck('S2 重应用恢复基线', store['修改变量'] === BASE);
ck('S2 清暂存+锚点保持', __fs['p'].mon_edit_pending === '' && __fs['p.applied'].mon_edit_pending_applied === 'T1');

/* S3: 锚点命中+本地损坏(非数组) => 重应用 */
resetEnv();
__fs['p.applied'] = {mon_edit_pending_applied: 'T1'};
store['修改变量'] = 'not-json';
__fs['p'] = {mon_edit_pending: BASE};
arrApplyServerEdit('修改变量', 'p', 'mon_edit_pending');
ck('S3 本地损坏重应用', store['修改变量'] === BASE);

/* S4: 锚点空 => 正常应用并写锚点 */
resetEnv();
__fs['p'] = {mon_edit_pending: BASE};
arrApplyServerEdit('修改变量', 'p', 'mon_edit_pending');
ck('S4 正常应用', store['修改变量'] === BASE && __fs['p.applied'].mon_edit_pending_applied === 'T1' && __fs['p'].mon_edit_pending === '');

/* S5: 锚点丢+本地章同+语义等 => 锚点2 补录跳过 */
resetEnv();
store['修改变量'] = BASE;
__fs['p'] = {mon_edit_pending: BASE};
arrApplyServerEdit('修改变量', 'p', 'mon_edit_pending');
ck('S5 锚点2补录跳过', __fs['p.applied'].mon_edit_pending_applied === 'T1' && __fs['p'].mon_edit_pending === '' && store['修改变量'] === BASE);

/* S6: 锚点丢+本地章同但语义不等 => 重应用 */
resetEnv();
store['修改变量'] = CHANGED;
__fs['p'] = {mon_edit_pending: BASE};
arrApplyServerEdit('修改变量', 'p', 'mon_edit_pending');
ck('S6 章同但值偏 重应用', store['修改变量'] === BASE && __fs['p.applied'].mon_edit_pending_applied === 'T1');

/* S7: 应用写不落地 => 暂存保留不写锚点 */
resetEnv();
__fs['p'] = {mon_edit_pending: BASE};
auto.setValue = function () {};
arrApplyServerEdit('修改变量', 'p', 'mon_edit_pending');
ck('S7 写失败保留暂存', __fs['p'].mon_edit_pending === BASE && !__fs['p.applied']);

/* S8: pretty 格式本地 => 语义等跳过 (本地不被覆盖) */
resetEnv();
__fs['p.applied'] = {mon_edit_pending_applied: 'T1'};
store['修改变量'] = JSON.stringify([{count:'抢',name:'抢红包'},{count:3,name:'萧何赠礼'}], null, 2);
__fs['p'] = {mon_edit_pending: BASE};
arrApplyServerEdit('修改变量', 'p', 'mon_edit_pending');
ck('S8 pretty本地语义等跳过', store['修改变量'] !== BASE && __fs['p'].mon_edit_pending === '');
console.log(t + ' passed, ' + f + ' failed');
process.exit(f > 0 ? 1 : 0);
