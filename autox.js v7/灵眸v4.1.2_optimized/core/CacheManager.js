/**
 * 灵眸 v4.1.2 - 通用缓存
 */
LingMouAPI.register("CacheManager", function(API) {
    "use strict";

    var _cache = {};
    var _lock = threads.lock();
    var _maxSize = 200;
    var _defaultTTL = 5000;
    var _timer = null;

    function now() { return Date.now(); }

    function keysUnlocked() {
        var ks = [];
        for (var k in _cache) if (_cache.hasOwnProperty(k)) ks.push(k);
        return ks;
    }

    function cleanupUnlocked() {
        var t = now(), removed = 0;
        for (var k in _cache) {
            if (!_cache.hasOwnProperty(k)) continue;
            if (_cache[k].expiresAt > 0 && _cache[k].expiresAt <= t) {
                delete _cache[k];
                removed++;
            }
        }
        return removed;
    }

    function trimUnlocked() {
        var ks = keysUnlocked();
        if (ks.length <= _maxSize) return;
        ks.sort(function(a, b) { return _cache[a].updatedAt - _cache[b].updatedAt; });
        while (ks.length > _maxSize) delete _cache[ks.shift()];
    }

    return {
        init: function(options) {
            options = options || {};
            _maxSize = Number(options.maxSize || _maxSize);
            _defaultTTL = Number(options.defaultTTL !== undefined ? options.defaultTTL : _defaultTTL);
            var self = this;
            _timer = setInterval(function() { self.cleanup(); }, Math.max(1000, _defaultTTL));
            log("[CacheManager] Initialized");
            return true;
        },
        set: function(key, value, ttl) {
            var life = ttl === undefined ? _defaultTTL : Number(ttl);
            _lock.lock();
            try {
                _cache[String(key)] = {
                    value: value,
                    updatedAt: now(),
                    expiresAt: life > 0 ? now() + life : 0
                };
                trimUnlocked();
            } finally { _lock.unlock(); }
            return value;
        },
        get: function(key, defaultValue) {
            _lock.lock();
            try {
                var item = _cache[String(key)];
                if (!item) return defaultValue;
                if (item.expiresAt > 0 && item.expiresAt <= now()) {
                    delete _cache[String(key)];
                    return defaultValue;
                }
                return item.value;
            } finally { _lock.unlock(); }
        },
        has: function(key) {
            return this.get(key, undefined) !== undefined;
        },
        remove: function(key) {
            _lock.lock();
            try {
                var had = _cache.hasOwnProperty(String(key));
                delete _cache[String(key)];
                return had;
            } finally { _lock.unlock(); }
        },
        clear: function() {
            _lock.lock();
            try { _cache = {}; }
            finally { _lock.unlock(); }
        },
        cleanup: function() {
            _lock.lock();
            try { return cleanupUnlocked(); }
            finally { _lock.unlock(); }
        },
        size: function() {
            _lock.lock();
            try { cleanupUnlocked(); return keysUnlocked().length; }
            finally { _lock.unlock(); }
        },
        stop: function() {
            if (_timer) { clearInterval(_timer); _timer = null; }
            this.clear();
        }
    };
});
