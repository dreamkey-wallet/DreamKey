/** Minimal EIP-1193 types used by the wallet provider. */
export interface RequestArguments {
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

export type ProviderEvent = 'connect' | 'disconnect' | 'chainChanged' | 'accountsChanged' | 'message';

export interface ProviderMessage {
  type: string;
  data?: unknown;
}

export interface ProviderRpcError extends Error {
  code: number;
  data?: unknown;
}

export interface EIP1193Provider {
  request(args: RequestArguments): Promise<unknown>;
  on(event: ProviderEvent | string, listener: (...args: any[]) => void): this;
  addListener?(event: ProviderEvent | string, listener: (...args: any[]) => void): this;
  removeListener(event: ProviderEvent | string, listener: (...args: any[]) => void): this;
  off?(event: ProviderEvent | string, listener: (...args: any[]) => void): this;
  once?(event: ProviderEvent | string, listener: (...args: any[]) => void): this;
  removeAllListeners?(event?: ProviderEvent | string): this;
  isConnected?(): boolean;
  /** Legacy provider aliases retained for older web3 libraries. */
  enable?(): Promise<string[]>;
  sendAsync?(request: unknown, callback: (error: unknown, response?: unknown) => void): void;
  send?(request: unknown, callback?: unknown): unknown;
  readonly isMetaMask?: boolean;
  readonly providers?: EIP1193Provider[];
  readonly chainId?: string;
  readonly selectedAddress?: string | null;
}

export interface RpcTransport {
  (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<any>;
  }>;
}

export interface WalletPermission {
  parentCapability: 'eth_accounts';
  caveats: Array<{
    type: 'restrictReturnedAccounts';
    value: string[];
  }>;
}
