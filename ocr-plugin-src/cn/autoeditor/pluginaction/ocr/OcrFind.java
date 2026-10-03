package cn.autoeditor.pluginaction.ocr;

import android.graphics.Bitmap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class OcrFind extends BaseOcrAction {

    private static final String NAME = "查找文字";
    private static final String ARG_TEXT = "查找文字";
    private static final String RESULT_FOUND = "是否找到";
    private static final String RESULT_RECT = "文字矩形";
    private static final String RESULT_CENTER = "中心点";
    private static final List ARGS = Arrays.asList(ARG_TEXT);
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
        if (!target.isEmpty()) {
            String raw = OcrEngine.recognize(mContext, screenshot, 3);
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
                        int[] r = OcrEngine.rectOf(item);
                        if (r != null) {
                            out.put(RESULT_FOUND, "true");
                            out.put(RESULT_RECT, r[0] + "," + r[1] + "," + r[2] + "," + r[3]);
                            out.put(RESULT_CENTER, (r[0] + r[2] / 2) + "," + (r[1] + r[3] / 2));
                            found = true;
                            break;
                        }
                    }
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
