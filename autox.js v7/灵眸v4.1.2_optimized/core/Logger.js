/**
 * 灵眸 v4.1.2 - 日志管理器
 */
LingMouAPI.register("Logger", function(API) {
    "use strict";

    var _dir = files.join(API.getBaseDir(), "logs/");
    var _file = files.join(_dir, "app.log");
    var _maxSize = 5 * 1024 * 1024;
    var _maxFiles = 5;
    var _level = 1;
    var _lock = threads.lock();
    var LEVELS = {debug: 0, info: 1, warn: 2, error: 3};

    function ensureDir() {
        if (!files.exists(_dir)) files.createWithDirs(_dir);
    }

    function rotate() {
        if (!files.exists(_file)) return;
        var size = new java.io.File(_file).length();
        if (size < _maxSize) return;
        var oldest = files.join(_dir, "app." + _maxFiles + ".log");
        if (files.exists(oldest)) files.remove(oldest);
        for (var i = _maxFiles - 1; i >= 1; i--) {
            var src = files.join(_dir, "app." + i + ".log");
            var dst = files.join(_dir, "app." + (i + 1) + ".log");
            if (files.exists(src)) files.move(src, dst);
        }
        files.move(_file, files.join(_dir, "app.1.log"));
    }

    function normalize(tag, msg) {
        if (msg === undefined) return {tag: "LingMou", msg: String(tag)};
        return {tag: String(tag), msg: String(msg)};
    }

    function write(level, tag, msg) {
        if (LEVELS[level] < _level) return;
        var nm = normalize(tag, msg);
        var line = "[" + new Date().toLocaleString() + "] [" + level.toUpperCase() + "] [" +
            nm.tag + "] " + nm.msg;
        _lock.lock();
        try {
            ensureDir();
            rotate();
            files.append(_file, line + "\n");
        } catch (e) {
            log("[Logger] Write error: " + e);
        } finally {
            _lock.unlock();
        }
        log(line);
    }

    return {
        init: function(options) {
            ensureDir();
            if (options && options.level) this.setLevel(options.level);
            log("[Logger] Initialized");
            return true;
        },
        setLevel: function(level) {
            _level = LEVELS[level] !== undefined ? LEVELS[level] : LEVELS.info;
            return true;
        },
        getLevel: function() {
            for (var k in LEVELS) if (LEVELS[k] === _level) return k;
            return "info";
        },
        debug: function(tag, msg) { write("debug", tag, msg); },
        info: function(tag, msg) { write("info", tag, msg); },
        warn: function(tag, msg) { write("warn", tag, msg); },
        error: function(tag, msg) { write("error", tag, msg); }
    };
});
