import { type TransactionRequest as EthersTransactionRequest } from "ethers";
import type { WalletCore } from "../core/wallet-core.js";
import { providerErrors } from "./errors.js";
import { getUncertainBroadcastHash, RPC_BROADCAST_UNCERTAIN } from '../core/rpc-broadcast.js';
import { WalletProvider, type TransactionRequest, type WalletProviderOptions } from "./wallet-provider.js";
import type { RpcTransport } from './types.js';
import { normalizeSigningMessage, parseSigningTypedData } from './signing-payload.js';

export interface WalletApprovalRequest {
  origin: string;
  method: string;
  params: unknown[];
}

export interface WalletCoreProviderOptions {
  /** Called before any request that can spend or sign. Return false to reject it. */
  approve?: (request: WalletApprovalRequest) => Promise<boolean> | boolean;
  /** Called when a dApp requests accounts for the first time. */
  requestAccounts?: WalletProviderOptions["requestAccounts"];
  /** Optional shared permission store. */
  permissions?: WalletProviderOptions["permissions"];
}

function withoutFrom(transaction: TransactionRequest): TransactionRequest {
  const { from: _from, gas, ...rest } = transaction;
  // JSON-RPC uses gas; ethers uses gasLimit and silently ignores gas.
  return gas === undefined ? rest : { ...rest, gasLimit: gas };
}

/**
 * Binds the standalone wallet core to an EIP-1193 provider. The adapter keeps
 * RPC endpoints supplied by the host app and routes signing to the derived
 * BIP-44 account. UI confirmation belongs in `approve`.
 */
