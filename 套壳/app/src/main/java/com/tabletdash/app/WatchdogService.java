package com.tabletdash.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * 常驻服务。**只有用户打开「常驻模式」时才会运行**（默认关闭）。
 *
 * 两个职责：
 *   1. 开机后把界面拉起来（前台服务有启动 Activity 的豁免，绕开 Android 10+ 的后台限制）
 *   2. 每 5 秒看一眼界面还在不在；崩了或被系统回收了就再拉起来
 *
 * 用户主动按返回键退出时，MainActivity 会把自己的 userExited 置位并停掉本服务，
 * 所以不会出现"用户想退出却被反复拉回来"的困局。
 */
public class WatchdogService extends Service {

    private static final String CHANNEL_ID = "tabletdash_alive";
    private static final int NOTI_ID = 1001;
    private static final long TICK_MS = 5000L;

    private Handler handler;
    private Runnable tick;
    private boolean ticking = false;

    /* ------------------------------------------------------------ 启停入口 */

    public static void start(Context c) {
        if (c == null) {
            return;
        }
        Intent i = new Intent(c, WatchdogService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                c.startForegroundService(i);
            } else {
                c.startService(i);
            }
        } catch (Exception ignored) {
            // 个别 ROM 在开机阶段会拦，忽略即可，不影响手动打开应用
        }
    }

    public static void stop(Context c) {
        if (c == null) {
            return;
        }
        try {
            c.stopService(new Intent(c, WatchdogService.class));
        } catch (Exception ignored) { }
    }

    /* ---------------------------------------------------------------- 生命周期 */

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        tick = new Runnable() {
            @Override
            public void run() {
                ensureUiAlive();
                if (handler != null) {
                    handler.postDelayed(this, TICK_MS);
                }
            }
        };
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            Notification n = buildNotification();
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTI_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTI_ID, n);
            }
        } catch (Exception ignored) { }

        ensureUiAlive();

        if (!ticking) {
            ticking = true;
            handler.postDelayed(tick, TICK_MS);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        ticking = false;
        if (handler != null) {
            handler.removeCallbacksAndMessages(null);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /* ---------------------------------------------------------------- 内部 */

    private void ensureUiAlive() {
        if (MainActivity.userExited) {
            return;   // 用户是自己退的，别去烦他
        }
        MainActivity cur = MainActivity.current;
        if (cur != null && !cur.isFinishing() && !cur.isDestroyed()) {
            return;   // 界面好好活着
        }
        try {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            startActivity(i);
        } catch (Exception ignored) { }
    }

    private Notification buildNotification() {
        NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.notif_channel),
                    NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            ch.setSound(null, null);
            ch.enableVibration(false);
            nm.createNotificationChannel(ch);
        }

        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            piFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }

        return b.setContentTitle(getString(R.string.notif_title))
                .setContentText(getString(R.string.notif_text))
                .setSmallIcon(R.drawable.ic_notify)
                .setContentIntent(pi)
                .setOngoing(true)
                .setShowWhen(false)
                .build();
    }
}
