package cn.autoeditor.pluginaction.ocr;

import android.content.Context;
import android.graphics.Bitmap;

import java.util.List;
import java.util.Map;

public abstract class BaseOcrAction implements IAction {

    protected Context mContext;

    @Override
    public void initContext(Context ctx) {
        mContext = ctx;
    }

    protected String license() {
        return LicenseGate.check(mContext);
    }

    @Override
    public Map getOptions() {
        return null;
    }

    protected static String str(Map args, String key, String def) {
        Object v = args == null ? null : args.get(key);
        if (v instanceof String) {
            String s = ((String) v).trim();
            if (!s.isEmpty()) {
                return s;
            }
        }
        return def;
    }

    protected static int parseInt(Map args, String key, int def) {
        try {
            return Integer.parseInt(str(args, key, String.valueOf(def)));
        } catch (Exception e) {
            return def;
        }
    }

    /**
     * 解析 "x,y,w,h" 格式区域；空或无效返回 null。
     */
    protected static int[] parseXYWH(String s) {
        if (s == null || s.isEmpty()) {
            return null;
        }
        String[] parts = s.split("[,，]");
        if (parts.length < 4) {
            return null;
        }
        try {
            int[] r = new int[4];
            for (int i = 0; i < 4; i++) {
                r[i] = (int) Double.parseDouble(parts[i].trim());
            }
            return r;
        } catch (Exception e) {
            return null;
        }
    }

    protected static Bitmap crop(Bitmap src, int l, int t, int r, int b) {
        int w = src.getWidth();
        int h = src.getHeight();
        l = Math.max(0, Math.min(l, w - 1));
        t = Math.max(0, Math.min(t, h - 1));
        r = Math.max(l + 1, Math.min(r, w));
        b = Math.max(t + 1, Math.min(b, h));
        if (r - l < 1 || b - t < 1) {
            return null;
        }
        if (l == 0 && t == 0 && r == w && b == h) {
            return src;
        }
        try {
            return Bitmap.createBitmap(src, l, t, r - l, b - t);
        } catch (Throwable e) {
            return null;
        }
    }
}
