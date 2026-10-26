import { providerErrors, WalletProviderError } from './errors.js';
import { PermissionManager } from './permissions.js';
import type { EIP1193Provider, ProviderEvent, RequestArguments, RpcTransport } from './types.js';

export interface TransactionRequest {
  from?: string;
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
  [key: string]: unknown;
}

export interface WalletProviderOptions {
  rpcUrl: string;
  chainId: number | string;
  /** Optional RPC endpoints keyed by decimal or hexadecimal chain id. */
  rpcUrls?: Record<string, string>;
  accounts?: string[];
  origin?: string;
  permissions?: PermissionManager;
  fetch?: RpcTransport;
  /** Called for local wallet signing methods. Return the JSON-RPC result. */
  signer?: (method: string, params: unknown[], origin: string) => Promise<unknown>;
  /** Called by eth_requestAccounts when the origin has no grant. */
  requestAccounts?: (origin: string) => Promise<string[]> | string[];
}

type Listener = (...args: any[]) => void;

// A DApp must never reach node-admin, remote-account signing, or unfamiliar
// extension methods through the otherwise convenient RPC fallback.
const READ_RPC_METHODS = new Set([
  'web3_clientVersion', 'web3_sha3', 'net_listening', 'net_peerCount',
  'eth_blockNumber', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt',
  'eth_getTransactionCount', 'eth_call', 'eth_estimateGas', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBlockByNumber',
  'eth_getBlockByHash', 'eth_getBlockTransactionCountByNumber',
  'eth_getBlockTransactionCountByHash', 'eth_getTransactionByHash',
  'eth_getTransactionByBlockNumberAndIndex', 'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionReceipt', 'eth_getLogs', 'eth_getProof', 'eth_syncing',
]);

const TRANSACTION_FIELDS = new Set([
  'from', 'to', 'data', 'input', 'value', 'gas', 'gasLimit', 'gasPrice',
  'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'chainId', 'type',
]);

/** Approval and signing share a detached, immutable JSON-RPC snapshot. */
function snapshotSigningParams(params: unknown[]): unknown[] {
  let serialized: string;
  try { serialized = JSON.stringify(params); }
  catch { throw providerErrors.invalidParams('Signing parameters must be JSON serializable'); }
  if (serialized.length > 262144) throw providerErrors.invalidParams('Signing parameters are too large');
  const snapshot = JSON.parse(serialized) as unknown[];
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}

/** Only fields that the wallet can review and sign consistently are accepted. */
function normalizeTransaction(value: unknown): TransactionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerErrors.invalidParams('Transaction object is required');
  const tx = value as Record<string, unknown>;
  if (Object.keys(tx).some((key) => !TRANSACTION_FIELDS.has(key))) throw providerErrors.invalidParams('Unsupported transaction field');
  const result: TransactionRequest = {};
  for (const [key, field] of Object.entries(tx)) {
    if (field === undefined) continue;
    if (key === 'from' || key === 'to') {
      if (typeof field !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(field)) throw providerErrors.invalidParams(`Invalid transaction ${key}`);
    } else if (key === 'data' || key === 'input') {
      if (typeof field !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(field)) throw providerErrors.invalidParams('Transaction data must contain complete hex bytes');
    } else if (typeof field !== 'string' || !/^0x(?:0|[a-fA-F1-9][a-fA-F0-9]*)$/.test(field)) {
      throw providerErrors.invalidParams(`Transaction ${key} must be a hex quantity`);
    }
    result[key] = field;
  }
  if (result.data !== undefined && result.input !== undefined && result.data.toLowerCase() !== String(result.input).toLowerCase()) throw providerErrors.invalidParams('Conflicting transaction data and input');
  if (result.gas !== undefined && result.gasLimit !== undefined && BigInt(result.gas) !== BigInt(String(result.gasLimit))) throw providerErrors.invalidParams('Conflicting transaction gas limits');
  if (result.gasPrice !== undefined && (result.maxFeePerGas !== undefined || result.maxPriorityFeePerGas !== undefined)) throw providerErrors.invalidParams('Conflicting transaction fee fields');
  if (result.maxFeePerGas !== undefined && result.maxPriorityFeePerGas !== undefined && BigInt(result.maxPriorityFeePerGas) > BigInt(result.maxFeePerGas)) throw providerErrors.invalidParams('Priority fee exceeds the maximum fee');
  if (result.type !== undefined && BigInt(String(result.type)) > 2n) throw providerErrors.invalidParams('Unsupported transaction type');
  if (result.data === undefined && result.input !== undefined) result.data = String(result.input);
  if (result.gas === undefined && result.gasLimit !== undefined) result.gas = String(result.gasLimit);
  delete result.input;
  delete result.gasLimit;
  return result;
}

