/**
 * 灵眸 v4.3 - 编辑器复刻层: .auto 任务装载
 * 对齐编辑器 .auto 格式:
 *   ZIP = script.json (任务模型) + image/ (模板图) + ori/ + local_data/ + GBK插件目录
 *   插件 JSON 文件名 = uuid, 与 script.json 的 js_plugin_list 对应
 * 依赖注入: io {readBytes, writeBytes, listDir, exists, mkdirs} 便于 node 冒烟;
 * AutoX 侧用默认实现 (ZipInputStream + files API)。
 */
"use strict";

function AutoTask(opts) {
    opts = opts || {};
    this.io = opts.io || null;   // node 注入; AutoX 侧 null 走 java 内置
    this.logger = typeof opts.logger === "function" ? opts.logger : function() {};
}

/* ---------- io 适配 ---------- */

AutoTask.prototype._readBytes = function(path) {
    if (this.io && this.io.readBytes) return this.io.readBytes(path);
    var fis = new java.io.FileInputStream(path);
    try {
        var baos = new java.io.ByteArrayOutputStream();
        var buf = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 8192);
        var n;
        while ((n = fis.read(buf)) > 0) baos.write(buf, 0, n);
        return baos.toByteArray();
    } finally { fis.close(); }
};

AutoTask.prototype._writeBytes = function(path, bytes) {
    if (this.io && this.io.writeBytes) return this.io.writeBytes(path, bytes);
    var f = new java.io.File(path);
    var parent = f.getParentFile();
    if (parent && !parent.exists()) parent.mkdirs();
    var fos = new java.io.FileOutputStream(f);
    try { fos.write(bytes); } finally { fos.close(); }
};

AutoTask.prototype._exists = function(path) {
    if (this.io && this.io.exists) return this.io.exists(path);
    return new java.io.File(path).exists();
};

AutoTask.prototype._mkdirs = function(path) {
    if (this.io && this.io.mkdirs) return this.io.mkdirs(path);
    new java.io.File(path).mkdirs();
};

/** 流式解包: GBK entry name, 返回 {entries:[{name, bytes?}], count}。
 * script.json 与插件 json 读入内存; image/ori 落盘。 */
AutoTask.prototype._unzip = function(autoPath, outDir) {
    var charset = java.nio.charset.Charset.forName("GBK");
    var fis = new java.io.FileInputStream(autoPath);
    var zis = new java.util.zip.ZipInputStream(fis, charset);
    var result = { scriptJson: null, pluginDefs: [], files: [] };
    var buf = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 8192);
    var entry;
    try {
        while ((entry = zis.getNextEntry()) !== null) {
            var name = String(entry.getName());
            if (!name || name.charAt(0) === "/" || name.indexOf("..") >= 0) continue; // zip slip 防护
            var baos = new java.io.ByteArrayOutputStream();
            var n;
            while ((n = zis.read(buf)) > 0) baos.write(buf, 0, n);
            var bytes = baos.toByteArray();
            var base = name.replace(/\\/g, "/");
            // script.json 读入内存
            if (base === "script.json") {
                result.scriptJson = new java.lang.String(bytes, "UTF-8");
                continue;
            }
            // 插件 json: "插件/<分组>/<uuid>.json" (真实样本为 插件/我的/), 文件名即 uuid (权威);
            // 注意 JSON 内 mUUID 可能与文件名不一致 (样本: 气泡), 任务引用以文件名为准
            if (/^插件\/[^\/]+\/[^\/]+\.json$/.test(base) || /plugin\/[^\/]+\/[^\/]+\.json$/i.test(base)) {
                var def = JSON.parse(String(new java.lang.String(bytes, "UTF-8")));
                def.mFileUuid = base.split("/").pop().replace(/\.json$/, "");
                result.pluginDefs.push(def);
                continue;
            }
            // image/ori 落盘
            if (/^(image|ori)\//.test(base)) {
                var out = outDir + "/" + base;
                this._writeBytes(out, bytes);
                result.files.push(base);
            }
            // local_data / version 等跳过
            zis.closeEntry();
        }
    } finally { zis.close(); }
    return result;
};

