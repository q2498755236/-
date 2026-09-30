/**
 * 灵眸 v4.3 - 编辑器复刻层: HTTP 控制口
 * 对齐编辑器 EditorService (NanoHTTPD 端口 11243) 语义:
 *   GET  /console -> {code:0, port:11243}          免白名单 (探活)
 *   POST /run     body {code|file_name, name, verify_code} Base64
 *                 code 分支直接执行 (无白名单); file_name 分支校验白名单
 *   POST /stop /sync -> 白名单校验
 * 白名单 = 编辑器 files/vs_white_list 按行语义, 空则除 /console 外全拒
 * 纯函数路由可 node 冒烟; AutoX 侧 java.net.ServerSocket 绑 127.0.0.1。
 */
"use strict";

/* ================= 纯函数层 (node 可测) ================= */

/** 解析原始 HTTP 请求 -> {method, path, headers, body} 或 null。 */
function parseRequest(raw) {
    if (!raw) return null;
    var idx = raw.indexOf("\r\n\r\n");
    var head = idx >= 0 ? raw.slice(0, idx) : raw;
    var body = idx >= 0 ? raw.slice(idx + 4) : "";
    var lines = head.split("\r\n");
    if (!lines.length) return null;
    var parts = lines[0].split(" ");
    if (parts.length < 2) return null;
    var headers = {};
    for (var i = 1; i < lines.length; i++) {
        var c = lines[i].indexOf(":");
        if (c > 0) headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
    }
    var len = parseInt(headers["content-length"] || "0", 10);
    if (len > 0 && body.length > len) body = body.slice(0, len);
    return { method: parts[0].toUpperCase(), path: parts[1].split("?")[0], headers: headers, body: body };
}

function buildResponse(status, obj) {
    var text = JSON.stringify(obj || {});
    return "HTTP/1.1 " + status + " " + (status === 200 ? "OK" : "ERROR") + "\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: " + text.length + "\r\n" +
        "Connection: close\r\n\r\n" + text;
}

/** 路由: state {whiteList:[], deps:{b64decode, execCode, stopTask, logger}}。
 * 返回 {status, json}。 */
function route(state, req) {
    if (!req) return { status: 400, json: { code: -1, message: "bad request" } };
    var p = req.path;
    if (p === "/console" && req.method === "GET") {
        return { status: 200, json: { code: 0, port: state.port } };
    }
    var wl = state.whiteList || [];
    var inWhitelist = wl.length === 0 ? false : wl.indexOf(String(state.clientName || "")) >= 0;
    if (p === "/run" && req.method === "POST") {
        var body = {};
        try { body = JSON.parse(req.body || "{}"); } catch (e) {
            return { status: 200, json: { code: -1, message: "bad json" } };
        }
        // code 分支: Base64 解码直接跑, 无白名单 (对齐编辑器语义)
        if (body.code) {
            var code = state.deps.b64decode(String(body.code));
            if (!code) return { status: 200, json: { code: -1, message: "code decode failed" } };
            var r = state.deps.execCode(code, state.deps.b64decode(String(body.file_name || "")) || body.name || "remote");
            return { status: 200, json: r.ok ? { code: 0, message: "" } : { code: -1, message: r.message } };
        }
        // file_name 分支: 白名单校验
        var fname = state.deps.b64decode(String(body.file_name || ""));
        if (!fname) return { status: 200, json: { code: -1, message: "file_name required" } };
        if (wl.indexOf(fname) < 0) {
            return { status: 200, json: { code: -1, message: "not in white list" } };
        }
        var r2 = state.deps.execFile(fname);
        return { status: 200, json: r2.ok ? { code: 0, message: "" } : { code: -1, message: r2.message } };
    }
    if (p === "/stop" && req.method === "POST") {
        if (!inWhitelist) return { status: 200, json: { code: -1, message: "not in white list" } };
        state.deps.stopTask();
        return { status: 200, json: { code: 0, message: "" } };
    }
    if (p === "/sync" && req.method === "POST") {
        if (!inWhitelist) return { status: 200, json: { code: -1, message: "not in white list" } };
        return { status: 200, json: { code: 0, message: "sync ok" } };
    }
    return { status: 404, json: { code: -1, message: "not found" } };
}

/* ================= AutoX 服务壳 ================= */

function EditorServer(opts) {
    opts = opts || {};
    this.port = Number(opts.port) || 11243;
    this.runtime = opts.runtime;           // EditorRuntime (runUserCode/stop)
    this.logger = typeof opts.logger === "function" ? opts.logger : function() {};
    this.whiteList = [];
    this._server = null;
    this._running = false;
}

