package cn.autoeditor.pluginaction.ocr;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

/**
 * 授权门禁：token 缓存 20 分钟，过期重新在线验证；所有动作执行前必须通过。
 */
public final class LicenseGate {

    private static final String TAG = "LicenseGate";
    private static final String PREFS = "license";
    private static final long CACHE_TTL = 20 * 60 * 1000L;

    private static final Object LOCK = new Object();
    private static String sLastError;
    private static boolean sLibLoaded;

    private LicenseGate() {
    }

    private static synchronized boolean ensureLib(Context ctx) {
        if (sLibLoaded) {
            return true;
        }
        try {
            Context pc = ctx.createPackageContext(OcrEngine.PLUGIN_PACKAGE,
                    Context.CONTEXT_INCLUDE_CODE | Context.CONTEXT_IGNORE_SECURITY);
            System.load(pc.getApplicationInfo().nativeLibraryDir + "/libyolo8.so");
            sLibLoaded = true;
        } catch (Throwable t) {
            Log.w(TAG, "load libyolo8: " + t);
        }
        return sLibLoaded;
    }

    /**
     * 统一取插件包自己的 Context：编辑器宿主传入的 Context 会把
     * SharedPreferences 写到宿主包名下，导致激活状态与插件 App 不同步。
     */
    private static Context pluginCtx(Context ctx) {
        try {
            if (ctx == null || OcrEngine.PLUGIN_PACKAGE.equals(ctx.getPackageName())) {
                return ctx;
            }
            return ctx.createPackageContext(OcrEngine.PLUGIN_PACKAGE,
                    Context.CONTEXT_INCLUDE_CODE | Context.CONTEXT_IGNORE_SECURITY);
        } catch (Throwable t) {
            return ctx;
        }
    }

    private static void pushSession(Context ctx) {
        SharedPreferences sp = pluginCtx(ctx).getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String token = sp.getString("token", "");
        if (token.isEmpty()) {
            return;
        }
        long expireAt = sp.getLong("expireAt", 0) * 1000L;
        long cacheEnd = sp.getLong("savedAt", 0) + CACHE_TTL;
        long deadline = expireAt > 0 ? Math.min(expireAt, cacheEnd) : cacheEnd;
        YoloJni.nativeSetSession(token, deadline);
    }

    /**
     * @return null = 已授权可执行；否则返回错误原因。
     */
    public static String check(Context ctx) {
        /* v7 无卡密版：直接放行 */
        return null;
    }

    public static String checkReal(Context ctx) {
        Context pctx = pluginCtx(ctx);
        synchronized (LOCK) {
            if (!ensureLib(pctx)) {
                sLastError = "授权组件加载失败";
                return sLastError;
            }
            SharedPreferences sp = pctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String code = sp.getString("code", "");
            if (code.isEmpty()) {
                sLastError = "插件未激活，请打开插件输入卡密激活";
                return sLastError;
            }
            long savedAt = sp.getLong("savedAt", 0);
            long now = System.currentTimeMillis();
            if (savedAt > 0 && now - savedAt < CACHE_TTL) {
                long expireAt = sp.getLong("expireAt", 0);
                if (expireAt > 0 && expireAt * 1000L < now) {
                    sLastError = "卡密已过期，请续费或更换卡密";
                    return sLastError;
                }
                pushSession(pctx);
                return null;
            }
            // 缓存过期，重新在线验证
            LicenseClient.Result r = LicenseClient.verify(pctx, code);
            if (r.ok) {
                sp.edit()
                        .putString("token", r.token)
                        .putLong("expireAt", r.expireAt)
                        .putString("uuid", r.uuid)
                        .putLong("savedAt", now)
                        .apply();
                pushSession(ctx);
                return null;
            }
            sLastError = r.message == null || r.message.isEmpty() ? "授权验证失败" : r.message;
            Log.w(TAG, "check failed: " + sLastError);
            return sLastError;
        }
    }

    /**
     * 激活卡密。返回 null = 成功。
     */
    public static String activate(Context ctx, String code) {
        Context pctx = pluginCtx(ctx);
        if (code == null || code.trim().isEmpty()) {
            return "请输入卡密";
        }
        if (!ensureLib(pctx)) {
            return "授权组件加载失败";
        }
        String c = code.trim().toUpperCase();
        LicenseClient.Result r = LicenseClient.verify(pctx, c);
        if (r.ok) {
            pctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString("code", c)
                    .putString("token", r.token)
                    .putLong("expireAt", r.expireAt)
                    .putString("uuid", r.uuid)
                    .putLong("savedAt", System.currentTimeMillis())
                    .apply();
            pushSession(pctx);
            return null;
        }
        return r.message == null || r.message.isEmpty() ? "激活失败" : r.message;
    }

    public static String getLastError() {
        return sLastError;
    }

    public static String getActivatedCode(Context ctx) {
        return pluginCtx(ctx).getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("code", "");
    }

    public static long getExpireAt(Context ctx) {
        return pluginCtx(ctx).getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("expireAt", 0);
    }
}