/** 主入口: 解包 .auto 并解析任务模型。
 * 返回 {ok, dir, model, pluginDefs, message}。 */
AutoTask.prototype.parse = function(autoPath, tasksRoot) {
    try {
        var src = new java.io.File(autoPath);
        if (!src.exists()) return { ok: false, message: "文件不存在: " + autoPath };
        var taskName = String(src.getName()).replace(/\.auto$/i, "");
        var outDir = tasksRoot + "/" + taskName;
        if (!this._exists(outDir)) this._mkdirs(outDir);
        var uz = this._unzip(autoPath, outDir);
        if (!uz.scriptJson) return { ok: false, message: "缺少 script.json" };
        var model = JSON.parse(String(uz.scriptJson));
        // image_list: id -> {file, sim, rect}; image_id 动作/条件经此查模板图
        var imageMap = {};
        var imgList = Array.isArray(model.image_list) ? model.image_list : [];
        for (var i = 0; i < imgList.length; i++) {
            var img = imgList[i];
            if (!img || !img.id) continue;
            var first = (Array.isArray(img.images) && img.images[0]) || null;
            imageMap[String(img.id)] = {
                name: img.name || "",
                file: first ? first.file : "",
                sim: Number(first && first.sim || img.sim) || 0.8,
                rect: first ? first.rect : ""
            };
        }
        // image/ 文件名 -> 路径
        var fileMap = {};
        for (var j = 0; j < uz.files.length; j++) {
            var f = uz.files[j];
            var m2 = /^image\/(.+)$/.exec(f);
            if (m2) fileMap[m2[1]] = outDir + "/" + f;
        }
        // gesture_group_list: id -> 手势定义 (pathList 多段指针路径)
        var gestureMap = {};
        var gList = Array.isArray(model.gesture_group_list) ? model.gesture_group_list : [];
        for (var k = 0; k < gList.length; k++) {
            if (gList[k] && gList[k].id) gestureMap[String(gList[k].id)] = gList[k];
        }
        // color_list: id -> {name, color(int 负数 ARGB), sim} (找色计数条件 type=7 引用)
        var colorMap = {};
        var cList = Array.isArray(model.color_list) ? model.color_list : [];
        for (var k2 = 0; k2 < cList.length; k2++) {
            if (cList[k2] && cList[k2].id) colorMap[String(cList[k2].id)] = cList[k2];
        }
        this._imageMap = imageMap;
        this._fileMap = fileMap;
        this._gestureMap = gestureMap;
        this._colorMap = colorMap;
        var varMap = {};
        var vList = Array.isArray(model.var_list) ? model.var_list : [];
        for (var k3 = 0; k3 < vList.length; k3++) {
            if (vList[k3] && vList[k3].id) varMap[String(vList[k3].id)] = vList[k3];
        }
        this._varById = varMap;
        this.dir = outDir;
        this.model = model;
        this.pluginDefs = uz.pluginDefs;
        this.logger("[.auto] " + taskName + " 装载: 场景 " + (model.scene_list || []).length +
            ", 变量 " + (model.var_list || []).length + ", 插件 " + uz.pluginDefs.length +
            ", 模板图 " + Object.keys(imageMap).length);
        return { ok: true, dir: outDir, model: model, pluginDefs: uz.pluginDefs, message: "" };
    } catch (e) {
        this.logger("[E] .auto 解析失败: " + e, "error");
        return { ok: false, message: String(e) };
    }
};

/** image_id -> 模板图 {path, sim, rect} 或 null。 */
AutoTask.prototype.imageFile = function(imageId) {
    var rec = this._imageMap ? this._imageMap[String(imageId)] : null;
    if (!rec || !rec.file) return null;
    var path = this._fileMap ? this._fileMap[rec.file] : null;
    if (!path) return null;
    return { path: path, sim: rec.sim, rect: rec.rect, name: rec.name };
};

/** gesture id -> 手势定义 {list:[{sleep, gesture:{pathList, duration}}]}。 */
AutoTask.prototype.gestureGroup = function(gid) {
    return (this._gestureMap && this._gestureMap[String(gid)]) || null;
};