/** 加载白名单文件 (按行, 对齐编辑器 vs_white_list)。 */
EditorServer.prototype.loadWhiteList = function(path) {
    try {
        if (typeof files !== "undefined" && files.exists(path)) {
            var content = files.read(path);
            this.whiteList = String(content).split(/\r?\n/).map(function(s) { return s.trim(); }).filter(function(s) { return s; });
        }
    } catch (e) {
        this.logger("[W] 白名单读取失败: " + e);
    }
    return this.whiteList;
};

EditorServer.prototype._b64decode = function(s) {
    try {
        if (!s) return "";
        if (typeof android !== "undefined" && android.util.Base64) {
            return String(new java.lang.String(android.util.Base64.decode(s, android.util.Base64.DEFAULT), "UTF-8"));
        }
        return new java.lang.String(java.util.Base64.getDecoder().decode(s), "UTF-8");
    } catch (e) { return ""; }
};

EditorServer.prototype.start = function() {
    var self = this;
    if (this._running) return { ok: false, message: "服务已启动" };
    try {
        this._server = new java.net.ServerSocket(this.port, 50, java.net.InetAddress.getByName("127.0.0.1"));
        this._running = true;
        threads.start(function() { self._acceptLoop(); });
        this.logger("[控制口] 监听 127.0.0.1:" + this.port);
        return { ok: true, message: "" };
    } catch (e) {
        this.logger("[E] 控制口启动失败: " + e, "error");
        return { ok: false, message: String(e) };
    }
};

EditorServer.prototype.stop = function() {
    this._running = false;
    try { if (this._server) this._server.close(); } catch (e) {}
    this._server = null;
    return { ok: true };
};

EditorServer.prototype._acceptLoop = function() {
    var self = this;
    while (this._running) {
        try {
            var conn = this._server.accept();
            (function(c) {
                threads.start(function() { self._handle(c); });
            })(conn);
        } catch (e) {
            if (this._running) this.logger("[W] accept 异常: " + e);
            break;
        }
    }
};

EditorServer.prototype._readRequest = function(conn) {
    var ins = conn.getInputStream();
    var baos = new java.io.ByteArrayOutputStream();
    var buf = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 4096);
    var total = -1, n;
    conn.setSoTimeout(3000);
    try {
        while ((n = ins.read(buf)) > 0) {
            baos.write(buf, 0, n);
            var raw = String(new java.lang.String(baos.toByteArray(), "UTF-8"));
            var headEnd = raw.indexOf("\r\n\r\n");
            if (headEnd >= 0) {
                if (total < 0) {
                    var m = /content-length:\s*(\d+)/i.exec(raw.slice(0, headEnd));
                    total = m ? parseInt(m[1], 10) : 0;
                }
                if (baos.size() >= headEnd + 4 + total) break;
            }
            if (baos.size() > 5 * 1024 * 1024) break;
        }
    } catch (e) {}
    return String(new java.lang.String(baos.toByteArray(), "UTF-8"));
};

EditorServer.prototype._handle = function(conn) {
    try {
        var raw = this._readRequest(conn);
        var req = parseRequest(raw);
        var state = {
            port: this.port,
            whiteList: this.whiteList,
            deps: {
                b64decode: function(s) { return this._b64decode(s); }.bind(this),
                execCode: function(code, name) {
                    if (this.runtime) return this.runtime.runUserCode(code);
                    return { ok: false, message: "运行时未就绪" };
                }.bind(this),
                execFile: function(name) {
                    return { ok: false, message: "file 执行需任务上下文" };
                }.bind(this),
                stopTask: function() {
                    if (this.runtime) this.runtime.stop();
                }.bind(this),
                logger: this.logger
            }
        };
        var resp = route(state, req);
        if (resp.json && resp.json.code === -1 && resp.json.message) this.logger("[控制口] " + req.path + " -> " + resp.json.message);
        var out = conn.getOutputStream();
        out.write(new java.lang.String(buildResponse(resp.status, resp.json)).getBytes("UTF-8"));
        out.flush();
    } catch (e) {
        this.logger("[W] 控制口处理异常: " + e);
    } finally {
        try { conn.close(); } catch (e2) {}
    }
};

module.exports = EditorServer;
module.exports.parseRequest = parseRequest;
module.exports.buildResponse = buildResponse;
module.exports.route = route;