/** Mutable wallet state is shared by every origin-scoped provider. */
interface SharedWalletState {
  rpcUrl: string;
  rpcUrls: Map<number, string>;
  accounts: string[];
  currentChainId: number;
  nextId: number;
  connected: boolean;
  scopes: Map<string, WalletProvider>;
  root?: WalletProvider;
}

/**
 * Small, standalone EIP-1193 provider. It is deliberately transport-agnostic:
 * all chain reads go to the configured JSON-RPC endpoint and wallet writes can
 * be supplied by the host application's signer callback.
 */
export class WalletProvider implements EIP1193Provider {
  /** Compatibility marker used by dApps that target the common injected provider shape. */
  readonly isMetaMask = true;
  private readonly state: SharedWalletState;
  readonly permissions: PermissionManager;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly transport: RpcTransport;
  private readonly signer?: WalletProviderOptions['signer'];
  private readonly requestAccountsCallback?: WalletProviderOptions['requestAccounts'];
  private readonly origin: string;

  constructor(options: WalletProviderOptions, sharedState?: SharedWalletState) {
    if (!options.rpcUrl) throw new Error('rpcUrl is required');
    this.origin = options.origin?.trim() || 'default';
    if (sharedState) {
      this.state = sharedState;
    } else {
      const currentChainId = this.parseChainId(options.chainId);
      const rpcUrls = new Map<number, string>();
      for (const [id, url] of Object.entries(options.rpcUrls || {})) rpcUrls.set(this.parseChainId(id), url);
      rpcUrls.set(currentChainId, options.rpcUrl);
      this.state = {
        rpcUrl: options.rpcUrl,
        rpcUrls,
        currentChainId,
        accounts: [...(options.accounts || [])].map((a) => this.normalizeAccount(a)),
        nextId: 1,
        connected: true,
        scopes: new Map(),
        root: this,
      };
    }
    this.state.scopes.set(this.origin, this);
    this.permissions = options.permissions || new PermissionManager(() => this.accounts);
    this.transport = options.fetch || (globalThis.fetch as unknown as RpcTransport);
    if (!this.transport) throw new Error('A fetch implementation is required');
    this.signer = options.signer;
    this.requestAccountsCallback = options.requestAccounts;
  }

  get rpcUrl(): string { return this.state.rpcUrl; }
  set rpcUrl(url: string) { this.state.rpcUrl = url; }
  private get rpcUrls(): Map<number, string> { return this.state.rpcUrls; }
  private get accounts(): string[] { return this.state.accounts; }
  private set accounts(accounts: string[]) { this.state.accounts = accounts; }
  private get currentChainId(): number { return this.state.currentChainId; }
  private set currentChainId(chainId: number) { this.state.currentChainId = chainId; }
  private get nextId(): number { return this.state.nextId; }
  private set nextId(id: number) { this.state.nextId = id; }
  private get connected(): boolean { return this.state.connected; }
  private set connected(value: boolean) { this.state.connected = value; }

  private authorizedAccounts(): string[] {
    return this.permissions.getAccounts(this.origin).filter((account) => this.accounts.includes(account));
  }

