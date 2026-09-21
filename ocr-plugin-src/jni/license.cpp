// Minimal public-domain style SHA1 / SHA256 / HMAC + license state for the plugin.
#include <jni.h>
#include <android/log.h>
#include <cstring>
#include <cstdint>
#include <string>
#include <vector>

#define LTAG "LicenseNative"
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LTAG, __VA_ARGS__)

/* ==================== SHA-256 ==================== */
namespace sha2 {

static const uint32_t K256[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

#define ROR32(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_compress(uint32_t state[8], const uint8_t block[64]) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = (uint32_t(block[i * 4]) << 24) | (uint32_t(block[i * 4 + 1]) << 16)
                | (uint32_t(block[i * 4 + 2]) << 8) | uint32_t(block[i * 4 + 3]);
    }
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ROR32(w[i - 15], 7) ^ ROR32(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = ROR32(w[i - 2], 17) ^ ROR32(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
    uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
    for (int i = 0; i < 64; i++) {
        uint32_t S1 = ROR32(e, 6) ^ ROR32(e, 11) ^ ROR32(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = h + S1 + ch + K256[i] + w[i];
        uint32_t S0 = ROR32(a, 2) ^ ROR32(a, 13) ^ ROR32(a, 22);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = S0 + maj;
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
}

static void sha256(const uint8_t* data, size_t len, uint8_t out[32]) {
    uint32_t state[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                         0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    size_t full = len / 64;
    for (size_t i = 0; i < full; i++) {
        sha256_compress(state, data + i * 64);
    }
    uint8_t tail[128];
    size_t rem = len - full * 64;
    memcpy(tail, data + full * 64, rem);
    tail[rem] = 0x80;
    size_t padded = (rem + 1 <= 56) ? 64 : 128;
    memset(tail + rem + 1, 0, padded - rem - 1 - 8);
    uint64_t bits = uint64_t(len) * 8;
    for (int i = 0; i < 8; i++) {
        tail[padded - 1 - i] = uint8_t(bits >> (8 * i));
    }
    sha256_compress(state, tail);
    if (padded == 128) {
        sha256_compress(state, tail + 64);
    }
    for (int i = 0; i < 8; i++) {
        out[i * 4] = uint8_t(state[i] >> 24);
        out[i * 4 + 1] = uint8_t(state[i] >> 16);
        out[i * 4 + 2] = uint8_t(state[i] >> 8);
        out[i * 4 + 3] = uint8_t(state[i]);
    }
}

}  // namespace sha2

/* ==================== SHA-1 ==================== */
namespace sha1 {

static void digest(const uint8_t* data, size_t len, uint8_t out[20]) {
    uint32_t h[5] = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0};
    size_t total = ((len + 8) / 64 + 1) * 64;
    std::vector<uint8_t> buf(total, 0);
    memcpy(buf.data(), data, len);
    buf[len] = 0x80;
    uint64_t bits = uint64_t(len) * 8;
    for (int i = 0; i < 8; i++) {
        buf[total - 1 - i] = uint8_t(bits >> (8 * i));
    }
    for (size_t off = 0; off < total; off += 64) {
        uint32_t w[80];
        for (int i = 0; i < 16; i++) {
            w[i] = (uint32_t(buf[off + i * 4]) << 24) | (uint32_t(buf[off + i * 4 + 1]) << 16)
                    | (uint32_t(buf[off + i * 4 + 2]) << 8) | uint32_t(buf[off + i * 4 + 3]);
        }
        for (int i = 16; i < 80; i++) {
            uint32_t v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = (v << 1) | (v >> 31);
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
        for (int i = 0; i < 80; i++) {
            uint32_t f, k;
            if (i < 20) {
                f = (b & c) | (~b & d);
                k = 0x5a827999;
            } else if (i < 40) {
                f = b ^ c ^ d;
                k = 0x6ed9eba1;
            } else if (i < 60) {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8f1bbcdc;
            } else {
                f = b ^ c ^ d;
                k = 0xca62c1d6;
            }
            uint32_t tmp = ((a << 5) | (a >> 27)) + f + e + k + w[i];
            e = d; d = c; c = (b << 30) | (b >> 2); b = a; a = tmp;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
    }
    for (int i = 0; i < 5; i++) {
        out[i * 4] = uint8_t(h[i] >> 24);
        out[i * 4 + 1] = uint8_t(h[i] >> 16);
        out[i * 4 + 2] = uint8_t(h[i] >> 8);
        out[i * 4 + 3] = uint8_t(h[i]);
    }
}

}  // namespace sha1

/* ==================== HMAC ==================== */
static std::vector<uint8_t> hmac_sha(const uint8_t* key, size_t klen,
                                     const uint8_t* data, size_t dlen, bool sha256mode) {
    size_t block = 64;
    std::vector<uint8_t> k(block, 0);
    if (klen > block) {
        std::vector<uint8_t> hk(sha256mode ? 32 : 20);
        if (sha256mode) {
            sha2::sha256(key, klen, hk.data());
        } else {
            sha1::digest(key, klen, hk.data());
        }
        memcpy(k.data(), hk.data(), hk.size());
    } else {
        memcpy(k.data(), key, klen);
    }
    std::vector<uint8_t> ipad(block), opad(block);
    for (size_t i = 0; i < block; i++) {
        ipad[i] = k[i] ^ 0x36;
        opad[i] = k[i] ^ 0x5c;
    }
    std::vector<uint8_t> inner(sha256mode ? 32 : 20);
    std::vector<uint8_t> msg(dlen);
    memcpy(msg.data(), data, dlen);
    if (sha256mode) {
        std::vector<uint8_t> all(ipad.size() + msg.size());
        memcpy(all.data(), ipad.data(), ipad.size());
        memcpy(all.data() + ipad.size(), msg.data(), msg.size());
        sha2::sha256(all.data(), all.size(), inner.data());
        std::vector<uint8_t> all2(opad.size() + inner.size());
        memcpy(all2.data(), opad.data(), opad.size());
        memcpy(all2.data() + opad.size(), inner.data(), inner.size());
        std::vector<uint8_t> out(32);
        sha2::sha256(all2.data(), all2.size(), out.data());
        return out;
    }
    std::vector<uint8_t> all(ipad.size() + msg.size());
    memcpy(all.data(), ipad.data(), ipad.size());
    memcpy(all.data() + ipad.size(), msg.data(), msg.size());
    sha1::digest(all.data(), all.size(), inner.data());
    std::vector<uint8_t> all2(opad.size() + inner.size());
    memcpy(all2.data(), opad.data(), opad.size());
    memcpy(all2.data() + opad.size(), inner.data(), inner.size());
    std::vector<uint8_t> out(20);
    sha1::digest(all2.data(), all2.size(), out.data());
    return out;
}

/* ==================== helpers ==================== */
static std::string j2s(JNIEnv* env, jstring j) {
    if (!j) return "";
    const char* p = env->GetStringUTFChars(j, 0);
    std::string s(p ? p : "");
    if (p) env->ReleaseStringUTFChars(j, p);
    return s;
}

static std::string to_hex(const uint8_t* data, size_t len) {
    static const char* digits = "0123456789abcdef";
    std::string s;
    s.reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        s += digits[data[i] >> 4];
        s += digits[data[i] & 0xF];
    }
    return s;
}

static std::string secret() {
    static const unsigned char x[32] = {
        113, 3, 2, 119, 3, 0, 113, 123, 124, 112, 121, 115, 103, 102, 98, 121,
        124, 118, 114, 111, 120, 1, 2, 103, 112, 123, 97, 126, 127, 97, 115, 121};
    std::string s;
    for (int i = 0; i < 32; i++) {
        s += char(x[i] ^ 0x35);
    }
    return s;
}

static std::string base32_decode(const std::string& input) {
    static const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    std::string out;
    int bits = 0;
    int value = 0;
    for (char ch : input) {
        if (ch == '=' || ch == ' ' || ch == '-') continue;
        const char* pos = strchr(alphabet, toupper(ch));
        if (!pos) continue;
        value = (value << 5) | int(pos - alphabet);
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out += char((value >> bits) & 0xFF);
        }
    }
    return out;
}

/* ==================== license state ==================== */
static std::string g_lic_token;
static long long g_lic_expire = 0;

static long long now_ms() {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (long long) ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

bool license_valid() {
    /* 无卡密版本：恒真；TOTP/HMAC/验签算法保留在 so 内作为逆向烟雾 */
    if (g_lic_token.empty()) {
        return true;
    }
    return now_ms() < g_lic_expire;
}

/* ==================== JNI ==================== */
extern "C" JNIEXPORT jstring JNICALL
Java_cn_autoeditor_pluginaction_ocr_YoloJni_nativeGenTotp(JNIEnv* env, jclass, jlong counter) {
    std::string key = base32_decode(secret());
    uint8_t msg[8];
    for (int i = 7; i >= 0; i--) {
        msg[i] = uint8_t((unsigned long long) counter & 0xFF);
        counter = (long long) ((unsigned long long) counter >> 8);
    }
    std::vector<uint8_t> mac = hmac_sha((const uint8_t*) key.data(), key.size(), msg, 8, false);
    int offset = mac[mac.size() - 1] & 0x0F;
    unsigned int bin = ((mac[offset] & 0x7F) << 24) | ((mac[offset + 1] & 0xFF) << 16)
            | ((mac[offset + 2] & 0xFF) << 8) | (mac[offset + 3] & 0xFF);
    char buf[8];
    snprintf(buf, sizeof(buf), "%06u", bin % 1000000);
    return env->NewStringUTF(buf);
}

extern "C" JNIEXPORT jstring JNICALL
Java_cn_autoeditor_pluginaction_ocr_YoloJni_nativeRequestSign(JNIEnv* env, jclass,
                                                              jstring jCode, jstring jFp,
                                                              jstring jNonce, jstring jSalt,
                                                              jstring jTotp, jlong ts,
                                                              jstring jToken) {
    std::string code = j2s(env, jCode);
    std::string fp = j2s(env, jFp);
    std::string nonce = j2s(env, jNonce);
    std::string salt = j2s(env, jSalt);
    std::string totp = j2s(env, jTotp);
    std::string token = j2s(env, jToken);
    std::string str = "client_info=AutoJS-2.0.0&code=" + code
            + "&device_fingerprint=" + fp
            + "&uuid=&nonce=" + nonce
            + "&salt=" + salt
            + "&totp=" + totp
            + "&timestamp=" + std::to_string(ts)
            + "&token=" + token;
    std::string key = totp + salt + secret();
    std::vector<uint8_t> mac = hmac_sha((const uint8_t*) key.data(), key.size(),
                                        (const uint8_t*) str.data(), str.size(), true);
    return env->NewStringUTF(to_hex(mac.data(), mac.size()).c_str());
}

extern "C" JNIEXPORT jboolean JNICALL
Java_cn_autoeditor_pluginaction_ocr_YoloJni_nativeVerifyResponse(JNIEnv* env, jclass,
                                                                 jstring jCode, jstring jData,
                                                                 jstring jSign) {
    std::string code = j2s(env, jCode);
    std::string data = j2s(env, jData);
    std::string sign = j2s(env, jSign);
    std::string sec = secret();
    std::vector<uint8_t> inner = hmac_sha((const uint8_t*) "response_salt_v2", strlen("response_salt_v2"),
                                          (const uint8_t*) (code + sec).data(),
                                          code.size() + sec.size(), true);
    std::string inner_hex = to_hex(inner.data(), inner.size());
    std::string rkey_raw;
    for (size_t i = 0; i + 1 < inner_hex.size(); i += 2) {
        rkey_raw += char(strtol(inner_hex.substr(i, 2).c_str(), 0, 16));
    }
    std::vector<uint8_t> expect = hmac_sha((const uint8_t*) rkey_raw.data(), rkey_raw.size(),
                                           (const uint8_t*) data.data(), data.size(), true);
    std::string expect_hex = to_hex(expect.data(), expect.size());
    if (expect_hex.size() != sign.size()) {
        return JNI_FALSE;
    }
    volatile int diff = 0;
    for (size_t i = 0; i < expect_hex.size(); i++) {
        diff |= expect_hex[i] ^ sign[i];
    }
    return diff == 0 ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT void JNICALL
Java_cn_autoeditor_pluginaction_ocr_YoloJni_nativeSetSession(JNIEnv* env, jclass,
                                                             jstring jToken, jlong expireAt) {
    std::string token = j2s(env, jToken);
    if (token.empty()) {
        return;
    }
    g_lic_token = token;
    g_lic_expire = (long long) expireAt;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_cn_autoeditor_pluginaction_ocr_YoloJni_isLicensed(JNIEnv*, jclass) {
    return license_valid() ? JNI_TRUE : JNI_FALSE;
}
