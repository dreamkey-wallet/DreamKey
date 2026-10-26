import {
  Contract,
  HDNodeWallet,
  JsonRpcProvider,
  Mnemonic,
  Wallet,
  formatEther,
  formatUnits,
  isAddress,
  parseEther,
  parseUnits,
  randomBytes,
  type BlockTag,
  type ContractTransactionResponse,
  type TransactionReceipt,
  type TransactionRequest,
  type TransactionResponse,
} from "ethers";
import { WalletVault } from "./vault.js";
import { VerifiedRpcProvider } from "./rpc-provider.js";
import { getUncertainBroadcastHash, RpcBroadcastUncertainError } from './rpc-broadcast.js';
import type { RpcTransport } from "../provider/types.js";
import type { AssetTransaction } from './asset-history.js';
import type {
  AccountInfo,
  BiometricAuthenticator,
  Erc20Balance,
  Erc20Token,
  NetworkConfig,
  PasswordVerifier,
  TransactionStatus,
  VaultStorage,
  WalletCoreOptions,
  WalletKind,
} from "./types.js";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

export const DEFAULT_EVM_PATH = "m/44'/60'/{index}'/0/0";

export type FeeOverrides = Pick<TransactionRequest, 'gasLimit' | 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'>;

function feeFields(overrides: FeeOverrides): FeeOverrides {
  const result: FeeOverrides = {};
  for (const key of ['gasLimit', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const) {
    if (overrides[key] != null) result[key] = overrides[key];
  }
  return result;
}

function pathFor(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("Account index must be a non-negative integer");
  return DEFAULT_EVM_PATH.replace("{index}", String(index));
}

function assertAddress(value: string, label: string): void {
  if (!isAddress(value)) throw new Error(`${label} is not a valid EVM address`);
}

/**
 * Self-contained EVM wallet core. RPC endpoints and all network metadata are
 * supplied by the host application; no Infura, Firebase or MetaMask service is
 * used here.
 */
export class WalletCore {
  readonly vault: WalletVault;
  private readonly networks = new Map<string, NetworkConfig>();
  private readonly providers = new Map<string, JsonRpcProvider>();
  private readonly networkChecks = new Map<string, Promise<void>>();
  private readonly accountInfo = new Map<number, AccountInfo>();
  private readonly submittedTransactions = new Map<string, AssetTransaction>();
  private readonly transactionRecorder?: WalletCoreOptions['transactionRecorder'];
  private accountCount = 1;
  /** Non-null only for a read-only observed address. Watch cores never hold key material. */
  private readonly watchAddress: string | null;

  private constructor(vault: WalletVault, options: WalletCoreOptions = {}, watchAddress: string | null = null) {
    const accountCount = options.accountCount === undefined ? 1 : options.accountCount;
    if (!Number.isInteger(accountCount) || accountCount < 1 || accountCount > 1000) {
      throw new Error("Account count must be an integer from 1 through 1000");
    }
    if (watchAddress === null && vault.getWalletKind() === "privateKey" && accountCount !== 1) {
      throw new Error("A private-key wallet contains one account");
    }
    this.accountCount = accountCount;
    this.transactionRecorder = options.transactionRecorder;
    this.vault = vault;
    this.watchAddress = watchAddress;
    for (const network of options.networks ?? []) this.addNetwork(network);
  }

  static create(
    options: WalletCoreOptions = {},
    strength: 128 | 256 = 128,
  ): WalletCore {
    if (strength !== 128 && strength !== 256) throw new Error("Invalid mnemonic strength");
    // Generate the phrase only; Wallet.createRandom also derives a signer that
    // is discarded before the new wallet is persisted.
    const phrase = Mnemonic.entropyToPhrase(randomBytes(strength / 8));
    return new WalletCore(WalletVault.fromMnemonic(phrase, options.storage, options.biometric, options.passwordVerifier), options);
  }

  static fromMnemonic(mnemonic: string, options: WalletCoreOptions = {}): WalletCore {
    return new WalletCore(WalletVault.fromMnemonic(mnemonic, options.storage, options.biometric, options.passwordVerifier), options);
  }

  static fromPrivateKey(privateKey: string, options: WalletCoreOptions = {}): WalletCore {
    return new WalletCore(WalletVault.fromPrivateKey(privateKey, options.storage, options.biometric, options.passwordVerifier), options);
  }

  /** Restore a protected storage envelope, including the legacy raw mnemonic format. */
  static fromSerializedVault(value: string, options: WalletCoreOptions = {}): WalletCore {
    return new WalletCore(WalletVault.fromSerializedVault(value, options.storage, options.biometric, options.passwordVerifier), options);
  }

  /** For apps that import an encrypted/secure-storage backed vault. */
  static fromVault(vault: WalletVault, options: WalletCoreOptions = {}): WalletCore {
    return new WalletCore(vault, options);
  }

  /**
   * Creates a read-only core backed only by a public address. It intentionally
   * reuses balance/history readers while every signer and write method fails
   * closed. No placeholder secret is ever generated or persisted.
   */
  static fromWatchAddress(address: string, options: WalletCoreOptions = {}): WalletCore {
    assertAddress(address, 'Watch-only address');
    // The vault field stays typed for backwards compatibility with existing
    // consumers; watch-only methods guard it before any access.
    return new WalletCore(null as unknown as WalletVault, { ...options, accountCount: 1 }, address);
  }

  isWatchOnly(): boolean {
    return this.watchAddress !== null;
  }

  private controlledVault(): WalletVault {
    if (this.watchAddress !== null) throw new Error('This wallet is watch-only');
    return this.vault;
  }

  getMnemonic(): string {
    return this.controlledVault().getMnemonic();
  }

  getWalletKind(): WalletKind {
    // Keep the historical two-value return type. Callers that need to
    // distinguish observed addresses should use isWatchOnly().
    return this.watchAddress !== null ? 'privateKey' : this.vault.getWalletKind();
  }

  /** Returns the public address for controlled or observed wallets. */
  getPublicAddress(): string {
    return this.getAccount(0).address;
  }

  canDeriveAccounts(): boolean {
    return this.getWalletKind() === "mnemonic";
  }

  addNetwork(network: NetworkConfig): void {
    if (!network.id || !network.rpcUrl) throw new Error("Network id and rpcUrl are required");
    if (!Number.isInteger(network.chainId) || network.chainId < 0) throw new Error("Invalid chainId");
    this.networks.set(network.id, { ...network, rpcFallbackUrls: network.rpcFallbackUrls ? [...network.rpcFallbackUrls] : undefined });
    this.networkChecks.delete(network.id);
    this.providers.delete(network.id);
  }

  removeNetwork(id: string): void {
    this.networkChecks.delete(id);
    this.providers.delete(id);
    this.networks.delete(id);
  }

  listNetworks(): NetworkConfig[] {
    return [...this.networks.values()].map((n) => ({ ...n, rpcFallbackUrls: n.rpcFallbackUrls ? [...n.rpcFallbackUrls] : undefined }));
  }

  getNetwork(id: string): NetworkConfig {
    const network = this.networks.get(id);
    if (!network) throw new Error(`Unknown network: ${id}`);
    return network;
  }

  /** Fail closed when an RPC endpoint serves a different chain than configured. */
  async assertNetwork(networkId: string): Promise<void> {
    const pending = this.networkChecks.get(networkId);
    if (pending) return pending;
    const expected = this.getNetwork(networkId).chainId;
    const check = (async () => {
      const actual: unknown = await this.provider(networkId).send('eth_chainId', []);
      if (typeof actual !== 'string' || !/^0x[\da-f]+$/i.test(actual) || BigInt(actual) !== BigInt(expected)) {
        throw new Error('RPC chain does not match the selected network');
      }
    })();
    this.networkChecks.set(networkId, check);
    try { await check; }
    finally { if (this.networkChecks.get(networkId) === check) this.networkChecks.delete(networkId); }
  }

  private provider(networkId: string): JsonRpcProvider {
    const existing = this.providers.get(networkId);
    if (existing) return existing;
    const network = this.getNetwork(networkId);
    const provider = new VerifiedRpcProvider(network);
    this.providers.set(networkId, provider);
    return provider;
  }

  /** Share the verified endpoint selection with the Dapp provider. */
  getRpcTransport(networkId: string): RpcTransport {
    const provider = this.provider(networkId);
    if (!(provider instanceof VerifiedRpcProvider)) throw new Error('RPC transport is unavailable');
    return provider.getRpcTransport();
  }

  private accountWallet(index: number): HDNodeWallet | Wallet {
    if (this.watchAddress !== null) throw new Error('This wallet is watch-only');
    if (this.getWalletKind() === "privateKey") {
      if (index !== 0) throw new Error("A private-key wallet only contains account 0");
      return new Wallet(this.controlledVault().getPrivateKey());
    }
    const path = pathFor(index);
    const seed = this.controlledVault().getMnemonicSeed();
    try {
      return HDNodeWallet.fromSeed(seed).derivePath(path);
    } finally {
      seed.fill(0);
    }
  }

  getAccount(index: number): AccountInfo {
    if (this.watchAddress !== null) {
      if (index !== 0) throw new Error('A watch-only wallet contains account 0 only');
      return { index: 0, path: '', address: this.watchAddress };
    }
    // Cache only public metadata. Never retain an HD wallet or signing key.
    if (this.controlledVault().isLocked()) throw new Error('Wallet is locked');
    const existing = this.accountInfo.get(index);
    if (existing) return { ...existing };
    const wallet = this.accountWallet(index);
    const account = { index, path: this.canDeriveAccounts() ? pathFor(index) : "", address: wallet.address };
    this.accountInfo.set(index, account);
    return { ...account };
  }

  listAccounts(): AccountInfo[] {
    return Array.from({ length: this.accountCount }, (_, index) => this.getAccount(index));
  }

  addAccount(): AccountInfo {
    if (this.watchAddress !== null) throw new Error('Additional accounts cannot be added to a watch-only wallet');
    if (!this.canDeriveAccounts()) throw new Error("Additional accounts cannot be derived from a private key");
    if (this.accountCount >= 1000) throw new Error("The wallet has reached its 1000 account limit");
    const account = this.getAccount(this.accountCount);
    this.accountCount += 1;
    return account;
  }

  /** Returns a signer connected to the supplied network, or an offline signer. */
  getSigner(index = 0, networkId?: string): HDNodeWallet | Wallet {
    if (this.watchAddress !== null) throw new Error('This wallet is watch-only');
    const signer = this.accountWallet(index);
    return networkId ? signer.connect(this.provider(networkId)) : signer;
  }

  async getNativeBalance(index: number, networkId: string, blockTag: BlockTag = "latest"): Promise<string> {
    await this.assertNetwork(networkId);
    const balance = await this.provider(networkId).getBalance(this.getAccount(index).address, blockTag);
    return formatEther(balance);
  }

  async getErc20Balance(index: number, networkId: string, token: Erc20Token, blockTag: BlockTag = "latest"): Promise<Erc20Balance> {
    assertAddress(token.address, "Token address");
    await this.assertNetwork(networkId);
    const provider = this.provider(networkId);
    const contract = new Contract(token.address, ERC20_ABI, provider);
    const [raw, decimals, symbol, name] = await Promise.all([
      contract.balanceOf(this.getAccount(index).address, { blockTag }),
      token.decimals ?? contract.decimals(),
      token.symbol ?? contract.symbol().catch(() => undefined),
      token.name ?? contract.name().catch(() => undefined),
    ]);
    const metadata = { ...token, decimals: Number(decimals), symbol, name };
    return { token: metadata, raw: raw.toString(), formatted: formatUnits(raw, metadata.decimals) };
  }

  async sendNative(index: number, networkId: string, to: string, amount: string, overrides: FeeOverrides = {}): Promise<TransactionResponse> {
    assertAddress(to, "Recipient");
    await this.assertNetwork(networkId);
    const value = parseEther(amount);
    const from = this.getAccount(index).address;
    try {
      const response = await this.getSigner(index, networkId).sendTransaction({ ...feeFields(overrides), to, value });
      this.recordSubmittedTransaction(networkId, response, { to, rawValue: value.toString() });
      return response;
    } catch (error) {
      const hash = getUncertainBroadcastHash(error);
      if (!hash) throw error;
      this.recordSubmittedTransaction(networkId, { hash, from, to, value, data: '0x' });
      throw new RpcBroadcastUncertainError(hash);
    }
  }

  async sendErc20(index: number, networkId: string, token: Erc20Token, to: string, amount: string, overrides: FeeOverrides = {}): Promise<ContractTransactionResponse> {
    assertAddress(token.address, "Token address");
    assertAddress(to, "Recipient");
    await this.assertNetwork(networkId);
    const provider = this.provider(networkId);
    const contract = new Contract(token.address, ERC20_ABI, this.getSigner(index, networkId));
    const decimals = token.decimals ?? Number(await new Contract(token.address, ERC20_ABI, provider).decimals());
    const rawValue = parseUnits(amount, decimals);
    const from = this.getAccount(index).address;
    const transfer = { to, tokenAddress: token.address, symbol: token.symbol ?? 'TOKEN', decimals, rawValue: rawValue.toString() };
    try {
      const response = await contract.transfer(to, rawValue, feeFields(overrides));
      this.recordSubmittedTransaction(networkId, response, transfer);
      return response;
    } catch (error) {
      const hash = getUncertainBroadcastHash(error);
      if (!hash) throw error;
      this.recordSubmittedTransaction(networkId, { hash, from, to: token.address, value: 0n, data: '0x' }, transfer);
      throw new RpcBroadcastUncertainError(hash);
    }
  }

  /**
   * Track an accepted or uncertain broadcast without storing signing material. Arbitrary
   * DApp calls remain native interactions unless an explicit ERC-20 transfer
   * was prepared by the wallet. Recording errors never change broadcast success.
   */
  recordSubmittedTransaction(networkId: string, transaction: Pick<TransactionResponse, 'hash' | 'from' | 'to' | 'value' | 'data'>,
    transfer?: { to: string; rawValue: string; tokenAddress?: string; symbol?: string; decimals?: number }): void {
    if (!this.transactionRecorder) return;
    try {
      const network = this.getNetwork(networkId);
      const from = transaction.from;
      const to = transfer?.to ?? transaction.to;
      if (!isAddress(from) || !to || !isAddress(to) || !/^0x[\da-f]{64}$/i.test(transaction.hash)) return;
      const record: AssetTransaction = {
        id: `${transaction.hash.toLowerCase()}:${transfer?.tokenAddress?.toLowerCase() ?? 'native'}:submitted`,
        hash: transaction.hash.toLowerCase(), chainId: network.chainId, accountAddress: from,
        from, to, tokenAddress: transfer?.tokenAddress, symbol: transfer?.symbol ?? network.nativeSymbol ?? 'ETH',
        decimals: transfer?.tokenAddress ? transfer.decimals ?? 18 : 18,
        rawValue: BigInt(transfer?.rawValue ?? transaction.value ?? 0n).toString(),
        direction: from.toLowerCase() === to.toLowerCase() ? 'self' : 'out', state: 'pending',
        timestamp: Math.floor(Date.now() / 1000), source: 'local',
        type: !transfer && transaction.data !== '0x' ? 'interaction' : 'transfer',
      };
      this.submittedTransactions.set(`${networkId}:${record.hash}`, record);
      if (this.submittedTransactions.size > 500) this.submittedTransactions.delete(this.submittedTransactions.keys().next().value!);
      this.persistTransaction(record);
    } catch { /* A local metadata failure must never replay or fail an accepted broadcast. */ }
  }

  private persistTransaction(record: AssetTransaction): void {
    if (!this.transactionRecorder) return;
    void Promise.resolve().then(() => this.transactionRecorder!({ ...record })).catch(() => undefined);
  }

  private recordTransactionStatus(networkId: string, status: TransactionStatus): void {
    const key = `${networkId}:${status.hash.toLowerCase()}`;
    const previous = this.submittedTransactions.get(key);
    if (!previous || status.state === 'not-found' || status.state === previous.state) return;
    const record = { ...previous, state: status.state, blockNumber: status.blockNumber };
    this.submittedTransactions.set(key, record);
    this.persistTransaction(record);
  }

  async signMessage(index: number, message: string | Uint8Array): Promise<string> {
    return this.getSigner(index).signMessage(message);
  }

  async signTransaction(index: number, transaction: TransactionRequest): Promise<string> {
    return this.getSigner(index).signTransaction(transaction);
  }

  async getTransactionStatus(networkId: string, hash: string): Promise<TransactionStatus> {
    const provider = this.provider(networkId);
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) {
      const tx = await provider.getTransaction(hash);
      return tx ? { hash, state: "pending" } : { hash, state: "not-found" };
    }
    const status = await this.statusFromReceipt(provider, hash, receipt);
    this.recordTransactionStatus(networkId, status);
    return status;
  }

  async waitForTransaction(networkId: string, hash: string, confirmations = 1, timeoutMs?: number): Promise<TransactionStatus> {
    const receipt = await this.provider(networkId).waitForTransaction(hash, confirmations, timeoutMs);
    if (!receipt) return { hash, state: "pending" };
    const status = await this.statusFromReceipt(this.provider(networkId), hash, receipt);
    this.recordTransactionStatus(networkId, status);
    return status;
  }

  private async statusFromReceipt(provider: JsonRpcProvider, hash: string, receipt: TransactionReceipt): Promise<TransactionStatus> {
    // A receipt already proves the transaction reached a terminal state. A
    // public RPC can serve the receipt while its latest-block endpoint is
    // temporarily unavailable, so confirmation count is best effort.
    let latest: number | undefined;
    try { latest = await provider.getBlockNumber(); } catch { latest = undefined; }
    return {
      hash,
      state: receipt.status === 1 ? "confirmed" : "failed",
      blockNumber: receipt.blockNumber,
      confirmations: latest === undefined ? undefined : Math.max(0, latest - receipt.blockNumber + 1),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.gasPrice?.toString(),
    };
  }
}

