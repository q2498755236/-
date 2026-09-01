/**
 * 灵眸 v4.1.2 - 事件树管理器
 * - remove 同时从 parent.children 移除
 * - timeoutAt 在执行前真实检查
 */
LingMouAPI.register("EventManager", function(API) {
    "use strict";

    var _root = {name: "__root__", children: [], parent: null};
    var _events = {};
    var _lock = threads.lock();
    var _stats = {added: 0, removed: 0, executed: 0, errors: 0, timeouts: 0};

    function detach(node) {
        if (!node || !node.parent) return;
        var arr = node.parent.children;
        for (var i = arr.length - 1; i >= 0; i--) {
            if (arr[i] === node) arr.splice(i, 1);
        }
        node.parent = null;
    }

    function removeNode(node) {
        if (!node) return;
        var children = node.children.slice();
        for (var i = 0; i < children.length; i++) removeNode(children[i]);
        delete _events[node.name];
        detach(node);
        _stats.removed++;
    }

    function executeNode(node, payload) {
        if (!node) return false;

        // 执行前确认节点仍在事件树中；这会阻止 once 父节点移除子树后，traverse 的旧快照继续执行子节点。
        _lock.lock();
        try {
            if (_events[node.name] !== node || node.enabled === false) return false;
            if (node.timeoutAt && Date.now() >= node.timeoutAt) {
                _stats.timeouts++;
                removeNode(node);
                return false;
            }
        } finally { _lock.unlock(); }

        try {
            node.fn(payload, node);
            _stats.executed++;
            if (node.once) {
                _lock.lock();
                try {
                    if (_events[node.name] === node) removeNode(node);
                } finally { _lock.unlock(); }
            }
            return true;
        } catch (e) {
            _stats.errors++;
            log("[EventManager] Event error [" + node.name + "]: " + e);
            return false;
        }
    }

    return {
        init: function() {
            log("[EventManager] Initialized");
            return true;
        },

        add: function(name, fn, options) {
            options = options || {};
            if (!name || typeof fn !== "function") throw new Error("Invalid event");
            _lock.lock();
            try {
                if (_events[name]) removeNode(_events[name]);
                var parent = options.parent ? _events[options.parent] : _root;
                if (!parent) parent = _root;
                var node = {
                    name: String(name),
                    fn: fn,
                    parent: parent,
                    children: [],
                    priority: Number(options.priority || 0),
                    enabled: options.enabled !== false,
                    once: !!options.once,
                    timeoutAt: options.timeout ? Date.now() + Number(options.timeout) : 0
                };
                parent.children.push(node);
                parent.children.sort(function(a, b) { return b.priority - a.priority; });
                _events[node.name] = node;
                _stats.added++;
                return node;
            } finally { _lock.unlock(); }
        },

        on: function(name, fn, options) { return this.add(name, fn, options); },

        remove: function(name) {
            _lock.lock();
            try {
                var node = _events[String(name)];
                if (!node) return false;
                removeNode(node);
                return true;
            } finally { _lock.unlock(); }
        },

        emit: function(name, payload) {
            var node;
            _lock.lock();
            try { node = _events[String(name)]; }
            finally { _lock.unlock(); }
            return executeNode(node, payload);
        },

        trigger: function(name, payload) { return this.emit(name, payload); },

        traverse: function(payload) {
            var list = [];
            function walk(node) {
                for (var i = 0; i < node.children.length; i++) {
                    list.push(node.children[i]);
                    walk(node.children[i]);
                }
            }
            _lock.lock();
            try { walk(_root); }
            finally { _lock.unlock(); }
            for (var j = 0; j < list.length; j++) executeNode(list[j], payload);
            return list.length;
        },

        clear: function() {
            _lock.lock();
            try {
                _root.children = [];
                _events = {};
            } finally { _lock.unlock(); }
        },

        stop: function() { this.clear(); },
        getStats: function() { return JSON.parse(JSON.stringify(_stats)); }
    };
});