  private normalizeAccount(account: string): string {
    if (!/^0x[a-fA-F0-9]{40}$/.test(account)) throw providerErrors.invalidParams(`Invalid Ethereum account: ${account}`);
    return account.toLowerCase();
  }

  private parseChainId(chainId: number | string): number {
    if (typeof chainId === 'string' && !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(chainId)) throw providerErrors.invalidParams(`Invalid chainId: ${chainId}`);
    const parsed = Number(chainId);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw providerErrors.invalidParams(`Invalid chainId: ${chainId}`);
    return parsed;
  }

  private chainIdHex(): string { return `0x${this.currentChainId.toString(16)}`; }

  /** EIP-1193 connectivity check used by dApp adapters. */
  isConnected(): boolean { return this.connected; }

  /** Legacy convenience properties exposed by most injected providers. */
  get chainId(): string { return this.chainIdHex(); }
  get selectedAddress(): string | null {
    return this.authorizedAccounts()[0] || null;
  }

  get providers(): EIP1193Provider[] { return [this]; }

  /** Legacy convenience aliases used by older web3 libraries. */
  async enable(): Promise<string[]> {
    return this.request({ method: 'eth_requestAccounts' }) as Promise<string[]>;
  }

  sendAsync(request: unknown, callback: (error: unknown, response?: unknown) => void): void {
    const requests = Array.isArray(request) ? request : [request];
    void Promise.all(requests.map(async (item) => {
      const payload = (item || {}) as Record<string, unknown>;
      try {
        const result = await this.request({ method: String(payload.method || ''), params: (payload.params as unknown[] | Record<string, unknown> | undefined) });
        return { jsonrpc: '2.0', id: payload.id, result };
      } catch (error) {
        const value = error as Partial<WalletProviderError>;
        return { jsonrpc: '2.0', id: payload.id, error: { code: value.code ?? -32603, message: value.message ?? 'Provider request failed', data: value.data } };
      }
    })).then((responses) => callback(null, Array.isArray(request) ? responses : responses[0]));
  }

  send(request: unknown, callback?: unknown): unknown {
    if (typeof request === 'string') return this.request({ method: request, params: Array.isArray(callback) ? callback as unknown[] : [] });
    if (typeof callback === 'function') { this.sendAsync(request, callback as (error: unknown, response?: unknown) => void); return undefined; }
    const payload = (request || {}) as Record<string, unknown>;
    return this.request({ method: String(payload.method || ''), params: payload.params as unknown[] | Record<string, unknown> | undefined }).then((result) => ({ jsonrpc: '2.0', id: payload.id, result }));
  }

