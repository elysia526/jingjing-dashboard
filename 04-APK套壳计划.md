# 第四阶段 · Android 套壳（APK）计划

> 目标：把现在这个网页仪表板装进一个安卓应用里，解决纯网页做不到的三件事——
> **平板温度**、**开机自启 / 崩溃重启**、**真正的全屏常驻 Kiosk**。

---

## 一、你机器上的家伙什（已实测）

| 组件 | 位置 / 版本 | 状态 |
| --- | --- | --- |
| **JDK（首选）** | `D:\Program Files\Android\Android Studio\jbr` — OpenJDK **25.0.3** | ✅ 含 javac / keytool / jar |
| **JDK（退路）** | `D:\PyCharm 2024.3.3\jbr` — OpenJDK **21.0.7** | ✅ **AGP 8.7 要的就是这个** |
| **Android SDK** | `D:\project\AndroidSdk` | ✅ |
| platforms | `android-35`(API 35)、`android-37.0`(API 37) | ✅ |
| build-tools | `34.0.0`、`36.0.0`（aapt2 / d8 / zipalign / apksigner 齐全） | ✅ |
| platform-tools | adb 1.0.41（37.0.1） | ✅ |
| emulator | `AndroidSdk\emulator\emulator.exe` | ✅ 但**没有任何 AVD** |
| **AGP** | `~/.gradle/caches` 里已有 **8.7.3** | ✅ 关键 |
| **Gradle 发行版** | wrapper 里已下载 **8.7 / 8.9 / 9.3.0** | ✅ 关键 |
| Kotlin Gradle 插件 | 已缓存 | ✅（但我们用不上） |
| 签名密钥 | `~/.android/debug.keystore` | ✅ |
| SDK 许可 | `licenses\android-sdk-license` 已接受 | ✅ |
| 雷电模拟器 | `D:\project\leidian\LDPlayer14` | ✅ 可当测试机（当前未启动） |
| **cmdline-tools / sdkmanager** | **缺** | ⚠️ 装不了新 SDK 组件 |
| Kotlin 编译器 | 无 | ⚠️ **所以壳必须用 Java 写** |

---

## 二、三个先定死的技术结论

**1. 壳用 Java，不用 Kotlin。**
机器上没有 kotlinc，走 Java 就完全不需要 Kotlin 工具链。这个壳只有一个 Activity，Java 写起来毫无负担。

**2. 不引入 androidx，不用 WebViewAssetLoader。**
一旦引 androidx 就得联网拉 AAR，而国内拉 Google Maven 是最大变数。
改用 **自己写 40 行 `shouldInterceptRequest`**，把 `assets/www/` 映射到
`https://appassets.androidplatform.net/`——效果和 WebViewAssetLoader 一样：
网页拿到的是**真正的 https 源**，localStorage / IndexedDB / fetch 跨域全部按正常网站行为走。

**3. 两条构建路线都要有，先走 A，A 卡住立刻切 B。**

| | 路线 A：标准 Gradle 工程 | 路线 B：免 Gradle 手工构建 |
| --- | --- | --- |
| 依赖 | AGP 8.7.3 + Gradle 8.9 + **JDK 21** 全在本地 | 只要 aapt2 / javac / d8 / zipalign / apksigner |
| 网络 | 首次可能要去 Google Maven 补依赖 | **全程零网络** |
| 产出速度 | 首次约 1–3 分钟 | 约 10 秒 |
| Android Studio | 能直接打开、好维护 | 打不开 |
| 风险 | 缓存不全就得联网 | 几乎为零 |
| 适合 | 以后还要加功能 | **只求这一次一定能出 APK** |

> 建议：**两条都做**。A 用于长期维护，B 作为"无论如何都能出货"的保底。
> 我个人倾向实际交付走 B，把 A 当作附赠的工程文件。

---

## 三、要写的文件清单

```
套壳/                                   ← 新建，与网页源码分开
├── shell/                              Java 源码
│   ├── MainActivity.java               主界面：WebView + 沉浸式全屏 + 屏幕常亮
│   ├── AssetServer.java                shouldInterceptRequest 资源映射（≈40 行）
│   ├── NativeBridge.java               JS 桥：@JavascriptInterface 全部方法
│   ├── BootReceiver.java               开机自启
│   └── WatchdogService.java            崩溃/被杀后拉回来（前台服务）
├── res/
│   ├── values/strings.xml, styles.xml, colors.xml
│   ├── drawable/ic_launcher.xml        矢量图标（不依赖图片资源）
│   └── xml/backup_rules.xml
├── AndroidManifest.xml
├── assets/www/index.html               ← 构建时由 工具/pack.js 生成后拷进来
└── gradle 工程文件（仅路线 A 需要）
    ├── build.gradle  settings.gradle  gradle.properties
    └── gradle/wrapper/gradle-wrapper.properties  → 指向 8.9

工具/
├── build-apk.js                        Node 构建脚本（路线 A：调 gradle）
└── build-apk-manual.js                 Node 构建脚本（路线 B：免 Gradle）
```

**关键约定**：`assets/www/index.html` **不手工维护**。
构建时先跑 `node 工具/pack.js` 出单文件，再原样拷进去。
这样网页只有一份真源，不会出现"改了网页忘了同步 APK"。

---

## 四、JS 桥接接口设计（这一阶段的核心）

Java 侧通过 `addJavascriptInterface` 暴露 `window.NativeShell`，
每个方法返回 JSON 字符串（不直接返回对象，避免类型映射的坑）：

| 方法 | 返回 | 用途 |
| --- | --- | --- |
| `battery()` | `{level:72, charging:true, temperature:36.2, voltage:4.05, health:"good"}` | **平板温度**（BatteryManager）、比网页 Battery API 更全 |
| `device()` | `{model, manufacturer, android, sdk, appVersion}` | 设备信息，可在设置里显示 |
| `storage()` | `{totalBytes, freeBytes, usedPercent}` | `StatFs` 取真实存储占用，网页的 `storage.estimate()` 拿不到 |
| `network()` | `{online, type:"wifi", ssid}` | WiFi 名（Android 10+ 需定位权限，拿不到就留空） |
| `setKeepScreenOn(on)` | — | 比 Wake Lock API 可靠，不挑前台/后台 |
| `setFullscreen(on)` | — | 隐藏状态栏与导航栏（沉浸式） |
| `toast(msg)` | — | 调试用 |
| `appInfo()` | `{versionName, versionCode, packageName}` | 设置页显示 |

**网页侧新增 `assets/js/native.js`**（薄适配层）：

```js
window.Native = {
  available: !!window.NativeShell,
  battery(), device(), storage(), network(),   // 内部 JSON.parse，失败返回 null
  setKeepScreenOn(on), setFullscreen(on)
};
```

`app.js` 里只加几处判断：
- **平板温度**：有 `Native` 就用桥接值，没有就继续显示 `--`（现在的行为不变）
- **电量 / 存储**：优先用桥接值（更准），拿不到就退回现在这套
- **屏幕常亮**：有 `Native` 就用 `setKeepScreenOn`，否则退回 Wake Lock

> 这样**同一份网页在浏览器里照样能跑**，不会因为套壳而变成只能装在 APK 里。

---

## 五、构建流程

### 路线 A（Gradle，可开进 Android Studio）

```bash
set JAVA_HOME=D:\PyCharm 2024.3.3\jbr          # JDK 21，AGP 8.7 要的版本
set ANDROID_HOME=D:\project\AndroidSdk
node 工具/pack.js                               # 1. 生成单文件 HTML
copy 分享版\平板仪表板.html 套壳\assets\www\index.html   # 2. 塞进壳
gradlew.bat assembleDebug --offline             # 3. 先试离线
```

固定版本（避免它去网上下载）：
- `compileSdk 35` / `targetSdk 35` / `minSdk 29`（iPlay 20 Pro 是 Android 10）
- `buildToolsVersion "34.0.0"`（本地有；AGP 8.7 默认要 35.0.0，本地没有会触发下载）
- Gradle wrapper 指向 **8.9**

### 路线 B（免 Gradle，零网络）

```
aapt2 compile  res/**  →  compiled/*.flat
aapt2 link     --manifest AndroidManifest.xml -I android.jar --java gen/
               -o base.apk  -A assets/
javac          -source 17 -target 17 -bootclasspath android.jar  →  *.class
d8             --min-api 29 --output .  *.class  →  classes.dex
zip            classes.dex 进 base.apk
zipalign       -p 4  →  aligned.apk
apksigner sign --ks ~/.android/debug.keystore  →  仪表板.apk
```

约 10 秒完成，完全离线。**这条路一定走得通，所以它是保底。**

---

## 六、测试与验收

| 项目 | 怎么做 |
| --- | --- |
| 装到哪 | ① 雷电模拟器（`D:\project\leidian\LDPlayer14`，需先启动）② 你的平板用 USB 调试 |
| 能不能装 | `adb install -r 仪表板.apk` |
| 三项网站在浏览器做不到的 | 温度有数字、开机自启生效、杀进程后能拉回来 |
| 网页功能没被弄坏 | 天气 / AI / 背景 / 月历全部复测一遍 |
| 退路 | 装不上就 `adb logcat` 抓日志 |

> 注意：模拟器**测不出温度**（返回值会是 0 或缺少该字段），温度只能在你真机上验。

---

