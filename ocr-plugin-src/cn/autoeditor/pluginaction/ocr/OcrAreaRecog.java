package cn.autoeditor.pluginaction.ocr;

import android.graphics.Bitmap;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class OcrAreaRecog extends BaseOcrAction {

    private static final String NAME = "区域OCR识别";
    private static final String ARG_REGION = "区域";
    private static final String ARG_TYPE = "识别格式";
    private static final String RESULT_TEXT = "识别结果";
    private static final List ARGS = Arrays.asList(ARG_REGION, ARG_TYPE);
    private static final List RESULTS = Arrays.asList(RESULT_TEXT);

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
            out.put(RESULT_TEXT, "未授权: " + lic);
            return out;
        }
        int type = parseInt(args, ARG_TYPE, 1);
        if (type < 1 || type > 3) {
            type = 1;
        }
        int[] rect = parseXYWH(str(args, ARG_REGION, ""));
        int l = rect != null ? rect[0] : 0;
        int t = rect != null ? rect[1] : 0;
        int r = rect != null ? rect[0] + rect[2] : screenshot.getWidth();
        int b = rect != null ? rect[1] + rect[3] : screenshot.getHeight();
        Bitmap region = crop(screenshot, l, t, r, b);
        if (region == null) {
            out.put(RESULT_TEXT, "");
            return out;
        }
        String raw = OcrEngine.recognize(mContext, region, type);
        String data = OcrEngine.dataOf(raw);
        out.put(RESULT_TEXT, data == null ? "" : data);
        if (region != screenshot) {
            region.recycle();
        }
        return out;
    }
}
