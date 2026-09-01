/**
 * 灵眸 v4.1.2 - 操作回放
 * - 录制纯 action + delay JSON，不保存截图 Image
 * - 录制/播放状态切换原子化
 * - playback generation 防止 stop -> play 后旧回放线程重新进入
 * - 导入记录严格校验，导出文件名限制在 records 目录
 */
LingMouAPI.register("Replay", function(API) {
    "use strict";

    var _config = {
        enable: true,
        maxRecords: 10000,
        playbackSpeed: 1.0,
        loopCount: 1,
        enableRandomDelay: false,
        randomDelayRange: [0, 50],
        enableLog: true
    };
    var _stats = {records: 0, playbacks: 0, exports: 0, imports: 0, errors: 0};
    var _recording = false;
    var _playing = false;
    var _playGeneration = 0;
    var _records = [];
    var _lastRecordTime = 0;
    var _playbackThread = null;
    var _actionEngine = null;
    var _threadMgr = null;
    var _lock = threads.lock();
    var _logPath = null;

    function now() { return Date.now(); }
    function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }
    function finiteNumber(value, fallback, min, max) {
        var n = Number(value);
        if (!isFinite(n)) n = fallback;
        if (min !== undefined) n = Math.max(min, n);
        if (max !== undefined) n = Math.min(max, n);
        return n;
    }

    function fileLog(msg) {
        if (!_config.enableLog || !_logPath) return;
        try { files.append(_logPath, now() + " | " + msg + "\n"); } catch (e) {}
    }

    function normalizeRange(range, fallback) {
        if (!Array.isArray(range) || range.length < 2) range = fallback;
        var a = finiteNumber(range[0], fallback[0], 0, 600000);
        var b = finiteNumber(range[1], fallback[1], 0, 600000);
        if (a > b) { var t = a; a = b; b = t; }
        return [Math.floor(a), Math.floor(b)];
    }

    function randomDelay() {
        if (!_config.enableRandomDelay) return 0;
        var r = _config.randomDelayRange;
        return Math.floor(Math.random() * (r[1] - r[0] + 1)) + r[0];
    }

    function validAction(action) {
        if (!action || typeof action !== "object") return false;
        var type = String(action.type || "");
        if (["click", "longClick", "swipe", "input", "pressKey"].indexOf(type) < 0) return false;
        function num(v) { return isFinite(Number(v)); }
        if (type === "click" || type === "longClick") return num(action.x) && num(action.y);
        if (type === "swipe") return num(action.x1) && num(action.y1) && num(action.x2) && num(action.y2);
        if (type === "input") return action.text !== undefined && action.text !== null;
        return action.key !== undefined && action.key !== null;
    }

    function normalizeRecord(rec) {
        if (!rec || rec.type !== "action" || !validAction(rec.action)) return null;
        var delay = Math.floor(finiteNumber(rec.delay, 0, 0, 3600000));
        var timestamp = Math.floor(finiteNumber(rec.timestamp, 0, 0));
        var duration = Math.floor(finiteNumber(rec.duration, 0, 0, 3600000));
        return {type: "action", timestamp: timestamp, delay: delay, duration: duration, action: deepCopy(rec.action)};
    }

    return {
        init: function(options) {
            options = options || {};
            for (var k in options) if (options.hasOwnProperty(k) && _config.hasOwnProperty(k)) _config[k] = options[k];
            _config.maxRecords = Math.floor(finiteNumber(_config.maxRecords, 10000, 1, 100000));
            _config.playbackSpeed = finiteNumber(_config.playbackSpeed, 1.0, 0.01, 100);
            _config.loopCount = Math.floor(finiteNumber(_config.loopCount, 1, 1, 10000));
            _config.randomDelayRange = normalizeRange(_config.randomDelayRange, [0, 50]);
            _actionEngine = API.require("ActionEngine");
            _threadMgr = API.require("ThreadManager");
            var dir = files.join(API.getBaseDir(), "logs/");
            if (!files.exists(dir)) files.createWithDirs(dir);
            _logPath = files.join(dir, "replay.log");
            log("[Replay] Initialized");
            return true;
        },

        startRecord: function() {
            _lock.lock();
            try {
                if (!_config.enable || _recording || _playing) return false;
                _records = [];
                _recording = true;
                _lastRecordTime = now();
            } finally { _lock.unlock(); }
            fileLog("RECORD_START");
            return true;
        },

        recordAction: function(action, meta) {
            if (!action || !validAction(action)) return false;
            var copy;
            try { copy = deepCopy(action); }
            catch (e) { _stats.errors++; return false; }
            meta = meta || {};

            _lock.lock();
            try {
                if (!_recording || _playing) return false;
                var t = now();
                var startedAt = Math.floor(finiteNumber(meta.startedAt, t, 0));
                var endedAt = Math.floor(finiteNumber(meta.endedAt, t, 0));
                if (endedAt < startedAt) endedAt = startedAt;
                var rec = {
                    type: "action",
                    timestamp: startedAt,
                    delay: Math.max(0, startedAt - _lastRecordTime),
                    duration: Math.max(0, endedAt - startedAt),
                    action: copy
                };
                _records.push(rec);
                while (_records.length > _config.maxRecords) _records.shift();
                // 下一条 delay 从本次动作结束时刻计算，避免把本次 press/swipe 耗时重复算进回放等待。
                _lastRecordTime = endedAt;
                _stats.records++;
                return true;
            } finally { _lock.unlock(); }
        },

        stopRecord: function() {
            var count;
            _lock.lock();
            try {
                _recording = false;
                count = _records.length;
            } finally { _lock.unlock(); }
            fileLog("RECORD_STOP count=" + count);
            return count;
        },

        isRecording: function() { return _recording; },

        play: function(records, options) {
            options = options || {};
            var list;
            try { list = records ? deepCopy(records) : this.getRecords(); }
            catch (e) { _stats.errors++; return false; }
            if (!Array.isArray(list) || !list.length) return false;

            var normalized = [];
            for (var i = 0; i < list.length; i++) {
                var rec = normalizeRecord(list[i]);
                if (!rec) return false;
                normalized.push(rec);
            }

            var speed = finiteNumber(options.speed, _config.playbackSpeed, 0.01, 100);
            var loop = Math.floor(finiteNumber(options.loop, _config.loopCount, 1, 10000));
            var myGeneration;

            _lock.lock();
            try {
                if (!_config.enable || _playing || _recording) return false;
                _playing = true;
                myGeneration = ++_playGeneration;
            } finally { _lock.unlock(); }

            var self = this;
            var w = _threadMgr.start("Replay", function() {
                try {
                    for (var l = 0; l < loop && _playing && myGeneration === _playGeneration; l++) {
                        for (var r = 0; r < normalized.length && _playing && myGeneration === _playGeneration; r++) {
                            var item = normalized[r];
                            var wait = Math.max(0, item.delay + randomDelay());
                            if (wait > 0) sleep(Math.round(wait / speed));
                            if (!_playing || myGeneration !== _playGeneration) break;
                            if (!self._playAction(item.action)) {
                                _stats.errors++;
                                fileLog("PLAYBACK_ACTION_FAILED type=" + item.action.type + " index=" + r);
                            }
                        }
                    }
                    if (_playing && myGeneration === _playGeneration) _stats.playbacks++;
                } catch (e) {
                    if (_playing && myGeneration === _playGeneration) {
                        _stats.errors++;
                        fileLog("PLAYBACK_ERROR " + e);
                    }
                } finally {
                    _lock.lock();
                    try {
                        if (myGeneration === _playGeneration) {
                            _playing = false;
                            _playbackThread = null;
                        }
                    } finally { _lock.unlock(); }
                }
            }, 0);

            if (!w) {
                _lock.lock();
                try {
                    if (myGeneration === _playGeneration) _playing = false;
                } finally { _lock.unlock(); }
                return false;
            }
            _lock.lock();
            try { if (_playing && myGeneration === _playGeneration) _playbackThread = w; }
            finally { _lock.unlock(); }
            return true;
        },

        _playAction: function(action) {
            if (!validAction(action) || !_actionEngine) return false;
            switch (action.type) {
                case "click": return _actionEngine.click(action.x, action.y, action.options || {raw: true});
                case "longClick": return _actionEngine.longClick(action.x, action.y, action.options || {raw: true});
                case "swipe": return _actionEngine.swipe(action.x1, action.y1, action.x2, action.y2, action.options || {raw: true});
                case "input": return _actionEngine.input(action.text, action.options || {});
                case "pressKey": return _actionEngine.pressKey(action.key, action.options || {});
                default: return false;
            }
        },

        stopPlay: function() {
            var old;
            _lock.lock();
            try {
                _playing = false;
                _playGeneration++;
                old = _playbackThread;
                _playbackThread = null;
            } finally { _lock.unlock(); }
            if (old) old.cancel();
            return true;
        },

        isPlaying: function() { return _playing; },

        exportRecords: function(filename) {
            var dir = files.join(API.getBaseDir(), "records/");
            if (!files.exists(dir)) files.createWithDirs(dir);
            filename = String(filename || ("replay_" + now() + ".json"));
            filename = new java.io.File(filename).getName();
            if (!/\.json$/i.test(filename)) filename += ".json";
            var path = files.join(dir, filename);
            try {
                var records = this.getRecords();
                var data = {version: "4.1.2", timestamp: now(), count: records.length, records: records};
                files.write(path, JSON.stringify(data, null, 2));
                _stats.exports++;
                return path;
            } catch (e) {
                _stats.errors++;
                return false;
            }
        },

        importRecords: function(path) {
            if (!path || !files.exists(path)) return false;
            try {
                var data = JSON.parse(files.read(path));
                if (!data || !Array.isArray(data.records)) return false;
                var normalized = [];
                for (var i = 0; i < data.records.length; i++) {
                    var rec = normalizeRecord(data.records[i]);
                    if (!rec) return false;
                    normalized.push(rec);
                }
                if (normalized.length > _config.maxRecords) normalized = normalized.slice(-_config.maxRecords);
                _lock.lock();
                try {
                    if (_recording || _playing) return false;
                    _records = normalized;
                    if (_records.length) {
                        var last = _records[_records.length - 1];
                        _lastRecordTime = Number(last.timestamp || 0) + Number(last.duration || 0);
                    } else _lastRecordTime = 0;
                    _stats.imports++;
                } finally { _lock.unlock(); }
                return true;
            } catch (e) {
                _stats.errors++;
                return false;
            }
        },

        clear: function() {
            _lock.lock();
            try {
                if (_recording || _playing) return false;
                _records = [];
                _lastRecordTime = 0;
                return true;
            } finally { _lock.unlock(); }
        },

        getRecords: function() {
            _lock.lock();
            try { return deepCopy(_records); }
            finally { _lock.unlock(); }
        },

        getStats: function() { return deepCopy(_stats); },

        stop: function() {
            this.stopRecord();
            this.stopPlay();
        }
    };
});
