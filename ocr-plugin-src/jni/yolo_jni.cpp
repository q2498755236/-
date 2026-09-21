#include <jni.h>
#include <android/bitmap.h>
#include <android/asset_manager.h>
#include <android/asset_manager_jni.h>
#include <android/log.h>
#include <net.h>
#include <cstdlib>
#include <cmath>
#include <vector>

bool license_valid();

#define TAG "YoloJni"
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

static ncnn::Net* g_net = 0;
static const int INPUT_SIZE = 640;

struct Det {
    float x, y, w, h;
    int cls;
    float conf;
};

static float iou(const Det& a, const Det& b) {
    float ax0 = a.x, ay0 = a.y, ax1 = a.x + a.w, ay1 = a.y + a.h;
    float bx0 = b.x, by0 = b.y, bx1 = b.x + b.w, by1 = b.y + b.h;
    float ix = std::max(0.f, std::min(ax1, bx1) - std::max(ax0, bx0));
    float iy = std::max(0.f, std::min(ay1, by1) - std::max(ay0, by0));
    float inter = ix * iy;
    float uni = a.w * a.h + b.w * b.h - inter;
    return uni > 0 ? inter / uni : 0;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_cn_autoeditor_pluginaction_ocr_YoloJni_init(JNIEnv* env, jclass, jobject assetManager,
                                                 jstring paramPath, jstring binPath) {
    if (g_net) {
        return JNI_TRUE;
    }
    const char* param = env->GetStringUTFChars(paramPath, 0);
    const char* bin = env->GetStringUTFChars(binPath, 0);
    AAssetManager* mgr = AAssetManager_fromJava(env, assetManager);

    ncnn::Net* net = new ncnn::Net();
    net->opt.use_vulkan_compute = false;
    net->opt.num_threads = 4;
    int r1 = net->load_param(mgr, param);
    int r2 = net->load_model(mgr, bin);
    env->ReleaseStringUTFChars(paramPath, param);
    env->ReleaseStringUTFChars(binPath, bin);

    if (r1 != 0 || r2 != 0) {
        LOGE("load model failed: param=%d bin=%d", r1, r2);
        delete net;
        return JNI_FALSE;
    }
    g_net = net;
    return JNI_TRUE;
}

extern "C" JNIEXPORT jfloatArray JNICALL
Java_cn_autoeditor_pluginaction_ocr_YoloJni_detect(JNIEnv* env, jclass, jobject bitmap,
                                                   jfloat confThresh, jfloat nmsThresh) {
    if (!license_valid()) {
        LOGE("detect blocked: not licensed");
        return env->NewFloatArray(0);
    }
    if (!g_net) {
        return env->NewFloatArray(0);
    }
    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, bitmap, &info) != 0) {
        return env->NewFloatArray(0);
    }
    if (info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) {
        LOGE("bitmap format not RGBA_8888: %d", info.format);
        return env->NewFloatArray(0);
    }
    void* pixels = 0;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) != 0) {
        return env->NewFloatArray(0);
    }

    int imgW = info.width;
    int imgH = info.height;

    // resize to 640x640 nearest/linear, RGBA -> RGB CHW float 0..1
    ncnn::Mat in(INPUT_SIZE, INPUT_SIZE, 3);
    const unsigned char* src = (const unsigned char*) pixels;
    for (int y = 0; y < INPUT_SIZE; y++) {
        int sy = (int) ((long long) y * imgH / INPUT_SIZE);
        const unsigned char* row = src + (size_t) sy * info.stride;
        float* pr = in.row(y);
        float* pg = pr + INPUT_SIZE;
        float* pb = pg + INPUT_SIZE;
        for (int x = 0; x < INPUT_SIZE; x++) {
            int sx = (int) ((long long) x * imgW / INPUT_SIZE);
            const unsigned char* p = row + (size_t) sx * 4;
            pr[x] = p[0] / 255.f;
            pg[x] = p[1] / 255.f;
            pb[x] = p[2] / 255.f;
        }
    }
    AndroidBitmap_unlockPixels(env, bitmap);

    float sx = (float) imgW / INPUT_SIZE;
    float sy = (float) imgH / INPUT_SIZE;

    ncnn::Extractor ex = g_net->create_extractor();
    ex.input("in0", in);
    ncnn::Mat out;
    if (ex.extract("out0", out) != 0 || out.w == 0) {
        LOGE("extract out0 failed");
        return env->NewFloatArray(0);
    }

    // out: (84, 8400) rows = [cx,cy,w,h, cls0..79]
    int num = out.w;
    int ch = out.h;
    int ncls = ch - 4;
    std::vector<Det> cands;
    for (int j = 0; j < num; j++) {
        const float* row0 = out.row(0) + j;
        float conf = 0;
        int best = -1;
        for (int c = 4; c < ch; c++) {
            float v = out.row(c)[j];
            if (v > conf) {
                conf = v;
                best = c - 4;
            }
        }
        if (best < 0 || conf < confThresh) {
            continue;
        }
        Det d;
        d.w = out.row(2)[j] * sx;
        d.h = out.row(3)[j] * sy;
        d.x = row0[0] * sx - d.w / 2;
        d.y = out.row(1)[j] * sy - d.h / 2;
        d.cls = best;
        d.conf = conf;
        cands.push_back(d);
    }

    std::sort(cands.begin(), cands.end(), [](const Det& a, const Det& b) { return a.conf > b.conf; });
    std::vector<Det> keep;
    std::vector<bool> removed(cands.size(), false);
    for (size_t i = 0; i < cands.size(); i++) {
        if (removed[i]) continue;
        keep.push_back(cands[i]);
        for (size_t j = i + 1; j < cands.size(); j++) {
            if (!removed[j] && cands[j].cls == cands[i].cls &&
                iou(cands[i], cands[j]) > nmsThresh) {
                removed[j] = true;
            }
        }
    }

    // output: n * 6 floats = cx,cy,w,h,cls,conf (original image coords)
    jfloatArray arr = env->NewFloatArray((int) (keep.size() * 6));
    if (!keep.empty()) {
        std::vector<float> flat;
        flat.reserve(keep.size() * 6);
        for (size_t i = 0; i < keep.size(); i++) {
            const Det& d = keep[i];
            flat.push_back(d.x + d.w / 2);
            flat.push_back(d.y + d.h / 2);
            flat.push_back(d.w);
            flat.push_back(d.h);
            flat.push_back((float) d.cls);
            flat.push_back(d.conf);
        }
        env->SetFloatArrayRegion(arr, 0, (int) flat.size(), flat.data());
    }
    return arr;
}

extern "C" JNIEXPORT void JNICALL
Java_cn_autoeditor_pluginaction_ocr_YoloJni_uninit(JNIEnv*, jclass) {
    if (g_net) {
        g_net->clear();
        delete g_net;
        g_net = 0;
    }
}
