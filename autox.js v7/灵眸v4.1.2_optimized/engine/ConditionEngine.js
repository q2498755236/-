/**
 * 灵眸 v4.1.2 - 条件引擎
 * - 并行结果使用 ReentrantLock 保护
 * - 超时后冻结返回结果，后台线程不再继续修改已返回数组
 * - 线程容量不足时同步降级，不把“没执行”误判为 false
 * - 缓存改为显式 cacheKey，避免不同 context 被错误复用
 */
LingMouAPI.register("ConditionEngine", function(API) {
    "use strict";

    var _config = {
        enableCache: true,
        cacheTTL: 1000,
        maxCacheSize: 200,
        enableParallel: true,
        parallelTimeout: 3000
    };
    var _cache = {};
    var _cacheLock = threads.lock();
    var _threadMgr = null;

    function now() { return Date.now(); }
    function finiteNumber(value, fallback, min, max) {
        var n = Number(value);
        if (!isFinite(n)) n = fallback;
        if (min !== undefined) n = Math.max(min, n);
        if (max !== undefined) n = Math.min(max, n);
        return n;
    }

    function evalOne(condition, context) {
        if (typeof condition === "function") return !!condition(context);
        if (condition && typeof condition.check === "function") return !!condition.check(context);
        if (condition && typeof condition.test === "function") return !!condition.test(context);
        return !!condition;
    }

    function cacheKey(condition, options) {
        options = options || {};
        // 只有调用方明确声明“这个 key 与 context 无关/已包含 context”时才缓存。
        if (options.cacheKey !== undefined && options.cacheKey !== null) return String(options.cacheKey);
        if (condition && condition.cacheKey !== undefined && condition.cacheKey !== null) return String(condition.cacheKey);
        return null;
    }

    function cacheGet(key) {
        if (!key || !_config.enableCache) return undefined;
        _cacheLock.lock();
        try {
            var item = _cache[key];
            if (!item) return undefined;
            if (item.expiresAt <= now()) {
                delete _cache[key];
                return undefined;
            }
            return item.value;
        } finally { _cacheLock.unlock(); }
    }

    function cacheSet(key, value, ttl) {
        if (!key || !_config.enableCache) return;
        var life = finiteNumber(ttl, _config.cacheTTL, 0, 600000);
        _cacheLock.lock();
        try {
            _cache[key] = {value: value, expiresAt: now() + life};
            var ks = [];
            for (var k in _cache) if (_cache.hasOwnProperty(k)) ks.push(k);
            if (ks.length > _config.maxCacheSize) {
                ks.sort(function(a, b) { return _cache[a].expiresAt - _cache[b].expiresAt; });
                while (ks.length > _config.maxCacheSize) delete _cache[ks.shift()];
            }
        } finally { _cacheLock.unlock(); }
    }

    return {
        init: function(options) {
            options = options || {};
            for (var k in options) if (options.hasOwnProperty(k) && _config.hasOwnProperty(k)) _config[k] = options[k];
            _config.cacheTTL = finiteNumber(_config.cacheTTL, 1000, 0, 600000);
            _config.maxCacheSize = Math.floor(finiteNumber(_config.maxCacheSize, 200, 1, 10000));
            _config.parallelTimeout = finiteNumber(_config.parallelTimeout, 3000, 100, 600000);
            _threadMgr = API.require("ThreadManager");
            log("[ConditionEngine] Initialized");
            return true;
        },

        check: function(condition, context, options) {
            options = options || {};
            var key = cacheKey(condition, options);
            var cached = cacheGet(key);
            if (cached !== undefined) return cached;
            var result = evalOne(condition, context);
            cacheSet(key, result, options.cacheTTL);
            return result;
        },

        checkAll: function(conditions, context, options) {
            var result = this.checkParallel(conditions, context, options);
            if (!result.completed) return false;
            for (var i = 0; i < result.results.length; i++) if (!result.results[i]) return false;
            return true;
        },

        checkAny: function(conditions, context, options) {
            var result = this.checkParallel(conditions, context, options);
            for (var i = 0; i < result.results.length; i++) if (result.results[i]) return true;
            return false;
        },

        checkParallel: function(conditions, context, options) {
            conditions = conditions || [];
            options = options || {};
            if (!Array.isArray(conditions)) throw new Error("conditions must be an array");

            if (!_config.enableParallel || options.parallel === false || conditions.length <= 1) {
                var seq = [];
                for (var s = 0; s < conditions.length; s++) seq.push(this.check(conditions[s], context, options));
                return {completed: true, timedOut: false, results: seq};
            }

            var results = new Array(conditions.length);
            var workers = [];
            var stateLock = threads.lock();
            var completed = 0;
            var closed = false;
            var self = this;
            var timeout = finiteNumber(options.timeout, _config.parallelTimeout, 100, 600000);
            var deadline = now() + timeout;

            function commit(index, value) {
                stateLock.lock();
                try {
                    if (closed) return false;
                    if (results[index] === undefined) {
                        results[index] = !!value;
                        completed++;
                    }
                    return true;
                } finally { stateLock.unlock(); }
            }

            for (var i = 0; i < conditions.length; i++) {
                (function(index) {
                    var w = _threadMgr.start("condition:" + index, function() {
                        var value = false;
                        try { value = self.check(conditions[index], context, options); }
                        catch (e) { value = false; }
                        commit(index, value);
                    }, timeout);

                    if (w) {
                        workers.push(w);
                    } else {
                        // 线程池满时同步执行，保证“资源不足”不会被伪装成条件失败。
                        var value = false;
                        try { value = self.check(conditions[index], context, options); }
                        catch (e) { value = false; }
                        commit(index, value);
                    }
                })(i);
            }

            while (now() < deadline) {
                stateLock.lock();
                var done;
                try { done = completed >= conditions.length; }
                finally { stateLock.unlock(); }
                if (done) {
                    stateLock.lock();
                    try { closed = true; }
                    finally { stateLock.unlock(); }
                    return {completed: true, timedOut: false, results: results.slice()};
                }
                sleep(10);
            }

            stateLock.lock();
            try { closed = true; }
            finally { stateLock.unlock(); }
            for (var j = 0; j < workers.length; j++) if (!workers[j].finished) workers[j].cancel();

            // 未完成项稳定地归一为 false；返回后不会再被后台线程改写。
            var frozen = results.slice();
            for (var r = 0; r < frozen.length; r++) if (frozen[r] === undefined) frozen[r] = false;
            return {completed: false, timedOut: true, results: frozen};
        },

        clearCache: function() {
            _cacheLock.lock();
            try { _cache = {}; }
            finally { _cacheLock.unlock(); }
        },

        stop: function() { this.clearCache(); }
    };
});
