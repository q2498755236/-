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
}
