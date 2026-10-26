export interface PopularDapp {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly logoUrl?: string;
}

// Public shortcuts, rather than a ranking or a statement of network compatibility.
// Logo URLs come from the official sites; ICOs use DappFavicon's decoder.
export const POPULAR_DAPPS: readonly PopularDapp[] = [
  {
    id: "uniswap",
    name: "Uniswap",
    url: "https://app.uniswap.org/",
    logoUrl: "https://cdn.app.uniswap.org/images/192x192_App_Icon.png",
  },
  {
    id: "pancakeswap",
    name: "PancakeSwap",
    url: "https://pancakeswap.finance/",
    logoUrl: "https://pancakeswap.finance/logo.png",
  },
  {
    id: "aave",
    name: "Aave",
    url: "https://app.aave.com/",
    logoUrl: "https://app.aave.com/apple-touch-icon.png",
  },
  {
    id: "curve",
    name: "Curve",
    url: "https://www.curve.finance/",
    logoUrl: "https://www.curve.finance/apple-touch-icon.png",
  },
  {
    id: "1inch",
    name: "1inch",
    url: "https://1inch.com/swap",
    logoUrl: "https://1inch.com/favicon/apple-touch-icon.png",
  },
  {
    id: "compound",
    name: "Compound",
    url: "https://app.compound.xyz/",
    logoUrl: "https://app.compound.xyz/images/compound-192.png",
  },
  {
    id: "lido",
    name: "Lido",
    url: "https://stake.lido.fi/",
    logoUrl: "https://stake.lido.fi/favicon-192x192.png",
  },
  {
    id: "defillama",
    name: "DefiLlama",
    url: "https://defillama.com/",
    logoUrl: "https://defillama.com/favicon.ico",
  },
  {
    id: "opensea",
    name: "OpenSea",
    url: "https://opensea.io/",
    logoUrl: "https://opensea.io/icons/icon-192x192.png",
  },
  {
    id: "blur",
    name: "Blur",
    url: "https://blur.io/",
    logoUrl: "https://blur.io/favicons/180.png",
  },
  {
    id: "ens",
    name: "ENS",
    url: "https://app.ens.domains/",
    logoUrl: "https://app.ens.domains/apple-touch-icon.png",
  },
  {
    id: "polymarket",
    name: "Polymarket",
    url: "https://polymarket.com/",
    logoUrl: "https://polymarket.com/icons/apple-touch-icon.png",
  },
  {
    id: "sushi",
    name: "Sushi",
    url: "https://www.sushi.com/",
    logoUrl: "https://www.sushi.com/apple-touch-icon.png?v=1",
  },
  {
    id: "gmx",
    name: "GMX",
    url: "https://app.gmx.io/",
    logoUrl: "https://app.gmx.io/favicon/android-icon-192x192.png",
  },
  {
    id: "yearn",
    name: "Yearn",
    url: "https://yearn.fi/",
    logoUrl: "https://yearn.fi/favicons/android-icon-192x192.png",
  },
  {
    id: "pendle",
    name: "Pendle",
    url: "https://app.pendle.finance/",
    logoUrl: "https://app.pendle.finance/favicon.ico",
  },
  {
    id: "morpho",
    name: "Morpho",
    url: "https://app.morpho.org/",
    logoUrl: "https://cdn.morpho.org/v2/assets/images/favicon-192x192.png",
  },
  {
    id: "cowswap",
    name: "CoW Swap",
    url: "https://swap.cow.fi/",
    logoUrl: "https://swap.cow.fi/apple-touch-icon.png",
  },
  {
    id: "aerodrome",
    name: "Aerodrome",
    url: "https://aerodrome.finance/",
    logoUrl: "https://aerodrome.finance/images/AERO/apple-touch-icon.png",
  },
  {
    id: "velodrome",
    name: "Velodrome",
    url: "https://velodrome.finance/",
    logoUrl: "https://velodrome.finance/images/VELO/apple-touch-icon.png",
  },
  {
    id: "stargate",
    name: "Stargate",
    url: "https://stargate.finance/",
    logoUrl: "https://stargate.finance/static/favicons/favicon-196x196.png",
  },
  {
    id: "across",
    name: "Across",
    url: "https://across.to/",
    logoUrl: "https://across.to/logo-small.png",
  },
  {
    id: "quickswap",
    name: "QuickSwap",
    url: "https://dapp.quickswap.exchange/swap",
    logoUrl: "https://quickswap.exchange/logo_circle.png",
  },
  {
    id: "dodo",
    name: "DODO",
    url: "https://app.dodoex.io/",
    logoUrl: "https://app.dodoex.io/images/dodo-192x192.png",
  },
  {
    id: "kyberswap",
    name: "KyberSwap",
    url: "https://kyberswap.com/swap",
    logoUrl: "https://kyberswap.com/favicon.png?version=v1",
  },
  {
    id: "jumper",
    name: "Jumper",
    url: "https://jumper.xyz/",
    logoUrl: "https://jumper.xyz/apple-touch-icon-180x180.png",
  },
  {
    id: "zerion",
    name: "Zerion",
    url: "https://app.zerion.io/",
    logoUrl: "https://app.zerion.io/favicon.png",
  },
  {
    id: "beefy",
    name: "Beefy",
    url: "https://app.beefy.com/",
    logoUrl: "https://app.beefy.com/favicon.ico",
  },
];
