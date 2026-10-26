import type { ImageSourcePropType } from 'react-native';

// Bundled brand icons keep curated shortcuts visible on the first offline launch.
// Sources are recorded in logos/README.md; visited sites may refresh their own cache.
export const POPULAR_DAPP_LOGOS: Readonly<Record<string, ImageSourcePropType>> = {
  'uniswap': require('./logos/uniswap.png'),
  'pancakeswap': require('./logos/pancakeswap.png'),
  'aave': require('./logos/aave.png'),
  'curve': require('./logos/curve.png'),
  '1inch': require('./logos/1inch.png'),
  'compound': require('./logos/compound.png'),
  'lido': require('./logos/lido.png'),
  'defillama': require('./logos/defillama.png'),
  'opensea': require('./logos/opensea.png'),
  'blur': require('./logos/blur.png'),
  'ens': require('./logos/ens.png'),
  'polymarket': require('./logos/polymarket.png'),
  'sushi': require('./logos/sushi.png'),
  'gmx': require('./logos/gmx.png'),
  'yearn': require('./logos/yearn.png'),
  'pendle': require('./logos/pendle.png'),
  'morpho': require('./logos/morpho.png'),
  'cowswap': require('./logos/cowswap.png'),
  'aerodrome': require('./logos/aerodrome.png'),
  'velodrome': require('./logos/velodrome.png'),
  'stargate': require('./logos/stargate.png'),
  'across': require('./logos/across.png'),
  'quickswap': require('./logos/quickswap.png'),
  'dodo': require('./logos/dodo.png'),
  'kyberswap': require('./logos/kyberswap.png'),
  'jumper': require('./logos/jumper.png'),
  'zerion': require('./logos/zerion.png'),
  'beefy': require('./logos/beefy.png'),
};
