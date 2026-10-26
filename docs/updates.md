# 整包升级与 OSS 热更新

应用需要先发布包含更新模块的新 APK/iOS App。Android 整包升级下载 APK 后交给系统安装器；OTA 下载 ZIP，校验后在下次完整启动时启用。普通应用不能静默安装 APK。

## 配置

编辑 `src/config/app-updates.ts`：

开源默认配置留空，关闭在线更新。请填写自己控制的服务地址，避免将分支用户连接到原项目的生产更新服务。

```ts
export const UPDATE_JSON_URL = 'https://updates.example.com/dreamkey.json';
export const UPDATE_DOWNLOAD_HOSTS: readonly string[] = ['your-bucket.oss-cn-shanghai.aliyuncs.com'];
```

`UPDATE_JSON_URL` 为空时关闭在线检查。下载主机必须填写精确的 HTTPS 主机名，不带协议、路径或通配符。客户端会检查 HTTPS、域名、同主机重定向、ZIP 格式、版本、路径、大小和 SHA-256；Android 还会拒绝解析到私网等保留地址。下载地址应只指向自己控制的 OSS/CDN。

APK 正式签名仍使用现有 `.p12`。OTA ZIP 不需要额外的公私钥，发布工具不会生成或读取 OTA 密钥。

## JSON 接口

接口保留这八个字段：

```json
{
  "appVersion": "1.0.6",
  "bundleVersion": 5,
  "mandatory": false,
  "description": "1.提升了用户体验\n2.优化了应用性能",
  "downloadAndroidUrlApk": "https://your-bucket.oss-cn-shanghai.aliyuncs.com/dreamkey/android/app-1.0.6.apk",
  "downloadAndroidUrlBundle": "https://your-bucket.oss-cn-shanghai.aliyuncs.com/dreamkey/android/v5/index.android.bundle.zip",
  "downloadIosUrlApk": "",
  "downloadIosUrlBundle": ""
}
```

`appVersion` 必须与目标原生包的 `versionName`/`CFBundleShortVersionString` 一致。当前版本较低时使用整包链接；版本相同且 `bundleVersion` 更高时使用 OTA 链接；版本较高时忽略服务器版本。`mandatory: true` 不提供稍后跳过按钮。链接为空则跳过对应平台更新。

导航就绪并处于前台约 2.5 秒后自动检查。整包升级会在安全页面提示；签名、创建钱包等操作结束后再提示。自动检查或 OTA 暂时失败时，分别等待 15 秒、30 秒重试，每轮最多检查 3 次；退到后台会取消待执行检查，返回前台开启新一轮。OTA 始终静默下载，不会强制重启正在使用的钱包。同一版本不会因 `mandatory: true` 重复触发整包升级。

## Android 整包升级

1. 在 `android/app/build.gradle` 提升 `versionName` 和 `versionCode`。
2. 保持包名 `com.dreamkey.wallet` 和同一正式 APK 证书，构建正式 APK。
3. 上传 APK，再更新 JSON 中的 `appVersion` 和 APK 地址。

客户端会在私有目录下载 APK，并校验包名、目标版本、递增的 `versionCode` 和已安装证书；随后打开系统安装器。Android 8+ 首次安装需要在系统设置中允许此来源安装应用。覆盖安装会保留应用数据。

APK 验证成功后以独立文件保存，状态原子提交成功后才替换旧缓存。下载在后台完成时保留安装包，返回应用后点击“安装更新”。下载中断或空间不足时可以重试，不会先删除已有的可用安装包。检查更新与下载同时发生时，下载期间保持用户已选择的目标版本，较晚返回的检查结果不会改写弹窗版本。

## Android OTA 发布

当前工程版本为 `1.0.1` 时，命令为：

```powershell
npm run update:bundle -- --platform android --app-version 1.0.1 --bundle-version 1
```

版本号必须与当前 checkout 的原生版本一致。输出文件：

```text
dist/updates/android/1.0.1/v1/index.android.bundle.zip
```

iOS 在 macOS 安装 Pods 后执行：