## 七、风险清单

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| Gradle 缺依赖、Google Maven 拉不动 | A 路线卡住 | 立刻切 B 路线 |
| JDK 25 编不过（若误用 Studio 的 JBR） | 编译报错 | 显式指定 PyCharm 的 **JDK 21** |
| 开机自启在 Android 10+ 被限制 | 开机不自启 | 用前台服务常驻；部分国产 ROM 还要手动加白名单 |
| 平板 WebView 版本旧 | 新 CSS/JS 不生效 | iPlay 20 Pro 是 Android 10，WebView 可升级；必要时降低 `minSdk` |
| 温度字段厂商不实现 | 温度显示 `--` | 已做降级，不会崩；显示 `--` 而不是假数字 |
| 没有 cmdline-tools | 装不了新组件 | 现有 platforms/build-tools 够用，不需要装 |

---

## 八、需要你拍板的几件事

1. **构建路线**：两条都做，还是只做"免 Gradle 保底"那条？
   （我建议两条都做，实际交付用 B）
2. **包名**：默认 `com.tabletdash.app`，你有偏好吗？
3. **应用名**：默认「平板仪表板」。
4. **开机自启**：要不要？Android 10+ 需要前台服务常驻（会有一条常驻通知）。
5. **升级方向**：APK 里内置的网页，用**带内置 API Key 的分享版**（开箱即用），
   还是用不含 Key 的干净版？

---

## 九、我建议的推进顺序

1. 你拍板上面 5 件事
2. 我写 `套壳/` 全部源码 + Manifest + 资源
3. 先跑**路线 B** 出第一个 APK（快、确定性高）
4. 用雷电模拟器验证安装与基本功能
5. 补**路线 A** 的 Gradle 工程（能开进 Android Studio）
6. 你装到平板上，验温度、自启、常驻
7. 网页侧接 `native.js` 适配层，把 `--` 换成真实温度
8. 更新 `03-开发说明.md`

---

# 十、实施结果（路线 A 已完成）

**产物：`仪表版.apk`（88 KB），位于工程根目录。**

一键构建：双击 `工具/一键打包APK.cmd`，或 `node 工具/build-apk.js`。
它会自动：生成单文件网页 → 拷进壳的 assets → clean 构建 → 把 APK 复制到根目录。

## 已实测确认

| 检查项 | 结果 |
| --- | --- |
| 签名 | ✓ 通过（APK Signature Scheme v2，Android Debug 证书） |
| 包名 / 版本 | `com.tabletdash.app` v1.0 |
| 最低 / 目标 API | minSdk 29（Android 10）/ targetSdk 35 |
| 应用名 | **仪表版** |
| 图标 | `res/drawable/ic_launcher.xml`（矢量，深色底 + 琥珀表盘） |
| 权限 | 8 项：联网、网络状态、WiFi 状态、开机自启、前台服务×2、通知、唤醒锁 |
| 入口 Activity | `com.tabletdash.app.MainActivity` |
| 内置网页 | 186,251 字节，含内置 API 预设、新布局、防烧屏引擎 |
| 代码 | 7 个类全部在 `classes2.dex`（19.6 KB） |

## 路上撞的四个坑（都记下来，免得下次再踩）

**1. AGP 拒绝在含中文的路径下构建**
工程在 `C:\Users\熊凯\Desktop\平板仪表板设计\套壳`，AGP 直接报错拒编。
→ `gradle.properties` 里加 `android.overridePathCheck=true`。

**2. 两个 JBR 都不完整，AGP 造不了 JDK 镜像**
AGP 编译时要跑 `jlink` 生成 JDK 镜像，而：
- PyCharm 的 JBR（21）**根本没有 jlink.exe**
- Android Studio 的 JBR（25）有 jlink，但**没有 jmods**，实测报"不支持从当前运行时映像创建"

→ 双管齐下：`app/build.gradle` 把编译目标钉在 **Java 8**（AGP 只在目标 Java 9+ 时才需要造镜像），
再加 `android.experimental.disableJdkImageTransform=true` 双保险。壳里只用匿名内部类，Java 8 完全够用。

**3. `WebResourceResponse` 的两个 setter 不在公开 SDK 里**
`setStatusCode()` / `setReasonPhrase()` 编译报"找不到符号"（它们是 @hide 的）。
→ 改用带状态码的 6 参构造函数 `new WebResourceResponse(mime, enc, 200, "OK", headers, in)`。

**4. 增量构建会在 APK 里塞重复条目**
同一份代码，增量构建出来 **146 KB**，`clean` 之后 **88 KB**——多出来的 59,784 字节
几乎正好等于内置网页压缩后的大小，是重复的本地条目。
→ 构建脚本固定走 `clean assembleDebug`。

## 顺带确认过的环境细节

- Gradle 用本地缓存的 8.9，**完全离线**可构建，出包约 30 秒
- `gradlew.bat` 的 `distributionUrl` 已指向**腾讯云镜像**（官方 `services.gradle.org` 此处连不上）
- Maven 仓库顺序：**阿里云 gradle-plugin / google / public 优先，官方源兜底**

## 还没做的（下一步）

**网页侧还没接桥。** 现在这个 APK：
- ✅ 能加载仪表板、沉浸式横屏全屏、屏幕常亮
- ✅ 桥接接口 `window.NativeShell` 已就绪（电量温度 / 设备 / 存储 / 网络 / 常亮 / 全屏 / 常驻 / Toast）
- ❌ 网页还没调用它 —— **温度那格仍显示 `--`**
- ❌ 设置面板里**还没有「常驻模式」开关**，开机自启目前没有入口（默认关闭，符合要求）

下一步：
1. 新增 `assets/js/native.js` 适配层（有桥用桥、没桥自动降级）
2. `app.js` 接上：温度、存储、常亮，以及设置里的「常驻模式」开关（默认关）
3. 重新打包出新 APK

> ⚠️ **我没能验证的**：手头没有可用模拟器/真机（按你的要求没跑雷电），
> 所以"装上去能不能正常启动"**没有运行时证据**，只有静态证据
> （签名有效、清单正确、类都在、入口 Activity 已注册）。
> 装的时候要是闪退，`adb logcat -s AndroidRuntime` 抓报错发我。

---

# 十一、白屏修复 + 桥接完成（第二版）

## 1. 应用名更正

**仪表版 → 仪表板**（`res/values/strings.xml`）。
产物文件也改叫 `仪表板.apk`。

## 2. 酷比魔方 iPlay 20 Pro 白屏 —— 原因与修法

**现象**：Android 10 的 iPlay 20 Pro 打开后一片白，其它平板和手机正常。

**原因**：第一版用 `web.loadUrl("https://appassets.androidplatform.net/index.html")`，
靠 `shouldInterceptRequest` 把这个虚拟域名的请求截下来换成 APK 内的资源。
问题在于——**部分较旧的 WebView 不会拦截主文档（main frame）的导航请求**，
只拦子资源。于是 WebView 真的去 DNS 解析这个不存在的域名 → 解析失败 →
`onReceivedError`，而那一版**根本没写错误回调**，所以什么提示都没有，就是一片白。

**修法（釜底抽薪）**：**主文档根本不走网络。**

```java
String html = readAsset("www/index.html");          // 186 KB，几毫秒
web.loadDataWithBaseURL("https://appassets.androidplatform.net/",
                        html, "text/html", "utf-8", null);
```

`loadDataWithBaseURL` 把 HTML 直接注入 WebView，同时把 baseUrl 设成那个 https 域名。
好处全保留了：

| 关注点 | 结果 |
| --- | --- |
| 页面 origin | 仍是 `https://appassets.androidplatform.net`，localStorage 正常 |
| 跨域 fetch | Origin 正常，服务端 `ACAO:*` 就能过（天气、AI 都不受影响） |
| 主文档加载 | **零网络请求**，DNS / 拦截 / 证书这些坑全部消失 |
| 子资源 | 本来就没有——整个仪表板是单文件，CSS/JS 全内联 |

## 3. 顺手补上的四层保险

即使还有别的设备出问题，现在也不会再"一片白没线索"：

1. **错误全部可视化** —— `onReceivedError`（新旧两个重载）、`onReceivedHttpError`、
   `onReceivedSslError`、`onRenderProcessGone`、`onConsoleMessage` 全部记录
2. **加载超时回退** —— 10 秒没加载完就自动改走 `file:///android_asset/www/index.html`
3. **渲染进程崩溃自动重建** —— 低端机 + 老 WebView 上并不罕见，现在会重建 WebView 继续跑
4. **诊断页** —— 实在起不来时，把 Android 版本、设备型号、**系统 WebView 包名与版本**、
   加载模式、以及完整事件记录摊开显示，拍张照就能定位

另外还开了 `WebView.setWebContentsDebuggingEnabled(true)`，
平板连电脑后可以用 `chrome://inspect` 直接看这个页面——定位问题的终极手段。

## 4. 第四阶段的桥接做完了

新增 `assets/js/native.js` 适配层，网页侧接上了：

| 能力 | 说明 |
| --- | --- |
| **平板温度** | 走 `BatteryManager` 的粘性广播，**只有壳里才有**；浏览器里继续显示 `--` |
| **存储占用** | `StatFs` 读真实占用，比网页的 `storage.estimate()` 准（后者在 file:// 下根本拿不到） |
| **电量 / 充电** | 原生读取，比 Battery API 全（还带电压、充满状态） |
| **屏幕常亮** | 交给原生 `FLAG_KEEP_SCREEN_ON`，不挑前台后台，比 Wake Lock API 稳 |
| **常驻模式开关** | 设置面板新增，**默认关闭**，用户手动开启 |
| 设备 / 应用信息 | 型号、Android 版本、应用版本，显示在设置里 |

