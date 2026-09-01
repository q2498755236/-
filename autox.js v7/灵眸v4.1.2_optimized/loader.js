;ui;
/**
 * 灵眸 v4.1.2 - 模块加载器 / 生命周期管理
 * 注意：本文件不再自动 init/start。main.js 是唯一入口。
 */
(function() {
    "use strict";

    var SOURCE = engines.myEngine().getSource();
    var BASE_DIR = files.join(files.dirName(SOURCE), "/");

    var moduleSpecs = [
        ["ConfigManager", "core/ConfigManager.js"],
        ["Logger", "core/Logger.js"],
        ["ThreadManager", "core/ThreadManager.js"],
        ["MemoryManager", "core/MemoryManager.js"],
        ["CacheManager", "core/CacheManager.js"],
        ["Compatibility", "engine/Compatibility.js"],
        ["Scheduler", "engine/Scheduler.js"],
        ["ActionEngine", "engine/ActionEngine.js"],
        ["ConditionEngine", "engine/ConditionEngine.js"],
        ["EventManager", "engine/EventManager.js"],
        ["ScreenshotManager", "vision/ScreenshotManager.js"],
        ["FindEngine", "vision/FindEngine.js"],
        ["OCREngine", "vision/OCREngine.js"],
        ["FrameManager", "vision/FrameManager.js"],
        ["ImageManager", "vision/ImageManager.js"],
        ["TemplateManager", "vision/TemplateManager.js"],
        ["PluginSystem", "plugin/PluginSystem.js"],
        ["Floaty", "ui/Floaty.js"],
        ["Monitor", "ui/Monitor.js"],
        ["Replay", "ui/Replay.js"],
        ["WatchDog", "watchdog/WatchDog.js"],
        ["GCManager", "gc/GCManager.js"],
        ["PerfStats", "perf/PerfStats.js"]
    ];

    var LingMou = {
        _registry: {},
        _modules: {},
        _status: "idle",
        _failedModules: [],
        _startedModules: [],

        getBaseDir: function() { return BASE_DIR; },

        register: function(name, factory) {
            if (!name || typeof factory !== "function") throw new Error("Invalid module registration");
            this._registry[String(name)] = factory;
        },

        _createAPI: function() {
            var self = this;
            return {
                register: function(name, factory) { self.register(name, factory); },
                require: function(name) { return self.require(name); },
                getBaseDir: function() { return BASE_DIR; },
                getStatus: function() { return self._status; }
            };
        },

        require: function(name) {
            name = String(name);
            if (this._modules[name]) return this._modules[name];
            var factory = this._registry[name];
            if (!factory) throw new Error("Module not registered: " + name);
            var instance = factory(this._createAPI());
            if (!instance) throw new Error("Module factory returned empty instance: " + name);
            this._modules[name] = instance;
            return instance;
        },

        _loadFile: function(name, relPath) {
            var path = files.join(BASE_DIR, relPath);
            if (!files.exists(path)) throw new Error("Module file not found: " + path);
            var source = files.read(path);
            // 这是可信本地框架模块加载，不是插件 sandbox。
            var wrapped = "(function(LingMouAPI){\n" + source + "\n})";
            var registerFn = eval(wrapped);
            registerFn(this._createAPI());
            if (!this._registry[name]) throw new Error("Module did not register: " + name);
        },

        init: function() {
            if (this._status !== "idle" && this._status !== "error") return this._status === "ready";
            this._status = "loading";
            this._failedModules = [];
            this._registry = {};
            this._modules = {};
            for (var i = 0; i < moduleSpecs.length; i++) {
                try {
                    this._loadFile(moduleSpecs[i][0], moduleSpecs[i][1]);
                } catch (e) {
                    this._failedModules.push({name: moduleSpecs[i][0], error: String(e)});
                    log("[LingMou] Load failed [" + moduleSpecs[i][0] + "]: " + e);
                }
            }
            if (this._failedModules.length) {
                this._status = "error";
                return false;
            }
            this._status = "ready";
            log("[LingMou] All modules registered");
            return true;
        },

        _markStarted: function(name) {
            if (this._startedModules.indexOf(name) < 0) this._startedModules.push(name);
        },

        _callInit: function(name, options) {
            var m = this.require(name);
            if (m.init) {
                var ok = m.init(options || {});
                if (ok === false) throw new Error(name + ".init returned false");
            }
            this._markStarted(name);
            return m;
        },

        start: function() {
            if (this._status !== "ready") return false;
            this._status = "starting";
            this._startedModules = [];
            try {
                var config = this._callInit("ConfigManager");
                var cfg = config.getAll();

                var logger = this._callInit("Logger", {level: cfg.logLevel});
                logger.setLevel(cfg.logLevel);

                this._callInit("ThreadManager", cfg.thread);
                var compat = this._callInit("Compatibility");
                compat.check();

                this._callInit("MemoryManager");
                this._callInit("CacheManager", cfg.cache);

                this._callInit("ActionEngine", cfg.action);
                this._callInit("ConditionEngine", cfg.condition);
                this._callInit("EventManager");

                this._callInit("ScreenshotManager", cfg.vision);
                this._callInit("ImageManager", cfg.vision);
                this._callInit("TemplateManager", cfg.vision);
                this._callInit("OCREngine", cfg.vision);
                this._callInit("FindEngine", cfg.vision);
                this._callInit("FrameManager", cfg.vision);

                this._callInit("PluginSystem", cfg.plugin);
                this._callInit("Replay", cfg.replay);

                var gc = this._callInit("GCManager", cfg.gc);
                if (!gc.start()) throw new Error("GCManager.start failed");

                var perf = this._callInit("PerfStats", cfg.perf);
                if (!perf.start()) throw new Error("PerfStats.start failed");

                var watchdog = this._callInit("WatchDog", {
                    enable: cfg.watchdog.enable,
                    checkInterval: cfg.watchdog.checkInterval,
                    maxStallTime: cfg.watchdog.maxStallTime,
                    recoveryEnabled: cfg.watchdog.recoveryEnabled,
                    onStall: function() {
                        logger.warn("WatchDog", "Scheduler stalled; restarting scheduler");
                        try { LingMou.require("Scheduler").restart(); } catch (e) {
                            logger.error("WatchDog", "Scheduler restart failed: " + e);
                        }
                    }
                });

                var scheduler = this._callInit("Scheduler", cfg.scheduler);
                if (!watchdog.start()) throw new Error("WatchDog.start failed");
                if (!scheduler.start()) throw new Error("Scheduler.start failed");

                var floaty = this._callInit("Floaty", {enabled: cfg.ui.floatyEnabled});
                if (cfg.ui.floatyEnabled) floaty.show();

                var monitor = this._callInit("Monitor", cfg.monitor);
                if (cfg.ui.monitorEnabled) monitor.show();

                this._status = "running";
                logger.info("LingMou", "Framework v4.1.2 started");
                toast("灵眸v4.1.2已启动");
                return true;
            } catch (e) {
                log("[LingMou] Start failed: " + e);
                this._status = "error";
                this.stop(true);
                toast("灵眸v4.1.2启动失败: " + e.message);
                return false;
            }
        },

        stop: function(fromRollback) {
            if (this._status === "stopping") return true;
            this._status = "stopping";

            function safe(name, method) {
                var m = LingMou._modules[name];
                if (!m || typeof m[method] !== "function") return;
                try { m[method](); } catch (e) { log("[LingMou] Stop error " + name + "." + method + ": " + e); }
            }

            // 先停止产生新工作的模块，再释放底层资源。
            safe("Monitor", "hide");
            safe("Floaty", "hide");
            safe("Replay", "stop");
            safe("Scheduler", "stop");
            safe("WatchDog", "stop");
            safe("PerfStats", "stop");
            safe("GCManager", "stop");
            safe("PluginSystem", "stop");
            safe("EventManager", "stop");
            safe("ConditionEngine", "stop");
            safe("FrameManager", "stop");
            safe("TemplateManager", "stop");
            safe("ImageManager", "stop");
            safe("OCREngine", "release");
            safe("ScreenshotManager", "release");
            safe("CacheManager", "stop");
            safe("MemoryManager", "cleanup");
            safe("ConfigManager", "shutdown");
            safe("ThreadManager", "shutdownAll");

            this._startedModules = [];
            this._status = fromRollback ? "error" : "idle";
            if (!fromRollback) log("[LingMou] Framework stopped");
            return true;
        },

        getStatus: function() {
            return {
                status: this._status,
                failedModules: JSON.parse(JSON.stringify(this._failedModules)),
                loadedModules: Object.keys(this._registry)
            };
        }
    };

    global.LingMou = LingMou;
})();
