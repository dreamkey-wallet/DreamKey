# Local Iconify icons

The wallet uses a fixed, bundled selection of [Iconify](https://iconify.design/) icons. The runtime renders native SVG paths through `react-native-svg`; it does not download icons, render HTML, or parse arbitrary SVG strings.

## Interface icons

- Collection: [Phosphor Icons](https://icon-sets.iconify.design/ph/), version **2.1.1**, `duotone` style.
- Author: [Phosphor Icons](https://github.com/phosphor-icons/core).
- License: **MIT**. The original notice is preserved in `src/ui/icons/LICENSE.phosphor`.
- Pinned selected source: `src/ui/icons/ph-source.json`, downloaded from Iconify's official API on 2026-10-13. This JSON contains only the selected icons.
- Functional controls use the regular, single-color Phosphor sources `x`, `check`, `plus`, `caret-down`, `caret-right`, `caret-left`, `arrow-left`, `arrow-right`, `arrow-clockwise`, `arrow-up-right` and `arrow-down-left`, pinned in `src/ui/icons/ph-controls-source.json`. They intentionally avoid the duotone background shapes used by decorative icons, so close, back, refresh, check and disclosure controls render as clean glyphs.

## Network marks

- Collection: [Cryptocurrency Icons](https://icon-sets.iconify.design/cryptocurrency/), version **0.18.1**. The standalone `Bnb` and `Ethereum` icon components are retained for interface use.
- Author: [Christopher Downer / Cryptocurrency Icons](https://github.com/atomiclabs/cryptocurrency-icons).
- License: **CC0 1.0 Universal**. The original license text is preserved in `src/ui/icons/LICENSE.cryptocurrency`.
- Pinned selected source: `src/ui/icons/cryptocurrency-source.json`, downloaded from Iconify's official API on 2026-10-13.
- `NetworkMark` uses original-color BNB/ETH from the asset collection below, plus [Web3 Icons Branded](https://icon-sets.iconify.design/token-branded/) `arbitrum-one`, `polygon` and `base`, version **4.0.58**, by [0xa3k5](https://github.com/0xa3k5/web3icons), **MIT**. Pinned selection: `src/ui/icons/network-branded-source.json`, downloaded from Iconify's official API on 2026-10-13. The original notice is preserved in `src/ui/icons/LICENSE.web3icons`.

## Asset logos

- [Cryptocurrency Color Icons](https://icon-sets.iconify.design/cryptocurrency-color/), version **0.18.1**, by Christopher Downer / Cryptocurrency Icons. The bundled, original-color BNB, ETH, USDT, USDC, DAI, WBTC, BTC, UNI and LINK marks are **CC0 1.0 Universal**; the existing `LICENSE.cryptocurrency` notice applies. Pinned selection: `src/ui/icons/cryptocurrency-color-source.json`.
- [Web3 Icons Branded](https://icon-sets.iconify.design/token-branded/), version **4.0.58**, by [0xa3k5](https://github.com/0xa3k5/web3icons). The CAKE, POL, cbETH and AERO logos are **MIT**; the original notice is preserved in `src/ui/icons/LICENSE.web3icons`. Pinned selection: `src/ui/icons/token-branded-source.json`. ARB uses the same collection's `arbitrum-one` asset already pinned for the network mark.
- USDT0 uses the [official token symbol](https://docs.usdt0.to/img/assets/tokens/AssetSymbol_USDT0_Primary.svg), retrieved from the project's documentation on 2026-10-13. Its official symbol paths and radial gradient are preserved in `src/ui/icons/official-token-source.json`; the decorative raster noise overlay is omitted for small native SVG display. This is project brand artwork, not a CC0 or MIT icon, and ownership remains with USDT0. The wallet uses it to identify the verified USDT0 contracts.
- Both selections were downloaded from Iconify's official API on 2026-10-13. Their original colors are preserved, and all SVG paths are packaged with the app.

The registry in `src/ui/token-icon-registry.ts` identifies native BNB/ETH/POL by chain ID, and ERC-20 assets by chain ID plus normalized contract address. Arbitrum One and Base use ETH for their native assets; Polygon PoS uses POL. A token's symbol cannot select a logo. Unknown contracts and networks use a neutral geometric coin mark. Contract identities were checked against the [Uniswap token list](https://tokens.uniswap.org) and the [Trust Wallet BSC token list](https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/tokenlist.json). Native USDC contracts for Arbitrum One, Polygon PoS and Base were also verified against [Circle's official contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses). These sources are used during development; the app does not request them at runtime.

The Ethereum registry covers USDT, USDC, DAI, WETH, WBTC, UNI, LINK and CAKE. The BSC registry covers Binance-pegged USDT, USDC, DAI, ETH, UNI, LINK and BTCB, plus WBNB and CAKE. WETH/Binance-pegged ETH, WBNB and BTCB use the underlying ETH, BNB and BTC marks, respectively. The wallet's automatic list shows BNB/USDT on BSC, ETH/USDT/USDC on Ethereum, ETH/USDC on Arbitrum and Base, and POL/USDC on Polygon; the remaining verified marks stay available for address imports. Addresses and network names remain visible in the wallet; these marks do not certify an imported token or indicate equivalence between chains.

The Arbitrum One registry covers USD₮0, native USDC, bridged USDC.e, DAI, WETH, WBTC and ARB. Polygon PoS covers USDT0, native USDC, bridged USDC.e, DAI, WETH, WBTC and WPOL. The existing USDT contracts on Arbitrum and Polygon are now USDT0 deployments, checked against [USDT0's official deployment list](https://docs.usdt0.to/technical-documentation/deployments) and live `symbol()` calls. Base covers native USDC, bridged USDbC, DAI, WETH, cbBTC, cbETH and AERO; no USDT contract is assumed official for Base. USDC.e and USDbC retain the USDC artwork with a small wallet-authored chain-link badge to distinguish their bridged identity. cbBTC uses the underlying Bitcoin mark; the complete name and contract identify the Coinbase wrapper. Symbols and contract addresses remain the source of identity in the UI. The full defaults and source checks are documented in `docs/common-tokens.md`.

## Regeneration

Run `node src/ui/icons/generate.cjs` after updating the selected assets. The development-only script validates supported tags and attributes and generates the fixed native JSX in `src/ui/icons.tsx` and `src/ui/token-icon-assets.tsx`. Neither the source JSON nor the generator is imported by the application.

All interface icon components accept `size` and `color`, with a default size of 24. `strokeWidth` is accepted for existing call sites; the Phosphor assets supply their own optical weight. Passing a color to `Star.fill` highlights its interior for saved favorites. `NetworkMark` takes `chainId` and preserves brand colors regardless of caller tint. `TokenIcon` (also exported as `AssetMark`) accepts `chainId`, `address`, `native` and `size` (default 32); its original logo colors are fixed. Pass `native: true` for the network's native asset, or a contract `address` for an ERC-20 token. Legacy symbol-only calls receive a neutral mark.
