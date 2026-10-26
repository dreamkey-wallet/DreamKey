# DreamKey

这是一个**独立实现**的钱包与 DApp 浏览器基础项目，不复制 MetaMask Mobile 源码、品牌或服务配置。

当前目标功能：

- 加密钱包创建/导入、助记词、可插拔安全存储和生物识别门禁
- 多账户、EVM 网络切换、原生币/ERC-20 余额
- 转账、消息/交易签名、交易状态查询
- React Native CLI DApp 浏览器
- EIP-1193 Provider、权限授权/撤销和 DApp 事件

## 目录

根目录是当前 React Native CLI 应用；`IndependentWallet/` 是早期模板副本，运行和继续开发请使用根目录工程。

- `src/core`：助记词、账户派生、网络、余额、ERC-20、交易和安全存储
- `src/provider`：EIP-1193 Provider 与权限管理
- `src/dapp`：WebView DApp 浏览器、Provider 桥接和 URL 策略
- `src/native`：React Native CLI 的 Keychain/Keystore 安全存储适配器

## 开发

```bash
npm install
npm run typecheck
```

发布包已启用 R8/资源压缩和 Hermes 字节码，正式构建必须提供自己的签名配置。将 `android/release-signing.properties.example` 复制为同目录下被 Git 忽略的 `release-signing.properties`，或使用环境变量、用户级 Gradle 属性；不要在源码中填写凭据。配置与产物检查见 [发布安全说明](docs/release-security.md)。重点安全回归使用 `npm run verify:security`。

公开源码默认关闭在线更新，邀请下载链接使用示例地址。部署配置、敏感文件检查与安全公开方式见 [开源配置说明](docs/open-source.md)。

内置网络使用多个独立运营方的 RPC，并通过 Chainlist 候选目录、链与区块健康检查、本地缓存和故障冷却维护可用节点。广播超时后先查询原交易哈希。配置与验证说明见 [RPC 节点与故障恢复](docs/rpc-resilience.md)。

### Windows Android 环境

React Native 0.76 的 Android 工程使用 Gradle 8.10.2，运行 Gradle 时请使用 JDK 17。JDK 27 会触发 `Unsupported class file major version 71`；请确认 Android Studio 的 Gradle JDK 也指向 JDK 17（某些 Android Studio 版本自带的 JBR 可能是更高版本，不能替代 JDK 17）。

在 PowerShell 中配置当前终端（路径按本机安装位置调整）：

```powershell
$jdk = Get-ChildItem "C:\Program Files\Eclipse Adoptium" -Directory -Filter "jdk-17*" | Select-Object -First 1
$env:JAVA_HOME = $jdk.FullName
$env:ANDROID_HOME = "C:\Users\<user>\AppData\Local\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
java -version       # 应显示 17.x
npm run android
```

也可以在 Windows 的用户环境变量中永久设置 `JAVA_HOME`、`ANDROID_HOME` 和 `ANDROID_SDK_ROOT`，然后重新打开终端或 IDE。不要把本机绝对路径写入仓库的 `gradle.properties`。如果项目目录中存在 `android/local.properties`，该文件只用于本机 SDK 路径，不应提交到版本库。

React Native CLI 项目由宿主应用安装并链接 `react-native-webview`，以及安全存储/生物识别原生模块（例如 `react-native-keychain`）。核心层只依赖 `VaultStorage` 和 `BiometricAuthenticator` 接口，因此可以替换为应用自己的 Android Keystore / iOS Keychain 原生实现，不依赖 Expo。iOS 构建需要 macOS/Xcode；Android 可在 Windows 上构建。

## React Native CLI 接入

仓库现在包含可直接打开的 React Native CLI 原生工程：

- `android/`：Android Studio/Gradle 工程，包名 `com.dreamkey.wallet`。
- `ios/`：Xcode/CocoaPods 工程，Bundle ID `com.dreamkey.wallet`。
- 入口组件注册名仍是 `IndependentWallet`，应用显示名称为 `DreamKey`。

应用标识已从 `com.example.independentwallet` 改为 `com.dreamkey.wallet`。新包在系统中作为独立应用安装，不能直接覆盖旧包或自动读取其钱包数据；替换旧安装前请先确认钱包备份可恢复。

