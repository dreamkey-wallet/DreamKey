# 开源配置与发布

公开版本使用 `codex/open-source` 分支。该分支从完成脱敏的源码快照建立独立历史，不继承原项目提交。原 `main`、其他引用和本地 Git 对象仍保留历史配置与个人提交信息，不能随公开版本上传。

## 配置自己的服务

- 正式 Android 签名：复制 `android/release-signing.properties.example` 为同目录的 `release-signing.properties`，填写自己的签名配置。也可以通过环境变量、用户级 Gradle 属性或 CI secrets 提供，详见 [发布安全说明](release-security.md)。
- 在线更新：`src/config/app-updates.ts` 默认留空，配置自己控制的 HTTPS 更新 JSON 和下载主机后启用。使用自己的签名证书发布 APK，详见 [更新说明](updates.md)。
- 邀请下载：修改 `src/config/app-links.ts` 的示例下载链接。
- 热门 DApp：公开分支移除了自有业务站点及其图标，保留公共项目入口；可在 `src/ui/dapp/popular-dapps.ts` 配置自己的列表。
- RPC：默认目录和节点使用公开服务。若改为需要 Key 的服务，应自行设计访问控制；打包进客户端的 API Key 可以被提取。
- 发布自己的应用时，配置自己的包名、应用标识、版本和商店信息。

正式密钥库、密码、签名配置、环境文件、钱包数据、日志、构建产物、source map 和本地 QA 截图不属于公开源码。`.gitignore` 已排除常见敏感文件及 `.bundle/`，但它不能阻止强制添加，也不能清除旧提交。不要把包含 `.git`、本地签名文件或运行数据的整个工作目录压缩上传。

默认 `debug.keystore` 是公开的开发测试密钥，仅用于 Debug；不要用于正式发布。测试脚本中的助记词、私钥、地址和虚构凭据属于公开测试样例，不能用于接收或存储真实资产。

## 仅公开干净分支

发布前确认 `git log codex/open-source` 只包含整理后的公开提交，且公开分支不再连接旧项目历史。为了隔离旧引用，可以从该分支创建独立工作副本：

```powershell
git clone --no-local --single-branch --no-tags --branch codex/open-source . ../wallet-public
cd ../wallet-public
git remote remove origin
git remote add public https://example.invalid/your-account/your-public-repository.git
git push public HEAD:main
```

将示例地址替换为自己的新公开仓库。上述推送需要由维护者在最终检查后执行；准备开源分支不会自动发布。

不要使用 `git push --all`、`git push --mirror` 或推送原项目 tags；不要直接将包含旧历史的原远程仓库改为公开。原仓库的 `main`、远程和本地签名资料用于继续私有开发，保持独立保存。

如果真实凭证曾出现在旧提交中，删除当前文件不等于撤销凭证。公开前应更换可轮换的密码和服务凭证；Android 正式签名身份关系到已有用户的覆盖升级，应保管好原密钥并根据分发平台支持的流程处理，不要直接替换签名导致无法升级。

## 许可证与品牌资源

项目代码沿用 `package.json` 声明的 MIT License，完整文本见根目录 `LICENSE`。第三方依赖、图标和品牌素材仍遵循各自许可证及权利声明，MIT 不额外授予第三方商标权。

保留 `src/ui/icons/LICENSE.*`、[图标来源说明](icon-attribution.md) 和 `src/ui/dapp/logos/README.md`。DApp 图标、代币图标和 DreamKey 品牌资源应按对应权利范围使用，不能将全部图片素材一并声明为 MIT。

## 本地检查

```powershell
npm run verify:open-source -- --history
npm run typecheck
npm run verify:security
npm run verify:updates
npm run verify:rpc
npm run verify:favicon
```

检查通过说明相应回归未发现问题，不能替代独立钱包安全审计、许可证审查或真机发布验收。iOS 原生构建仍需要 macOS/Xcode。

`verify:open-source` 检查 Git 跟踪文件和公开默认配置，`--history` 还检查当前 `HEAD` 的可达历史及提交身份，不扫描被忽略的本地密钥，也不打印匹配值。后续合并私有分支、修改部署配置或加入新凭据后需要重新审查。检查脚本采用规则匹配，无法保证识别所有秘密。
