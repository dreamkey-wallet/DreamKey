# Public market price verification

The reproducible read-only check is `node scripts/verify-prices-live.cjs`. It sends only built-in chain identities and public ERC-20 contracts, never wallet addresses or transaction data. The latest captured result is `docs/asset-prices-verification.json`; market availability and ages can change on each run.

To verify the implemented service alone, run `node scripts/verify-prices-live.cjs --service-only`. This loads the current `AssetPriceService` source with its unmodified default fetch, clock, timeouts and freshness policies, then calls `getQuotes` sequentially for the five networks' six automatic default tokens and five native currencies. It records actual service snapshots in `docs/asset-prices-service-verification.json`. This mode avoids reloading the public token identity catalog and is the direct check of application behavior. The full command checks the complete 35-contract catalog, including optional imports, then runs this final default-service check.

On 2026-10-13, all 35 built-in contract keys returned DefiLlama quotes, so this was not a missing contract or incorrect chain namespace problem. Some source series refreshed slowly: the initial sample returned roughly 12-minute-old quotes for BSC USDC/ETH/CAKE, Arbitrum USDT0/WBTC, Polygon USDT0/USDC.e/DAI/WPOL and Base cbETH/AERO, while eight other contracts were already approximately 16 minutes old. The service's five-minute delayed threshold and 15-minute maximum usable age exposed this slower upstream cadence as persistent “cached” or unavailable prices.

CoinGecko's public `/coins/list?include_platform=true` endpoint confirmed a unique platform and contract match for every built-in token. Querying those exact identities through DefiLlama's `coingecko:` keys can return a newer series. Any identity fallback must preserve bridged and wrapped tokens: for example, BSC USDC maps to `binance-bridged-usdc-bnb-smart-chain`, Base USDbC maps to `bridged-usd-coin-base`, and Base cbETH maps to `coinbase-wrapped-staked-eth`. Neither ticker matching nor replacing cbETH with ETH establishes token identity.

Eight exact identities still shared DefiLlama's slower timestamp series during this check. The public CoinGecko `/simple/price?ids=...&vs_currencies=usd&include_last_updated_at=true` endpoint returned all eight in one request with actual market timestamps only 2–23 seconds old:

- BSC DAI: `binance-peg-dai`; BTCB: `binance-bitcoin`.
- Arbitrum USDC.e: `usd-coin-ethereum-bridged`; DAI: `makerdao-arbitrum-bridged-dai-arbitrum-one`.
- Polygon WETH: `polygon-pos-bridged-weth-polygon-pos`; WBTC: `polygon-bridged-wbtc-polygon-pos`.
- Base USDbC: `bridged-usd-coin-base`; DAI: `l2-standard-bridged-dai-base`.

The captured check found 27 of 35 direct contract quotes within five minutes and all 35 within five minutes after the bounded exact-identity fallback. Refreshing a price does not rewrite its market timestamp. Stablecoin prices are not assumed to equal one US dollar, and Bitcoin or Ether derivatives are not replaced by the underlying coin's price.

The saved service report was captured with the previous four-ERC-20-per-network list. `node scripts/verify-prices-live.cjs --service-only` loaded the actual default `AssetPriceService` and called `getQuotes(force=true)` sequentially for all five networks, yielding 20/20 fresh default token quotes and 5/5 fresh native quotes, with zero delayed or unavailable results. The current defaults are a subset of those verified assets. The complete 35-contract identity evidence remains available for manually imported tokens. That result depends on live public APIs and should be treated as a point-in-time verification rather than a service-level guarantee.

Other public APIs were also checked. CoinGecko's contract-price endpoint rejected multiple contracts per anonymous request, so it is unsuitable for this batch. DexScreener and GeckoTerminal were reachable and contract-specific, but their checked price responses did not include a market timestamp. A local retrieval time cannot prove that those prices are fresher. Public endpoints may also return rate limits; the live verification script reports unavailable data instead of inventing a price.
