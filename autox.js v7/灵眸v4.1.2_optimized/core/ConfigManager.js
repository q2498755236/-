/**
 * 灵眸 v4.1.2 - 配置管理器
 * AutoX V7 Rhino
 * - 使用 threads.lock() 真正互斥
 * - 首次启动不再发生嵌套锁死锁
 * - 默认配置与 config.example.json 统一
 */
LingMouAPI.register("ConfigManager", function(API) {
    "use strict";

    var _config = {};
    var _path = files.join(API.getBaseDir(), "config.json");
    var _lock = threads.lock();
    var _saveTimer = null;
    var _initialized = false;

    var DEFAULTS = {
        debug: false,
        logLevel: "info",
        vision: {
            screenshotQuality: 80,
            findTimeout: 5000,
            ocrEnabled: true,
            ocrLanguage: "ch",
            ocrRequired: false,
            ocrCpuThreads: 4,
            ocrUseSlim: true,
            frameHistory: 5,
            imageCacheTTL: 60000,
            imageCacheSize: 20
        },
        thread: {
            maxThreads: 16,
            defaultTimeout: 30000,
            gcInterval: 30000
        },
        scheduler: {
            tickInterval: 100,
            maxErrors: 10,
            recoveryEnabled: true
        },
        cache: {
            maxSize: 200,
            defaultTTL: 5000
        },
        action: {
            coordinateMode: "screen",
            designWidth: 1080,
            designHeight: 1920,
            clickDelay: [80, 180],
            swipeDuration: [300, 600],
            longPressDuration: [800, 1200],
            randomOffset: 3,
            enableRandom: true,
            enableRetry: true,
            maxRetry: 3,
            retryDelay: 150
        },
        condition: {
            enableCache: true,
            cacheTTL: 1000,
            maxCacheSize: 200,
            enableParallel: true,
            parallelTimeout: 3000
        },
        plugin: {
            enabled: true,
            directory: "plugins",
            autoInit: true,
            allowExternalPaths: false
        },
        ui: {
            floatyEnabled: true,
            monitorEnabled: false,
            showFps: false
        },
        gc: {
            enable: true,
            autoGC: true,
            autoGCThreshold: 0.85,
            autoGCInterval: 30000,
            enableMemoryReport: true,
            memoryReportInterval: 60000,
            enableLeakDetect: false,
            leakCheckInterval: 120000,
            enableLog: true
        },
        perf: {
            enable: true,
            collectInterval: 5000,
            enableHistory: true,
            maxHistory: 100,
            enableBottleneckDetect: true,
            bottleneckThreshold: 0.8,
            enableAutoExport: false,
            exportInterval: 300000
        },
        monitor: {
            enable: true,
            updateInterval: 1000,
            enableCPU: true,
            enableMemory: true,
            enableFPS: false,
            enableBattery: true,
            enableThread: true,
            enableLog: true,
            enableAlert: true,
            alertCooldown: 30000,
            alertThresholds: {
                cpu: 90,
                memory: 90,
                battery: 10
            }
        },
        replay: {
            enable: true,
            maxRecords: 10000,
            playbackSpeed: 1.0,
            loopCount: 1,
            enableRandomDelay: false,
            randomDelayRange: [0, 50],
            enableLog: true
        },
        watchdog: {
            enable: true,
            checkInterval: 5000,
            maxStallTime: 15000,
            recoveryEnabled: true
        }
    };

    var SCHEMA = {
        debug: {type: "boolean"},
        logLevel: {type: "enum", values: ["debug", "info", "warn", "error"]},

        "vision.screenshotQuality": {type: "integer", min: 1, max: 100},
        "vision.findTimeout": {type: "integer", min: 100, max: 60000},
        "vision.ocrEnabled": {type: "boolean"},
        "vision.ocrLanguage": {type: "string", nonEmpty: true},
        "vision.ocrRequired": {type: "boolean"},
        "vision.ocrCpuThreads": {type: "integer", min: 1, max: 8},
        "vision.ocrUseSlim": {type: "boolean"},
        "vision.frameHistory": {type: "integer", min: 1, max: 1000},
        "vision.imageCacheTTL": {type: "integer", min: 0, max: 3600000},
        "vision.imageCacheSize": {type: "integer", min: 1, max: 200},

        "thread.maxThreads": {type: "integer", min: 1, max: 64},
        "thread.defaultTimeout": {type: "integer", min: 0, max: 600000},
        "thread.gcInterval": {type: "integer", min: 1000, max: 600000},

        "scheduler.tickInterval": {type: "integer", min: 20, max: 5000},
        "scheduler.maxErrors": {type: "integer", min: 1, max: 1000},
        "scheduler.recoveryEnabled": {type: "boolean"},

        "cache.maxSize": {type: "integer", min: 1, max: 10000},
        "cache.defaultTTL": {type: "integer", min: 0, max: 3600000},

        "action.coordinateMode": {type: "enum", values: ["screen", "design"]},
        "action.designWidth": {type: "number", min: 1, max: 100000},
        "action.designHeight": {type: "number", min: 1, max: 100000},
        "action.clickDelay": {type: "range", min: 0, max: 60000, integer: true},
        "action.swipeDuration": {type: "range", min: 1, max: 60000, integer: true},
        "action.longPressDuration": {type: "range", min: 1, max: 60000, integer: true},
        "action.randomOffset": {type: "integer", min: 0, max: 1000},
        "action.enableRandom": {type: "boolean"},
        "action.enableRetry": {type: "boolean"},
        "action.maxRetry": {type: "integer", min: 0, max: 10},
        "action.retryDelay": {type: "integer", min: 0, max: 60000},

        "condition.enableCache": {type: "boolean"},
        "condition.cacheTTL": {type: "integer", min: 0, max: 600000},
        "condition.maxCacheSize": {type: "integer", min: 1, max: 10000},
        "condition.enableParallel": {type: "boolean"},
        "condition.parallelTimeout": {type: "integer", min: 100, max: 600000},

        "plugin.enabled": {type: "boolean"},
        "plugin.directory": {type: "string", nonEmpty: true},
        "plugin.autoInit": {type: "boolean"},
        "plugin.allowExternalPaths": {type: "boolean"},

        "ui.floatyEnabled": {type: "boolean"},
        "ui.monitorEnabled": {type: "boolean"},
        "ui.showFps": {type: "boolean"},

        "gc.enable": {type: "boolean"},
        "gc.autoGC": {type: "boolean"},
        "gc.autoGCThreshold": {type: "number", min: 0.1, max: 0.99},
        "gc.autoGCInterval": {type: "integer", min: 1000, max: 3600000},
        "gc.enableMemoryReport": {type: "boolean"},
        "gc.memoryReportInterval": {type: "integer", min: 1000, max: 3600000},
        "gc.enableLeakDetect": {type: "boolean"},
        "gc.leakCheckInterval": {type: "integer", min: 1000, max: 3600000},
        "gc.enableLog": {type: "boolean"},

        "perf.enable": {type: "boolean"},
        "perf.collectInterval": {type: "integer", min: 500, max: 3600000},
        "perf.enableHistory": {type: "boolean"},
        "perf.maxHistory": {type: "integer", min: 1, max: 10000},
        "perf.enableBottleneckDetect": {type: "boolean"},
        "perf.bottleneckThreshold": {type: "number", min: 0, max: 1},
        "perf.enableAutoExport": {type: "boolean"},
        "perf.exportInterval": {type: "integer", min: 1000, max: 86400000},

        "monitor.enable": {type: "boolean"},
        "monitor.updateInterval": {type: "integer", min: 200, max: 60000},
        "monitor.enableCPU": {type: "boolean"},
        "monitor.enableMemory": {type: "boolean"},
        "monitor.enableFPS": {type: "boolean"},
        "monitor.enableBattery": {type: "boolean"},
        "monitor.enableThread": {type: "boolean"},
        "monitor.enableLog": {type: "boolean"},
        "monitor.enableAlert": {type: "boolean"},
        "monitor.alertCooldown": {type: "integer", min: 0, max: 3600000},
        "monitor.alertThresholds.cpu": {type: "number", min: 0, max: 100},
        "monitor.alertThresholds.memory": {type: "number", min: 0, max: 100},
        "monitor.alertThresholds.battery": {type: "number", min: 0, max: 100},

        "replay.enable": {type: "boolean"},
        "replay.maxRecords": {type: "integer", min: 1, max: 100000},
        "replay.playbackSpeed": {type: "number", min: 0.01, max: 100},
        "replay.loopCount": {type: "integer", min: 1, max: 10000},
        "replay.enableRandomDelay": {type: "boolean"},
        "replay.randomDelayRange": {type: "range", min: 0, max: 600000, integer: true},
        "replay.enableLog": {type: "boolean"},

        "watchdog.enable": {type: "boolean"},
        "watchdog.checkInterval": {type: "integer", min: 500, max: 600000},
        "watchdog.maxStallTime": {type: "integer", min: 500, max: 3600000},
        "watchdog.recoveryEnabled": {type: "boolean"}
    };

    function deepCopy(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    function merge(defaults, loaded) {
        var result = deepCopy(defaults);
        if (!loaded || typeof loaded !== "object") return result;
        for (var key in loaded) {
            if (!loaded.hasOwnProperty(key)) continue;
            if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
            if (loaded[key] && typeof loaded[key] === "object" && !Array.isArray(loaded[key])) {
                result[key] = merge(result[key] || {}, loaded[key]);
            } else {
                result[key] = loaded[key];
            }
        }
        return result;
    }

    function getPath(obj, key) {
        var parts = String(key).split(".");
        for (var i = 0; i < parts.length; i++) {
            if (obj === null || obj === undefined) return undefined;
            obj = obj[parts[i]];
        }
        return obj;
    }

    function setPath(obj, key, value) {
        var parts = String(key).split(".");
        for (var i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]] || typeof obj[parts[i]] !== "object") obj[parts[i]] = {};
            obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
    }

    function defaultFor(key) {
        return deepCopy(getPath(DEFAULTS, key));
    }

    function validate(key, value) {
        var rule = SCHEMA[key];
        if (!rule) return value;
        var fallback = defaultFor(key);

        if (rule.type === "boolean") {
            if (value === true || value === 1 || value === "1" || value === "true") return true;
            if (value === false || value === 0 || value === "0" || value === "false") return false;
            return fallback;
        }
        if (rule.type === "number" || rule.type === "integer") {
            var n = Number(value);
            if (!isFinite(n)) return fallback;
            if (rule.min !== undefined) n = Math.max(rule.min, n);
            if (rule.max !== undefined) n = Math.min(rule.max, n);
            if (rule.type === "integer") n = Math.round(n);
            return n;
        }
        if (rule.type === "enum") {
            return rule.values.indexOf(value) >= 0 ? value : fallback;
        }
        if (rule.type === "string") {
            if (typeof value !== "string") return fallback;
            if (rule.nonEmpty && value.trim() === "") return fallback;
            return value;
        }
        if (rule.type === "range") {
            if (!Array.isArray(value) || value.length < 2) return fallback;
            var a = Number(value[0]), b = Number(value[1]);
            if (!isFinite(a) || !isFinite(b)) return fallback;
            if (rule.min !== undefined) { a = Math.max(rule.min, a); b = Math.max(rule.min, b); }
            if (rule.max !== undefined) { a = Math.min(rule.max, a); b = Math.min(rule.max, b); }
            if (a > b) { var tmp = a; a = b; b = tmp; }
            if (rule.integer) { a = Math.round(a); b = Math.round(b); }
            return [a, b];
        }
        return value;
    }

    function normalizeSchema(config) {
        for (var key in SCHEMA) {
            if (!SCHEMA.hasOwnProperty(key)) continue;
            setPath(config, key, validate(key, getPath(config, key)));
        }
        return config;
    }

    function writeSnapshot(snapshot) {
        try {
            files.write(_path, JSON.stringify(snapshot, null, 2));
            return true;
        } catch (e) {
            log("[ConfigManager] Save error: " + e);
            return false;
        }
    }

    var service = {
        init: function() {
            if (_initialized) return true;
            var shouldSave = false;
            _lock.lock();
            try {
                if (!files.exists(_path)) {
                    _config = deepCopy(DEFAULTS);
                    shouldSave = true;
                } else {
                    var content = files.read(_path);
                    if (!content || content.trim() === "") {
                        _config = deepCopy(DEFAULTS);
                        shouldSave = true;
                    } else {
                        try {
                            _config = normalizeSchema(merge(DEFAULTS, JSON.parse(content)));
                        } catch (e) {
                            log("[ConfigManager] Invalid config.json, fallback to defaults: " + e);
                            _config = deepCopy(DEFAULTS);
                            shouldSave = true;
                        }
                    }
                }
                _initialized = true;
            } finally {
                _lock.unlock();
            }

            // 重要：保存发生在锁外，避免 load -> save 重入死锁。
            if (shouldSave) writeSnapshot(this.getAll());
            log("[ConfigManager] Initialized");
            return true;
        },

        load: function() {
            _initialized = false;
            return this.init();
        },

        save: function() {
            return writeSnapshot(this.getAll());
        },

        saveDelayed: function() {
            var self = this;
            if (_saveTimer) clearTimeout(_saveTimer);
            _saveTimer = setTimeout(function() {
                _saveTimer = null;
                self.save();
            }, 500);
        },

        get: function(key, defaultValue) {
            var parts = String(key).split(".");
            var obj = _config;
            _lock.lock();
            try {
                for (var i = 0; i < parts.length; i++) {
                    if (obj === null || obj === undefined) return defaultValue;
                    obj = obj[parts[i]];
                }
                return obj !== undefined ? deepCopy(obj) : defaultValue;
            } finally {
                _lock.unlock();
            }
        },

        set: function(key, value) {
            var parts = String(key).split(".");
            var validated = validate(key, value);
            _lock.lock();
            try {
                var obj = _config;
                for (var i = 0; i < parts.length - 1; i++) {
                    if (!obj[parts[i]] || typeof obj[parts[i]] !== "object") obj[parts[i]] = {};
                    obj = obj[parts[i]];
                }
                obj[parts[parts.length - 1]] = validated;
            } finally {
                _lock.unlock();
            }
            this.saveDelayed();
            return true;
        },

        getAll: function() {
            _lock.lock();
            try {
                return deepCopy(_config);
            } finally {
                _lock.unlock();
            }
        },

        getDefaults: function() {
            return deepCopy(DEFAULTS);
        },

        shutdown: function() {
            if (_saveTimer) {
                clearTimeout(_saveTimer);
                _saveTimer = null;
                this.save();
            }
        },

        _deepCopy: deepCopy,
        _merge: merge
    };

    return service;
});
