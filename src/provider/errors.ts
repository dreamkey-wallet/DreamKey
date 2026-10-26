import type { ProviderRpcError } from './types.js';

export class WalletProviderError extends Error implements ProviderRpcError {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ProviderRpcError';
    this.code = code;
    this.data = data;
  }
}

export const providerErrors = {
  userRejected: (message = 'User rejected the request') => new WalletProviderError(4001, message),
  unauthorized: (message = 'The requested account or method is not authorized') => new WalletProviderError(4100, message),
  unsupported: (message = 'The requested method is not supported') => new WalletProviderError(4200, message),
  disconnected: (message = 'The provider is disconnected') => new WalletProviderError(4900, message),
  chainDisconnected: (message = 'The provider is disconnected from the requested chain') => new WalletProviderError(4901, message),
  invalidParams: (message = 'Invalid method parameters') => new WalletProviderError(-32602, message),
  methodNotFound: (method: string) => new WalletProviderError(-32601, `The method ${method} does not exist`),
  internal: (message = 'Internal JSON-RPC error', data?: unknown) => new WalletProviderError(-32603, message, data),
};

