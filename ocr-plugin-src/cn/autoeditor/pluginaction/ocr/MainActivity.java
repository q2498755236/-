package cn.autoeditor.pluginaction.ocr;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.Map;

public class MainActivity extends android.app.Activity implements IPluginAction {

    private ActionProxy actionProxy;

    public MainActivity() {
        actionProxy = new ActionProxy();
        actionProxy.addIAction(OcrRecog.class);
        actionProxy.addIAction(OcrAreaRecog.class);
        actionProxy.addIAction(OcrFind.class);
        actionProxy.addIAction(OcrAreaFind.class);
        actionProxy.addIAction(YoloDetect.class);
        actionProxy.addIAction(OcrExists.class);
        actionProxy.addIAction(YoloExists.class);
    }

    @Override
    public void initContext(String action, Context ctx) {
        actionProxy.initContext(action, ctx);
    }

    @Override
    public java.util.List actionList() {
        return actionProxy.actionList();
    }

    @Override
    public java.util.List actionArgs(String action) {
        return actionProxy.actionArgs(action);
    }

    @Override
    public Map argsOptions(String action) {
        return actionProxy.argsOptions(action);
    }

    @Override
    public java.util.List results(String action) {
        return actionProxy.results(action);
    }

    @Override
    public Map onAction(String action, Map args, Bitmap screenshot) {
        return actionProxy.onAction(action, args, screenshot);
    }

    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.WHITE);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (getResources().getDisplayMetrics().density * 16);
        box.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("OCR / YOLO 识别插件");
        title.setTextSize(22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(Color.BLACK);
        box.addView(title);

        TextView body = new TextView(this);
        body.setText("\n本插件提供离线 OCR 与 YOLO 目标检测能力，安装后无需额外 APP。\n"
                + "\n提供 7 个动作：\n"
                + "1. OCR识别：识别屏幕全部文字，支持 3 种输出格式\n"
                + "2. 区域OCR识别：识别指定矩形区域内的文字\n"
                + "3. 查找文字：查找屏幕文字并返回中心坐标\n"
                + "4. 区域查找文字：在指定区域内查找文字并返回中心坐标\n"
                + "5. YOLO检测：检测屏幕目标（COCO 80类），返回中心坐标与检测结果Json\n"
                + "6. 存在文字：条件动作，判断屏幕是否包含指定文字\n"
                + "7. 存在目标：条件动作，判断是否检测到指定类别目标\n"
                + "\nOCR识别格式说明：\n"
                + "1 = 纯文本\n"
                + "2 = Json数组(含坐标)\n"
                + "3 = 详细Json(含矩形宽高)\n"
                + "\nYOLO检测说明：\n"
                + "目标类别 = 空(全部) 或 中文名(人/汽车/手机...) 或 英文名(person/bus...) 或 数字id(0-79)\n"
                + "置信度 = 0~1 之间，默认 0.45\n"
                + "检测结果Json 含 cls/conf/x/y/w/h/cx/cy 字段\n"
                + "\n条件动作返回 true/false，可用于任务流程的条件分支。\n"
                + "\n在任务编辑器的插件动作列表中选择本插件即可使用。");
        body.setTextSize(15);
        body.setTextColor(Color.DKGRAY);
        body.setLineSpacing(0, 1.2f);
        box.addView(body);

        scroll.addView(box);
        setContentView(scroll);
    }
}
