# Built-in common tokens

DreamKey automatically displays USDT on BSC, USDT and USDC on Ethereum, and USDC on Arbitrum, Polygon and Base, alongside each network's native currency. The wallet, asset management and send picker share this list and the existing balance, price, receive and transaction-history paths. The native currency remains the first asset. No token-list server is requested by the application. Additional verified contracts remain available when the user imports them by address.

The fixed catalog is `src/core/common-tokens.ts`. `getCommonTokens()` exposes the six automatic ERC-20 defaults, while `getKnownTokens()` retains all 35 verified contracts for imports and identity checks. On 2026-10-13, all 35 contracts were read through their configured public RPC endpoints using only `eth_call` for `symbol()` and `decimals()`. The reproducible result is `docs/common-tokens-verification.json`. Run `node scripts/verify-common-tokens-live.cjs` to repeat the read-only check, or `node scripts/verify-common-tokens.cjs` for the offline contract, identity and persistence checks.

## Default assets

- BSC: BNB, USDT.
- Ethereum: ETH, USDT, USDC.
- Arbitrum One: ETH, USDC.
- Polygon PoS: POL, USDC.
- Base: ETH, USDC.

The catalog also retains BSC USDC, DAI, WBNB, WETH, bridged USDC.e, WPOL, USDbC, UNI, CAKE, cbETH and other verified contracts for optional address imports. Wrapped native duplicates (WBNB on BSC, WETH on Ethereum/Arbitrum and WPOL on Polygon) and older bridged USDC entries are not shown by default.

These are a bounded default list, not an assertion that other tokens are unsupported. The user can continue importing ERC-20 contracts on the selected network.

## Contract identity and source checks

The [Uniswap default token list](https://tokens.uniswap.org) supplied or corroborated contracts and decimals for Ethereum, Arbitrum, Polygon and Base, and BSC stablecoins/WBNB/ETH. The [Trust Wallet BSC list](https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/tokenlist.json) supplied or corroborated BSC CAKE/BTCB and its other common contracts. These sources were checked during development; their ticker fields are not trusted to select a logo.

[Circle's official USDC contracts](https://developers.circle.com/stablecoins/usdc-contract-addresses) confirms issuer-native USDC on Ethereum, Arbitrum One, Polygon PoS and Base. The old bridged contracts on Arbitrum and Polygon remain distinct `USDC.e` entries with a chain-link icon badge; their on-chain symbol is still `USDC`. Base's `USDbC` is explicitly labeled “USD Base Coin (Bridged)” and uses the same bridge badge. It is separate from issuer-native USDC.

[USDT0's official deployments](https://docs.usdt0.to/technical-documentation/deployments) confirms the upgraded former USDT contract on Arbitrum One (`0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9`) and Polygon PoS (`0xc2132D05D31c914a87C6611C10748AEb04B58e8F`). Live contract calls returned `USD₮0` and `USDT0`, respectively, with six decimals. Their current symbols and official USDT0 logo are bundled. As of the check date, this official deployment list contains no Base deployment; the default Base list does not assume a USDT contract is issuer-native.

BSC USDT and USDC both have **18 decimals**; Ethereum's USDT and USDC have **6 decimals**. BSC stablecoins, ETH and BTCB are labeled Binance-Peg in their names. They are not the Ethereum or Circle-native token contract. BSC CAKE returns `Cake` from `symbol()`; the display uses the conventional uppercase `CAKE` from the token lists.

Polygon's former WMATIC contract (`0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270`) currently returns `WPOL` and 18 decimals. The wallet displays `WPOL` instead of the token list's stale WMATIC ticker. Native Polygon is `POL`.

Base cbBTC is the Uniswap-listed Coinbase wrapped Bitcoin contract, with eight decimals. It uses the underlying Bitcoin mark, as BTCB does; the complete name and contract establish its identity. cbETH and AERO use their bundled original-color logos. There is no runtime dependency on a logo CDN.

## Local edits and migrations

`src/native/token-storage.ts` merges the bundled catalog with user imports by chain ID and lowercase contract address. Existing saved arrays remain supported. New saves use a versioned object with `tokens` for user imports and `hiddenBuiltIns` for removed defaults. Adding one imported coin never serializes the entire default catalog.

Removing a built-in coin hides it persistently, including after an app restart. Importing its contract again restores it with the bundled symbol, bridge identity and precision. Imported metadata for a known contract cannot overwrite the bundled values. Changes are serialized per network so two simultaneous imports cannot discard each other. Removing a coin only changes the display list; it never changes on-chain balances.

Updates to the bundled defaults take effect for existing installations because automatic assets are not saved as user imports. Explicitly imported assets remain available when removed from the automatic list.

Price quotes remain contract-specific and come from the existing public price service. Missing quotes are not replaced with an assumed stablecoin price. Missing RPC balances remain unavailable rather than zero.