首次安装原生依赖后运行：

```bash
npm install
npx react-native start
# 另开终端
npx react-native run-android
# iOS 需要 macOS/Xcode：
cd ios && bundle exec pod install && cd ..
npx react-native run-ios
```

`react-native-webview`、`react-native-keychain`、`react-native-get-random-values`、`react-native-screens`、`react-native-safe-area-context`、`react-native-svg` 和 `@react-native-clipboard/clipboard` 通过 React Native CLI 自动链接。二维码使用 `react-native-qrcode-svg`；界面图标使用固定打包的 Iconify Phosphor Duotone 图标，网络和币种使用原色 Cryptocurrency/Web3 Icons，来源和许可证见 [docs/icon-attribution.md](docs/icon-attribution.md)。Android 的 `settings.gradle` 使用 Gradle plugin 的 `autolinkLibrariesFromCommand()`，iOS 的 `Podfile` 使用 `use_native_modules!`；不要手动复制这些模块的原生源码。Android 可在 Windows 上构建，iOS 构建需要 macOS/Xcode。

根目录 `App.tsx` 已接入创建/导入/生物识别解锁、账户与网络切换、原生币/ERC-20 资产管理、币种选择与转账确认、二维码接收页、DApp 浏览器，以及 DApp 的账户授权和签名/交易确认页面。账户数量和导入代币列表均在本地持久化。`react-native-screens` 固定为与 React Native 0.76 codegen 兼容的版本；`metro.config.js` 将 NodeNext 风格的 `.js` TypeScript 导入映射到 `.ts/.tsx` 源文件。

```tsx
import { useRef } from "react";
import { DappBrowser, WalletCore, createWalletProvider,
  ReactNativeKeychainVaultStorage } from "./src/index";

const storage = new ReactNativeKeychainVaultStorage("wallet.vault");
const wallet = WalletCore.create({
  storage,
  // BSC is the default; all five built-in mainnets are available in the picker.
  networks: [
    {
      id: "bsc-mainnet",
      chainId: 56,
      name: "BSC",
      nativeSymbol: "BNB",
      rpcUrl: "https://bsc-rpc.publicnode.com",
      rpcFallbackUrls: ["https://bsc-dataseed1.bnbchain.org"],
      explorerUrl: "https://bscscan.com",
    },
    {
      id: "ethereum-mainnet",
      chainId: 1,
      name: "Ethereum",
      nativeSymbol: "ETH",
      rpcUrl: "https://ethereum-rpc.publicnode.com",
      rpcFallbackUrls: ["https://eth.drpc.org", "https://mainnet.gateway.tenderly.co"],
      explorerUrl: "https://etherscan.io",
    },
    {
      id: "arbitrum-one", chainId: 42161, name: "Arbitrum One", nativeSymbol: "ETH",
      rpcUrl: "https://arbitrum.drpc.org",
      rpcFallbackUrls: ["https://arbitrum-one-rpc.publicnode.com"],
      explorerUrl: "https://arbiscan.io",
    },
    {
      id: "polygon-mainnet", chainId: 137, name: "Polygon", nativeSymbol: "POL",
      rpcUrl: "https://polygon.drpc.org",
      rpcFallbackUrls: ["https://polygon-bor-rpc.publicnode.com"],
      explorerUrl: "https://polygonscan.com",
    },
    {
      id: "base-mainnet", chainId: 8453, name: "Base", nativeSymbol: "ETH",
      rpcUrl: "https://base-rpc.publicnode.com",
      rpcFallbackUrls: ["https://base.drpc.org", "https://mainnet.base.org"],
      explorerUrl: "https://basescan.org",
    },
  ],
});

const provider = createWalletProvider(wallet, "bsc-mainnet", {
  // 这里必须显示你自己的账户/签名确认 UI。
  approve: ({ origin, method }) => confirmRequest(origin, method),
  requestAccounts: (origin) => requestAccountPermission(origin),
});

export function DappScreen() {
  const browserRef = useRef(null);
  return (
    <DappBrowser
      ref={browserRef}
      initialUrl="https://your-dapp.example"
      allowedHosts={["your-dapp.example", "*.your-dapp.example"]}
      onProviderRequest={(request, context) =>
        provider.forOrigin(context.origin).request(request)
      }
    />
  );
}
```