  on(event: ProviderEvent | string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, set = new Set());
    set.add(listener);
    return this;
  }

  addListener(event: ProviderEvent | string, listener: Listener): this { return this.on(event, listener); }

  removeListener(event: ProviderEvent | string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  off(event: ProviderEvent | string, listener: Listener): this { return this.removeListener(event, listener); }

  removeAllListeners(event?: ProviderEvent | string): this {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }

  once(event: ProviderEvent | string, listener: Listener): this {
    const wrapper = (...args: any[]) => { this.removeListener(event, wrapper); listener(...args); };
    return this.on(event, wrapper);
  }

  private emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) || []) listener(...args);
  }

  private broadcast(event: string, ...args: any[]): void {
    for (const scope of this.state.scopes.values()) scope.emit(event, ...args);
  }

  /** Only the granting origin sees account events. The host root also gets the origin as a second argument. */
  private emitAccountsChanged(): void {
    const accounts = this.authorizedAccounts();
    this.emit('accountsChanged', accounts, this.origin);
    if (this.state.root !== this) this.state.root?.emit('accountsChanged', accounts, this.origin);
  }

  emitMessage(message: { type: string; data?: unknown }): void {
    this.emit('message', message);
  }

  /** Return a provider scoped to another dApp origin, sharing wallet state. */
  forOrigin(origin: string): WalletProvider {
    const normalizedOrigin = origin.trim() || 'default';
    const existing = this.state.scopes.get(normalizedOrigin);
    if (existing) return existing;
    return new WalletProvider({
      rpcUrl: this.rpcUrl,
      chainId: this.currentChainId,
      rpcUrls: Object.fromEntries([...this.rpcUrls].map(([id, url]) => [String(id), url])),
      accounts: this.accounts,
      origin: normalizedOrigin,
      permissions: this.permissions,
      fetch: this.transport,
      signer: this.signer,
      requestAccounts: this.requestAccountsCallback,
    }, this.state);
  }

  setAccounts(accounts: string[]): void {
    this.accounts = accounts.map((a) => this.normalizeAccount(a));
    for (const scope of this.state.scopes.values()) scope.emitAccountsChanged();
  }

  setChainId(chainId: number | string): void {
    const next = this.parseChainId(chainId);
    if (next === this.currentChainId) return;
    const nextRpcUrl = this.rpcUrls.get(next);
    if (nextRpcUrl) this.rpcUrl = nextRpcUrl;
    this.currentChainId = next;
    this.broadcast('chainChanged', this.chainIdHex());
  }

  disconnect(message = 'Provider disconnected'): void {
    if (!this.connected) return;
    this.connected = false;
    this.broadcast('disconnect', new WalletProviderError(4900, message));
  }

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.broadcast('connect', { chainId: this.chainIdHex() });
  }

  async request({ method, params = [] }: RequestArguments): Promise<unknown> {
    if (!method || typeof method !== 'string') throw providerErrors.invalidParams('method is required');
    if (!this.connected && method !== 'eth_chainId' && method !== 'net_version') throw providerErrors.disconnected();
    const p = Array.isArray(params) ? params : [params];
    switch (method) {
      case 'eth_chainId': return this.chainIdHex();
      case 'net_version': return String(this.currentChainId);
      case 'eth_accounts': return this.authorizedAccounts();
      case 'eth_coinbase': return this.authorizedAccounts()[0] || null;
      case 'metamask_getProviderState': return {
        accounts: this.authorizedAccounts(),
        chainId: this.chainIdHex(),
        isConnected: this.connected,
      };
      case 'eth_requestAccounts': return this.requestAccounts();
      case 'wallet_getPermissions': return this.permissions.getPermissions(this.origin);
      case 'wallet_requestPermissions': return this.requestPermissions(p);
      case 'wallet_revokePermissions': return this.revokePermissions(p);
      case 'wallet_switchEthereumChain': return this.switchChain(p);
      case 'wallet_addEthereumChain': return this.addChain(p);
      case 'wallet_watchAsset': throw providerErrors.unsupported('Adding assets from a DApp is not supported yet');
      case 'eth_sendTransaction': return this.sendTransaction(p);
      case 'personal_sign':
      case 'eth_sign':
      case 'eth_signTypedData':
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4':
        return this.sign(method, p);
      default:
        if (!READ_RPC_METHODS.has(method)) throw providerErrors.unsupported(`RPC method is not supported: ${method}`);
        return this.forward(method, p);
    }
  }

  private async requestAccounts(): Promise<string[]> {
    const existing = this.authorizedAccounts();
    if (existing.length) return existing;
    if (!this.requestAccountsCallback) throw providerErrors.userRejected('Account access requires host approval');
    const selected = await this.requestAccountsCallback(this.origin);
    if (!selected?.length) throw providerErrors.userRejected();
    const normalized = selected.map((account) => this.normalizeAccount(account));
    if (normalized.some((account) => !this.accounts.includes(account))) throw providerErrors.unauthorized('Requested account is not controlled by this wallet');
    const granted = this.permissions.grantAccounts(this.origin, normalized);
    this.emitAccountsChanged();
    return granted;
  }

  private async requestPermissions(params: unknown[]): Promise<unknown> {
    const requested = (params[0] || {}) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(requested, 'eth_accounts') || Object.keys(requested).some((key) => key !== 'eth_accounts')) throw providerErrors.unsupported('Only eth_accounts is supported');
    await this.requestAccounts();
    return this.permissions.getPermissions(this.origin);
  }

  private revokePermissions(params: unknown[]): [] {
    const request = (params[0] || {}) as Record<string, unknown>;
    const capability = String(request.parentCapability || 'eth_accounts');
    this.permissions.revoke(this.origin, capability as 'eth_accounts');
    this.emitAccountsChanged();
    return [];
  }

  private switchChain(params: unknown[]): null {
    if (!this.authorizedAccounts().length) throw providerErrors.unauthorized('Connect the wallet before switching its network');
    const request = (params[0] || {}) as Record<string, unknown>;
    if (typeof request.chainId !== 'string') throw providerErrors.invalidParams('chainId is required');
    const next = this.parseChainId(request.chainId);
    if (this.rpcUrls.size > 0 && !this.rpcUrls.has(next)) {
      throw new WalletProviderError(4902, 'The requested chain has not been added');
    }
    this.setChainId(request.chainId);
    return null;
  }

  private addChain(params: unknown[]): null {
    const request = (params[0] || {}) as Record<string, unknown>;
    if (typeof request.chainId !== 'string') throw providerErrors.invalidParams('chainId is required');
    const chain = this.parseChainId(request.chainId);
    // Existing RPC configuration belongs to the host wallet. A website may
    // acknowledge that a chain exists, but cannot silently replace its RPC.
    if (this.rpcUrls.has(chain)) return null;
    throw providerErrors.unsupported('Only networks configured by the wallet are supported');
  }

  private assertAuthorized(account: unknown): string {
    if (typeof account !== 'string') throw providerErrors.invalidParams('An account address is required');
    const normalized = this.normalizeAccount(account);
    if (!this.authorizedAccounts().includes(normalized)) throw providerErrors.unauthorized();
    return normalized;
  }

  private async sendTransaction(params: unknown[]): Promise<unknown> {
    if (params.length !== 1) throw providerErrors.invalidParams('Exactly one transaction is required');
    const tx = normalizeTransaction(params[0]);
    if (tx.chainId !== undefined && BigInt(String(tx.chainId)) !== BigInt(this.currentChainId)) throw providerErrors.chainDisconnected('Transaction chainId does not match the selected network');
    const from = tx.from ? this.assertAuthorized(tx.from) : this.authorizedAccounts()[0];
    if (!from) throw providerErrors.unauthorized();
    // Signing adapters must never fall back to account 0 when that account
    // was not the one granted to this origin.
    const normalizedParams = snapshotSigningParams([{ ...tx, from }]);
    if (!this.signer) throw providerErrors.unsupported('Local transaction signing is unavailable');
    return this.signer('eth_sendTransaction', normalizedParams, this.origin);
  }

  private async sign(method: string, params: unknown[]): Promise<unknown> {
    if (params.length !== 2) throw providerErrors.invalidParams('Exactly two signing parameters are required');
    const snapshot = snapshotSigningParams(params);
    const account = method === 'personal_sign' ? snapshot[1] : snapshot[0];
    this.assertAuthorized(account);
    if (!this.signer) throw providerErrors.unsupported('Local signing is unavailable');
    return this.signer(method, snapshot, this.origin);
  }

  private async forward(method: string, params: unknown[]): Promise<unknown> {
    const response = await this.transport(this.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    });
    if (!response.ok) throw providerErrors.internal(`RPC request failed (${response.status})`);
    const body = await response.json();
    if (body?.error) throw new WalletProviderError(body.error.code || -32603, body.error.message || 'JSON-RPC error', body.error.data);
    return body?.result;
  }
}

