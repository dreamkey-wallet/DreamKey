# 依赖安全检查

检查日期：2026-10-15。检查基于当前 `package-lock.json`、`npm audit` 公告与实际调用路径；这不是完整的原生平台 CVE 扫描或渗透测试。

## 已处理

- 从 BSC RPC 备用地址中移除带 API 凭证的 NodeReal 端点。客户端包和混淆后的字符串都可以被提取，付费配额凭证不能依赖客户端保密。当前内置 RPC 及市场/交易记录服务使用 HTTPS；未发现业务源码记录密码、私钥或助记词的日志。
- 已提交到历史或进入旧安装包的 RPC 配额凭证仍可能被提取，应由凭证所有者在服务商后台轮换或撤销；本轮仅移除了当前客户端引用，没有操作服务商账户。
- 使用精确 `overrides` 将 React Native CLI 的 `fast-xml-parser` 固定到 5.11.2，修复 [GHSA-gh4j-gqv2-49f6](https://github.com/advisories/GHSA-gh4j-gqv2-49f6) 的 XML 注释/CDATA 注入。CLI 实际使用 XMLParser/XMLValidator 读取本地配置；没有找到用户 DApp 数据进入 XMLBuilder 的路径。覆盖后已验证 Android Manifest、iOS scheme 和真实 CLI 自动链接配置解析。
- `node scripts/verify-dependency-security.cjs` 检查 CLI 兼容性及恶意 XML 分隔符；`npm run typecheck`、`verify-networks.cjs`、`verify-rpc.cjs`、`verify-provider.cjs`、`verify-signatures.cjs` 均通过。

## 尚待上游或整体工具链升级

当前 `npm audit --omit=dev` 仍报告传递依赖告警。React Native 将 CLI、Metro、Jest 等工具列为依赖，npm 的 prod 分类因此包含构建工具，累计条目不等于 APK 存在同样数量的可利用漏洞。根公告涉及以下四个组件；它们没有被业务代码或钱包加密模块导入。

- `braces` 3.0.3：[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)，深度嵌套 glob 模式导致栈耗尽。经 micromatch 被 Metro/CLI/Jest 使用。截至检查时 npm latest 仍为 3.0.3，未发布修复版。避免把不可信 glob 模式交给构建工具。
- `image-size` 1.2.1：[GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)、[GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)，畸形 JXL/HEIF/ICNS 使图像解析无限循环。Metro 在打包静态图像时使用它；DApp 在线图像走原生 Image/WebView，不走这个 Node 模块。安全版 2.0.4 改变导出及文件路径 API，当前 Metro 0.81.5 依赖可调用的 CommonJS 导出和路径输入，不能直接 override；需整体升级兼容 Metro 或等待兼容补丁。
- `node-forge` 1.4.0：[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)，RSA PKCS#1 v1.5 验签接受额外摘要算法元素。由 React Native 开发服务器的 selfsigned 引入，不用于钱包签名或 HTTPS 传输证书验证。截至检查时 npm latest 仍为 1.4.0，未发布修复版。
- `sprintf-js` 1.0.3：[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)，不受限的精度格式符导致拒绝服务。经 argparse/js-yaml 进入构建配置工具，不处理 DApp 签名数据。截至检查时 npm latest 1.1.3 仍在受影响范围，升级到它不能修复公告。

没有执行 `npm audit fix --force` 或跨 React Native 主版本升级。继续使用锁定依赖的 `npm ci`；框架升级需独立验证 Android/iOS 原生模块、密钥存储兼容及发布包。不要将 Metro 开发服务器直接暴露到互联网。iOS 原生构建需在 macOS/Xcode 上继续验证。
