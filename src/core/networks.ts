import type { NetworkConfig } from './types.js';

/** Built-in mainnets share verified RPC failover; BSC is the default. */
export const DEFAULT_NETWORKS: NetworkConfig[] = [
  {
    id: 'bsc-mainnet', chainId: 56, name: 'BSC', nativeSymbol: 'BNB',
    rpcUrl: 'https://bsc.mytokenpocket.vip',
    rpcFallbackUrls: [
      'https://bsc-rpc.publicnode.com',
      'https://bsc-dataseed1.bnbchain.org',
      'https://bsc-dataseed1.defibit.io',
    ],
    explorerUrl: 'https://bscscan.com',
  },
  {
    id: 'ethereum-mainnet', chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH',
    rpcUrl: 'https://web3.mytokenpocket.vip',
    rpcFallbackUrls: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://mainnet.gateway.tenderly.co'],
    explorerUrl: 'https://etherscan.io',
  },
  {
    id: 'arbitrum-one', chainId: 42161, name: 'Arbitrum One', nativeSymbol: 'ETH',
    rpcUrl: 'https://arb.mytokenpocket.vip',
    rpcFallbackUrls: ['https://arbitrum.drpc.org', 'https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    explorerUrl: 'https://arbiscan.io',
  },
  {
    id: 'polygon-mainnet', chainId: 137, name: 'Polygon', nativeSymbol: 'POL',
    rpcUrl: 'https://matic2.mytokenpocket.vip',
    rpcFallbackUrls: ['https://polygon.drpc.org', 'https://polygon-bor-rpc.publicnode.com', 'https://polygon.gateway.tenderly.co'],
    explorerUrl: 'https://polygonscan.com',
  },
  {
    id: 'base-mainnet', chainId: 8453, name: 'Base', nativeSymbol: 'ETH',
    rpcUrl: 'https://base.mytokenpocket.vip',
    rpcFallbackUrls: ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'],
    explorerUrl: 'https://basescan.org',
  },
];
