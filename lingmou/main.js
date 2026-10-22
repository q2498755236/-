// LingMou RC13 Startup Diagnostic
try{
 require('./core/StartupDiagnostic').check();
}catch(e){}

/**
 * 灵眸 v4.2 RC13 - 唯一入口
 * 1) 同引擎加载 loader.js
 * 2) 权限只在这里申请一次
 * 3) 启动失败由 loader 回滚
 */
(function() {
    "use strict";

    var source = engines.myEngine().getSource();
    var FileCompat = require("./core/FileCompat");
    var baseDir = files.join(FileCompat.dirName(source), "/");
    var loaderPath = files.join(baseDir, "loader.js");

    if (!files.exists(loaderPath)) throw new Error("loader.js not found: " + loaderPath);
    try {
        require("./loader.js");
    } catch (e) {
        log("[Loader Error] " + e);
        toast("灵眸启动失败:\\n" + e);
        throw e;
    }

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

        // 框架启动成功后拉起 Studio 可视化编辑器（独立 UI 引擎）
        if (!(cfg.ui && cfg.ui.studioEnabled === false)) {
            var studioPath = files.join(baseDir, "eca/studio.js");
            if (files.exists(studioPath)) {
                log("[Main] Launching Studio UI...");
                engines.execScriptFile(studioPath, {delay: 300});
            } else {
                log("[Main] Studio script missing: " + studioPath);
            }
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
