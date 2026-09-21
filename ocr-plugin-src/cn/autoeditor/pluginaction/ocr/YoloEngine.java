package cn.autoeditor.pluginaction.ocr;

import android.content.Context;
import android.graphics.Bitmap;

import org.json.JSONArray;
import org.json.JSONObject;

public final class YoloEngine {

    private static final String PARAM_ASSET = "model.ncnn.param";
    private static final String BIN_ASSET = "model.ncnn.bin";

    private static final Object LOCK = new Object();
    private static boolean sLoaded;
    private static String sLoadError;

    private YoloEngine() {
    }

    private static boolean ensureReady(Context ctx) {
        if (sLoaded) {
            return true;
        }
        try {
            Context pc = ctx.createPackageContext(OcrEngine.PLUGIN_PACKAGE,
                    Context.CONTEXT_INCLUDE_CODE | Context.CONTEXT_IGNORE_SECURITY);
            String dir = pc.getApplicationInfo().nativeLibraryDir;
            System.load(dir + "/libyolo8.so");
            sLoaded = YoloJni.init(pc.getAssets(), PARAM_ASSET, BIN_ASSET);
            if (!sLoaded) {
                sLoadError = "yolo model load failed";
            }
        } catch (Throwable t) {
            sLoadError = String.valueOf(t);
        }
        return sLoaded;
    }

    /**
     * 检测，返回原始数组 [n, 6]：中心X, 中心Y, 宽, 高, 类别id, 置信度（原图坐标）。
     */
    public static float[][] detect(Context ctx, Bitmap bitmap, float confThresh, float nmsThresh) {
        synchronized (LOCK) {
            if (!ensureReady(ctx)) {
                return new float[0][];
            }
            try {
                Bitmap src = bitmap;
                if (src.getConfig() != Bitmap.Config.ARGB_8888) {
                    src = src.copy(Bitmap.Config.ARGB_8888, false);
                }
                if (src == null) {
                    return new float[0][];
                }
                float[] raw = YoloJni.detect(src, confThresh, nmsThresh);
                int n = raw.length / 6;
                float[][] result = new float[n][];
                for (int i = 0; i < n; i++) {
                    result[i] = new float[]{raw[i * 6], raw[i * 6 + 1], raw[i * 6 + 2],
                            raw[i * 6 + 3], raw[i * 6 + 4], raw[i * 6 + 5]};
                }
                return result;
            } catch (Throwable t) {
                return new float[0][];
            }
        }
    }

    public static String getLoadError() {
        return sLoadError;
    }

    public static String resultsJson(float[][] dets) {
        JSONArray arr = new JSONArray();
        for (float[] d : dets) {
            JSONObject o = new JSONObject();
            try {
                o.put("cls", className((int) d[4]));
                o.put("conf", (double) Math.round(d[5] * 1000) / 1000);
                o.put("x", Math.round(d[0] - d[2] / 2));
                o.put("y", Math.round(d[1] - d[3] / 2));
                o.put("w", Math.round(d[2]));
                o.put("h", Math.round(d[3]));
                o.put("cx", Math.round(d[0]));
                o.put("cy", Math.round(d[1]));
            } catch (Exception ignored) {
            }
            arr.put(o);
        }
        JSONObject out = new JSONObject();
        try {
            out.put("status", 200);
            out.put("data", arr);
        } catch (Exception ignored) {
        }
        return out.toString();
    }

    private static String[] COCO = {"person", "bicycle", "car", "motorcycle", "airplane", "bus",
            "train", "truck", "boat", "traffic light", "fire hydrant", "stop sign",
            "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
            "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie",
            "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite", "baseball bat",
            "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
            "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
            "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake",
            "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv",
            "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven",
            "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors",
            "teddy bear", "hair drier", "toothbrush"};

    public static String className(int id) {
        if (id < 0 || id >= COCO.length) {
            return String.valueOf(id);
        }
        return COCO[id];
    }