```bash
npm run update:bundle -- --platform ios --app-version 1.0.1 --bundle-version 1
```

构建过程使用生产 Metro 和匹配版本的 Hermes，生成 Hermes bundle 和资源，并且不生成 source map。工具会检查实际 Hermes 字节码版本。输出目录同时包含原生版本和补丁编号；同一原生版本下已有同编号 ZIP 不会覆盖。ZIP 写入完成后才原子发布到输出路径，中断或并发构建不会覆盖已有产物。

ZIP 根目录包含：

```text
manifest.json
index.android.bundle    # iOS 为 index.ios.bundle
drawable-mdpi/...
其他 Metro 资源
```

`manifest.json` 记录平台、原生版本、补丁版本、入口文件以及每个资源的 SHA-256 和字节数。工具生成标准 ZIP32 STORE，限制 ZIP 50 MiB、展开内容 150 MiB、单文件 50 MiB、最多 1000 个文件；拒绝路径越界、符号链接、重复路径、密钥库和 source map。

ZIP 上传完成后再发布 JSON，建议使用 `Cache-Control: no-cache` 或短缓存。不要把其他 App 的 bundle 直接上传。

## 启用和回退

下载、校验和解压都在应用私有临时目录完成，完整验证成功后才写入待启用版本。OTA 不会立即 reload，需要完全关闭并重新打开应用。下次启动会再次校验 manifest、版本、文件大小和 SHA-256；新版本先处于待确认状态，页面稳定运行后确认成功。若启动失败或未确认，下次启动自动回退到上一可用补丁或内置 bundle。

启动确认需要导航就绪并连续在前台运行约 5 秒；临时失败会有限重试。下载与启动确认使用独立执行路径。状态提交前中断留下的临时文件会清理，同版本可以重新下载；已确认失败的补丁不会反复安装，修复后应发布更大的 `bundleVersion`。回退通知只在实际展示后确认，“关于我们”读取版本不会提前清除通知。

整包升级会隔离旧原生版本的补丁状态，本地 `bundleVersion` 从 `0` 开始。Android 以 `versionCode` 隔离，iOS 以原生版本与 build 隔离；已下载但尚未启动的补丁不算当前运行版本。

原生代码、权限、原生依赖、RN/Hermes 版本或原生资源发生变化时，必须提升 `appVersion` 并发布新整包，不能依赖 OTA 注册新的原生模块。

八字段协议没有运行时指纹，因此不能仅修改 `versionCode`/build 而沿用 `appVersion` 发布不兼容的原生改动。即使旧补丁已按原生 build 隔离，服务器仍可能把同 `appVersion` 的旧 OTA 提供给新包。本次更新模块审计包含原生修复，完整交付需要提升原生版本并发布新整包。

## 离线验证

```bash
npm run typecheck
npm run verify:security
npm run verify:updates
```

`verify:updates` 包含发布工具、版本策略、真实 Provider 生命周期回归、Android 原生 JVM 回归，以及 iOS 接线检查。Android JVM 回归需要 JDK 17 和 Gradle 已缓存的 `org.json` JAR；也可以通过 `UPDATE_TEST_JSON_JAR` 指定该依赖。`UPDATE_TEST_REAL_ZIP` 可指定额外的真实 `appVersion=1.0.1`、`bundleVersion=2147483647` 测试 ZIP，该编号仅供验证，不能发布。

这些检查不会访问钱包、真实安装器或上传文件。Windows 的 iOS 检查会明确跳过 Objective-C++ 编译；在 macOS 上脚本会编译执行隔离的原生回归，但仍不能代替 Xcode Release 构建和真机验证。

发布前仍需使用专门的测试安装包完成设备验收：旧包启动发现新 APK、未知来源授权后安装、取消安装后重试、后台完成下载后手动安装、OTA 下次完整启动生效及资源展示、未确认启动后的回退、断网/下载中断/空间不足恢复，以及覆盖安装后补丁版本归零。确认钱包数据保留应使用测试钱包。