**降级是彻底的**：`Native.available` 为 false 时全部方法返回 null，
网页其余部分完全不受影响——同一份网页在浏览器里照跑，实测确认过。

## 5. 当前产物

**`仪表板.apk`（101 KB）**，已验证：

| 检查项 | 结果 |
| --- | --- |
| 签名 | ✓ 通过 |
| 应用名 | **仪表板** |
| 包名 / 版本 | `com.tabletdash.app` v1.0 |
| minSdk / targetSdk | 29（Android 10）/ 35 |
| 内置网页 | 193,402 字节，含原生桥、常驻开关、温度读取 |
| 代码 | 2 个 dex，合计 32.6 KB |

## 6. 仍然没法验证的

我手上**没有 iPlay 20 Pro 这种机器**，也没有可用模拟器（按你的要求没跑雷电），
所以"在这台 Android 10 平板上是否真的不白了"**只有推理，没有实证**。

不过现在的设计是——**就算还白，也不会再是"一片白没线索"**：
它会显示诊断页，把 WebView 版本和事件记录摊开。到时候拍照发我即可。

另外提醒一句：温度只有**在壳里**才有。直接用浏览器打开网页版永远是 `--`，这是正常的。

---

# 十二、v1.1：白屏再排查 + 四步兜底

## 1. 新增的关键线索

用户反馈：**同一份 HTML 在这台平板的浏览器里以 `file://` 打开是正常的**，只有装进壳里白屏。

这条线索价值极高——它排除了"引擎不支持 / 语法太新 / CSS 太新"这一整类猜测：
**同一台机器、同一个内核、同一份文件，能渲染。** 所以问题在**壳的加载方式或首帧时机**。

## 2. 找到的真凶：首帧尺寸为 0 → 缩放算成 0

`fitStage()` 原来这么写：

```js
var w = window.innerWidth, h = window.innerHeight;
var s = Math.min(w / 1920, h / 1200);
el.style.transform = '... scale(' + s + ')';
```

**WebView 里首帧还没完成布局时，`window.innerWidth / innerHeight` 是 0**，
于是 `s = 0`，整个 `#stage` 被缩成看不见——屏幕上只剩 body 底色。
而浅色主题的底色是 `#F4F2EC`，**看起来就是"一片白，什么都没有"**。

更糟的是：尺寸不变就不会触发 `resize`，所以它会**永远停在 scale(0)**。

**修法**：尺寸不可信时**不写 transform**，返回失败，交给重试逻辑：

```js
if (w < 2 || h < 2) { return false; }          // 尺寸没意义，别动画布
var s = Math.min(w / 1920, h / 1200);
if (!isFinite(s) || s <= 0) { return false; }
```

配一个 `fitStageRetry()`：每 100ms 重试，最多 4 秒；
**实在拿不到尺寸就按 1:1 显示**——宁可画面超出，也绝不留一片白。

## 3. 四步逐级兜底（不再靠猜）

单个原因猜不中，所以壳里做成了阶梯式重试，**每一步都先等网页确认真跑起来了**：

| 步 | 做什么 | 为什么 |
| --- | --- | --- |
| 1 | 注入 HTML，baseUrl 用 https 虚拟域名 | origin 最干净，跨域最标准 |
| 2 | 改 `file:///android_asset/` 直接加载 | **浏览器版验证过这条路能跑** |
| 3 | 切**软件渲染**（`LAYER_TYPE_SOFTWARE`）再走 file:// | 绕过展锐等芯片的 GPU 渲染问题 |
| 4 | 放弃 WebView，原生控件摊开诊断信息 | 兜底，保证有东西可看 |

每一步给网页 7 秒，靠新增的 **`pageReady()` 回调**判断"网页真的跑起来了"。
光有 `onPageFinished` 不够——**页面"加载完成"不等于 JS 跑成功**。

**还多了一道渲染自检**：网页报了就绪之后，壳会再问一句
`#stage` 实际占多大；宽度 < 200 就认定"画布没占位"，直接进下一步。
这一步专门用来抓 scale(0) 那类问题——**JS 跑了 ≠ 画出来了**。

## 4. 永远不会再"什么都没有"

加载全程有一个**原生覆盖层**铺在 WebView 上面，写着当前走到第几步。
成功才隐藏。所以：

- 走通了 → 看到仪表板
- 走不通 → 看到诊断页（Android 版本、设备型号、**系统 WebView 包名与版本**、硬件加速开关、渲染崩溃次数、完整事件记录）
- 连 WebView 都建不起来 → 原生 TextView 把原因和解决办法写清楚

另外，渲染进程崩溃会**计数**：崩过两次就直接进第 3 步（软件渲染），不再硬撑。

## 5. 顺带修的：浅色主题的温度

原来温度只在深色主题的状态栏里（`status-items` 是 `only-dark`），
浅色主题压根没这个位置。现在浅色右栏改成：

```
存储 64%  ·  平板温度 36.2°C
```

## 6. v1.1 产物

| 项 | 值 |
| --- | --- |
| 文件 | `仪表板.apk`（107 KB） |
| 版本 | versionCode 2 / versionName **1.1** |
| targetSdk | **29**（见下） |
| 签名 | ✓ 通过 |

**targetSdk 故意从 35 降到 29**，原因有两层：

1. targetSdk ≥ 30 时 WebView 会**忽略** `setAllowUniversalAccessFromFileURLs`
   ——而第 2/3 步兜底要跑 `file://`，那一步需要它能发跨域请求（天气 / AI）
2. 本应用只自用、不上商店，不受商店 targetSdk 要求约束；29 正好等于目标设备版本，
   行为最可预期

## 7. 老实说

我依然**没有这台机器可以实测**。但和上一版的区别是：
上一版是"一个猜测 + 静默失败"，这一版是**四个猜测依次试 + 全程可见**。

如果 v1.1 还白屏——**那它一定会显示诊断页**，上面有系统 WebView 的版本号。
拍照发我，我就能知道到底卡在哪一环。

---

# 十三、v1.2：白屏真凶落网 —— 系统 WebView 是 Chrome 74

## 1. 诊断页立功了

用户拍回来的诊断页信息：

```
Android  : 10 (API 29)
设备     : CUBE iPlay_20
ABI      : arm64-v8a
WebView  : org.chromium.chrome  74.0.3729.23     ← 关键
硬件加速 : 开
走到第   : 4 / 4 步
渲染崩溃 : 0 次

[3] 加载完成 https://appassets.androidplatform.net/
[4] 子资源错误 -1 发生了网络错误。
[5] 第 1 步 7 秒内没等到网页就绪      ← 页面"加载完成"，但 JS 从没跑起来
```

两条关键信息：

- **系统 WebView 是 Chrome 74**（2019 年 4 月），出厂版本，用户从没更新过
- **页面"加载完成"了，但 JS 一次都没跑** —— 说明不是脚本语法问题，是**渲染/布局层面**

而用户的浏览器内核比 WebView 新，所以"网页版能开、装进 APK 就白屏"。

## 2. 真凶：`inset: 0`（CSS 简写属性，Chrome 87+）

```css
#viewport { position: fixed; inset: 0; overflow: hidden; }
```

`inset` 是 `top/right/bottom/left` 的简写，**Chrome 87 才支持**。
在 Chrome 74 上它被整个忽略 → `#viewport` 四边都没有值 →
`position: fixed` 且尺寸由内容决定，而它的内容 `#stage` 是绝对定位（脱离文档流）
→ **`#viewport` 收缩成 0×0**，再配上 `overflow: hidden` → **整页被剪光**。

浅色主题底色 `#F4F2EC` 就是用户看到的"一片白"。

**修法**：老老实实写四边。共 6 处：

```css
#viewport { position: fixed; top: 0; right: 0; bottom: 0; left: 0; overflow: hidden; }
```

## 3. 顺带修的另外两个 Chrome 74 不兼容

**① flex `gap`（Chrome 84+）** —— 共 24 处 flex 容器。
不支持时 gap 被整个忽略，子元素紧挨成一团，排版全挤。
修法：新增 `assets/css/legacy.css`，用 `> * + *` 的 margin 等价还原，
再由 app.js 做**特性检测**，不支持时给 `<html>` 挂 `.no-flexgap`。

> 为什么不直接改原 CSS：这样新浏览器上行为**一模一样**，
> 补丁集中一处、将来去留都方便。
> 注意 **grid 的 gap 从 Chrome 57 就支持**，`.metric` / `.cal-grid` 这些不用补。

**② `translate` 独立变换属性（Chrome 104+）** —— 防烧屏用的。
改成两套 `transform` 关键帧：`.mod` 只要平移，`.bg-img` 把自己的 `scale(1.06)` 一起写上。

## 4. 全项目扫过的其它风险（确认没事）

