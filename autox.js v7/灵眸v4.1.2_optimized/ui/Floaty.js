/**
 * 灵眸 v4.1.2 - 浮窗管理
 * 权限只检查，不在模块内部重复请求。
 */
LingMouAPI.register("Floaty", function(API) {
    "use strict";

    var _window = null;
    var _visible = false;
    var _worker = null;
    var _generation = 0;
    var _threadMgr = null;
    var _enabled = true;

    return {
        init: function(options) {
            options = options || {};
            _enabled = options.enabled !== false;
            _threadMgr = API.require("ThreadManager");
            log("[Floaty] Initialized");
            return true;
        },

        show: function() {
            if (!_enabled || _visible) return _visible;
            if (!floaty.checkPermission()) {
                log("[Floaty] Permission missing; main.js owns permission requests");
                return false;
            }

            _window = floaty.window(
                <frame gravity="center">
                    <text id="status" text="灵眸v4.1.2" textColor="#ffffff" bg="#80000000" padding="10"/>
                </frame>
            );
            _window.setPosition(100, 100);
            _window.setAdjustEnabled(true);
            _visible = true;
            var myGeneration = ++_generation;

            var w = _threadMgr.start("FloatyClock", function() {
                while (_visible && _window && myGeneration === _generation) {
                    try {
                        ui.run(function() {
                            if (_window && _window.status) {
                                _window.status.setText("灵眸v4.1.2 | " + new Date().toLocaleTimeString());
                            }
                        });
                    } catch (e) {}
                    sleep(1000);
                }
            }, 0);
            if (!w) {
                if (myGeneration === _generation) _visible = false;
                try { _window.close(); } catch (e) {}
                _window = null;
                return false;
            }
            _worker = w;
            return true;
        },

        hide: function() {
            _visible = false;
            _generation++;
            var old = _worker;
            _worker = null;
            if (old) old.cancel();
            if (_window) {
                try { _window.close(); } catch (e) {}
                _window = null;
            }
            return true;
        },

        setText: function(text) {
            if (!_window || !_window.status) return false;
            ui.run(function() {
                if (_window && _window.status) _window.status.setText(String(text));
            });
            return true;
        },

        isVisible: function() { return _visible; }
    };
});
