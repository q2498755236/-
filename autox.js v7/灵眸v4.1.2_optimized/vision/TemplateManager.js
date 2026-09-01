/**
 * 灵眸 v4.1.2 - 模板管理器
 * 管理 name -> path/options 元数据；图片缓存 ownership 统一交给 ImageManager。
 */
LingMouAPI.register("TemplateManager", function(API) {
    "use strict";

    var _templates = {};
    var _lock = threads.lock();
    var _images = null;
    var _baseDir = null;

    function resolvePath(path) {
        path = String(path);
        try {
            var f = new java.io.File(path);
            if (f.isAbsolute()) return path;
        } catch (e) {}
        return files.join(_baseDir, path);
    }

    function mergeOptions(base, override) {
        var out = {}, k;
        base = base || {};
        override = override || {};
        for (k in base) if (base.hasOwnProperty(k)) out[k] = base[k];
        for (k in override) if (override.hasOwnProperty(k)) out[k] = override[k];
        return out;
    }

    return {
        init: function() {
            _images = API.require("ImageManager");
            _baseDir = API.getBaseDir();
            log("[TemplateManager] Initialized");
            return true;
        },

        register: function(name, path, options) {
            if (!name || !path) throw new Error("TemplateManager.register requires name and path");
            var item = {path: resolvePath(path), options: mergeOptions({}, options)};
            _lock.lock();
            try { _templates[String(name)] = item; }
            finally { _lock.unlock(); }
            return true;
        },

        load: function(nameOrPath, options) {
            if (!nameOrPath) return null;
            var key = String(nameOrPath);
            var item = null;
            _lock.lock();
            try {
                if (_templates[key]) item = {path: _templates[key].path, options: mergeOptions({}, _templates[key].options)};
            } finally { _lock.unlock(); }

            var path = item ? item.path : resolvePath(key);
            var opts = mergeOptions(item ? item.options : {}, options);
            return _images.load(path, {
                cache: opts.cache !== false,
                cacheKey: "template:" + path
            });
        },

        get: function(name) { return this.load(name); },

        remove: function(name) {
            var item = null;
            _lock.lock();
            try {
                name = String(name);
                item = _templates[name];
                if (!item) return false;
                delete _templates[name];
            } finally { _lock.unlock(); }
            // ImageManager.remove 仅解除缓存引用，不会回收外部可能仍持有的 Image。
            _images.remove("template:" + item.path);
            return true;
        },

        list: function() {
            _lock.lock();
            try {
                var out = {};
                for (var k in _templates) {
                    if (_templates.hasOwnProperty(k)) out[k] = {path: _templates[k].path, options: mergeOptions({}, _templates[k].options)};
                }
                return out;
            } finally { _lock.unlock(); }
        },

        clearCache: function() {
            var list = this.list();
            for (var k in list) if (list.hasOwnProperty(k)) _images.remove("template:" + list[k].path);
            return true;
        },

        clear: function() {
            var list = this.list();
            _lock.lock();
            try { _templates = {}; }
            finally { _lock.unlock(); }
            for (var k in list) if (list.hasOwnProperty(k)) _images.remove("template:" + list[k].path);
            return true;
        },

        stop: function() { this.clear(); }
    };
});
