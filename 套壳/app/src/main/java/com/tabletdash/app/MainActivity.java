package com.tabletdash.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 唯一的界面。
 *
 * ============================ 关于那个"一片白" ============================
 * 酷比魔方 iPlay 20 Pro（Android 10，展锐 SC9863A）上打开就是一片白，
 * 而同一份 HTML 在它的浏览器里以 file:// 打开却完全正常。
 * 说明引擎能渲染，问题出在壳这边。最可能的两个原因：
 *
 *  1. **首帧尺寸为 0**：WebView 还没完成布局时 window.innerWidth/Height 是 0，
 *     网页算出的缩放 scale 就是 0，整个画布被缩成看不见 —— 屏幕只剩底色，
 *     浅色主题下就是"一片白"。网页侧已经加了防护与重试。
 *  2. **GPU 渲染路径有问题**：展锐这类芯片上 WebView 硬件渲染整块画不出来的
 *     情况是有的，页面"加载成功"但一帧都不画。
 *
 * 单个原因猜不中，所以这里做成**四步逐级兜底**，并且全程有一个原生覆盖层
 * 告诉用户当前走到哪一步 —— 无论成功失败，屏幕上永远不会是"什么都没有"。
 *
 *   第 1 步：注入单文件 HTML，baseUrl 用 https 虚拟域名（origin 最干净）
 *   第 2 步：改用 file:///android_asset/ 直接加载（浏览器版验证过这条能跑）
 *   第 3 步：切软件渲染，再走一次 file://
 *   第 4 步：放弃 WebView，用原生控件把诊断信息摊开
 *
 * 每一步都等网页回调 pageReady()，再额外做一次"画布真的占位了吗"的自检。
 * ========================================================================
 */
public class MainActivity extends Activity {

    public static volatile MainActivity current;
    public static volatile boolean userExited = false;

    private static final String ASSET_HTML = "www/index.html";
    private static final String FILE_URL = "file:///android_asset/" + ASSET_HTML;
    private static final int BG = 0xFF121417;
    private static final long STAGE_TIMEOUT_MS = 7000L;
    private static final int MAX_STAGE = 4;

    /** 网页里 <input type="file"> 弹出系统选择器的请求码 */
    private static final int REQ_FILE_CHOOSER = 1001;

    private FrameLayout root;
    private WebView web;
    private TextView overlay;

    /**
     * 网页调起文件选择器时的回调。**必须由 WebChromeClient.onShowFileChooser 接住**，
     * 否则 WebView 里的 <input type="file"> 点了完全没反应——这正是"背景图片导入
     * 点击没反应"的根因（网页侧 JS 没问题，是壳没实现这个回调）。
     */
    private ValueCallback<Uri[]> filePathCallback;

    private int stage = 0;
    private boolean pageReady = false;
    private boolean usingFileFallback = false;
    private int renderGoneCount = 0;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<String> events = new ArrayList<>();
    private Runnable stageWatchdog;

