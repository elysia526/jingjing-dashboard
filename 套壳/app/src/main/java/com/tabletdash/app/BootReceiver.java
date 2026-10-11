package com.tabletdash.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机自启。
 *
 * 默认关闭——只有用户在图标的设置里打开了「常驻模式」才会响应，
 * 没开的话这里什么都不做。
 *
 * Android 10 起对后台启动 Activity 有限制，所以这里不直接 startActivity，
 * 而是先起前台服务，由前台服务去拉起界面（前台服务属于允许启动 Activity 的豁免情形）。
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (ctx == null || intent == null) {
            return;
        }
        String action = intent.getAction();
        boolean boot = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action);
        if (!boot) {
            return;
        }
        if (!Prefs.isAutoStart(ctx)) {
            return;   // 用户没开常驻，什么都不做
        }
        WatchdogService.start(ctx);
    }
}