| 检查项 | 结果 |
| --- | --- |
| JS 现代语法（`?.` `??` `replaceAll` `allSettled` `Object.hasOwn`…） | **一处都没有** |
| `:is()` / `:where()` / `:has()` / `aspect-ratio` / `inset-inline` / `color-mix` | **都没用** |
| `backdrop-filter`（Chrome 76） | 用了 2 处，但**本来就有降级**（毛玻璃不生效而已） |
| `accent-color`（Chrome 93） | 复选框着色，忽略无害 |
| `prefers-color-scheme`（Chrome 76） | 用 matchMedia，旧版返回 false，不报错 |
| `navigator.wakeLock`（Chrome 84） | 代码里本来就有 `if (!navigator.wakeLock)` 兜底 |

**结论：JS 完全干净，问题 100% 在 CSS。**

## 5. v1.2 产物

| 项 | 值 |
| --- | --- |
| 文件 | `仪表板.apk`（109 KB） |
| 版本 | versionCode 3 / versionName **1.2** |
| 签名 | ✓ 通过 |
| 内置网页 | 201,779 字节 |

已验证：产物里**再无 `inset` 简写**、四边定位已写入、
flex-gap 补丁与 `legacy.css` 都已内联、防烧屏已改用 `transform`。
现代浏览器（Chrome 140）渲染**无任何变化**，截图比对确认。

## 6. 顺带加的

- 设置里的「运行在 Android 壳内」那行现在会显示**系统 WebView 版本**
- 诊断页也会显示 WebView 版本、硬件加速开关、渲染崩溃次数

## 7. 如果 v1.2 还是白

那就只剩一种可能：**Chrome 74 太老，还有我没扫到的写法**。
这时候有两条路：

1. 我继续针对性兼容（诊断页 + `chrome://inspect` 远程调试能精确定位）
2. **更新平板的「Android System WebView」**——它是独立于 Chrome 的一个系统组件，
   出厂后不会自动更新。装个新版能从根子上解决，以后所有现代写法都能用

> 顺带一提：这也是个教训——**"网页版能跑"不等于"壳里能跑"**。
> 壳用的是**系统 WebView**，很多人从没更新过它，版本可能落后好几年。

---

# 十四、v1.3：最后一环 —— 桥接调用的参数个数不匹配

## 1. 用户的关键观察

> "这次在进入诊断页前**闪了一下仪表板界面**，然后就进诊断页了"

这一句价值极高。它说明：

- **页面其实一直渲染得好好的**（第 2、3 步都正常加载了内容）
- 只是被那个黑底覆盖层压着，所以看不到
- 那一下"闪"正是诊断页先 `hideOverlay()`、后加载诊断 HTML 之间的空隙——
  **底下的仪表板露了出来**

所以 v1.2 的 `inset` 修复**其实已经成功了**。剩下的唯一问题是：
**`pageReady()` 这个回调从来没送到 Java。**

## 2. 真凶：JS 桥按「方法名 + 参数个数」匹配

`native.js` 里的通用调用函数：

```js
function call(name, arg) {
  if (!SHELL || typeof SHELL[name] !== 'function') { return false; }
  try { SHELL[name](arg); return true; } catch (e) { return false; }
  //              ^^^^^ 永远会传一个参数，哪怕它是 undefined
}
```

而 Java 端：

```java
@JavascriptInterface
public void pageReady() { ... }        // ← 无参方法
```

**Android 的 JS 桥是按「方法名 + 参数个数」去匹配 Java 方法的。**
`SHELL.pageReady(undefined)` 传了 1 个参数，匹配不到 0 参的 `pageReady()`，
于是**静默失败**（异常被 `try/catch` 吃掉了）。

其它桥方法参数个数都对得上，所以只有这一个哑了：

| JS 调用 | Java 方法 | 参数个数 | 结果 |
| --- | --- | --- | --- |
| `SHELL.toast(msg)` | `toast(String)` | 1 : 1 | ✓ |
| `SHELL.setFullscreen(on)` | `setFullscreen(boolean)` | 1 : 1 | ✓ |
| `SHELL.setKeepScreenOn(on)` | `setKeepScreenOn(boolean)` | 1 : 1 | ✓ |
| `SHELL.getAutoStart()` | `getAutoStart()` | 0 : 0 | ✓ |
| **`SHELL.pageReady(undefined)`** | **`pageReady()`** | **1 : 0** | **✘ 静默失败** |

**修法一（治标）**：`pageReady` 不再走通用 `call()`，老老实实无参调用。

```js
pageReady: function () {
  if (!SHELL || typeof SHELL.pageReady !== 'function') { return false; }
  try { SHELL.pageReady(); return true; } catch (e) { return false; }
}
```

## 3. 修法二（治本）：不再依赖网页回调

就算桥再出别的问题，也不该让"页面明明渲染好了却判失败"。所以判定逻辑改成
**壳主动查 DOM**——走 `evaluateJavascript`，不经过 JS 桥：

```js
(function () {
  var o = [];
  var e = document.getElementById('stage');
  o.push(e ? Math.round(e.getBoundingClientRect().width) : -1);   // 画布宽度
  o.push(e ? Math.round(e.getBoundingClientRect().height) : -1);  // 画布高度
  o.push((typeof Native !== 'undefined' && Native.available) ? 1 : 0);   // 桥通不通
  o.push(document.body.classList.contains('ready') ? 1 : 0);      // init 跑完没
  return o.join(',');
})()
```

判定规则：**画布有真实尺寸（≥200×100）= 页面真的渲染出来了**，直接成功。

时序也理顺了：

- `onPageFinished` 后 +1.5 秒、+3.5 秒各查一次（查失败**不**急着进下一步）
- 7 秒 watchdog 到点再查一次，这次查失败才进下一步

顺便，每次探测都会把 **JS 桥通不通** 记进事件里，以后一眼就能看出是不是桥的问题。

## 4. 加了一个终极逃生口

覆盖层支持**长按直接显示界面**：

```java
overlay.setOnLongClickListener(... succeed("用户长按跳过") ...);
```

万一所有检测逻辑又判断错了，用户长按两秒就能把界面亮出来，不会被困在黑屏里。
覆盖层上的文字也写明了这一点。

## 5. v1.3 产物

| 项 | 值 |
| --- | --- |
| 文件 | `仪表板.apk`（112 KB） |
| 版本 | versionCode 4 / versionName **1.3** |
| 签名 | ✓ 通过 |
| 内置网页 | 202,231 字节 |

已验证：`pageReady` 不再传参 ✓、无 `inset` 简写 ✓、flex-gap 补丁已内联 ✓、
现代浏览器渲染无变化 ✓。

## 6. 复盘：这一路到底栽在哪

| 版本 | 以为的问题 | 真正的问题 |
| --- | --- | --- |
| v1.0 | 虚拟域名加载慢 | `shouldInterceptRequest` 拦不到主文档导航 |
| v1.1 | GPU 渲染崩溃 | 首帧尺寸为 0 → scale(0)；顺带查出 `inset` |
| v1.2 | 现代 CSS 太新 | **对了一半**：`inset` 确实致命，但真正卡住的是下一环 |
| v1.3 | — | **JS 桥参数个数不匹配，回调静默失败** |

**教训**：诊断信息要"能自证"。前两版都输在没有证据，
从 v1.1 的覆盖层 + 诊断页开始，每一轮都能拿到确定性信息——
最后一环其实是**用户一句"闪了一下仪表板"**破的案。

---

# 十五、v1.4：换图标 + 更名「鲸鲸仪表板」

## 1. 改了什么

| 项 | 旧 | 新 |
| --- | --- | --- |
| 应用名 | 仪表版 → 仪表板 | **鲸鲸仪表板** |
| 图标 | 矢量表盘（`drawable/ic_launcher.xml`） | **鲸鲸头像**（自适应图标 + 各密度 PNG） |
| 通知小图标 | 复用 `R.drawable.ic_launcher` | 新建单色 `R.drawable/ic_notify` |
| 根目录 APK | `仪表板.apk` | **`鲸鲸仪表板.apk`** |
| 分享版单文件 | `分享版/平板仪表板.html` | **`分享版/鲸鲸仪表板.html`** |

网页 `<title>` 也跟着改成「鲸鲸仪表板」。

## 2. 图标是怎么做的

源图：`C:\Users\熊凯\Downloads\大肥鱼图标背景透明处理.png`（1860×1847，已抠掉背景）。

**自适应图标**（minSdk 29，所以一定会走这条路）：

```
res/mipmap-anydpi-v26/ic_launcher.xml     自适应图标定义
res/values/ic_launcher_background.xml     背景色 #CFE0F5
res/mipmap-*/ic_launcher_foreground.png   前景（108dp 基准，内容压在安全区内）
res/mipmap-*/ic_launcher.png              传统方形图标（48dp 基准，兜底）
```

**两个尺寸是分开算的**，因为用途不同：

- **传统方形图标用 0.86 倍**——启动器基本不裁切，可以撑满一点
- **自适应前景用 0.70 倍**——自适应图标会被裁成圆形/方形/水滴形，
  必须把角色压进**中央安全区**，否则耳朵和头发会被切掉

背景色 `#CFE0F5` 是拿鲸鲸本身的平均色 `#8292BB` 配的同色系浅调，
既衬得住白色的女仆头饰，也能让深色描边清晰分离。

**生成方式**：PowerShell + `System.Drawing` 高质量双三次插值，
不依赖任何第三方库。

**已验证**：把自适应前景套上圆形遮罩做了预览，鲸鲸完整落在圆内、
脸和耳朵都没被切。

## 3. 顺带修的一个坑：通知图标不能用彩色图