/** color_id -> 颜色定义 {name, color(int 负数 ARGB), sim:"0.8"} 或 null。 */
AutoTask.prototype.colorDef = function(colorId) {
    return (this._colorMap && this._colorMap[String(colorId)]) || null;
};

/** var_id -> 变量绑定模板图 {path, rect, screenW, screenH} 或 null。
 * type=4 找图赋值的模板来自变量 crops (变量面板截图: ori 原图文件 + rect 裁剪区),
 * 非动作 image_id (image_list)。fileMap 键兼容 parse("image/x.png") 与
 * loadFromDir("x.png") 两种形态。 */
AutoTask.prototype.cropImage = function(varId) {
    var rec = this._varById ? this._varById[String(varId)] : null;
    var c = rec && Array.isArray(rec.crops) && rec.crops[0];
    if (!c || !c.ori) return null;
    var path = (this._fileMap && (this._fileMap[c.ori] || this._fileMap["image/" + c.ori])) || null;
    if (!path) return null;
    var si = c.screen_info || {};
    return {
        path: path,
        rect: c.rect || "",
        screenW: Number(si.width) || 0,
        screenH: Number(si.height) || 0
    };
};

/** node 冒烟入口: 从已解包目录装载 (parse 的内存版)。
 * io: {readFile(path)->string|Buffer, listDir(dir)->[names]}。 */
AutoTask.prototype.loadFromDir = function(dir, io) {
    var model = JSON.parse(io.readFile(dir + "/script.json"));
    var fileMap = {};
    var names = io.listDir(dir + "/image") || [];
    for (var i = 0; i < names.length; i++) fileMap[names[i]] = dir + "/image/" + names[i];
    var imageMap = {};
    var imgList = Array.isArray(model.image_list) ? model.image_list : [];
    for (var j = 0; j < imgList.length; j++) {
        var img = imgList[j];
        if (!img || !img.id) continue;
        var first = (Array.isArray(img.images) && img.images[0]) || null;
        imageMap[String(img.id)] = {
            name: img.name || "",
            file: first ? first.file : "",
            sim: Number(first && first.sim || img.sim) || 0.8,
            rect: first ? first.rect : ""
        };
    }
    var gestureMap = {};
    var gList = Array.isArray(model.gesture_group_list) ? model.gesture_group_list : [];
    for (var k = 0; k < gList.length; k++) {
        if (gList[k] && gList[k].id) gestureMap[String(gList[k].id)] = gList[k];
    }
    var colorMap = {};
    var cList = Array.isArray(model.color_list) ? model.color_list : [];
    for (var k2 = 0; k2 < cList.length; k2++) {
        if (cList[k2] && cList[k2].id) colorMap[String(cList[k2].id)] = cList[k2];
    }
    this.dir = dir;
    this.model = model;
    // node 路径: 插件 defs 由调用方读取后传入 loadFromDir 的 io.pluginDefs 或后续 setPluginDefs
    this.pluginDefs = [];
    this._imageMap = imageMap;
    this._fileMap = fileMap;
    this._gestureMap = gestureMap;
    this._colorMap = colorMap;
    var varMap = {};
    var vList = Array.isArray(model.var_list) ? model.var_list : [];
    for (var k3 = 0; k3 < vList.length; k3++) {
        if (vList[k3] && vList[k3].id) varMap[String(vList[k3].id)] = vList[k3];
    }
    this._varById = varMap;
    return { ok: true, dir: dir, model: model, pluginDefs: [], message: "" };
};

/** 注入插件 defs (node 测试路径; 文件名即 uuid)。 */
AutoTask.prototype.setPluginDefs = function(defs, fileNames) {
    var list = Array.isArray(defs) ? defs : [];
    for (var i = 0; i < list.length; i++) {
        if (fileNames && fileNames[i]) list[i].mFileUuid = String(fileNames[i]).replace(/\.json$/, "");
    }
    this.pluginDefs = list;
    return this;
};

module.exports = AutoTask;