export function createWalletProvider(
  wallet: WalletCore,
  networkId: string,
  options: WalletCoreProviderOptions = {},
): WalletProvider {
  const selectedNetwork = wallet.getNetwork(networkId);
  const networkByChain = new Map(wallet.listNetworks().map((network) => [network.chainId, network.id]));
  const networkByRpc = new Map(wallet.listNetworks().map((network) => [network.rpcUrl, network.id]));
  // Reuse the core's endpoint health, chain guards and timeout policy. The
  // optional check preserves transport-agnostic host/fake implementations.
  const fetch: RpcTransport | undefined = typeof wallet.getRpcTransport === 'function' ? async (url, init) => {
    const id = networkByRpc.get(url);
    if (!id) throw providerErrors.chainDisconnected('RPC endpoint is not configured by the wallet');
    return wallet.getRpcTransport(id)(url, init);
  } : undefined;
  let provider!: WalletProvider;
  // Do not sign a fresh nonce when a DApp retries after a lost RPC response.
  // Keep public request fingerprints only; signed payloads are never retained.
  const uncertainTransactions = new Map<string, string>();
  const inFlightTransactions = new Map<string, Promise<string>>();
  const uncertainError = (hash: string) => providerErrors.internal(
    `Transaction submission is unconfirmed. Check ${hash} before sending again.`,
    { code: RPC_BROADCAST_UNCERTAIN, transactionHash: hash },
  );
  const accounts = wallet.listAccounts().map((account) => account.address);

  const approve = options.approve ?? (() => false);
  const signer = async (method: string, params: unknown[], origin: string): Promise<unknown> => {
    // Observed addresses are intentionally read-only. Still open the host
    // confirmation surface so the user gets an explicit explanation instead
    // of a silent dApp rejection. The host marks the request as watch-only
    // and disables the approve action before this callback resolves.
    const watchOnly = typeof wallet.isWatchOnly === 'function' && wallet.isWatchOnly();
    if (watchOnly) {
      if (!(await approve({ origin, method, params }))) throw providerErrors.userRejected();
      throw providerErrors.unauthorized("This wallet is watch-only and cannot sign or send transactions");
    }
    // Capture the chain when confirmation opens. A chain change while a
    // signing prompt is visible must never turn that prompt into a spend on
    // a different network.
    const requestedChainId = provider.chainId;
    const currentNetworkId = networkByChain.get(Number(requestedChainId));
    if (!currentNetworkId) throw providerErrors.chainDisconnected("No RPC network is configured for the selected chain");
    if (method.startsWith('eth_signTypedData')) {
      const typed = parseSigningTypedData(params[1]);
      if (typed.domain.chainId != null) {
        let typedChainId: bigint;
        try { typedChainId = BigInt(typed.domain.chainId); }
        catch { throw providerErrors.invalidParams('Typed data chainId is invalid'); }
        if (typedChainId !== BigInt(requestedChainId)) throw providerErrors.chainDisconnected('Typed data chainId does not match the selected network');
      }
    }
    if (!(await approve({ origin, method, params }))) throw providerErrors.userRejected();
    if (provider.chainId !== requestedChainId) throw providerErrors.chainDisconnected("The selected network changed while the request was being approved");
    if (!provider.isConnected()) throw providerErrors.disconnected();

    const first = params[0];
    const account = method === "personal_sign" ? params[1] : (method === "eth_sign" || method.startsWith("eth_signTypedData") ? params[0] : (first as TransactionRequest)?.from);
    const address = typeof account === "string" ? account.toLowerCase() : wallet.getAccount(0).address.toLowerCase();
    if (!provider.permissions.has(origin, address)) throw providerErrors.unauthorized('Account permission was revoked while the request was being approved');
    const accountIndex = wallet.listAccounts().find((item) => item.address.toLowerCase() === address)?.index;
    if (accountIndex === undefined) throw providerErrors.unauthorized("Account is not controlled by this wallet");

    if (method === "personal_sign" || method === "eth_sign") {
      return wallet.signMessage(accountIndex, normalizeSigningMessage(method === "personal_sign" ? params[0] : params[1]));
    }
    if (method.startsWith("eth_signTypedData")) {
      const typed = parseSigningTypedData(params[1]);
      return wallet.getSigner(accountIndex).signTypedData(typed.domain, typed.types, typed.message);
    }
    if (method === "eth_sendTransaction") {
      if (!first || typeof first !== "object") throw providerErrors.invalidParams("Transaction object is required");
      const transaction = first as TransactionRequest;
      const fingerprint = JSON.stringify([requestedChainId, address, Object.entries(transaction)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, typeof value === 'string' ? value.toLowerCase() : value])]);
      // Every caller has independently passed approval, chain and permission
      // checks above. Merge only simultaneous identical requests from this
      // origin; completion leaves ordinary later transfers unaffected.
      const inFlightKey = JSON.stringify([origin, fingerprint]);
      const existing = inFlightTransactions.get(inFlightKey);
      if (existing) return existing;
      const sending = (async (): Promise<string> => {
        const uncertainHash = uncertainTransactions.get(fingerprint);
        if (uncertainHash) {
          // A missing transaction on one node is not evidence of a rejected
          // broadcast. Keep blocking replay until an on-chain result is known.
          try {
            const status = await wallet.getTransactionStatus(currentNetworkId, uncertainHash);
            if (status.state !== 'not-found') return uncertainHash;
          } catch { /* A lookup outage cannot make replay safe. */ }
          throw uncertainError(uncertainHash);
        }
        try {
          const response = await wallet.getSigner(accountIndex, currentNetworkId).sendTransaction(withoutFrom(transaction) as unknown as EthersTransactionRequest);
          if (typeof wallet.recordSubmittedTransaction === 'function') {
            try { wallet.recordSubmittedTransaction(currentNetworkId, response); }
            catch { /* An accepted broadcast still returns its hash if recording fails. */ }
          }
          return response.hash;
        } catch (error) {
          const hash = getUncertainBroadcastHash(error);
          if (!hash) throw error;
          uncertainTransactions.set(fingerprint, hash);
          if (typeof wallet.recordSubmittedTransaction === 'function') {
            try {
              wallet.recordSubmittedTransaction(currentNetworkId, {
                hash, from: address, to: transaction.to ?? null,
                value: BigInt(transaction.value ?? '0x0'), data: transaction.data ?? '0x',
              });
            } catch { /* Recording failure cannot hide the hash or make replay safe. */ }
          }
          throw uncertainError(hash);
        }
      })();
      inFlightTransactions.set(inFlightKey, sending);
      try { return await sending; }
      finally { if (inFlightTransactions.get(inFlightKey) === sending) inFlightTransactions.delete(inFlightKey); }
    }
    throw providerErrors.unsupported(`Signing method is not supported: ${method}`);
  };

  provider = new WalletProvider({
    rpcUrl: selectedNetwork.rpcUrl,
    rpcUrls: Object.fromEntries(wallet.listNetworks().map((network) => [String(network.chainId), network.rpcUrl])),
    chainId: selectedNetwork.chainId,
    fetch,
    accounts,
    permissions: options.permissions,
    signer,
    requestAccounts: async (origin) => {
      if (options.requestAccounts) return options.requestAccounts(origin);
      if (!(await approve({ origin, method: "eth_requestAccounts", params: [] }))) {
        throw providerErrors.userRejected();
      }
      return accounts;
    },
  });
  return provider;
}