`WalletCore.create` 会生成新的助记词；导入已有钱包可使用 `WalletCore.fromMnemonic` 或 `WalletCore.fromPrivateKey`。私钥钱包包含一个账户，不能派生更多账户。应用启动时不要把助记词或私钥放入 Redux、AsyncStorage、日志或崩溃报告。将 `WalletVault.lock()` 与应用切后台/超时策略连接起来，解锁时由 Keychain/Keystore 的用户验证弹窗保护。原生安全存储继续兼容早期直接保存的助记词，同时新钱包使用版本化钱包密钥封装。

`createWalletProvider` 已将 `personal_sign`、`eth_signTypedData_v4` 和 `eth_sendTransaction` 路由到本地派生账户，但不会替应用决定是否允许请求。生产 UI 必须展示 DApp origin、链、收款地址、金额、合约 calldata 和 gas，再由用户确认。

签名确认页按方法读取消息参数：`personal_sign` 使用第一个参数，`eth_sign` 和结构化签名使用第二个参数。可读的 UTF-8 十六进制消息解码为完整文本，原始数据可展开核对；二进制消息保留十六进制。EIP-712 请求分区展示域、主类型、消息正文和可展开的数据结构，解析失败时禁用签名。预览与签名共用消息解析逻辑，显示解码不会改变实际签名的字节。

内置 DApp 浏览器会在 WebView 中注入 EIP-1193、常见旧版 `window.web3.currentProvider` 和 EIP-6963 Provider 发现接口，因此 Uniswap 等网页可在应用内发现并连接本钱包。`isMetaMask` 仅作为网页兼容标记，应用没有引入 MetaMask SDK、`io.metamask` 包名或品牌资源。这个注入层不会改变系统 Chrome/Safari；如果要让系统浏览器直接发现钱包，需要另行实现浏览器扩展或 WalletConnect/深链适配。

网页后退、前进和刷新位于浏览器底部导航栏，关闭按钮位于顶部网址左侧。后退/前进根据 WebView 的真实历史状态启用，输入新网址会保留当前浏览器历史；关闭返回 DApp 中转页。Android 系统返回键优先后退网页，无历史时返回中转页。访问失败显示友好提示并保留网页历史，刷新或后退可继续操作。

## 服务配置

设置中的「邀请好友」提供下载二维码、复制链接、分享链接和完整海报图片。统一下载地址配置在 `src/config/app-links.ts` 的 `APP_DOWNLOAD_URL`；目前使用演示地址 `https://example.com/dreamkey/download`，替换为正式下载页面后，二维码和分享文案会同步更新。海报不包含钱包账户或密钥信息。图片分享使用系统面板，新增原生模块后需要重新编译安装；不需要相册或存储权限。

资产页面会按当前网络和当前账户的原生币及已导入 ERC-20 资产显示 USD 单价、持仓估值和总额，不合并其他网络。报价先查询 DefiLlama 的链/合约报价及已核验的 CoinGecko 币种 ID，优先采用较新的有效行情；内置常用币仍缺少新报价时，批量查询 CoinGecko 公开接口补充。币种 ID 按网络和合约地址固定匹配，桥接币和包装币使用各自身份，不按简称匹配，也不把稳定币价格固定成 $1。报价请求不上传钱包地址、助记词或私钥。

页面可见时每分钟刷新报价，App 从后台恢复时立即强制刷新；首页、资产管理、币种详情和发送币种选择弹窗均支持下拉刷新。新鲜度按接口的真实行情时间戳判断，超过 5 分钟的报价标记为缓存估值（≈）；暂时请求失败可使用最近报价，但超过 15 分钟即不再使用。没有有效报价时显示“无报价/No price”，余额未知时不会当作 0；总额缺少报价或余额时明确显示为部分估值。USD 金额仅供展示，不影响链上转账。只读报价检查和来源说明见 [docs/asset-prices.md](docs/asset-prices.md)。

