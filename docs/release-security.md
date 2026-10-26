# 发布混淆与安全检查

检查日期：2026-10-15。范围为根目录当前应用；`IndependentWallet/` 是旧模板，不参与本次构建。检查包含源码、公开模拟数据回归、Android Release 构建与产物检查；不等同于独立渗透测试或所有原生依赖的 CVE 审计。

## 发布保护

- Android Release 开启 R8 优化、重命名和资源压缩；React Native 桥和反射入口保留必要名称。
- JavaScript 经 Metro 压缩，再编译为优化 Hermes 字节码，去除函数名和调试信息。移除仓库中四份预生成明文 bundle，每次从当前源码生成。源码映射及 R8 mapping 保存在本机构建目录，不进入 APK。
- Release 显式关闭调试、JNI 调试、系统备份和明文 HTTP。移除 Camera Kit 带入但扫码不使用的共享存储权限。
- Android 12+ 通过 `dataExtractionRules` 排除云备份和设备迁移中的应用数据，旧版同时关闭完整备份。扫码相机声明为可选硬件。
- Release Activity 和 React Native Modal 的独立窗口启用 `FLAG_SECURE`，阻止系统截图/录屏和任务快照。Debug 保留开发调试能力。
- iOS 显式启用 Hermes；Release 压缩、编译字节码并移除函数名/调试信息，开启原生符号裁剪；失去活动状态时使用独立遮罩窗口保护任务快照。iOS 无法通过公开 API 全面禁止用户截图。

这些措施提高逆向成本。Hermes 字节码仍可分析，客户端字符串仍可提取；没有加入内置固定解密密钥的“代码加密”。钱包秘密依赖系统 Keychain/Keystore 加密，不依赖代码混淆保密。

## 正式签名

Release 已移除默认 `debug.keystore` 签名回退，缺少正式配置会直接失败。将 `android/release-signing.properties.example` 复制为 `android/release-signing.properties`，填写自己的四项配置：

```properties
WALLET_RELEASE_STORE_FILE=D:/wallet-signing/your-release.p12
WALLET_RELEASE_STORE_PASSWORD=your-store-password
WALLET_RELEASE_KEY_ALIAS=your-key-alias
WALLET_RELEASE_KEY_PASSWORD=your-key-password
```

本地文件使用 UTF-8 和 Java Properties 格式，不需要引号；Windows 路径使用 `/`，值中的反斜杠写为 `\\`，换行写为 `\n`，开头的空格写为 `\ `。相对路径从 `android/app` 解析，例如 `your-release.p12`。本地配置与正式签名文件已被 Git 忽略，不要强制提交。也可以通过 CI secret、本机环境变量或同名 Gradle 属性提供配置：

- `WALLET_RELEASE_STORE_FILE`：外部正式 keystore 的绝对路径。
- `WALLET_RELEASE_STORE_PASSWORD`：keystore 密码。
- `WALLET_RELEASE_KEY_ALIAS`：正式签名别名。
- `WALLET_RELEASE_KEY_PASSWORD`：签名密钥密码。

读取优先级为环境变量 > 同名 Gradle 属性（例如用户级 Gradle 配置）> 被忽略的本地配置。缺少配置时不会自动使用调试签名。构建会拒绝项目默认 debug.keystore 和 Android Debug 证书。正式密钥应独立备份，并保持后续更新的签名身份一致。

配置后使用 `npm run android:release` 或 `npm run android:bundle`。仅供审查的未签名构建：

```powershell
cd android
.\gradlew.bat :app:assembleRelease :app:bundleRelease -PwalletUnsignedRelease=true '-PreactNativeArchitectures=armeabi-v7a,arm64-v8a'
```

本次提供的 `dist/security-review/DreamKey-release-unsigned.apk` 和 `.aab` 为未签名审查产物，不能直接安装或作为已签名正式包发布。

APK 检查：

```powershell
.\scripts\verify-release-apk.ps1 -Apk .\dist\security-review\DreamKey-release-unsigned.apk -AllowUnsigned
```

