/* ============================================================================
 * build-apk.js — 一键把网页打进 APK
 * ----------------------------------------------------------------------------
 * 做四件事：
 *   1. 跑 工具/pack.js 生成单文件网页
 *   2. 拷进 套壳/app/src/main/assets/www/index.html
 *   3. 调 Gradle 出 APK
 *   4. 把产物复制到工程根目录，改名成 仪表版.apk
 *
 * 用法：node 工具/build-apk.js      （或双击 工具/一键打包APK.cmd）
 *
 * 环境说明（本机实测踩过的坑都写在这里了）：
 *   · 必须用 JDK 21（PyCharm 自带那个）；Studio 自带的 JDK 25 跑不了 Gradle 8.9
 *   · 两个 JBR 都缺 jmods，jlink 不可用，所以 app/build.gradle 把编译目标钉在 Java 8
 *   · 工程路径有中文，gradle.properties 里开了 android.overridePathCheck
 *   · services.gradle.org 连不上，所以优先用本地缓存的 Gradle，wrapper 指向腾讯云镜像
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SHELL_DIR = path.join(ROOT, '套壳');
const ASSET_DIR = path.join(SHELL_DIR, 'app', 'src', 'main', 'assets', 'www');
const OUT_APK = path.join(SHELL_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const FINAL_APK = path.join(ROOT, '鲸鲸仪表板.apk');

const line = (s) => console.log(s === undefined ? '' : s);
const step = (n, s) => console.log('\n  [' + n + '] ' + s);

/* ------------------------------------------------------------ 找一个能用的 JDK */
function findJdk() {
  const cands = [
    'D:\\PyCharm 2024.3.3\\jbr',
    'D:\\Program Files\\Android\\Android Studio\\jbr',
    process.env.JAVA_HOME || ''
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'bin', 'javac.exe'))) return c;
  }
  return null;
}

/* ---------------------------------------------- 找一个能直接用的 Gradle（免下载） */
function findGradle() {
  const dists = path.join(os.homedir(), '.gradle', 'wrapper', 'dists');
  const wanted = ['gradle-8.9', 'gradle-8.7', 'gradle-9.3.0'];
  if (fs.existsSync(dists)) {
    for (const w of wanted) {
      const dir = path.join(dists, w + '-bin');
      if (!fs.existsSync(dir)) continue;
      for (const hash of fs.readdirSync(dir)) {
        const bat = path.join(dir, hash, w, 'bin', 'gradle.bat');
        if (fs.existsSync(bat)) return bat;
      }
    }
  }
  const wrapper = path.join(SHELL_DIR, 'gradlew.bat');
  return fs.existsSync(wrapper) ? wrapper : null;
}

function findSdk() {
  const cands = [
    process.env.ANDROID_HOME || '',
    process.env.ANDROID_SDK_ROOT || '',
    'D:\\project\\AndroidSdk'
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'platforms'))) return c;
  }
  return null;
}

function run(cmd, cwd, env, label) {
  line('  → ' + label);
  const r = spawnSync(cmd, { cwd, env, stdio: 'inherit', shell: true });
  return r.status === 0;
}

/* -------------------------------------------------------------------- 主流程 */
function main() {
  line('');
  line('  ╔══════════════════════════════════════════════╗');
  line('  ║   仪表版 · 打包 APK                          ║');
  line('  ╚══════════════════════════════════════════════╝');

  /* --- 环境自检 --- */
  const jdk = findJdk();
  const sdk = findSdk();
  const gradle = findGradle();

  step('1', '环境自检');
  line('      JDK     : ' + (jdk || '✘ 没找到，需要能跑 Gradle 的 JDK 17–21'));
  line('      SDK     : ' + (sdk || '✘ 没找到 Android SDK'));
  line('      Gradle  : ' + (gradle || '✘ 没找到'));

  if (!jdk || !sdk || !gradle) {
    line('\n  环境不全，先补齐再跑。');
    process.exitCode = 1;
    return;
  }

  const env = Object.assign({}, process.env, {
    JAVA_HOME: jdk,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    PATH: path.join(jdk, 'bin') + path.delimiter + (process.env.PATH || '')
  });

  /* --- 生成单文件网页 --- */
  step('2', '生成单文件网页（工具/pack.js）');
  if (!run('"' + process.execPath + '" "' + path.join(__dirname, 'pack.js') + '"',
           ROOT, env, '打包网页')) {
    line('\n  网页打包失败。');
    process.exitCode = 1;
    return;
  }

  const single = path.join(ROOT, '分享版', '鲸鲸仪表板.html');
  if (!fs.existsSync(single)) {
    line('\n  没找到单文件产物：' + single);
    process.exitCode = 1;
    return;
  }

  /* --- 塞进壳的 assets --- */
  step('3', '拷进 APK 的 assets');
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  fs.copyFileSync(single, path.join(ASSET_DIR, 'index.html'));
  line('      → ' + path.relative(ROOT, path.join(ASSET_DIR, 'index.html')) +
       '  (' + Math.round(fs.statSync(single).size / 1024) + ' KB)');

  /* --- 构建 --- */
  step('4', 'Gradle 构建（clean + 先试离线）');
  // 必须带 clean：实测增量构建会在 APK 里留下重复的本地条目，
  // 体积从 88 KB 虚胖到 146 KB。clean 之后正常。
  const gradleCmd = (g, offline) =>
    '"' + g + '" clean assembleDebug --console=plain' + (offline ? ' --offline' : '');

  let built = run(gradleCmd(gradle, true), SHELL_DIR, env, 'clean assembleDebug --offline');
  if (!built) {
    line('\n  离线构建没成功，改成联网构建（走 settings.gradle 里的阿里云镜像）…');
    built = run(gradleCmd(gradle, false), SHELL_DIR, env, 'clean assembleDebug');
  }
  if (!built) {
    line('\n  构建失败。把上面的报错发我。');
    process.exitCode = 1;
    return;
  }

  /* --- 收产物 --- */
  step('5', '收产物');
  if (!fs.existsSync(OUT_APK)) {
    line('  没找到 APK：' + OUT_APK);
    process.exitCode = 1;
    return;
  }
  fs.copyFileSync(OUT_APK, FINAL_APK);

  const size = Math.round(fs.statSync(FINAL_APK).size / 1024);
  line('');
  line('  ┌──────────────────────────────────────────────┐');
  line('  │  ✓ 打包完成                                  │');
  line('  └──────────────────────────────────────────────┘');
  line('     产物 : ' + path.relative(ROOT, FINAL_APK) + '   (' + size + ' KB)');
  line('');
  line('  装到平板：');
  line('    1) 平板打开「开发者选项 → USB 调试」，用数据线连电脑');
  line('    2) 命令行执行：');
  line('       "' + path.join(sdk, 'platform-tools', 'adb.exe') + '" install -r "' + FINAL_APK + '"');
  line('    3) 或者直接把 仪表版.apk 拷到平板里点击安装');
  line('');
}

main();
