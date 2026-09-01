/**
 * 灵眸 v4.1.2 - 图片资源管理器
 * ImageManager 是文件图片缓存的 owner，但运行期淘汰只“解除缓存引用”，不主动 recycle 已暴露给调用方的 Image。
 * 这样可避免 TTL/LRU 与调用方并发造成 use-after-recycle。stop() 时才集中回收仍由缓存持有的图片。
 */
LingMouAPI.register("ImageManager", function(API) {
    "use strict";

    var _cache = {};
    var _lock = threads.lock();
    var _ttl = 60000;
    var _maxSize = 20;
    var _timer = null;
    var _stats = {loads: 0, hits: 0, misses: 0, evictions: 0, recycled: 0, errors: 0};

    function now() { return Date.now(); }

    function safeRecycle(img) {
        if (!img || !img.recycle) return false;
        try {
            if (!img.isRecycled || !img.isRecycled()) img.recycle();
            _stats.recycled++;
            return true;
        } catch (e) { return false; }
    }

    function dropUnlocked(key, recycleNow) {
        var item = _cache[key];
        if (!item) return false;
        delete _cache[key];
        if (recycleNow) safeRecycle(item.image);
        _stats.evictions++;
        return true;
    }

    function cleanupUnlocked() {
        var t = now(), removed = 0;
        for (var key in _cache) {
            if (!_cache.hasOwnProperty(key)) continue;
            var item = _cache[key];
            if (item.expiresAt > 0 && item.expiresAt <= t) {
                // 不能确定调用方是否还持有同一 Image，因此这里只解除 manager 引用。
                if (dropUnlocked(key, false)) removed++;
            }
        }
        return removed;
    }

    function trimUnlocked() {
        var ks = [];
        for (var k in _cache) if (_cache.hasOwnProperty(k)) ks.push(k);
        ks.sort(function(a, b) { return _cache[a].usedAt - _cache[b].usedAt; });
        while (ks.length > _maxSize) dropUnlocked(ks.shift(), false);
    }

    function finiteInt(value, fallback, min, max) {
        var n = Number(value);
        if (!isFinite(n)) n = fallback;
        n = Math.floor(n);
        return Math.max(min, Math.min(max, n));
    }

    return {
        init: function(options) {
            options = options || {};
            _ttl = finiteInt(options.imageCacheTTL !== undefined ? options.imageCacheTTL : options.ttl, _ttl, 0, 3600000);
            _maxSize = finiteInt(options.imageCacheSize !== undefined ? options.imageCacheSize : options.maxSize, _maxSize, 1, 200);
            if (_timer) { try { clearInterval(_timer); } catch (e) {} _timer = null; }
            var self = this;
            var interval = _ttl > 0 ? Math.max(5000, Math.min(_ttl, 30000)) : 30000;
            _timer = setInterval(function() { self.cleanup(); }, interval);
            log("[ImageManager] Initialized ttl=" + _ttl + " maxSize=" + _maxSize);
            return true;
        },

        load: function(path, options) {
            options = options || {};
            if (!path) return null;
            path = String(path);
            var key = String(options.cacheKey || path);

            if (options.cache !== false) {
                _lock.lock();
                try {
                    cleanupUnlocked();
                    if (_cache[key]) {
                        _cache[key].usedAt = now();
                        // 滑动 TTL：实际被使用时延长生命周期，降低频繁磁盘解码。
                        if (_ttl > 0) _cache[key].expiresAt = now() + _ttl;
                        _stats.hits++;
                        return _cache[key].image;
                    }
                } finally { _lock.unlock(); }
            }

            _stats.misses++;
            if (!files.exists(path)) {
                _stats.errors++;
                return null;
            }

            var img;
            try { img = images.read(path); }
            catch (e) { img = null; }
            if (!img) {
                _stats.errors++;
                return null;
            }
            _stats.loads++;

            // cache=false 时 caller 是唯一 owner，应在不用时 recycle。
            if (options.cache === false) return img;

            _lock.lock();
            try {
                // 并发期间同 key 已出现：当前重复对象从未暴露，可安全立即回收。
                if (_cache[key]) {
                    safeRecycle(img);
                    _cache[key].usedAt = now();
                    if (_ttl > 0) _cache[key].expiresAt = now() + _ttl;
                    _stats.hits++;
                    return _cache[key].image;
                }
                _cache[key] = {
                    image: img,
                    path: path,
                    usedAt: now(),
                    expiresAt: _ttl > 0 ? now() + _ttl : 0
                };
                trimUnlocked();
                return img;
            } finally { _lock.unlock(); }
        },

        remove: function(key) {
            _lock.lock();
            try {
                // 运行期 remove 只解除缓存引用，不回收可能被外部持有的 Image。
                return dropUnlocked(String(key), false);
            } finally { _lock.unlock(); }
        },

        cleanup: function() {
            _lock.lock();
            try { return cleanupUnlocked(); }
            finally { _lock.unlock(); }
        },

        recycle: function(img) {
            // 仅用于调用方明确拥有的非缓存图片。
            return safeRecycle(img);
        },

        clearCache: function(recycleNow) {
            _lock.lock();
            try {
                for (var k in _cache) {
                    if (!_cache.hasOwnProperty(k)) continue;
                    if (recycleNow === true) safeRecycle(_cache[k].image);
                }
                _cache = {};
            } finally { _lock.unlock(); }
            return true;
        },

        stop: function() {
            if (_timer) { try { clearInterval(_timer); } catch (e) {} _timer = null; }
            // 框架已停止提供服务，此时缓存内仍持有的 Image 可集中回收。
            this.clearCache(true);
        },

        size: function() {
            _lock.lock();
            try {
                var n = 0;
                for (var k in _cache) if (_cache.hasOwnProperty(k)) n++;
                return n;
            } finally { _lock.unlock(); }
        },

        getStats: function() {
            var s = JSON.parse(JSON.stringify(_stats));
            s.size = this.size();
            return s;
        }
    };
});
