# React Native CLI 原生适配

安装：

```sh
npm install react-native-keychain react-native-get-random-values
cd ios && pod install
```

在应用入口最早导入：

```ts
import "react-native-get-random-values";
```

`ReactNativeKeychainVaultStorage` 和 `ReactNativeWalletManagerStorage` 使用 iOS Keychain / Android Keystore 保存钱包秘密。Android 根据设备能力选择硬件保护或 Keystore 软件保护。`hasWallet()` 只检查记录是否存在，不读取密钥。

`ReactNativeWalletPasswordVerifier` 保存随机盐和 PBKDF2 校验值，不保存明文密码。`isConfigured()` 表示钱包密码是否启用；`isBiometricEnabled()` 是独立偏好，两者可以共存。需要密码时先调用 `verify()`，生物识别则先调用 `ReactNativeKeychainBiometricAuthenticator.authenticate()`，成功后才加载钱包集合。没有可用生物识别且没有钱包密码的新用户，会先进入密码设置页。

生物识别使用独立的 Keychain 认证项，配置 `BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE`；无可用生物识别时认证直接失败。钱包存储项本身不再次弹出认证，让用户可以选择密码或生物识别。`storage.load()` 和 `WalletManager.restore()` 必须放在认证成功后执行。旧版带生物识别访问策略的钱包项，在首次成功解锁后重新保存；迁移前系统仍可能要求一次原有认证。

钱包切入真正的后台时会立即清除所有已加载钱包和创建草稿中的密钥，拒绝待批准的 DApp 请求，并重建导航来卸载导出弹窗和敏感输入。Android 由 `DreamKeyAppVisibility` 监听主 Activity 的 `onStop` / `onResume`；RN 的 `AppState` 在 `onPause` 就报告 `background`，因此新安装包不以该事件判断 Android 是否真正不可见。相机权限、生物识别或分享选择面板仅覆盖仍可见的 Activity 时不锁定；按 Home、锁屏、切换到分享目标应用、系统设置或安装界面使 Activity 停止时立即锁定，不设置任何短暂豁免。iOS 和未包含此原生模块的旧 Android 安装包保留 `AppState` 的后台锁定逻辑，`inactive` 不会中断验证。订阅时读取原生初始状态并按递增编号处理后续状态，避免迟到快照覆盖已发生的后台事件。会话编号确保迟到的密码/生物认证以及集合持久化结果不能恢复旧会话。已有钱包首次启用钱包密码，也必须先通过现有生物认证。

扫码弹窗只在可见且相机权限已授予后挂载原生 Camera。每次打开先检查权限，复用尚未结束的系统授权请求；隐藏、关闭或重新打开后，旧扫描会话的授权结果和扫码事件均会被忽略。新增 `DreamKeyAppVisibility` 原生模块后需要重新编译安装应用，单独 OTA 更新无法加入该模块。

导出的私钥或助记词复制后 30 秒、弹窗关闭或页面卸载时会尝试清空剪贴板；只在剪贴板仍是本次秘密时清空，保留用户后来复制的其他内容。操作系统剪贴板历史、已经读取的其他应用以及 JavaScript 引擎的不可变字符串副本不受此机制控制。

应用密码用于认证门禁，不是钱包秘密的独立加密密钥。静态秘密由 iOS Keychain / Android Keystore 加密；在已取得同进程代码执行、root/越狱或系统密钥访问能力的威胁模型下，不能依赖应用层门禁保护钱包。后续如需提高该边界，应设计由密码派生密钥加密的钱包封装，并为生物识别单独保存硬件保护的解密密钥，包含现有钱包安全迁移与恢复方案。

`shareInviteImage()` 接收 `react-native-svg` 的 PNG `toDataURL()` 结果和包含下载链接的分享文案，再打开系统分享面板。Android 将图片写入独立的临时缓存目录，经未导出的 `FileProvider` 提供一次分享所需的只读 URI 权限，下次分享时清理超过 24 小时的旧缓存；iOS 直接将图片与文案交给 `UIActivityViewController`，支持 iPad。此功能不访问相册，也不需要存储权限；新增原生模块后需要重新编译安装应用。Android 只确认面板成功打开，取消不会当作已发送；iOS 取消正常返回。