检查正式 APK 时省略 `-AllowUnsigned`，签名缺失或默认调试证书会失败。脚本验证 Hermes 头、bundle 唯一性、源码/映射/凭证标记、调试/备份/HTTP/存储权限。

Google Play AAB 会自动携带 `BUNDLE-METADATA` 中的 R8 mapping 和部分原生符号，用于商店反混淆；这些元数据不会下发到安装 APK。AAB、mapping、源码映射及 dSYM 应作为私有发布资料保存，公开下载提供已签名 APK。

## 本次确认并修复的问题

- **高：首次密码设置可接管生物识别钱包。** 原来已有钱包但没有密码时，可从已解锁 App 直接添加密码，再通过导出验证。现在必须先通过已有生物身份验证，首次安装不受影响。
- **高：后台继续保留可签名会话。** 现在进入真正后台立即失效会话，清除所有受控钱包、创建/导入草稿和恢复中的临时密钥，拒绝待批准请求并卸载秘密页面。迟到认证/存储回调无法重新打开旧会话。生物弹窗产生的 `inactive` 保留当前验证流程。
- **高：Android iframe 可伪装成已授权主站。** 原生钱包桥现在强制 `isMainFrame`、HTTPS 来源与当前主页面一致；不支持安全消息接口的旧 WebView 停用钱包桥并提示更新。iOS 消息也核对发送框架和主页面来源。
- **高：默认批准和远程签名回退。** 缺少批准回调、账户授权或本地 signer 时拒绝请求；远程节点签名、管理方法和未知 RPC 不再直通，只保留明确的只读 RPC。
- **高：确认与实际签署不一致。** 校正 JSON-RPC `gas` 到 ethers `gasLimit`，拒绝隐藏/冲突/不支持的交易字段，限制交易及 EIP-712 链；批准后复查链、连接和账户权限。批准和签署共用分离、深冻结的参数快照，防止等待时更改金额、调用数据或结构化消息。
- **高：合约操作缺少可审查内容。** 交易确认展示完整地址、网络、金额单位、费用参数和全部 calldata；识别常用 `approve`、`transfer`、`setApprovalForAll`，标明无限授权和未知操作。选择器识别不代表合约身份已核验。
- **中：敏感屏幕和复制残留。** Android Release 保护 Activity/Modal；iOS 添加失活遮罩。复制导出秘密后 30 秒、关闭或卸载弹窗时，先确认剪贴板仍是本次秘密再清除。
- **中：观察钱包切换仍留下旧受控钱包备份。** 切到观察钱包或删除钱包后同步清理/更新 legacy 单钱包副本。
- **中：公开 Vault 无认证配置仍能解锁。** 现在缺少认证适配器时拒绝，持久化失败仍清除内存解锁状态。
- **中：未连接站点可切换全局链。** 切链现在要求当前来源仍有有效账户授权。已连接站点的切链仍不另弹确认，但在批准期间改变网络会取消签署。
- 已配置钱包密码时，解锁及删除/导出验证继续优先生物识别；失败、取消或原生异常后自动切换密码输入，仍须正确密码才能继续。生物能力查询异常时也保留密码入口；未配置密码的旧钱包不会因此获得密码验证权限。
- 移除 RPC 内嵌配额凭证；修补 CLI XML 解析依赖，详见 [依赖安全检查](dependency-security.md)。

## 尚存限制与后续加固

