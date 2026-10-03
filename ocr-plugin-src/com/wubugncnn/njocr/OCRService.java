package com.wubugncnn.njocr;

import android.content.res.AssetManager;
import android.graphics.Bitmap;

public class OCRService {

    public native boolean initModels(AssetManager assetManager);

    public native String nativeProcessBitmap(Bitmap bitmap, int type);
}
