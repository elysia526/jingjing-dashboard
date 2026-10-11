package com.tabletdash.app;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 把 APK 里的 assets/www/ 映射到 https://appassets.androidplatform.net/
 *
 * 为什么不直接用 file:///android_asset/：
 *   那样网页拿到的是不透明的 file 源，localStorage、IndexedDB、跨域请求的行为
 *   都会变得不可靠（跟我们在桌面浏览器上踩过的坑一模一样）。
 *   给一个真正的 https 源之后，网页行为就和它跑在普通网站上完全一致。
 *
 * 这段加上 MainActivity 里的 shouldInterceptRequest，就是官方 WebViewAssetLoader
 * 的最小实现——省掉了一个 androidx 依赖。
 */
public final class AssetServer {

    public static final String HOST = "appassets.androidplatform.net";
    /** 页面的 baseUrl：决定页面的 origin，localStorage 和跨域请求都挂在它上面。 */
    public static final String BASE_URL = "https://" + HOST + "/";
    public static final String START_URL = BASE_URL + "index.html";

    private AssetServer() { }

    /** 不是我们的虚拟域名就返回 null，交给 WebView 正常处理。 */
    public static WebResourceResponse serve(Context ctx, Uri uri) {
        if (uri == null || !HOST.equals(uri.getHost())) {
            return null;
        }

        String path = uri.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) {
            path = "/index.html";
        }
        while (path.startsWith("/")) {
            path = path.substring(1);
        }
        // 防目录穿越
        if (path.contains("..")) {
            return notFound();
        }

        try {
            InputStream in = ctx.getAssets().open("www/" + path);
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            // 注意：setStatusCode / setReasonPhrase 这两个 setter 不在公开 SDK 里
            //（编译会报"找不到符号"），只能用带状态码的构造函数。
            return new WebResourceResponse(mimeOf(path), "utf-8", 200, "OK", headers, in);
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new HashMap<String, String>(), null);
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }
}
