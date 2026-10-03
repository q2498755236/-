package cn.autoeditor.pluginaction.ocr;

import java.util.List;
import java.util.Map;

public interface IAction {
    void initContext(android.content.Context ctx);
    String getName();
    List getArgs();
    Map getOptions();
    List getResults();
    Map onAction(Map args, android.graphics.Bitmap screenshot);
}