`setSmallIcon()` 在通知栏会被渲染成**单色剪影**（只取 alpha 通道）。
原来复用的是那个彩色表盘矢量，改图标后如果直接指过去，
只会显示成一个白团。所以单独做了 `drawable/ic_notify.xml`：
纯白的表盘圈 + 指针，剪影下依然认得出（坐标由原来 108 视口等比缩放到 24）。

## 4. v1.4 产物

| 项 | 值 |
| --- | --- |
| 文件 | `鲸鲸仪表板.apk`（438 KB，图标占了大头） |
| 版本 | versionCode 5 / versionName **1.4** |
| 应用名 | **鲸鲸仪表板** |
| 签名 | ✓ 通过 |
| 兼容性自检 | ✓ 全部通过 |

APK 从 112 KB 涨到 438 KB，基本都是各密度图标 PNG。







---

# 十六、v1.5：文件选择器回调缺失 + 设置里的"黑底"

## 1. 用户反馈

> "背景图片导入有问题，点击没反应；设置里自定义字段勾选不明显，把黑底取掉。"

三件事，其实是两个根因。

## 2. 真凶一：壳没实现 `onShowFileChooser`

网页侧 `#bgPick` → `fileEl.click()` 一直是好的，**问题在壳**：

```java
web.setWebChromeClient(new WebChromeClient() {
    @Override public boolean onConsoleMessage(...) { ... }   // 只实现了这个
});
```

WebView 里 `<input type="file">` 被点击时，会去问 `WebChromeClient.onShowFileChooser()`。
**没实现 = 直接吞掉**，页面上什么都不会发生——所以"选择图片…"点了没反应。
（同理，配置 JSON 的"导入"也是哑的。）

**修法**（`MainActivity.java`）：

1. 实现 `onShowFileChooser()`：接住 `ValueCallback<Uri[]>`，用
   `FileChooserParams.createIntent()` 拉起系统选择器（失败时自己拼 `ACTION_GET_CONTENT` 兜底），
   返回 `true` 告诉 WebView"我接管了"。
2. 实现 `onActivityResult()`：把选中的 Uri（单选 `getData()` / 多选 `getClipData()` 两种形式）
   回传给网页。不回传，`input.files` 永远是空的。
3. 连续两次调起时先把旧的回调作废，否则 WebView 会卡住不再响应。

另外把 `<input type="file">` 的 `hidden` 改成 `.file-hidden`
（1px 视觉隐藏，仍在渲染树里）。老 WebView 对"点 `display:none` 的文件框"有概率直接忽略。

## 3. 真凶二：原生表单控件被壳的深色主题画成黑块

两个叠加原因：

| 层面 | 问题 |
| --- | --- |
| 网页 | `accent-color` 是 **Chrome 93** 才有的属性，目标机是 Chrome 74 → 写了等于没写，复选框退回原生外观 |
| 壳 | `AppTheme` 的 parent 是 `Theme.Material`（**深色**），WebView 的原生复选框 / 滑块 / 时间框全部跟着变成黑的 |

在浅色主题下，勾选态是一个**纯黑方块**——既刺眼，又读不出"这是个可勾选项"，
就是用户说的"勾选不明显 / 把黑底取掉"。滑块同理：轨道左半边被涂成一整条黑块。

**修法**：

1. **复选框完全自绘**（`base.css`）：`-webkit-appearance:none` 接管控件，
   白底 + 细边 + SVG 勾号（`background-image` + data URI）。
   浅色＝白底墨勾，深色＝深底琥珀勾。不依赖任何新语法，Chrome 74 与现代浏览器一致。
2. **滑块完全自绘**：细轨 + 空心圆钮，不再有黑色填充。
   数值本来就在每行标题里（"夜间压暗 25%"），轨道不需要填充色。
3. **壳主题换成 `Theme.Material.Light.NoActionBar.Fullscreen`**：
   WebView 的原生控件改跟浅色主题走。
   `windowBackground` 仍单独钉成 `#FF121417`，**防闪白的效果不变**。

## 4. v1.5 产物

| 项 | 值 |
| --- | --- |
| 文件 | `鲸鲸仪表板.apk`（442 KB） |
| 版本 | versionCode 6 / versionName **1.5** |
| 兼容性自检 | ✓ 全部通过（只剩 `backdrop-filter` 那条软提示，本就有降级） |
| 分享版 | `分享版/鲸鲸仪表板.html`（已同步重打） |

**待验证**（需要真机）：平板装上新版后，设置 → 背景 → 选择图片…，应能拉起系统相册/文件选择器；
选中的图片导入后出现在列表里。

---

# 十七、v1.6：从"只为 iPlay 20 Pro 做的"变成"任何横屏/方屏都能用"

## 1. 用户的原话

> "因为原本是为了我的旧平板专门做的软件，在显示尺寸上可能被限制成 1920×1200，
>  导入背景图也会被压缩，但现在我希望任何设备都能很好使用。"

先摸了一遍现状：

| 现状 | 具体表现 |
| --- | --- |
| 画布写死 | `#stage` 固定 `1920×1200`，`transform: scale(min(vw/1920, vh/1200))` 居中 → 宽高比一不对就出边 |
| 尺寸写死 | 两个主题文件里 **411 处固定 px**，零媒体查询、零 `vw/vh` |
| 背景图写死 | 硬压到 `1920×1200`、q0.82、总量 4.5 MB，全塞 localStorage |

确认范围后按 **「横屏/方屏全适配 + 背景图换 IndexedDB」** 做（手机竖屏不做专门布局）。

## 2. 核心思路：设计单位 `--u`

保留 1920×1200 这张设计稿，但把"整体缩放"换成"**流体单位**"：

```css
:root { --u: 0.05208333vw; }                      /* 100vw / 1920 */
@media (min-aspect-ratio: 1920/1200) {
  :root { --u: 0.08333333vh; }                    /* 100vh / 1200 */
}
#stage { width: 100%; height: 100%; }             /* 铺满，不再缩放 */
```

所有尺寸写成 `calc(N * var(--u))`，于是：

- **16:10（1920×1200）**：`--u` 正好 = 1px，**逐像素等于改造前**
- **比 16:10 窄（4:3）**：宽度是瓶颈 → `--u` 跟宽度走，纵向多出的空间交给 grid 的行吸收
- **比 16:10 宽（16:9、21:9）**：高度是瓶颈 → `--u` 跟高度走，横向多出的空间交给 `1fr` 吸收

**永远铺满，且圆还是圆、字还是同样的比例**（不是非等比拉伸）。

### 为什么不用 `min()`

`min()/max()/clamp()` 要 **Chrome 79**，目标机是 **Chrome 74**。
`@media (min-aspect-ratio: 1920/1200)` 分两档，语义与 `min()` 完全等价，
而媒体查询 Chrome 29 就有。附带好处：**纯 CSS，JS 挂了布局也不会塌**。
JS 只在 `fitStage()` 里用实测视口把 `--u` 再精修一遍（移动端 `vh` 有时指大视口）。

411 处固定 px 用 `工具/fluidize.js` 批量转换，**1px/2px 发丝线保持物理尺寸**
（放大到 1.8px 反而糊），注释和 SVG data URI 一律不动。

## 3. 顺带修掉一个老 bug：月历最后一行被裁

16:10 原设计下就有：6 行月份的最后一行总是被切掉半截。
原因是 **flex 子项默认 `min-height:auto` + grid 行默认下限 `min-content`** 叠加，
"日期 + 农历"撑出的最小高度顶穿了容器。

修法：`.cal-grid` 加 `min-height: 0` 和 `grid-auto-rows: minmax(0, 1fr)`，
并给 `.cal-head` / `.cal-week` 加 `flex: 0 0 auto` 防止被挤扁。

## 4. 超宽屏微调

21:9 时高度是瓶颈，横向会多出一大截。加了一条 `@media (min-aspect-ratio: 2/1)`，
把右侧天气栏从 `620u` 加宽到 `840u`、并把内边距放大，构图重心往中间收。

## 5. 背景图：IndexedDB + 分辨率自适应

见 `03-开发说明.md` 第五节的更新。要点：

- IndexedDB 优先（软上限 **48 MB**），`file://` 自动降级 localStorage（4.5 MB）
- 超时**不判死刑**：先降级跑起来，IndexedDB 后来开成功了仍然切过去并迁移
- 老数据一次性迁移（直接扫 `localStorage` 键，孤儿图补元数据，不丢图）
- 导入长边上限 = `min(3840, max(1920, 屏幕长边 × DPR))`，或手动选 高清2560 / 超清3840
- 涉及图片的 API 全部改成 Promise

## 6. 新增的工具（都在 `工具/`）

| 文件 | 作用 |
| --- | --- |
| `fluidize.js` | 把 CSS 里的固定 px 批量转成 `calc(N * var(--u))`。幂等，可重复跑 |
| `run-test.js` | 无头浏览器测试跑板：起静态服务 + 页面 POST 回传结果。**解决 `--dump-dom` 抓太早、等不到 IndexedDB 回调的问题** |

## 7. 验证

- `node 工具/检查兼容性.js` → ✓ 全过（只剩 `backdrop-filter` 那条软提示，本就有降级）
- `node 工具/run-test.js 测试/背景自检.html` → 在 **http** 下跑：后端 = **idb**、48 MB、
  3000px 大图不被压到 1920、老数据迁移成功、全部 PASS
