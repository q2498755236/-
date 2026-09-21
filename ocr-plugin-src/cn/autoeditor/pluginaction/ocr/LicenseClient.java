package cn.autoeditor.pluginaction.ocr;

import android.content.Context;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * 卡密授权客户端：与 NEXUS CARDKEY 服务端协议闭环。
 * 签名算法（TOTP/HMAC/密钥）在 native 层（libyolo8.so），Java 层只负责网络与 JSON。
 */
public final class LicenseClient {

    private static final String TAG = "LicenseClient";
    private static final String API_BASE = "https://2498755236.byethost7.com";
    /* ByetHost 防护层 UA 白名单（与 v2.js 一致），普通 UA 会被 slowAES 挑战页拦截 */
    private static final String UA = "Googlebot/2.1 (+http://www.google.com/bot.html)";
    private static volatile String sChallengeCookie;

    private LicenseClient() {
    }

    public static class Result {
        public boolean ok;
        public String message;
        public String token;
        public long expireAt;
        public String uuid;
    }

    public static Result verify(Context ctx, String code) {
        Result r = new Result();
        try {
            String fp = fingerprint(ctx);
            String tsResp = httpGet(API_BASE + "/api/time");
            JSONObject tsJson = new JSONObject(tsResp);
            long serverTs = tsJson.getLong("timestamp");
            String salt = tsJson.getString("salt");

            String totp = YoloJni.nativeGenTotp(serverTs / 30);
            String nonce = UUID.randomUUID().toString().replace("-", "");
            String sign = YoloJni.nativeRequestSign(code, fp, nonce, salt, totp, serverTs, "");
            String body = new JSONObject()
                    .put("code", code)
                    .put("device_fingerprint", fp)
                    .put("nonce", nonce)
                    .put("timestamp", serverTs)
                    .put("salt", salt)
                    .put("totp", totp)
                    .put("sign", sign)
                    .toString();
            String resp = httpPost(API_BASE + "/api/verify", body);
            if (resp == null || resp.contains("slowAES")) {
                r.message = "服务端防护校验未通过，请稍后重试";
                return r;
            }
            JSONObject signed = new JSONObject(resp);
            String data = signed.optString("data", "");
            String respSign = signed.optString("sign", "");
            if (data.isEmpty() || !YoloJni.nativeVerifyResponse(code, data, respSign)) {
                r.message = "响应校验失败";
                return r;
            }
            JSONObject payload = new JSONObject(new String(
                    android.util.Base64.decode(data, android.util.Base64.DEFAULT),
                    StandardCharsets.UTF_8));
            r.ok = payload.optBoolean("success", false);
            r.message = payload.optString("message", "");
            r.token = payload.optString("token", "");
            r.expireAt = payload.optLong("expireAt", 0);
            r.uuid = payload.optString("uuid", "");
            return r;
        } catch (Throwable t) {
            Log.w(TAG, "verify: " + t);
            r.message = "网络异常: " + t.getClass().getSimpleName();
            return r;
        }
    }

    public static String fingerprint(Context ctx) {
        String aid = "";
        try {
            aid = Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ANDROID_ID);
        } catch (Throwable ignored) {
        }
        return sha256Hex("ocrplugin|" + (aid == null ? "unknown" : aid));
    }

    static String sha256Hex(String input) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Throwable t) {
            return "unknown";
        }
    }

    private static String httpGet(String url) throws Exception {
        return request("GET", url, null);
    }

    private static String httpPost(String url, String json) throws Exception {
        return request("POST", url, json);
    }

    private static String request(String method, String url, String body) throws Exception {
        String resp = rawRequest(method, url, body, null);
        if (resp != null && resp.contains("slowAES")) {
            String ck = solveChallenge(resp);
            if (ck != null) {
                sChallengeCookie = ck;
                resp = rawRequest(method, url, body, ck);
            }
        }
        return resp;
    }

    private static String rawRequest(String method, String url, String body, String cookie) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        conn.setRequestProperty("User-Agent", UA);
        String ck = cookie != null ? cookie : sChallengeCookie;
        if (ck != null) {
            conn.setRequestProperty("Cookie", ck);
        }
        if ("POST".equals(method)) {
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            OutputStream os = conn.getOutputStream();
            os.write(body.getBytes(StandardCharsets.UTF_8));
            os.close();
        }
        return readAll(conn);
    }

    /* 解 ByetHost slowAES 挑战页: AES-128-CBC/NoPadding 解密 c 得 __test cookie（与 v2.js/monitor.js 同构） */
    private static String solveChallenge(String html) {
        try {
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("toNumbers\\(\"([0-9a-f]{32})\"\\)[\\s\\S]*?toNumbers\\(\"([0-9a-f]{32})\"\\)[\\s\\S]*?toNumbers\\(\"([0-9a-f]{32})\"\\)")
                    .matcher(html);
            if (!m.find()) {
                return null;
            }
            javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/CBC/NoPadding");
            c.init(javax.crypto.Cipher.DECRYPT_MODE,
                    new javax.crypto.spec.SecretKeySpec(hexBytes(m.group(1)), "AES"),
                    new javax.crypto.spec.IvParameterSpec(hexBytes(m.group(2))));
            byte[] pt = c.doFinal(hexBytes(m.group(3)));
            StringBuilder sb = new StringBuilder("__test=");
            for (byte b : pt) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Throwable t) {
            Log.w(TAG, "challenge: " + t);
            return null;
        }
    }

    private static byte[] hexBytes(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private static String readAll(HttpURLConnection conn) throws Exception {
        int code = conn.getResponseCode();
        InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] tmp = new byte[8192];
        int n;
        while (is != null && (n = is.read(tmp)) > 0) {
            buf.write(tmp, 0, n);
        }
        if (is != null) {
            is.close();
        }
        if (code >= 400) {
            throw new Exception("HTTP " + code);
        }
        return buf.toString("UTF-8");
    }
}
