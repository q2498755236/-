package cn.autoeditor.pluginaction.ocr;

import android.graphics.Bitmap;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class OcrRecog extends BaseOcrAction {

    private static final String NAME = "OCR识别";
    private static final String ARG_TYPE = "识别格式";
    private static final String RESULT_TEXT = "识别结果";
    private static final List ARGS = Arrays.asList(ARG_TYPE);
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
        String raw = OcrEngine.recognize(mContext, screenshot, type);
        String data = OcrEngine.dataOf(raw);
        /* 识别结果统一为标准数组格式 [{"name":"文字","count":".."}], 转换失败回退原始 data */
        String std = data == null ? null : OcrEngine.stdOf(data, type);
        out.put(RESULT_TEXT, std != null ? std : (data == null ? "" : data));
        return out;
    }
}
