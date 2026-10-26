/** Bundled logo identity uses a network and contract, never untrusted token symbols. */
export type TokenIconId = 'bnb' | 'eth' | 'pol' | 'usdt' | 'usdt0' | 'usdc' | 'usdc-e' | 'dai' | 'wbtc' | 'btc' | 'uni' | 'link' | 'cake' | 'arb' | 'cbeth' | 'aero';

export interface TokenIconIdentity {
  chainId?: number;
  address?: string;
  native?: boolean;
}

const NATIVE_ICON_IDS: Readonly<Record<number, TokenIconId>> = {
  1: 'eth',
  56: 'bnb',
  42161: 'eth',
  137: 'pol',
  8453: 'eth',
};

// Contracts checked against Circle, Uniswap and Trust Wallet public sources.
// Native USDC and USDC.e remain separate identities. See docs/icon-attribution.md.
const TOKEN_ICON_IDS: Readonly<Record<number, Readonly<Record<string, TokenIconId>>>> = {
  1: {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'usdt',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'usdc',
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'dai',
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'eth',
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'wbtc',
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 'uni',
    '0x514910771af9ca656af840dff83e8264ecf986ca': 'link',
    '0x152649ea73beab28c5b49b26eb48f7ead6d4c898': 'cake',
  },
  56: {
    '0x55d398326f99059ff775485246999027b3197955': 'usdt',
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'usdc',
    '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': 'dai',
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'bnb',
    '0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'eth',
    '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': 'btc',
    '0xbf5140a22578168fd562dccf235e5d43a02ce9b1': 'uni',
    '0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd': 'link',
    '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': 'cake',
  },
  42161: {
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'usdt0',
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'usdc',
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'usdc-e',
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'dai',
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'eth',
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': 'wbtc',
    '0x912ce59144191c1204e64559fe8253a0e49e6548': 'arb',
  },
  137: {
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'usdc',
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'usdc-e',
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 'usdt0',
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': 'dai',
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': 'eth',
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': 'wbtc',
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 'pol',
  },
  8453: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'usdc',
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'usdc-e',
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'dai',
    '0x4200000000000000000000000000000000000006': 'eth',
    '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'btc',
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 'cbeth',
    '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 'aero',
  },
};

export function getTokenIconId({ chainId, address, native }: TokenIconIdentity): TokenIconId | undefined {
  if (chainId === undefined) return undefined;
  if (native && !address) return NATIVE_ICON_IDS[chainId];
  if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) return undefined;
  return TOKEN_ICON_IDS[chainId]?.[address.toLowerCase()];
}