- 同一个自检页在 **file://** 下跑 → 后端 = ls，降级路径同样全部 PASS
- 截图比对：1920×1200 / 1920×1080 / 2560×1080 / 1600×1200 / 2160×1440 / 1280×800，
  浅色深色各一轮，均铺满无黑边、无裁切

## 8. v1.6 产物

| 项 | 值 |
| --- | --- |
| 文件 | `鲸鲸仪表板.apk`（448 KB） |
| 版本 | versionCode 7 / versionName **1.6** |
| 分享版 | `分享版/鲸鲸仪表板.html`（已同步重打） |

**待真机确认**：平板上界面应仍与原设计一致（16:10 下逐像素相同）；
若平板实际可视区域不是严格 16:10，会看到轻微重新分配，属预期。

---

# 十八、v1.7：计时器 + 闹钟

## 1. 需求

> "加两个功能：一是倒计时和正计时，倒计时可添加删除常用计时器，类似手机自带的；
>  二是闹钟。两种模式都要加，位置放到现有空白处，点击展开设置详情页（参考已有的设置日程功能）。
>  主设置里可以取消这两个功能（默认打开）。提醒可设置铃声还是震动以及通知，
>  铃声也可自定义音频。以及我没提到但重要的你也考虑考虑。"

## 2. 位置：为什么落在时钟模块里

先量了一遍两个主题的空白：

| 主题 | 空白在哪 |
| --- | --- |
| 浅色 | 大时钟与下方分隔线之间（约 150px 高 × 整栏宽）；右下侧栏底部 |
| 深色 | 左栏「时钟 ↔ 日期 ↔ 电池」之间的间隙（`justify-content: space-between` 分出来的） |

**两个主题共同且位置最合理的就是时钟模块**，而且计时器/闹钟本来就该跟时钟在一起。
所以加了一行两个入口卡片（`.clk-tools`）：

- 浅色：`margin-top: auto` 贴到模块底部
- 深色：跟在电池/日出日落之后
- 卡片上直接显示实时摘要：正在跑的倒计时剩余（`03:03 +2`）、下一个闹钟（`07:30 明天`）
- 点击 → 详情弹层，结构与「点日历格看日程」的 `#dateModal` 一致

## 3. 三个新模块

| 文件 | 职责 |
| --- | --- |
| `assets/js/remind.js` | 提醒引擎：内置合成铃声 / 自定义音频 / 震动 / 系统通知 / 页面浮层 / 贪睡 |
| `assets/js/timers.js` | 倒计时 + 正计时 + 常用时长增删 |
| `assets/js/alarms.js` | 闹钟：时间 / 重复星期 / 标签 / 开关 / 补响 |

### 3.1 提醒引擎：四条通道，任何一条挂了都不影响其余

1. **页面浮层** —— 最可靠。Android WebView 里 `window.Notification` 基本不可用，
   所以"屏幕上弹出来"才是真正兜底的通道，永远最先做
2. **响铃** —— 内置铃声用 **WebAudio 现场合成**（叮咚/滴滴/脉冲/经典闹铃/急促），
   不占任何体积、不需要音频文件；自定义音频存 IndexedDB
3. **震动** —— `navigator.vibrate`，壳里补了 `VIBRATE` 权限
4. **系统通知** —— 有就用，没有就跳过

处理掉的坑：
- **自动播放限制**：`AudioContext` 必须在用户手势后 resume，失败就静默降级为"只浮层+震动"
- **音量渐入**：1.6 秒内从 0 爬到设定音量，免得突然吓人
- **夜间勿扰**：夜里闹钟该响还得响，但计时器提醒可以只震动（可配）
- **多路并发**：同时到点的提醒**排队**而不是互相顶掉（顶掉的话前面那条就永远丢了）
- **贪睡**：不销毁这次提醒，只是推迟 N 分钟重新排队

### 3.2 计时器：存时间戳，不存"还剩几秒"

- 倒计时运行中存 `endAt`（结束时刻），暂停时存 `remainMs`
- 正计时运行中存 `startAt`，暂停时把本段累加进 `accMs`

这样刷新、切主题、APK 崩溃自恢复之后时间依然准。
如果存"剩余秒数"再每秒减一，`setInterval` 一旦被节流就会越走越偏。

页面重新可见时 `catchUp()` 补一次，把被挂起期间到点的计时器补上提醒。

### 3.3 闹钟：去重靠 `lastFired`

每秒看一眼"当前 HH:MM 是否命中"，用 `lastFired='YYYY-MM-DD HH:MM'` 去重：
某一秒被跳过也不会漏响，重复 tick 又不会重复响。

打开页面时**补响**：响铃时刻在过去 5 分钟内的立刻补一次（闹钟晚响总比不响好）；
更早的只记一条"错过的闹钟"提示，不惊动用户。单次闹钟响完自动关。

## 4. 主设置新增两节

- **计时器与闹钟**：两个启用开关（默认开）、两个"打开面板"按钮
  关掉后入口卡片隐藏、对应调度停掉；重开从原状态继续
- **提醒方式**（两者共用）：响铃 / 震动 / 系统通知三个独立开关、
  铃声六选一（含自定义音频）、音量、贪睡时长、音量渐入、夜间只震动、试听

## 5. 顺带考虑到的（用户没提但重要的）

1. 页面浮层永远最先做 —— 其余三条通道都可能不可用
2. 多路提醒排队，不互相顶掉
3. 音量渐入，避免突然吓人
4. 贪睡
5. 存绝对时间戳，扛得住刷新 / 崩溃自恢复 / `setInterval` 节流
6. 页面恢复时补响错过的提醒
7. 夜间勿扰与闹钟区分对待
8. 自定义音频存 IndexedDB（localStorage 兜底，并明确提示 1.2MB 上限）
9. 导出配置时带上计时器 / 闹钟 / 提醒设置（音频文件本身不入配置，太大）
10. 单次闹钟响完自动关闭，不会变成"明天再来一次"
11. 关掉功能时把正在跑的面板一起收起来

## 6. 自检抓出的一个真 bug

`timers.js` 里同时存在：

```js
function start(id) { ... }   // 启动"某一个"计时器
function start()   { ... }   // 启动整个模块（挂 tick 定时器）
```

JS 的函数声明会互相覆盖，**后声明的赢** —— 于是 `Timers.start(id)` 变成了
"启动模块并忽略 id"，单个计时器永远开始不了。

自检页直接把这个抓了出来（"开始后 running" 那条 FAIL）。
修法：模块级改成 `boot()` / `shutdown()`，并在源码里留了警告注释。

> 教训：同一个作用域里别用同名函数。批量写模块时很容易犯，靠自检兜住。

## 7. 验证

- `node 工具/run-test.js 测试/计时与闹钟自检.html` → **60+ 项全部 PASS**
  （时长解析、倒计时生命周期、到点触发、正计时、预设增删、
   闹钟下次响铃计算 / 重复说明 / 触发去重 / 单次自动关、
   提醒排队 / 通道开关 / 贪睡、主设置开关、落盘）
- `node 工具/检查兼容性.js` → ✓ 全过（新代码补了 12 条 flex gap 降级规则）
- 截图：浅色 / 深色 × 仪表板 / 计时器面板 / 闹钟面板 / 提醒浮层 / 设置抽屉，逐一看过

## 8. v1.7 产物

| 项 | 值 |
| --- | --- |
| 文件 | `鲸鲸仪表板.apk`（476 KB） |
| 版本 | versionCode 8 / versionName **1.7** |
| 权限 | 新增 `android.permission.VIBRATE` |
| 分享版 | `分享版/鲸鲸仪表板.html`（已同步重打） |

**待真机确认**：平板上震动是否生效；铃声在 WebView 里能否播放
（自动播放策略在壳里通常宽松，但第一次点击前仍可能被拦）。

---

# 十九、v1.7.1：装到平板上之后反馈的四个问题

## 1. 倒计时不响铃，闹钟响

**不是坏了，是我把默认值设错了。**

`Remind.fire()` 里有一条：

```js
var quiet = (ringing.kind === 'timer') && cfg.quietTimerVibeOnly && inQuietHours();
```

`quietTimerVibeOnly`（夜间时段计时器只震动）**默认是 1**，
而白天/夜间划分是 06:00 / 18:00 —— 用户在 18:30 测试，正处在"夜间"，
于是倒计时只震不响；闹钟不受这条约束，所以照响。

**修法**：
- 默认值改成 **0**（这条规则太容易误伤了，得让用户主动开）
- 加配置版本号 `_v`：老配置（没有 `_v`）里那个 `1` 是旧默认值不是用户选的，
  启动时自动纠正成 0；打过 `_v` 标记后就不再动，尊重用户的选择
- 真的被夜间规则静音时，**浮层上写出来**：
  "夜间时段：计时器只震动不响铃（设置 → 提醒方式 里可以关掉这条规则）"
  —— 否则用户只看到弹窗没声音，还是会以为坏了

## 2. 正计时页还留着倒计时的「自定义时长」

没做模式切换时的显隐。修法：`paintModal()` 里给 `#timerModal` 挂 `.tm-up` 类，
CSS 里 `#timerModal.tm-up .tm-add { display: none; }`，同时把标题从「常用计时器」换成「新建」。

## 3. 正计时要单独显示在主屏幕右边（可能有多个）

原来 `summary()` 只挑倒计时，只跑秒表时退化成了「1 个正计时」这种没用的文字。

