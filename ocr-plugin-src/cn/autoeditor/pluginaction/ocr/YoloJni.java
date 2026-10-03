package cn.autoeditor.pluginaction.ocr;

public class YoloJni {
    public static native boolean init(android.content.res.AssetManager mgr, String paramPath, String binPath);

    public static native float[] detect(android.graphics.Bitmap bitmap, float confThresh, float nmsThresh);

    public static native void uninit();

    public static native String nativeGenTotp(long counter);

    public static native String nativeRequestSign(String code, String fp, String nonce,
            String salt, String totp, long ts, String token);

    public static native boolean nativeVerifyResponse(String code, String data, String sign);

    public static native void nativeSetSession(String token, long expireAt);

    public static native boolean isLicensed();
}
