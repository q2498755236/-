;ui;
/**
 * 灵眸 v4.1.2 - 唯一入口
 * 1) 同引擎加载 loader.js
 * 2) 权限只在这里申请一次
 * 3) 启动失败由 loader 回滚
 */
(function() {
    "use strict";

    var source = engines.myEngine().getSource();
    var baseDir = files.join(files.dirName(source), "/");
    var loaderPath = files.join(baseDir, "loader.js");

    if (!files.exists(loaderPath)) throw new Error("loader.js not found: " + loaderPath);
    eval(files.read(loaderPath));

    if (!global.LingMou) throw new Error("LingMou loader failed");
    var LM = global.LingMou;

    function ensureAccessibility() {
        if (!auto.service) {
            log("[Main] Waiting for accessibility service...");
            auto.waitFor();
        }
    }

    function ensureScreenCapture() {
        log("[Main] Requesting screen capture permission...");
        if (!requestScreenCapture()) throw new Error("Screen capture permission denied");
    }

    function ensureFloatyPermission() {
        if (!floaty.checkPermission()) {
            log("[Main] Requesting floaty permission...");
            floaty.requestPermission();
            // 用户切换到设置页后可能需要更久；这里只做有限等待，不死循环。
            var deadline = Date.now() + 5000;
            while (!floaty.checkPermission() && Date.now() < deadline) sleep(250);
        }
    }

    try {
        if (!LM.init()) {
            throw new Error("Module loading failed: " + JSON.stringify(LM.getStatus().failedModules));
        }

        // 先读取配置，再决定是否申请可选的悬浮窗权限。
        var config = LM.require("ConfigManager");
        config.init();
        var cfg = config.getAll();

        ensureAccessibility();
        ensureScreenCapture();
        if ((cfg.ui && cfg.ui.floatyEnabled) || (cfg.ui && cfg.ui.monitorEnabled)) ensureFloatyPermission();

        if (!LM.start()) {
            throw new Error("Framework start failed");
        }

        events.on("exit", function() {
            try {
                if (global.LingMou && global.LingMou._status === "running") global.LingMou.stop();
            } catch (e) {}
        });
    } catch (e) {
        log("[Main] Fatal: " + e);
        try { LM.stop(true); } catch (ignore) {}
        toast("启动失败: " + e.message);
        exit();
    }
})();