**修法**：正计时不塞进那张卡片 —— 它可能有多个、每个都要看读秒，挤不下也看不清。
在 `.clk-tools` 那一行的**右侧**加了一条独立条带 `.clk-sw`：

- 每个正在跑的秒表一个小块：名称 + 读秒
- 最多显示 3 个，多出来的显示 `+N`
- 空间不够时（深色主题只有 1/3 屏宽）整条换到下一行
- 点任意一块 → 切到「正计时」页并展开面板
- 卡片那边只报个数（`1 个正计时`），不重复占位

## 4. 主设置里关掉功能后，入口卡片没隐藏 ⚠️ 真 bug

```css
.tool-card { display: flex; }
```

**浏览器给 `[hidden]` 的 `display:none` 只是「用户代理样式」，作者写的
`display:flex` 会把它整个盖掉。** 所以 `el.hidden = true` 属性设上了，
元素照样显示。

**修法**：base.css 里加一条兜底

```css
[hidden] { display: none !important; }
```

### 为什么自检没抓到

自检当时断言的是 `el.hidden === true` —— **属性**，不是**计算样式**。
属性确实设上了，所以测试通过，视觉却纹丝不动。

修完自检也一并改了：所有"隐藏"断言都改成
`getComputedStyle(el).display === 'none'`。
**教训：测"看不见"要测渲染结果，不能测那个标志位。**

## 5. v1.7.1 产物

| 项 | 值 |
| --- | --- |
| 文件 | `鲸鲸仪表板.apk` |
| 版本 | versionCode 9 / versionName **1.7.1** |
| 自检 | 70+ 项全 PASS（新增隐藏断言、正计时条带、模式切换、配置迁移） |
| 分享版 | `分享版/鲸鲸仪表板.html`（已同步重打） |

---

# 二十、v1.8：设置面板改造成「分类 → 二级页」

## 1. 问题

到 v1.7.1 为止，设置抽屉里已经堆了 **14 个小节、60 多个控件**，
全在一个滚动条里 —— 找「改个铃声」要往下翻十几屏。

## 2. 做法：DOM 原地分组，不动任何逻辑

关键判断：**所有控件的 id / data-seg / data-field 一个都不能改**，
因为 `app.js` 里 `syncSettings()`、`$$('.seg')` 的绑定、各种 `$('#xxx')`
全都指着它们。所以这次**不搬 DOM、不重写绑定**，只做两件事：

1. 把原来那条长内容按块切出来，各自塞进一个
   `<div class="set-page" data-page="xxx">`，靠 CSS 的 `display` 切换
2. 在抽屉顶部加一屏**分类列表**（`.set-cat`），点进去才显示对应那一页

用一次性脚本按行号切块重组（跑完即删），比手抄 460 行可靠得多。
重组后比对过：`id` 46 个、`data-seg` 29 个、`data-field` 8 个，
**一个没丢**（只新增了 `setBody` / `setTitle` / `setBack` 三个）。

## 3. 八个分类

| 分类 | 装了什么 |
| --- | --- |
| 外观与主题 | 主题、主题模式、白天/夜间划分、时间制式、显示秒数 |
| 屏幕与防烧屏 | 屏幕常亮、夜间勿扰+压暗、防烧屏全套、Android 常驻 |
| 天气 | 数据源、密钥、城市、预报天数、刷新频率、显示字段、立即操作 |
| 背景 | 模式、导入、画质、图片列表、轮播、模糊/淡化/压暗、毛玻璃、清空 |
| 计时器与闹钟 | 两个启用开关 + 两个管理入口 |
| 提醒方式 | 响铃/震动/通知、铃声、自定义音频、音量、贪睡、渐入、夜间、试听 |
| AI 问候与对话 | 启用、API、模型、连接、流式、刷新、温度、token、提示词 |
| 数据与系统 | 导出/导入、状态信息、恢复默认 |

一级列表每行**右侧显示当前值摘要**（`浅色编辑网格 · 手动`、`叮咚 · 铃声/震动`、
`Open-Meteo · 攀枝花`…），不进二级页也知道现在是什么状态。

## 4. 顺带修掉的

- 原来「城市」在两处都有 `data-city-label`，而 `$()` 只取第一个 ——
  天气页那个其实**从来没被更新过**。现在删掉重复的那个，只留天气页里的
- Esc 键在二级页先退回分类列表，在分类列表才关抽屉
- 每次打开设置都回到分类列表，不会停在上次那个二级页

## 5. 又踩了一个「作者样式盖过默认样式」的坑

`.set-cat` 是 `<button>`，写了 `appearance: none` 但**没写 `background`** ——
结果 `<button>` 的默认底色（ButtonFace）还在，8 个分类渲染成 8 条灰块。
补上 `background: transparent` 就好了。

> 和 v1.7.1 那个 `[hidden]` 是同一类问题：**`appearance:none` 不等于重置全部**。
> 自己做控件时，`background` / `border` / `padding` / `font` 都得显式给。

## 6. 验证

- `node 工具/run-test.js 测试/计时与闹钟自检.html` → **80+ 项全 PASS**
  （新增：8 个分类、默认只显示列表、点进二级页、标题与返回按钮、
   每个分类都有值摘要、**二级页里的控件抽查 7 个全在 DOM 里**）
- 截图：浅色/深色 × 分类列表 / 天气页 / 屏幕页 / 提醒页 / AI 页 / 外观页

## 7. v1.8 产物

| 项 | 值 |
| --- | --- |
| 文件 | `鲸鲸仪表板.apk` |
| 版本 | versionCode 10 / versionName **1.8** |
| 分享版 | `分享版/鲸鲸仪表板.html`（已同步重打） |

---

# 二十一、v1.9：内置壁纸 + AI 人设库

## 1. 内置一张壁纸（可删）

用户给了一张图（1920×1080 的夏日光斑人像），要求内置进背景库，
**和导入的图片一样能删除**，并且种进来之后背景默认以图片展示。

### 为什么把图 base64 内嵌，而不是放成 assets/img/xxx.jpg

内置图要在首次启动时"导入"进背景库 —— 这一步得把它**画到 canvas 上**
（重新压到设备分辨率 + 生成缩略图）。而：

> **`file://` 页面里加载 `file://` 图片会把 canvas 污染（tainted）**，
> 之后 `toDataURL()` 直接抛 `SecurityError`。

APK 的第 2/3 步兜底正好跑在 `file:///android_asset/` 下，那样内置图就永远导不进来。
dataURL 是同源的，画进 canvas 不会被污染，**任何环境都能用**。

代价是体积：1920 长边 q0.78 之后 JPEG 238 KB，base64 后 **317 KB**，
直接进 HTML（分享版从 347 KB 涨到约 660 KB，APK 从 481 KB 涨到约 800 KB）。
对自用 kiosk 来说可以接受。

### 实现

- `assets/js/builtin-bg.js` —— 只放数据：`window.DASH_BUILTIN_BG = [{ id, name, w, h, data }]`
- `background.js` 里把原来的 `compress(file)` 拆成
  `compressSrc(src, mime, isObjectUrl)` + `compress(file)`，
  于是**内置图和用户导入的图走完全同一条压缩入库路径**，待遇一致
- 新增 `seedBuiltin()`：
  - 首次启动时种进背景库，`meta` 里 `builtin: 1`
  - `dash.bg.seeded` 记已种过的 id —— **删掉之后不会再自动回来**
  - 种成功后如果 `mode` 还是 `off`，自动切成 `image`（否则壁纸躺在库里不显示，
    用户会以为没生效）；用户自己选过模式就不动
  - 空间不足时也标记已种过，免得每次启动都白试一遍

## 2. AI 人设库

### 结构调整

原来 `ask()` 里的对话系统提示词是**硬编码**的 —— 设置里那个「系统提示词」其实
只影响问候语。这次顺手拆清楚：

| 配置 | 作用 |
| --- | --- |
| `prompt` | 问候语提示词（原「系统提示词」，标签已改准确） |
| `chatPrompt` | 对话提示词（**新增**，从硬编码挪出来变成可编辑） |
| `personaOn` / `personaId` | 人设开关与当前选中的人设 |

### 人设怎么拼进去

```
[基础提示词（替换 {{}} 变量）] + [人设段落] + [实时上下文]
```

**是追加不是替换**，而且人设夹在中间：前面是任务要求，后面是数据，
塞中间最不容易被上下文淹掉。问候语和对话都吃这一套。

### 内置人设

| 名字 | 说明 |
| --- | --- |
| **DeepSeek 大肥鱼** | 社区二创的「鲸鱼娘」形象，见下 |
| 温柔陪聊 | 一个克制的陪聊人设，作为对照 |

**两个都默认不启用**（`personaOn = 0`、`personaId = ''`），要用户自己去设置里打开。
和内置壁纸一样：`dash.ai.personaSeeded` 记已种过的 id，**删了不复活**。

### 关于「大肥鱼」这个人设

取材自社区二创（`dafeiyu-persona` 等）：一条活泼俏皮的蓝色鲸鱼娘，
贱兮兮、傲娇、爱偷吃爱摸鱼、会冒"思维链心声"。

社区原版的核心原则我原样保留了：

> **人设只包裹语气，不牺牲正确性。**

所以内置提示词里硬性规则第 1 条是「先办对事，再卖萌：任务正确性永远大于人设」，
第 5 条是「遇到安全/医疗/法律/财务这类严肃话题，或主人说'别演了/正经点'，
立刻收起卖萌正常回答」。**这不是越狱型人设，是纯语气层。**

