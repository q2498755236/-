package cn.autoeditor.pluginaction.ocr;

import android.graphics.Bitmap;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class YoloDetect extends BaseOcrAction {

    private static final String NAME = "YOLO检测";
    private static final String ARG_CLASS = "目标类别";
    private static final String ARG_CONF = "置信度";
    private static final String RESULT_FOUND = "是否检测到";
    private static final String RESULT_RECT = "目标矩形";
    private static final String RESULT_CENTER = "中心坐标";
    private static final String RESULT_JSON = "检测结果";
    private static final List ARGS = Arrays.asList(ARG_CLASS, ARG_CONF);
    private static final List RESULTS = Arrays.asList(RESULT_FOUND, RESULT_RECT,
            RESULT_CENTER, RESULT_JSON);

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
            out.put(RESULT_JSON, "{\"error\":\"" + lic + "\"}");
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
            out.put(RESULT_FOUND, "false");
            out.put(RESULT_RECT, "-1,-1,-1,-1");
            out.put(RESULT_CENTER, "-1,-1");
            out.put(RESULT_JSON, YoloEngine.resultsJson(new float[0][]));
            return out;
        }

        float[][] dets = YoloEngine.detect(mContext, screenshot, confThresh, 0.45f);
        out.put(RESULT_JSON, YoloEngine.resultsJson(dets));

        boolean found = false;
        float bestConf = 0;
        String rect = "-1,-1,-1,-1";
        String center = "-1,-1";
        for (float[] d : dets) {
            if (cls >= 0 && (int) d[4] != cls) {
                continue;
            }
            if (d[5] > bestConf) {
                bestConf = d[5];
                int x = Math.round(d[0] - d[2] / 2);
                int y = Math.round(d[1] - d[3] / 2);
                rect = x + "," + y + "," + Math.round(d[2]) + "," + Math.round(d[3]);
                center = Math.round(d[0]) + "," + Math.round(d[1]);
                found = true;
            }
        }
        out.put(RESULT_FOUND, found ? "true" : "false");
        out.put(RESULT_RECT, rect);
        out.put(RESULT_CENTER, center);
        return out;
    }
}
