package com.tabletdash.app;

import android.content.Context;
import android.content.SharedPreferences;

/** 极简偏好存储：只需要记住「常驻模式」和「屏幕常亮」两个开关。 */
public final class Prefs {

    private static final String FILE = "tabletdash";
    private static final String KEY_AUTOSTART = "auto_start";
    private static final String KEY_KEEP_AWAKE = "keep_awake";

    private Prefs() { }

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** 开机自启 / 崩溃自恢复。默认关闭，用户在设置里手动打开。 */
    public static boolean isAutoStart(Context c) {
        return sp(c).getBoolean(KEY_AUTOSTART, false);
    }

    public static void setAutoStart(Context c, boolean on) {
        sp(c).edit().putBoolean(KEY_AUTOSTART, on).apply();
    }

    /** 屏幕常亮。默认开启——仪表板本来就该常亮。 */
    public static boolean isKeepAwake(Context c) {
        return sp(c).getBoolean(KEY_KEEP_AWAKE, true);
    }

    public static void setKeepAwake(Context c, boolean on) {
        sp(c).edit().putBoolean(KEY_KEEP_AWAKE, on).apply();
    }
}