## 3. 界面

AI 设置页新增：

- 问候语提示词 / 对话提示词 两个文本框，各自带「恢复默认」
- **人设**小节：启用人设开关、人设 chips（选一个即自动开启）、
  人设内容文本框（改完自动保存）、新人设名字输入框、「另存为新人设」「删除这个人设」
- 底部一句状态说明：没开 / 开了但没选 / 正在用谁

## 4. 又踩了同一个坑

`.persona-chip` 又是 `<button>`，这次**一开始就写了** `background: transparent` ——
v1.8 那次的 `ButtonFace` 灰底教训记住了。

## 5. 验证

`node 工具/run-test.js 测试/计时与闹钟自检.html` → **100+ 项全 PASS**，新增：

- 内置图种进背景库、名字正确、有尺寸和大小、缩略图生成、**模式自动切成 image**
- 人设默认关闭、两个内置人设都在、大肥鱼提示词 671 字符
- 没开人设时提示词里没有人设；开了之后**对话和问候语都带上**，
  且**基础提示词没被顶掉、人设排在基础提示词之后**（追加不是替换）
- 另存为 / 改内容 / 删除 / 删掉正在用的那个会自动关掉人设

截图：浅色深色 × 仪表板（内置壁纸生效）/ 背景设置页（列表里能看到内置图）/ AI 人设页

## 6. v1.9 产物

| 项 | 值 |
| --- | --- |
| 文件 | `鲸鲸仪表板.apk` |
| 版本 | versionCode 11 / versionName **1.9** |
| 分享版 | `分享版/鲸鲸仪表板.html`（含内置壁纸，体积涨到约 660 KB） |

---

# 二十二、v1.9.1：三个显示问题

装到平板上之后反馈的三处，都是样式层面的。

## 1. 计时弹层右上角的 × 和「倒计时 / 正计时」重叠

`.modal-tool` 里的关闭按钮是**绝对定位**的（`top:14 / right:18`），
而 `.tm-head` 是 `justify-content: space-between`，右边的切换器正好顶到
弹层的 padding 边上 —— 于是切换器右半边钻到了 × 底下。

**修法**：给 `.tm-head` 加 `padding-right: calc(30 * var(--u))`，把位置让出来。

## 2. 深色下「＋ 自定义 / ＋ 新建秒表」白字白底看不见 ⚠️

**又是 `appearance: none` 不等于重置全部。**

`.tm-preset` 平时是 `<span>`，但「＋ 自定义 / ＋ 新建秒表」这两个是 `<button>`，
而 `.tm-preset` 的样式里**只写了 border，没写 background** ——
于是 `<button>` 的默认底色（ButtonFace）透出来：深色主题下是一块浅灰/白，
上面的 `var(--ink)` 近白字压上去就是"白字白底"。

**这个坑已经踩过三次了**：

| 版本 | 踩的地方 |
| --- | --- |
| v1.7.1 | `[hidden]` 被 `.tool-card{display:flex}` 盖掉 |
| v1.8 | `.set-cat` 忘了 `background`，8 个分类渲染成灰块 |
| v1.9.1 | `.tm-preset` 忘了 `background`，白字白底 |

所以这次在 base.css 里直接兜一条**全局规则**：

```css
button { background: transparent; }
```

特异性只有 (0,0,1)，任何 class 规则都能盖过它，只当兜底 ——
以后新增按钮忘了写 background 也不会再露底。

## 3. 深色下电量 / 计时 / 闹钟三个卡片是纯黑块

`.clock-battery`、`.tool-card`、`.sw-chip` 在深色主题下铺的是实色 `#1B1F24`，
压在壁纸上就是一坨黑块。

**修法**：`background: transparent`，改用**半透明描边** `rgba(255,255,255,.14)`
撑住形状（原来的实色描边 `--line #262A30` 在图上几乎看不见）。
hover 也从实色 `#20252B` 改成 `rgba(255,255,255,.07)`，这样压在什么背景上都成立。
`.tool-card.busy` 的描边换成琥珀色半透明。

顺带把正计时条带 `.sw-chip` 也一起改了 —— 它和那两个卡片是同一套视觉，
只改两个会显得突兀。

## 4. 自检补的防线

新增 `9e. 样式兜底` 一节，专门盯这类"渲染结果和属性不一致"的问题：

- 往 DOM 里插一个**裸 `<button>`**，断言它的计算背景是透明的
  （直接验证那条全局兜底规则还在）
- 断言「＋ 自定义」按钮没有实心底色
- 断言设置分类行没有实心底色
- 断言弹层头部的 `padding-right > 10px`（给关闭按钮留了位置）

## 5. v1.9.1 产物

| 项 | 值 |
| --- | --- |
| 文件 | `鲸鲸仪表板.apk` |
| 版本 | versionCode 12 / versionName **1.9.1** |
| 自检 | 110+ 项全 PASS |
| 分享版 | `分享版/鲸鲸仪表板.html`（已同步重打） |

---

# 二十三、v1.9.2：内置壁纸"第二次打开就没了" —— 一个真事故

用户反馈：**内置的图片背景没了。**

## 1. 真因：refresh 把"读不到"当成了"没有"，然后把数据删了

`start()` 的执行顺序是**先 `refresh()` 再开存储**：

```js
function start(theme) {
  refresh(true);          // ← 此刻 idb 还是 null
  schedule();
  initStore().then(...)   // ← 存储才在这里打开
}
```

第二次打开时，图片数据已经迁到 **IndexedDB** 里了，而这一刻 `idb === null`，
`loadRec` 只去 localStorage 找 → 找不到 → `refresh` 把它当成"幽灵条目"：

```js
if (!rec || !rec.data) {
  return removeItem(pick.id)      // ← 元数据 + IDB 记录一起删了
}
```

而 `dash.bg.seeded` 已经标记"种过了"，于是**内置图永远回不来**。

### 为什么截图和自检都没发现

- 我每次截图都用**全新的 `--user-data-dir`** —— 等于永远"第一次打开"，照不出来
- 自检只在第一次启动后断言了图片存在，**没有模拟第二次启动**

## 2. 修法：把"读不到"和"确实没有"彻底分开

### 2.1 `loadRecEx` 返回 `{ rec, missing }`

`missing` **只在"确实查过、确实没有"时才为 true**：

| 情况 | missing |
| --- | --- |
| 存储还没就绪（`pending`） | **false** —— 还没查呢 |
| IndexedDB 没开成（`ls` 模式） | **false** —— 数据可能在 IDB 里，够不着≠没有 |
| IDB 读取报错 | **false** —— 读不了≠没有 |
| IDB 正常查完、没有；localStorage 也没有 | **true** |

只有 `missing === true` 才允许清元数据。

### 2.2 `refresh` 挨个试，而不是"读不出就空着"

某一张这次读不出来（幽灵条目 / 正在迁移 / 存储够不着），**换下一张**，
不让整个背景空掉。清幽灵用 `dropGhost()`（不触发重绘），避免在循环里递归。

### 2.3 内置图自带自愈

判定标准从"种过没有"改成**"库里现在有没有、这次读不读得出来"**：

| 状态 | 动作 |
| --- | --- |
| 用户主动删过（`dash.bg.removed`） | 不再种回来 |
| 数据在、元数据也在 | 什么都不做 |
| **数据在、元数据没了** | 补一条元数据（不然图在库里却看不见） |
| 数据没了 | 重新种一份（补种时**不动**背景模式） |

`removeItem` 只在**用户主动删**时记 `removed`；`refresh` 清幽灵时用
`removeItemEx(id, true)`，不记 —— 否则内置图就永远回不来了。
`clearAll`（清空全部）也算用户意图，一并记上。

背景模式的自动切换放宽了一点：**头一回种**或者**补种时库本来是空的**，
都会把 `mode` 从 `off` 切成 `image`。这样"数据全丢 → 补种"之后壁纸也会自己显示出来，
而用户自己存了图、特意选纯色底的情况不会被覆盖。

## 3. 这次补的测试（关键）

新增 `14. 二次启动回归`，**真的再开一个 iframe 模拟第二次启动**：

```
第一次启动后库里有图          → 1 张
第二次启动后背景图还在        → 1 张
内置图没被当成幽灵条目删掉    → bi_summer-light
第二次启动后图片数据仍可读    → 385367 字符
元数据丢了也能自动补种回来    → bi_summer-light
```

**并且验证过这个测试不是摆设**：把修复临时回退，第 2 条立刻变红
（`第二次启动后背景图还在 → 0 张`），正是用户遇到的现象。

另外做了一次**真·多次启动**的端到端验证：同一个 Chrome profile 连开四次，
量左上角平均亮度 —— 四次都是 46 左右（纯色底只有约 19），壁纸稳定存在。

> **教训**：截图自检用全新 profile 等于只测了"首次启动"。
> 凡是涉及**持久化**的功能，必须专门造一个"第二次启动"的用例 ——
> 这次这个 bug 就藏在"第一次好好的、第二次就没了"这个缝里。

## 4. v1.9.2 产物

| 项 | 值 |
| --- | --- |
| 文件 | `鲸鲸仪表板.apk` |
| 版本 | versionCode 13 / versionName **1.9.2** |
| 自检 | 115+ 项全 PASS |
| 分享版 | `分享版/鲸鲸仪表板.html`（已同步重打） |
