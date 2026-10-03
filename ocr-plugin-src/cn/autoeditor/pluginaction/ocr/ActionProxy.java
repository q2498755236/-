package cn.autoeditor.pluginaction.ocr;

import android.content.Context;
import android.graphics.Bitmap;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class ActionProxy {

    private List mActionList = new ArrayList();
    private Map mActionObjects = new HashMap();

    public void addIAction(Class clazz) {
        try {
            IAction action = (IAction) clazz.newInstance();
            mActionObjects.put(action.getName(), action);
            mActionList.add(action.getName());
        } catch (InstantiationException e) {
            e.printStackTrace();
        } catch (IllegalAccessException e) {
            e.printStackTrace();
        }
    }

    public List actionList() {
        return mActionList;
    }

    public List actionArgs(String action) {
        return getAction(action).getArgs();
    }

    public Map argsOptions(String action) {
        return getAction(action).getOptions();
    }

    public List results(String action) {
        return getAction(action).getResults();
    }

    public void initContext(String action, Context ctx) {
        Object obj = mActionObjects.get(action);
        if (obj != null) {
            ((IAction) obj).initContext(ctx);
        }
    }

    public Map onAction(String action, Map args, Bitmap screenshot) {
        return getAction(action).onAction(args, screenshot);
    }

    private IAction getAction(String action) {
        Object obj = mActionObjects.get(action);
        if (obj == null) {
            throw new IllegalArgumentException("unknown action: " + action);
        }
        return (IAction) obj;
    }
}