    /**
     * 类别过滤：支持数字 id（0-79）、英文类名（bus）、中文别名（公交车）。
     * 返回 -1 表示不过滤，-2 表示未匹配。
     */
    public static int resolveClass(String filter) {
        if (filter == null || filter.trim().isEmpty()) {
            return -1;
        }
        String f = filter.trim();
        try {
            return Integer.parseInt(f);
        } catch (Exception ignored) {
        }
        String lf = f.toLowerCase();
        for (int i = 0; i < COCO.length; i++) {
            if (COCO[i].equalsIgnoreCase(lf)) {
                return i;
            }
        }
        for (int i = 0; i < CN.length; i++) {
            for (String alias : CN[i].split("\\|")) {
                if (alias.equals(f)) {
                    return i;
                }
            }
        }
        for (int i = 0; i < COCO.length; i++) {
            if (COCO[i].contains(lf)) {
                return i;
            }
        }
        for (int i = 0; i < CN.length; i++) {
            for (String alias : CN[i].split("\\|")) {
                if (f.contains(alias) || alias.contains(f)) {
                    return i;
                }
            }
        }
        return -2;
    }

    private static final String[] CN = {
            "人|人类|行人",                    // 0 person
            "自行车",                          // 1
            "汽车|轿车",                       // 2
            "摩托车",                          // 3
            "飞机",                            // 4
            "公交车|巴士|大巴",                // 5
            "火车|列车",                       // 6
            "卡车|货车",                       // 7
            "船|小船|轮船",                    // 8
            "红绿灯|交通灯|信号灯",            // 9
            "消防栓|消防龙头",                 // 10
            "停车标志|停止标志",               // 11
            "停车计时器|停车收费表|咪表",      // 12
            "长椅|长凳|板凳",                  // 13
            "鸟|小鸟",                         // 14
            "猫",                              // 15
            "狗",                              // 16
            "马",                              // 17
            "羊|绵羊",                         // 18
            "牛|奶牛|黄牛",                    // 19
            "大象",                            // 20
            "熊",                              // 21
            "斑马",                            // 22
            "长颈鹿",                          // 23
            "背包|双肩包",                     // 24
            "雨伞|伞",                         // 25
            "手提包|手袋|挎包",                // 26
            "领带",                            // 27
            "行李箱|手提箱|拉杆箱",            // 28
            "飞盘",                            // 29
            "滑雪板|滑雪橇",                   // 30
            "单板滑雪|滑雪单板",               // 31
            "球|皮球|运动球",                  // 32
            "风筝",                            // 33
            "棒球棒|球棒",                     // 34
            "棒球手套|手套",                   // 35
            "滑板",                            // 36
            "冲浪板",                          // 37
            "网球拍",                          // 38
            "瓶子|水瓶",                       // 39
            "酒杯|红酒杯|高脚杯",              // 40
            "杯子|水杯|茶杯",                  // 41
            "叉子|餐叉",                       // 42
            "刀|小刀",                         // 43
            "勺子|汤匙|调羹",                  // 44
            "碗",                              // 45
            "香蕉",                            // 46
            "苹果",                            // 47
            "三明治",                          // 48
            "橙子|橘子",                       // 49
            "西兰花",                          // 50
            "胡萝卜",                          // 51
            "热狗",                            // 52
            "披萨|比萨",                       // 53
            "甜甜圈|面包圈",                   // 54
            "蛋糕",                            // 55
            "椅子",                            // 56
            "沙发",                            // 57
            "盆栽|盆景|植物|花盆",             // 58
            "床",                              // 59
            "餐桌|桌子",                       // 60
            "马桶|坐便器",                     // 61
            "电视|电视机|显示器",              // 62
            "笔记本电脑|手提电脑|笔记本",      // 63
            "鼠标",                            // 64
            "遥控器",                          // 65
            "键盘",                            // 66
            "手机|电话",                       // 67
            "微波炉",                          // 68
            "烤箱",                            // 69
            "烤面包机|多士炉",                 // 70
            "水槽|洗手池|洗手盆",              // 71
            "冰箱",                            // 72
            "书|书本|书籍",                    // 73
            "钟表|时钟|挂钟",                  // 74
            "花瓶",                            // 75
            "剪刀",                            // 76
            "泰迪熊|玩偶|毛绒玩具",            // 77
            "吹风机|电吹风",                   // 78
            "牙刷",                            // 79
    };
}
