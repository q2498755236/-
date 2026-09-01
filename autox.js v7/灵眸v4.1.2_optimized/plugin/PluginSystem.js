/**
 * 灵眸 v4.1.2 - 插件系统
 * Rhino 动态 JS 无法提供进程级 sandbox；仅加载可信插件。
 * 默认限制在 plugins 目录，并对初始化失败/热替换做完整回滚。
 */
LingMouAPI.register("PluginSystem", function(API) {
    "use strict";

    var _plugins = {};
    var _lock = threads.lock();
    var _baseDir = null;
    var _config = {enabled: true, directory: "plugins", autoInit: true, allowExternalPaths: false};

    function canonical(path) { return String(new java.io.File(String(path)).getCanonicalPath()); }

    function allowed(path) {
        if (_config.allowExternalPaths) return true;
        if (!_baseDir) return false;
        var base = canonical(_baseDir);
        var target = canonical(path);
        return target === base || target.indexOf(base + java.io.File.separator) === 0;
    }

    function makePluginAPI(name) {
        return {
            name: name,
            require: function(moduleName) { return API.require(moduleName); },
            getBaseDir: function() { return API.getBaseDir(); },
            log: function(msg) {
                try { API.require("Logger").info("Plugin:" + name, msg); }
                catch (e) { log("[Plugin:" + name + "] " + msg); }
            }
        };
    }

    function safeStop(plugin) {
        if (!plugin || !plugin.exports || typeof plugin.exports.stop !== "function") return;
        try { plugin.exports.stop(); }
        catch (e) { log("[PluginSystem] stop failed [" + plugin.name + "]: " + e); }
    }

    return {
        init: function(options) {
            options = options || {};
            for (var k in options) if (options.hasOwnProperty(k) && _config.hasOwnProperty(k)) _config[k] = options[k];
            var dir = String(_config.directory || "plugins");
            try {
                var f = new java.io.File(dir);
                _baseDir = f.isAbsolute() ? canonical(dir) : canonical(files.join(API.getBaseDir(), dir));
            } catch (e) {
                _baseDir = files.join(API.getBaseDir(), "plugins/");
            }
            if (!files.exists(_baseDir)) files.createWithDirs(_baseDir);
            log("[PluginSystem] Initialized at " + _baseDir);
            return true;
        },

        load: function(name, path) {
            if (!_config.enabled) return false;
            name = String(name || "");
            if (!name) throw new Error("Plugin name required");
            path = path || files.join(_baseDir, name + ".js");
            path = canonical(path);
            if (!allowed(path)) throw new Error("Plugin path outside allowed directory: " + path);
            if (!files.exists(path)) throw new Error("Plugin not found: " + path);

            var code = files.read(path);
            var module = {exports: {}};
            var pluginApi = makePluginAPI(name);
            var exported;

            try {
                var factory = new Function("API", "module", "exports",
                    '"use strict";\n' + code + '\n;return module.exports;\n//# sourceURL=' + path.replace(/\\/g, "/"));
                exported = factory(pluginApi, module, module.exports);
                if (exported === undefined) exported = module.exports;
                if (exported === null) throw new Error("Plugin exported null");

                if (_config.autoInit && exported && typeof exported.init === "function") {
                    var initResult = exported.init(pluginApi);
                    if (initResult === false) throw new Error("Plugin init returned false");
                }
            } catch (e) {
                // 初始化到一半失败时尝试清理新插件，但不覆盖当前稳定版本。
                try { if (exported && typeof exported.stop === "function") exported.stop(); } catch (ignore) {}
                throw new Error("Plugin load failed [" + name + "]: " + e);
            }

            var plugin = {name: name, path: path, exports: exported, loadedAt: Date.now()};
            var old = null;
            _lock.lock();
            try {
                old = _plugins[name] || null;
                _plugins[name] = plugin;
            } finally { _lock.unlock(); }

            // 新版本已初始化成功并完成原子替换后，再清理旧版本。
            if (old && old !== plugin) safeStop(old);
            log("[PluginSystem] Loaded: " + name);
            return exported;
        },

        unload: function(name) {
            var plugin;
            _lock.lock();
            try {
                name = String(name);
                plugin = _plugins[name];
                if (!plugin) return false;
                delete _plugins[name];
            } finally { _lock.unlock(); }
            safeStop(plugin);
            return true;
        },

        get: function(name) {
            _lock.lock();
            try { return _plugins[String(name)] ? _plugins[String(name)].exports : null; }
            finally { _lock.unlock(); }
        },

        list: function() {
            _lock.lock();
            try {
                var arr = [];
                for (var k in _plugins) if (_plugins.hasOwnProperty(k)) arr.push(k);
                arr.sort();
                return arr;
            } finally { _lock.unlock(); }
        },

        stop: function() {
            var names = this.list();
            for (var i = 0; i < names.length; i++) this.unload(names[i]);
            return true;
        }
    };
});
