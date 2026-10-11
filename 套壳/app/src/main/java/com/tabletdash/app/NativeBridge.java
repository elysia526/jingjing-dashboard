package com.tabletdash.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.util.Locale;

/**
 * 暴露给网页的 window.NativeShell。
 *
 * 约定：所有查询方法返回 **JSON 字符串**（不直接返回对象，
 * 免得踩 JavascriptInterface 的类型映射坑）；控制方法返回空。
 * 任何一个方法出问题都只返回 {ok:false}，绝不让网页崩掉。
 */
public class NativeBridge {

    private final Activity act;

    public NativeBridge(Activity a) {
        this.act = a;
    }

    /* ------------------------------------------------------------ 电量与温度 */

    @JavascriptInterface
    public String battery() {
        JSONObject o = new JSONObject();
        try {
            // 传 null 直接拿 ACTION_BATTERY_CHANGED 这个粘性广播的当前值，不用注册常驻接收器
            Intent it = act.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));

            int level = it != null ? it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) : -1;
            int scale = it != null ? it.getIntExtra(BatteryManager.EXTRA_SCALE, 100) : 100;
            int status = it != null ? it.getIntExtra(BatteryManager.EXTRA_STATUS, -1) : -1;
            int tenths = it != null ? it.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE)
                                    : Integer.MIN_VALUE;
            int volt = it != null ? it.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1) : -1;

            boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING
                    || status == BatteryManager.BATTERY_STATUS_FULL;

            o.put("ok", true);
            o.put("level", (level >= 0 && scale > 0) ? Math.round(level * 100f / scale) : JSONObject.NULL);
            o.put("charging", charging);
            o.put("full", status == BatteryManager.BATTERY_STATUS_FULL);

            // 温度单位是「十分之一摄氏度」；部分机型恒为 0 或干脆不实现，那就返回 null，
            // 让界面继续显示 --，而不是编一个假数字出来。
            if (tenths == Integer.MIN_VALUE || tenths <= 0) {
                o.put("temperature", JSONObject.NULL);
            } else {
                o.put("temperature", Math.round(tenths / 10.0 * 10) / 10.0);
            }

            o.put("voltage", volt > 0 ? Math.round(volt / 100.0 * 100) / 100.0 : JSONObject.NULL);
        } catch (Exception e) {
            fail(o, e);
        }
        return o.toString();
    }

    /* ---------------------------------------------------------------- 设备 */

    @JavascriptInterface
    public String device() {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("model", Build.MODEL);
            o.put("manufacturer", Build.MANUFACTURER);
            o.put("brand", Build.BRAND);
            o.put("android", Build.VERSION.RELEASE);
            o.put("sdk", Build.VERSION.SDK_INT);

            // 系统 WebView 版本 —— 排查兼容性问题时这是最关键的一行。
            // iPlay 20 Pro 上是 Chrome 74，很多现代 CSS 都不支持。
            String wv = "未知";
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    PackageInfo pi = WebView.getCurrentWebViewPackage();
                    wv = pi == null ? "无" : (pi.versionName + "");
                }
            } catch (Throwable ignored) { }
            o.put("webview", wv);
        } catch (Exception e) {
            fail(o, e);
        }
        return o.toString();
    }

    /* ---------------------------------------------------------------- 存储 */

    @JavascriptInterface
    public String storage() {
        JSONObject o = new JSONObject();
        try {
            File data = Environment.getDataDirectory();
            StatFs fs = new StatFs(data.getPath());
            long total = fs.getTotalBytes();
            long free = fs.getAvailableBytes();
            long used = total - free;

            o.put("ok", true);
            o.put("totalBytes", total);
            o.put("freeBytes", free);
            o.put("usedBytes", used);
            o.put("usedPercent", total > 0 ? Math.round(used * 100.0 / total) : JSONObject.NULL);
            o.put("totalGB", round1(total / 1073741824.0));
            o.put("freeGB", round1(free / 1073741824.0));
        } catch (Exception e) {
            fail(o, e);
        }
        return o.toString();
    }

    /* ---------------------------------------------------------------- 网络 */

    @JavascriptInterface
    public String network() {
        JSONObject o = new JSONObject();
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) act.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network active = cm != null ? cm.getActiveNetwork() : null;
            NetworkCapabilities nc = active != null ? cm.getNetworkCapabilities(active) : null;

            String type = "none";
            if (nc != null) {
                if (nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) type = "wifi";
                else if (nc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) type = "cellular";
                else if (nc.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) type = "ethernet";
                else type = "other";
            }

            o.put("ok", true);
            o.put("online", nc != null);
            o.put("type", type);
            // WiFi 名称在 Android 10+ 需要定位权限，这里刻意不申请，留空即可
            o.put("ssid", "");
        } catch (Exception e) {
            fail(o, e);
        }
        return o.toString();
    }

    /* ------------------------------------------------------------ 应用信息 */

    @JavascriptInterface
    public String appInfo() {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("packageName", act.getPackageName());
            o.put("versionName", act.getPackageManager()
                    .getPackageInfo(act.getPackageName(), 0).versionName);
            o.put("versionCode", act.getPackageManager()
                    .getPackageInfo(act.getPackageName(), 0).versionCode);
        } catch (Exception e) {
            fail(o, e);
        }
        return o.toString();
    }

    /* -------------------------------------------------------------- 控制项 */

    @JavascriptInterface
    public void setKeepScreenOn(final boolean on) {
        Prefs.setKeepAwake(act, on);
        act.runOnUiThread(new Runnable() {
            @Override public void run() {
                if (on) {
                    act.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    act.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            }
        });
    }

    @JavascriptInterface
    public boolean getKeepScreenOn() {
        return Prefs.isKeepAwake(act);
    }

    @JavascriptInterface
    public void setFullscreen(final boolean on) {
        act.runOnUiThread(new Runnable() {
            @Override public void run() {
                if (on) Ui.enterImmersive(act); else Ui.exitImmersive(act);
            }
        });
    }

    /** 常驻模式（开机自启 + 崩溃自恢复）。默认关闭。 */
    @JavascriptInterface
    public boolean getAutoStart() {
        return Prefs.isAutoStart(act);
    }

    @JavascriptInterface
    public void setAutoStart(final boolean on) {
        Prefs.setAutoStart(act, on);
        if (on) {
            WatchdogService.start(act);
        } else {
            WatchdogService.stop(act);
        }
    }

    @JavascriptInterface
    public void toast(final String msg) {
        act.runOnUiThread(new Runnable() {
            @Override public void run() {
                Toast.makeText(act, msg == null ? "" : msg, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /** 网页 init 跑完会调这个，壳靠它判断"页面真的活了" */
    @JavascriptInterface
    public void pageReady() {
        if (act instanceof MainActivity) {
            ((MainActivity) act).onPageReady();
        }
    }

    /** 网页侧的错误递进来，诊断页里能看到 */
    @JavascriptInterface
    public void reportError(String msg) {
        if (act instanceof MainActivity) {
            ((MainActivity) act).onWebError(msg);
        }
    }

    @JavascriptInterface
    public void vibrate(int ms) {
        try {
            Vibrator v = (Vibrator) act.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) {
                v.vibrate(VibrationEffect.createOneShot(Math.max(10, ms), 80));
            }
        } catch (Exception ignored) { }
    }

    /** 重启界面（网页里调试用，也给崩溃自恢复留个手动入口） */
    @JavascriptInterface
    public void restart() {
        act.runOnUiThread(new Runnable() {
            @Override public void run() {
                Intent i = new Intent(act, MainActivity.class);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                act.startActivity(i);
                act.finish();
                android.os.Process.killProcess(android.os.Process.myPid());
            }
        });
    }

    /* ---------------------------------------------------------------- 工具 */

    private static double round1(double v) {
        return Math.round(v * 10) / 10.0;
    }

    private static void fail(JSONObject o, Exception e) {
        try {
            o.put("ok", false);
            o.put("error", String.format(Locale.US, "%s", e.getMessage()));
        } catch (Exception ignored) { }
    }
}
