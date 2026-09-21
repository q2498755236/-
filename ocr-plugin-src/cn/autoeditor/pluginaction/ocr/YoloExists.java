package cn.autoeditor.pluginaction.ocr;

import android.graphics.Bitmap;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class YoloExists extends BaseOcrAction {

    private static final String NAME = "存在目标";
    private static final String ARG_CLASS = "目标类别";
    private static final String ARG_CONF = "置信度";
    private static final String RESULT = "是否检测到";
    private static final List ARGS = Arrays.asList(ARG_CLASS, ARG_CONF);
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
        String clsFilter = str(args, ARG_CLASS, "");
        float confThresh = 0.45f;
        try {
            confThresh = Float.parseFloat(str(args, ARG_CONF, ""));
        } catch (Exception ignored) {
        }
        if (confThresh <= 0 || confThresh > 1) {
            confThresh = 0.45f;
        }

        int cls = YoloEngine.resolveClass(clsFilter);
        if (cls == -2) {
            out.put(RESULT, "false");
            return out;
        }

        float[][] dets = YoloEngine.detect(mContext, screenshot, confThresh, 0.45f);
        boolean found = false;
        for (float[] d : dets) {
            if (cls < 0 || (int) d[4] == cls) {
                found = true;
                break;
            }
        }
        out.put(RESULT, found ? "true" : "false");
        return out;
    }
}
