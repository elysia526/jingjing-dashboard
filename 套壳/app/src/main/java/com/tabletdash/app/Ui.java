package com.tabletdash.app;

import android.app.Activity;
import android.os.Build;
import android.view.View;
import android.view.WindowManager;

/** 全屏与系统栏控制。 */
public final class Ui {

    private Ui() { }

    /**
     * 沉浸式全屏：状态栏和导航栏都藏起来。
     * IMMERSIVE_STICKY 的好处是用户从边缘划出来时会临时显示、几秒后自动缩回去，
     * 适合常驻仪表板。
     */
    public static void enterImmersive(Activity a) {
        View decor = a.getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = a.getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            a.getWindow().setAttributes(lp);
        }
    }

    public static void exitImmersive(Activity a) {
        a.getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
    }
}
