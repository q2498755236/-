package cn.autoeditor.pluginaction.ocr;

import android.graphics.Bitmap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class OcrExists extends BaseOcrAction {

    private static final String NAME = "存在文字";
    private static final String ARG_TEXT = "查找文字";
    private static final String RESULT = "是否存在";
    private static final List ARGS = Arrays.asList(ARG_TEXT);
    private static final List RESULTS = Arrays.asList(RESULT);

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
            out.put(RESULT, "false");
            return out;
        }
        String target = str(args, ARG_TEXT, "");
        if (target.isEmpty()) {
            return null;
        }
        boolean found = false;
        String raw = OcrEngine.recognize(mContext, screenshot, 3);
        String data = OcrEngine.dataOf(raw);
        JSONArray items = data == null ? null : OcrEngine.itemsOf(data);
        if (items != null) {
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) {
                    continue;
                }
                if (item.optString("text", "").contains(target)) {
                    found = true;
                    break;
                }
            }
        }
        out.put(RESULT, found ? "true" : "false");
        return out;
    }
}
