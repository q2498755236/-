const fs = require('fs');
const src = fs.readFileSync(__dirname + "/monitor.js", 'utf8');
function cut(a, b) { const i = src.indexOf(a), j = src.indexOf(b, i); if (i<0||j<0) throw new Error(a); return src.slice(i,j); }
const code = [
    cut('function monApplyScreen(', '\n/* '),
    cut('function monThumbUpload(', '\n/* 服务端画面状态'),
].join('\n');
let sent = null, shells = [], svs = {}, logs = [], threadUsed = false;
const auto = { shell: function (c) { shells.push(c); if (c.indexOf('base64') === 0) return 'iVBORw0KGgo' + 'A'.repeat(120) + '\nAAAANS\n'; return ''; } };
const http = { postJson: function (url, data) { sent = { url: url, data: data }; return '{"success":true,"screen":{"state":"normal","static_sec":1}}'; } };
const threads = { start: function (fn) { threadUsed = true; fn(); } };
var sv = function (k, v) { svs[k] = v; };
var slog = function (m) { logs.push(m); };
const monEnsureIdentity = function () { return ['DEV1', 'UUID-1']; };
const monMakeThumbFile = function () { return '/sdcard/.mon_monitor/t.jpg'; };
const _monSeed = function () { return 'JBSWY3DPEHPK3PXP'; };
const _genNonce = function () { return 'nonce12345678'; };
const _totp = function () { return '123456'; };
const _hmacSha256 = function () { return 'a'.repeat(64); };
const MON_SERVER = 'https://srv';
const MON_USE_SHELL = true;
const MON_UA = 'ua';
eval(code);
function ck(n, c) { console.log((c ? 'PASS ' : 'FAIL ') + n + (c?'':' | logs='+logs.join(' // '))); if (!c) process.exitCode = 1; }
monThumbUpload();
ck('走 threads 子线程', threadUsed);
ck('URL 正确', sent && sent.url === 'https://srv/api/monitor/thumb');
ck('带 img base64 且无换行', sent && sent.data.img.length > 100 && sent.data.img.indexOf('\n') < 0);
ck('签名参数齐备', sent && sent.data.deviceId === 'DEV1' && sent.data.uuid === 'UUID-1' && String(sent.data.sign).length === 64);
ck('无 files 字段(不再 multipart)', sent && sent.data.files === undefined);
ck('结果变量 ok', svs['监控缩略图结果'] === 'ok');
ck('临时文件已删', shells.some(c => c.indexOf('rm -f') === 0));
ck('画面状态已应用', svs['画面静止秒'] === '1');
/* base64 过短 => 放弃 */
sent = null; svs = {}; shells = [];
auto.shell = function (c) { shells.push(c); return c.indexOf('base64') === 0 ? 'xx' : ''; };
monThumbUpload();
ck('base64 过短放弃不发送', sent === null);