    /* ================================================================ 生命周期 */

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = this;
        userExited = false;

        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);

        // 覆盖层：加载期间铺满屏幕，写清楚当前进度。
        // 它保证了"就算最后白屏，用户也能看到白屏前发生了什么"。
        overlay = new TextView(this);
        overlay.setTextColor(0xFFE8EAED);
        overlay.setTextSize(17f);
        overlay.setPadding(80, 60, 80, 60);
        overlay.setBackgroundColor(BG);
        overlay.setGravity(Gravity.CENTER);
        overlay.setLongClickable(true);
        // 终极逃生口：检测逻辑万一全判断错了，长按直接把界面亮出来
        overlay.setOnLongClickListener(new View.OnLongClickListener() {
            @Override public boolean onLongClick(View v) {
                note("用户长按，跳过检测");
                succeed("用户长按跳过");
                return true;
            }
        });
        root.addView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        applyKeepAwake();
        Ui.enterImmersive(this);

        try {
            buildWebView();
            startStage(1);
        } catch (Throwable t) {
            // 系统 WebView 缺失或损坏时 new WebView 会直接抛异常
            showNativeFatal(t);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        current = this;
        applyKeepAwake();
        Ui.enterImmersive(this);
        if (web != null) {
            web.onResume();
        }
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        cancelWatchdog();
        if (current == this) {
            current = null;
        }
        if (web != null) {
            try {
                root.removeView(web);
                web.destroy();
            } catch (Throwable ignored) { }
            web = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        userExited = true;
        WatchdogService.stop(this);
        super.onBackPressed();
    }

    /* ==================================================== 文件选择器（图片 / 配置） */

    /**
     * 系统选择器回来了。把用户选的 Uri 交还给网页 —— 这一步不做，
     * 网页的 input.files 永远是空的，表现就是"选完图片什么也没发生"。
     */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (filePathCallback == null) {
                super.onActivityResult(requestCode, resultCode, data);
                return;
            }
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                result = pickUris(data);
            }
            if (result == null) {
                note("文件选择：用户取消 / 未选中任何文件");
            } else {
                note("文件选择：选中 " + result.length + " 个");
            }
            try {
                filePathCallback.onReceiveValue(result);
            } catch (Throwable t) {
                note("回传文件选择结果失败：" + t);
            }
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** 兼容单选与多选两种返回形式 */
    private Uri[] pickUris(Intent data) {
        try {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                Uri[] arr = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) {
                    arr[i] = clip.getItemAt(i).getUri();
                }
                return arr;
            }
            Uri single = data.getData();
            return single == null ? null : new Uri[]{ single };
        } catch (Throwable t) {
            note("解析文件选择结果异常：" + t);
            return null;
        }
    }

    /* ============================================================== 逐级兜底 */

    private void startStage(int s) {
        stage = s;
        pageReady = false;
        cancelWatchdog();

        if (s > MAX_STAGE) {
            showDiagnostic("四步都试过了，界面还是没能显示出来", null);
            return;
        }

        showOverlay("正在启动…\n\n第 " + s + " / " + MAX_STAGE + " 步：" + stageName(s) +
                "\n\n（这里停住不动的话，长按屏幕可直接显示界面）");
        note("→ 进入第 " + s + " 步：" + stageName(s));

        try {
            switch (s) {
                case 1:
                    injectHtml();
                    break;
                case 2:
                    loadFile(false);
                    break;
                case 3:
                    loadFile(true);
                    break;
                default:
                    showDiagnostic("四步都试过了，界面还是没能显示出来", null);
                    return;
            }
        } catch (Throwable t) {
            note("第 " + s + " 步抛异常：" + t);
            handler.postDelayed(new Runnable() {
                @Override public void run() { startStage(stage + 1); }
            }, 400);
            return;
        }

        armWatchdog();
    }

    private String stageName(int s) {
        switch (s) {
            case 1: return "注入网页（https 源）";
            case 2: return "改用 file:// 加载";
            case 3: return "切软件渲染 + file://";
            default: return "诊断页";
        }
    }

    /** 第 1 步：把 HTML 直接注入，baseUrl 用虚拟 https 域名 */
    private void injectHtml() {
        String html;
        try {
            html = readAsset(ASSET_HTML);
        } catch (Throwable t) {
            note("读内置网页失败：" + t);
            handler.postDelayed(new Runnable() {
                @Override public void run() { startStage(stage + 1); }
            }, 200);
            return;
        }
        note("注入主文档，长度 " + html.length());
        web.loadDataWithBaseURL(AssetServer.BASE_URL, html, "text/html", "utf-8", null);
    }

    /** 第 2、3 步：file:// 直接加载（浏览器版验证过这条路） */
    private void loadFile(boolean software) {
        usingFileFallback = true;
        if (software) {
            note("切换为软件渲染（绕过 GPU）");
            web.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        }
        WebSettings st = web.getSettings();
        st.setAllowFileAccess(true);
        st.setAllowFileAccessFromFileURLs(true);
        st.setAllowUniversalAccessFromFileURLs(true);
        web.loadUrl(FILE_URL);
    }

    /** 每一步到点后：**先查 DOM**，确认渲染不出来才进下一步 */
    private void armWatchdog() {
        cancelWatchdog();
        final int at = stage;
        stageWatchdog = new Runnable() {
            @Override public void run() {
                if (pageReady || stage != at) {
                    return;
                }
                note("第 " + at + " 步到点，主动查一次 DOM");
                probeCanvas(at, true);
            }
        };
        handler.postDelayed(stageWatchdog, STAGE_TIMEOUT_MS);
    }

    private void cancelWatchdog() {
        if (stageWatchdog != null) {
            handler.removeCallbacks(stageWatchdog);
            stageWatchdog = null;
        }
    }

    /* ============================================== 网页回调 & 渲染自检 */

    /**
     * 网页 init 跑完了。
     * 这条路径**依赖 JS 桥**，所以只当锦上添花——真正的判定靠主动查 DOM
     * （probeCanvas），桥不通也照样能确认页面渲染成功。
     */
    public void onPageReady() {
        handler.post(new Runnable() {
            @Override public void run() {
                succeed("网页主动报到");
            }
        });
    }

    public void onWebError(final String msg) {
        handler.post(new Runnable() {
            @Override public void run() {
                note("网页报错：" + msg);
            }
        });
    }

    /** 判定成功：撤掉覆盖层，把界面亮出来 */
    private void succeed(String how) {
        if (pageReady) {
            return;
        }
        pageReady = true;
        cancelWatchdog();
        hideOverlay();
        note("✓ 界面已显示 —— " + how);
    }

    /**
     * 主动查 DOM：#stage 实际占多大、JS 桥通不通、init 有没有跑完。
     *
     * 这一步**不经过 JS 桥**（走 evaluateJavascript），所以是判断
     * "页面到底渲染出来没有"的主要依据。
     *
     * 之前的版本只等 pageReady() 回调，而那个桥调用因为参数个数不匹配
     * 一直是静默失败的 —— 页面明明渲染好了却被判成失败，一路走到诊断页。
     */
    private void probeCanvas(final int atStage, final boolean advanceIfFail) {
        if (web == null) {
            return;
        }
        try {
            web.evaluateJavascript(
                    "(function(){var o=[];" +
                            "try{var e=document.getElementById('stage');" +
                            "o.push(e?Math.round(e.getBoundingClientRect().width):-1);" +
                            "o.push(e?Math.round(e.getBoundingClientRect().height):-1);}" +
                            "catch(x){o.push(-2);o.push(-2);}" +
                            "try{o.push((typeof Native!=='undefined'&&Native&&Native.available)?1:0);}" +
                            "catch(x){o.push(-1);}" +
                            "try{o.push(document.body.classList.contains('ready')?1:0);}" +
                            "catch(x){o.push(-1);}" +
                            "return o.join(',');})()",
                    new ValueCallback<String>() {
                        @Override public void onReceiveValue(String v) {
                            onProbeResult(v, atStage, advanceIfFail);
                        }
                    });
        } catch (Throwable t) {
            note("DOM 探测失败：" + t);
            if (advanceIfFail && stage == atStage) {
                startStage(atStage + 1);
            }
        }
    }

    private void onProbeResult(String raw, int atStage, boolean advanceIfFail) {
        if (stage != atStage || pageReady) {
            return;
        }
        String v = raw == null ? "" : raw.replace("\"", "").trim();
        String[] p = v.split(",");
        int w = -1, h = -1, bridge = -1, ready = -1;
        try {
            if (p.length >= 4) {
                w = (int) Double.parseDouble(p[0]);
                h = (int) Double.parseDouble(p[1]);
                bridge = (int) Double.parseDouble(p[2]);
                ready = (int) Double.parseDouble(p[3]);
            }
        } catch (Throwable ignored) { }

        note("DOM 探测：画布 " + w + "x" + h +
                "，JS桥 " + (bridge == 1 ? "通" : bridge == 0 ? "不通" : "未知") +
                "，init " + (ready == 1 ? "已跑完" : "未跑完"));

        // 画布有真实尺寸 = 页面真的渲染出来了
        if (w >= 200 && h >= 100) {
            succeed("画布 " + w + "x" + h);
            return;
        }
        if (advanceIfFail) {
            startStage(atStage + 1);
        }
    }

    /* ================================================================== WebView */

    private void buildWebView() {
        web = new WebView(this);
        web.setBackgroundColor(BG);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setDefaultTextEncodingName("utf-8");

        web.setWebViewClient(new ShellClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                note("console: " + m.message() + "  @" + m.lineNumber());
                return true;
            }

            /**
             * 关键：WebView 里 <input type="file"> 被点击时会走到这里。
             * 不实现它 = 点了完全没反应（背景图片 / 配置导入都哑）。
             * 返回 true 表示"我接管了"，WebView 就会等 onActivityResult 回传结果。
             */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // 上一次还没回传又调一次：先把旧的作废，否则 WebView 会一直卡着不再响应
                if (filePathCallback != null) {
                    try { filePathCallback.onReceiveValue(null); } catch (Throwable ignored) { }
                    filePathCallback = null;
                }
                filePathCallback = callback;

                Intent intent = null;
                try {
                    intent = (params != null) ? params.createIntent() : null;
                } catch (Throwable t) {
                    note("构造文件选择 Intent 失败：" + t);
                }
                if (intent == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("image/*");
                    if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    }
                }
                try {
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                    note("已调起系统文件选择器");
                    return true;
                } catch (Throwable t) {
                    note("没有可用的文件选择器：" + t);
                    filePathCallback = null;
                    try { callback.onReceiveValue(null); } catch (Throwable ignored) { }
                    return false;
                }
            }
        });
        web.addJavascriptInterface(new NativeBridge(this), "NativeShell");

        root.addView(web);

        // 覆盖层必须盖在最上面
        if (overlay != null) {
            overlay.bringToFront();
        }
    }

    /* ============================================================ WebViewClient */

    private class ShellClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return intercept(request != null && request.getUrl() != null
                    ? request.getUrl().toString() : null);
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            return intercept(url);
        }

        private WebResourceResponse intercept(String url) {
            try {
                if (url == null || url.indexOf(AssetServer.HOST) < 0) {
                    return null;
                }
                return AssetServer.serve(MainActivity.this, android.net.Uri.parse(url));
            } catch (Throwable t) {
                return null;
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return false;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return false;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            note("开始加载 " + url);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            note("加载完成 " + url);
            // 给网页一点时间把 init 跑完，然后主动查一次 DOM。
            // 这次查失败不急着进下一步，等 watchdog 到点再决定。
            final int at = stage;
            handler.postDelayed(new Runnable() {
                @Override public void run() { probeCanvas(at, false); }
            }, 1500);
            handler.postDelayed(new Runnable() {
                @Override public void run() { probeCanvas(at, false); }
            }, 3500);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            boolean main = request == null || request.isForMainFrame();
            String d = error != null ? (error.getErrorCode() + " " + error.getDescription()) : "?";
            note((main ? "主框架" : "子资源") + "错误 " + d);
            if (main && stage < MAX_STAGE) {
                startStage(stage + 1);
            }
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            note("错误(旧回调) " + errorCode + " " + description);
            if (stage < MAX_STAGE) {
                startStage(stage + 1);
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse res) {
            note("HTTP " + (res != null ? res.getStatusCode() : "?") + " @ " +
                    (request != null && request.getUrl() != null ? request.getUrl() : "?"));
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
            note("SSL 错误 " + (error != null ? error.getPrimaryError() : "?"));
            handler.cancel();
            if (stage < MAX_STAGE) {
                startStage(stage + 1);
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            renderGoneCount++;
            note("渲染进程崩溃（第 " + renderGoneCount + " 次）" +
                    (detail != null ? " didCrash=" + detail.didCrash() : ""));
            try {
                root.removeView(view);
                view.destroy();
            } catch (Throwable ignored) { }
            web = null;
            try {
                buildWebView();
                // 崩过一次就别再试硬件渲染了，直接跳到软件渲染那一步
                startStage(renderGoneCount >= 2 ? 3 : Math.max(2, stage + 1));
            } catch (Throwable t) {
                showNativeFatal(t);
            }
            return true;
        }
    }

    /* ============================================================== 覆盖层 */

    private void showOverlay(String text) {
        if (overlay == null) {
            return;
        }
        overlay.setText(text);
        overlay.setVisibility(View.VISIBLE);
        overlay.bringToFront();
    }

    private void hideOverlay() {
        if (overlay != null) {
            overlay.setVisibility(View.GONE);
        }
    }

    /* ================================================================== 诊断 */

    private void note(String s) {
        events.add("[" + events.size() + "] " + s);
        if (events.size() > 60) {
            events.remove(0);
        }
    }

    private void showDiagnostic(String title, Throwable t) {
        hideOverlay();
        StringBuilder sb = new StringBuilder();
        sb.append("Android  : ").append(Build.VERSION.RELEASE)
          .append("  (API ").append(Build.VERSION.SDK_INT).append(")\n");
        sb.append("设备     : ").append(Build.MANUFACTURER).append(" ").append(Build.MODEL).append("\n");
        sb.append("ABI      : ").append(Build.SUPPORTED_ABIS != null && Build.SUPPORTED_ABIS.length > 0
                ? Build.SUPPORTED_ABIS[0] : "?").append("\n");

        String wv = "读取失败";
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                PackageInfo pi = WebView.getCurrentWebViewPackage();
                wv = pi == null ? "✘ 系统里没有可用的 WebView！"
                                : (pi.packageName + "  " + pi.versionName);
            }
        } catch (Throwable e) {
            wv = "读取异常 " + e;
        }
        sb.append("WebView  : ").append(wv).append("\n");
        sb.append("硬件加速 : ").append(web != null && web.isHardwareAccelerated() ? "开" : "关").append("\n");
        sb.append("走到第   : ").append(stage).append(" / ").append(MAX_STAGE).append(" 步\n");
        sb.append("渲染崩溃 : ").append(renderGoneCount).append(" 次\n");
        if (t != null) {
            sb.append("异常     : ").append(t).append("\n");
        }
        sb.append("\n———— 事件记录 ————\n");
        for (String e : events) {
            sb.append(e).append("\n");
        }
        sb.append("\n把这一屏拍照发给开发者即可定位。");

        String html = "<!DOCTYPE html><html><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{margin:0;background:#121417;color:#E8EAED;"
                + "font:15px/1.75 Consolas,monospace;padding:26px}"
                + "h1{font-size:19px;color:#F0A52B;margin:0 0 18px;font-weight:400}"
                + "pre{white-space:pre-wrap;word-break:break-all;background:#1B1F24;"
                + "padding:18px;border-radius:6px;margin:0}</style></head><body>"
                + "<h1>" + title + "</h1><pre>" + esc(sb.toString()) + "</pre></body></html>";

        try {
            if (web == null) {
                buildWebView();
            }
            web.setLayerType(View.LAYER_TYPE_SOFTWARE, null);   // 诊断页一律软件渲染
            web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        } catch (Throwable t2) {
            showNativeFatal(t2);
        }
    }

    /** 最后兜底：连 WebView 都用不了，纯原生控件把话说清楚 */
    private void showNativeFatal(Throwable t) {
        hideOverlay();
        StringBuilder sb = new StringBuilder();
        sb.append("仪表板启动失败\n\n");
        sb.append("Android : ").append(Build.VERSION.RELEASE)
          .append(" (API ").append(Build.VERSION.SDK_INT).append(")\n");
        sb.append("设备    : ").append(Build.MANUFACTURER).append(" ").append(Build.MODEL).append("\n\n");
        sb.append("最可能的原因：这台设备的系统 WebView 缺失或被禁用。\n");
        sb.append("请到「设置 → 应用」里找 Android System WebView / Chrome，\n");
        sb.append("启用或更新它，然后再打开本应用。\n\n");
        sb.append("错误详情：\n").append(t).append("\n\n");
        for (String e : events) {
            sb.append(e).append("\n");
        }

        TextView tv = new TextView(this);
        tv.setText(sb.toString());
        tv.setTextColor(0xFFE8EAED);
        tv.setTextSize(13f);
        tv.setPadding(40, 40, 40, 40);
        tv.setBackgroundColor(BG);

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(BG);
        sv.addView(tv, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        root.removeAllViews();
        root.addView(sv, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT,
                Gravity.CENTER));
    }

    /* ================================================================== 工具 */

    private void applyKeepAwake() {
        try {
            if (Prefs.isKeepAwake(this)) {
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        } catch (Throwable ignored) { }
    }

    private String readAsset(String name) throws Exception {
        InputStream in = getAssets().open(name);
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            return new String(bos.toByteArray(), "UTF-8");
        } finally {
            try { in.close(); } catch (Throwable ignored) { }
        }
    }

    private static String esc(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }
}
