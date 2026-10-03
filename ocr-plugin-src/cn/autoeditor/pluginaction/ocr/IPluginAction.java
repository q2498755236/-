package cn.autoeditor.pluginaction.ocr;

import java.util.List;
import java.util.Map;

public interface IPluginAction {
    void initContext(String action, android.content.Context ctx);
    List actionList();
    List actionArgs(String action);
    Map argsOptions(String action);
    List results(String action);
    Map onAction(String action, Map args, android.graphics.Bitmap screenshot);
}
