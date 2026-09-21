package cn.autoeditor.pluginaction.ocr;

import android.graphics.Bitmap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class OcrAreaFind extends BaseOcrAction {

    private static final String NAME = "区域查找文字";
    private static final String ARG_TEXT = "查找文字";
    private static final String ARG_REGION = "区域";
    private static final String RESULT_FOUND = "是否找到";
    private static final String RESULT_RECT = "文字矩形";
    private static final String RESULT_CENTER = "中心点";
    private static final List ARGS = Arrays.asList(ARG_TEXT, ARG_REGION);
    private static final List RESULTS = Arrays.asList(RESULT_FOUND, RESULT_RECT, RESULT_CENTER);

    @Override
    public String getName() {
        return NAME;
    }

    @Override
    public List getArgs() {
        return ARGS;
    }

    @Override
    public List getResults() {
        return RESULTS;
    }

    @Override
    public Map onAction(Map args, Bitmap screenshot) {
        Map<String, Object> out = new HashMap<String, Object>();
        String lic = license();
        if (lic != null) {
            out.put(RESULT_FOUND, "false");
            out.put(RESULT_RECT, "-1,-1,-1,-1");
            out.put(RESULT_CENTER, "-1,-1");
            return out;
        }
        String target = str(args, ARG_TEXT, "");
        boolean found = false;
        int[] rect = parseXYWH(str(args, ARG_REGION, ""));
        int l = rect != null ? rect[0] : 0;
        int t = rect != null ? rect[1] : 0;
        int r = rect != null ? rect[0] + rect[2] : screenshot.getWidth();
        int b = rect != null ? rect[1] + rect[3] : screenshot.getHeight();
        if (!target.isEmpty()) {
            Bitmap region = crop(screenshot, l, t, r, b);
            if (region != null) {
                String raw = OcrEngine.recognize(mContext, region, 3);
                String data = OcrEngine.dataOf(raw);
                JSONArray items = data == null ? null : OcrEngine.itemsOf(data);
                if (items != null) {
                    for (int i = 0; i < items.length(); i++) {
                        JSONObject item = items.optJSONObject(i);
                        if (item == null) {
                            continue;
                        }
                        String text = item.optString("text", "");
                        if (text.contains(target)) {
                            int x = item.optInt("x", -1) + l;
                            int y = item.optInt("y", -1) + t;
                            int w = item.optInt("w", 0);
                            int h = item.optInt("h", 0);
                            out.put(RESULT_FOUND, "true");
                            out.put(RESULT_RECT, x + "," + y + "," + w + "," + h);
                            out.put(RESULT_CENTER, (x + w / 2) + "," + (y + h / 2));
                            found = true;
                            break;
                        }
                    }
                }
                if (region != screenshot) {
                    region.recycle();
                }
            }
        }
        if (!found) {
            out.put(RESULT_FOUND, "false");
            out.put(RESULT_RECT, "-1,-1,-1,-1");
            out.put(RESULT_CENTER, "-1,-1");
        }
        return out;
    }
}
