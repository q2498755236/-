package cn.autoeditor.pluginaction.ocr;

import android.content.Context;
import android.graphics.Bitmap;

import com.wubugncnn.njocr.OCRService;

import org.json.JSONArray;
import org.json.JSONObject;

public final class OcrEngine {

    public static final String PLUGIN_PACKAGE = "cn.autoeditor.pluginaction.ocr";

    private static final Object LOCK = new Object();
    private static OCRService sService;
    private static boolean sLoaded;
    private static String sLoadError;

    private OcrEngine() {
    }

    private static boolean ensureReady(Context ctx) {
        if (sLoaded) {
            return true;
        }
        try {
            Context pc = ctx.createPackageContext(PLUGIN_PACKAGE,
                    Context.CONTEXT_INCLUDE_CODE | Context.CONTEXT_IGNORE_SECURITY);
            String dir = pc.getApplicationInfo().nativeLibraryDir;
            System.load(dir + "/libc++_shared.so");
            System.load(dir + "/libnjocr.so");
            OCRService service = new OCRService();
            if (!service.initModels(pc.getAssets())) {
                sLoadError = "model init failed";
                return false;
            }
            sService = service;
            sLoaded = true;
            return true;
        } catch (Throwable t) {
            sLoadError = String.valueOf(t);
            return false;
        }
    }

    public static String recognize(Context ctx, Bitmap bitmap, int type) {
        synchronized (LOCK) {
            if (!ensureReady(ctx)) {
                return "{\"status\": 500, \"data\": \"engine error: " + jsonEscape(sLoadError) + "\"}";
            }
            try {
                return sService.nativeProcessBitmap(bitmap, type);
            } catch (Throwable t) {
                return "{\"status\": 500, \"data\": \"ocr error: " + jsonEscape(String.valueOf(t)) + "\"}";
            }
        }
    }

    public static String dataOf(String raw) {
        try {
            JSONObject obj = new JSONObject(raw);
            int status = obj.optInt("status", -1);
            if (status != 200) {
                return null;
            }
            return obj.optString("data", "");
        } catch (Exception e) {
            return null;
        }
    }

    public static JSONArray itemsOf(String data) {
        try {
            JSONArray arr = new JSONArray(data);
            return arr;
        } catch (Exception e) {
            try {
                JSONObject single = new JSONObject(data);
                if (single.has("text")) {
                    JSONArray arr = new JSONArray();
                    arr.put(single);
                    return arr;
                }
            } catch (Exception ignored) {
            }
            return null;
        }
    }

    public static String jsonEscape(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }

    /* 从识别条目提取矩形 [x,y,w,h]: native points 四角点 (上左下右) 转包围盒,
     * 兼容已给 x/y/w/h 字段的形态; 无有效坐标返回 null */
    public static int[] rectOf(JSONObject item) {
        JSONArray pts = item.optJSONArray("points");
        if (pts != null && pts.length() > 0) {
            int minX = Integer.MAX_VALUE, minY = Integer.MAX_VALUE;
            int maxX = Integer.MIN_VALUE, maxY = Integer.MIN_VALUE;
            for (int p = 0; p < pts.length(); p++) {
                JSONArray pt = pts.optJSONArray(p);
                if (pt == null || pt.length() < 2) {
                    continue;
                }
                int px = pt.optInt(0), py = pt.optInt(1);
                if (px < minX) minX = px;
                if (py < minY) minY = py;
                if (px > maxX) maxX = px;
                if (py > maxY) maxY = py;
            }
            if (minX != Integer.MAX_VALUE) {
                return new int[]{minX, minY, maxX - minX, maxY - minY};
            }
            return null;
        }
        return new int[]{item.optInt("x", -1), item.optInt("y", -1),
                item.optInt("w", 0), item.optInt("h", 0)};
    }

    /* 识别结果转设备管理系统标准数组格式 [{"name":"文字","count":".."}]:
     * type 1 data 为纯文本, 按行拆条目, count 置空;
     * type 2 count = "x,y" (左上角坐标);
     * type 3 points 四角点转包围盒, count = "x,y,w,h" (兼容 native 已给 x/y/w/h 的形态);
     * 解析失败返回 null, 由调用方回退原始 data */
    public static String stdOf(String data, int type) {
        try {
            JSONArray out = new JSONArray();
            if (type == 1) {
                String[] lines = data.split("\n");
                for (int i = 0; i < lines.length; i++) {
                    String line = lines[i].trim();
                    if (line.isEmpty()) {
                        continue;
                    }
                    JSONObject it = new JSONObject();
                    it.put("name", line);
                    it.put("count", "");
                    out.put(it);
                }
            } else {
                JSONArray arr = new JSONArray(data);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject item = arr.optJSONObject(i);
                    if (item == null) {
                        continue;
                    }
                    String count = "";
                    if (type == 2) {
                        count = item.optInt("x", -1) + "," + item.optInt("y", -1);
                    } else {
                        int[] r = rectOf(item);
                        if (r != null) {
                            count = r[0] + "," + r[1] + "," + r[2] + "," + r[3];
                        }
                    }
                    JSONObject it = new JSONObject();
                    it.put("name", item.optString("text", ""));
                    it.put("count", count);
                    out.put(it);
                }
            }
            return out.toString();
        } catch (Exception e) {
            return null;
        }
    }
}