- **钱包密码目前是应用认证门禁，不参与钱包秘密加密。** Keychain/Keystore 提供落盘加密，但获得同进程执行能力或 root/越狱控制的人可能绕过 JS 门禁读取秘密。下一阶段应设计密码派生密钥的 AEAD 钱包封装、由生物认证保护的密钥包装、原子迁移和恢复测试；本轮没有冒险改写已有钱包存储格式。
- JS 字符串/ethers signer 不能保证逐字节清零，正在进行的底层签署/广播也无法因切后台撤回；回归验证覆盖清除引用、可变种子擦除和后续会话拒绝。
- 密码允许至少 6 字符，目前没有持久化错误尝试限速；OS 加密保护无法替代强密码和认证限速设计。
- URL 检查拦截明显私网地址、危险 scheme、文件访问和过大消息；不覆盖 DNS 重绑定、网页子资源的私网连接，不能作为完整网络沙箱。
- 余额/费用和交易记录依赖已配置 RPC；合约方法识别没有代币/NFT 可信身份和交易模拟，不能保证用户主动批准的恶意授权安全。
- 剪贴板在自动清理前仍可能被系统历史或其他应用读取，复制时应由用户承担可见的敏感信息操作。
- 旧单钱包与新集合并行持久化还存在崩溃时的非事务边界，后续宜迁移为单一原子加密集合。原生生物验证的实际强度受设备能力影响，并允许系统设备凭据作为配置中的回退。
- 剩余 npm 工具链告警、兼容性限制见 [依赖安全检查](dependency-security.md)。iOS 编译、真机生物识别、遮罩和签名仍需在 macOS/Xcode 验证。

## 验证记录

当前 Android 包名和 iOS Bundle ID 已改为 `com.dreamkey.wallet`，iOS 测试目标为 `com.dreamkey.wallet.tests`。新包与旧 `com.example.independentwallet` 安装的数据隔离，不能直接覆盖升级或自动迁移钱包。

### 包名迁移验证

- Android 原生代码目录和包声明已同步迁移；Debug/Release APK、Release AAB、`lintDebug` 和 `lintRelease` 构建通过。Lint 分别为 0 errors / 33 warnings、0 errors / 32 warnings。
- Release APK 静态检查通过；实际包名为 `com.dreamkey.wallet`，入口为 `com.dreamkey.wallet.MainActivity`，分享和其他 Provider authority 均使用新包名前缀。未签名 APK/AAB 审查产物已更新。
- TypeScript 及密码、邀请分享、DApp 浏览器、依赖安全四项离线回归通过。Windows 环境未执行 iOS Xcode 构建；未安装新包或进行新包运行验证。

### 迁移前安全检查

以下安全检查和隔离 QA 运行记录形成于本次包名迁移之前，不作为新包名的运行验证。

- TypeScript 通过；19 项认证、会话、密码、钱包管理、创建/导入、签名、Provider、浏览器、依赖、RPC、邀请分享针对性脚本通过。新增 `npm run verify:security` 可运行重点回归。
- Android `assembleRelease`、`bundleRelease` 通过，R8 mapping 确认应用内部类已重命名。缺少正式签名时验证失败符合预期。
- 后续构建检查：修正 Gradle 异常类的编辑器解析和 X.509 证书静态类型，保留签名门禁；缺签名及复制到外部路径的默认调试证书均被拒绝。Debug/Release 构建、`lintDebug`、`lintRelease` 通过，Lint 分别为 0 errors / 33 warnings、0 errors / 32 warnings；剩余提示涉及依赖版本、图标和第三方资源。
- 30 项离线回归、32 个 CJS 脚本语法、Babel/Metro 与 JSON 配置及 iOS 打包脚本语法通过；两个过时测试已同步顺序命名及组件依赖模拟，没有放宽产品行为断言。iOS 仍未实际编译。
- APK 静态检查通过；实际应用包内仅一份 Hermes bundle，无 `.map` 或 TypeScript 源码；备份、HTTP、调试关闭且无共享存储权限。
- Android x86_64 模拟器另装独立包名的 R8 Release，使用公开样例完成导入、导出密码验证及最终秘密弹窗验证，未发现本轮流程的 JS/native fatal。稳定显示后 `dumpsys window` 确认 Activity 和 Modal 独立窗口均含 `SECURE`；ADB 截图的弹窗区域抽样 3445 个像素全黑。秘密弹窗期间切后台再返回会强制解锁并卸载秘密页面。
- 上述运行测试使用临时 QA 签名和独立应用数据，未覆盖原有安装。正式 ARM 产物已构建、静态检查，但当前模拟器没有可用的 ARM Hermes 运行环境，因此 ARM 真机运行及 iOS 构建仍需后续验证。
- 测试全部使用公开模拟数据；未读取或导出已有用户钱包秘密，未广播真实交易。