RPC 由应用传入 `NetworkConfig.rpcUrl`，可以使用自建节点、第三方 RPC 或本地节点。项目不内置 Infura、Firebase、MetaMask 后端或任何 MetaMask 品牌配置。

BSC 默认 RPC 为 `https://bsc-rpc.publicnode.com`，备用为 `https://bsc-dataseed1.bnbchain.org`，均无需在客户端保存 API 凭证。这两个端点列于 [BSC 主网网络配置](https://github.com/ethereum-lists/chains/blob/master/_data/chains/eip155-56.json)，链 ID 均为 56。钱包余额、转账和 DApp Provider 共用已校验的端点选择。只读查询遇到慢响应时会尝试备用节点，交易广播不会自动重复发送。

ETH 默认 RPC 为 `https://ethereum-rpc.publicnode.com`，备用为 `https://eth.drpc.org` 和 `https://mainnet.gateway.tenderly.co`。三个端点列于 [Ethereum 主网网络配置](https://github.com/ethereum-lists/chains/blob/master/_data/chains/eip155-1.json)，不需要 API Key。原 Cloudflare 端点在链 ID 查询正常时仍可能拒绝余额、区块和 Gas 请求，已从默认配置移除。备用选择同时覆盖慢响应及明确的临时服务错误，合约执行失败保留原始错误，交易广播仍只发送一次。

内置网络配置在 `src/core/networks.ts`，默认 BSC，其余包括 Ethereum、Arbitrum One（42161 / ETH）、Polygon PoS（137 / POL）和 Base（8453 / ETH）。新网络 RPC 均验证链 ID、余额、区块、Gas、费用预估及 ERC-20 查询，不需要 API Key。代币列表和交易记录按链 ID 隔离；DApp 的 `wallet_switchEthereumChain` 支持切换到所有内置链，网站不能替换这些链的 RPC。网络参数来源：[Arbitrum](https://docs.arbitrum.io/chain-info)、[Polygon](https://docs.polygon.technology/pos/reference/rpc-endpoints)、[Base](https://docs.base.org/get-started/connect-to-base)。

`src/core/common-tokens.ts` 提供精简的默认币种，首页、管理资产和发送币种选择共用这份目录：BSC 显示 BNB/USDT，Ethereum 显示 ETH/USDT/USDC，Arbitrum 显示 ETH/USDC，Polygon 显示 POL/USDC，Base 显示 ETH/USDC。原生币排在首位。完整的 35 个已核验 ERC-20 合约仍可通过地址导入，包含 BSC USDC、DAI、桥接 USDC.e、USDbC、UNI、CAKE 等可选资产；已手动导入的 BSC USDC 继续保留。BSC Binance-Peg 代币、桥接 USDC 和发行商原生 USDC 保持各自合约、名称与精度；Base 不预设未经核验的 USDT 合约。完整合约和资料来源见 [docs/common-tokens.md](docs/common-tokens.md)。移除内置币会持久隐藏，再次导入同一合约可恢复；旧版导入列表继续保留。未加载完成的其他币种不阻塞已有可用余额的币种进行发送，确认前仍重新查询币种余额和网络费用。

Base 发送确认通过网络的 GasPriceOracle 查询 L1 数据费用及运营费用，包含在费用预估和余额校验中。使用未签名交易字段查询、为费用预算保留余量，无法读取额外费用时停止确认并提示重试；预算是当前估算，不是协议强制的总费用上限。Arbitrum 的 RPC Gas 估算已包含 L1 发布成本对应的 Gas 部分。实际费用以交易回执为准。

只读请求超过 800ms 会尝试下一备用节点，单次节点请求最多等待 8 秒；成功响应的节点优先用于后续请求。每个端点使用前会验证链 ID，交易广播前重新验证。BNB/ETH 余额独立更新，不等待慢代币；同页面重复刷新会合并。账户地址只缓存公开元数据。BIP-39 种子只在钱包解锁期间保留于 vault 内存，锁定或清除时覆写并释放，不写入存储；每次签名仍独立派生临时 signer，避免重复计算助记词种子造成等待。

导入和签名确认会先显示加载状态再执行本地计算，并阻止重复点击。导入一个账户时复用刚派生的账户信息；助记词和私钥导入均有处理中提示，验证或保存失败后可重新尝试。消息签名在本机完成，交易提交及 DApp 后续登录请求仍受各自网络响应时间影响。

## 安全边界

Android 应用内 APK 升级、OSS ZIP 热更新与发布命令见 [docs/updates.md](docs/updates.md)。首次接入需重新构建原生包；在线更新地址与下载主机按配置启用。

这是可运行的工程骨架，不是经过审计的生产钱包。发布前必须补充硬件钱包、钓鱼 URL 数据源、交易模拟/风险提示、密钥备份恢复演练、日志脱敏、依赖许可证审计和独立安全审计。

## 当前页面流程

- 钱包首页：网络/账户切换、当前网络全部已添加资产的 USD 总估值、发送/接收、原生币与导入代币列表；每项显示 USD 单价、持仓估值及币种数量，缺少报价或余额时提示部分估值。底部只保留一个 DApp 入口。
- 币种详情：点击首页或管理资产中的币种，查看余额和该币种的转入/转出、合约交互及确认状态；记录分页加载，点击进入交易详情，底部固定发送/接收。发送自动选择该币种，接收显示同一网络的账户地址二维码。
- 币种图标：BNB、ETH、POL、USDT、USDC、USDC.e、DAI、WETH、WBNB、WBTC、BTCB、UNI、LINK、CAKE 使用本地原色图标；代币以网络及合约地址匹配，USDC.e 标注桥接标志，未知合约使用中性图标。
- DApp 中转页：手动输入 HTTPS 网址、收藏卡片、最近访问及清除记录；不自动打开任何第三方站点。网页内支持后退、前进、刷新与独立退出。
- 发送：选择币种 → 输入地址/数量 → 查询余额与估算 Gas → 核对网络/完整地址/代币合约/费用上限 → 确认提交 → 交易状态。
- 接收：完整地址二维码、账户/网络切换、复制与系统分享。二维码编码 EVM 地址，网络另行标注。
- 管理资产：默认包含各网络常用代币，也可用当前网络的 ERC-20 合约地址导入其他币种，链上读取名称、符号、精度，按链保存；移除代币只移除或隐藏本地列表。

交易记录通过公开地址查询 BscTrace（BSC）和 Blockscout（Ethereum、Arbitrum、Polygon、Base）的公开索引接口，不需要 API Key，不上传助记词或私钥。余额和交易执行仍使用已校验的 RPC。本机提交的交易按网络及账户保存，确认状态可以在重启后继续更新。BscTrace 当前最多返回最近 500 条账户记录，ERC-20 查询按真实合约筛选；遇到索引失败时仅显示本地记录或最近 2048 个区块的 ERC-20 日志，页面会提示查询范围或错误，并提供区块浏览器入口。新增三条链的 Blockscout 接口在当前电脑返回 HTTP 403，配置使用官网公布的 API 域名并明确降级，不将不可用结果展示为空白完整历史。

新增原生模块后必须重新构建应用，热刷新无法注册新的原生模块。已有 Metro 若在依赖安装期间启动，可重新运行 `npm start -- --reset-cache`。iOS 在 macOS 上先运行 `cd ios && pod install && cd ..`。

离线验证（不访问用户密钥、不广播交易）：

```bash
npm run typecheck
node scripts/verify-provider.cjs
node scripts/verify-transfer.cjs
node scripts/verify-send-readiness.cjs
node scripts/verify-import.cjs
node scripts/verify-rpc.cjs
node scripts/verify-assets.cjs
node scripts/verify-core-latency.cjs
node scripts/verify-history.cjs
node scripts/verify-history-hook.cjs
node scripts/verify-networks.cjs
node scripts/verify-common-tokens.cjs
node scripts/verify-dapp-browser.cjs
node scripts/verify-network-fees.cjs
node scripts/verify-prices.cjs
node scripts/verify-prices-hook.cjs
node scripts/verify-prices-live.cjs
```
