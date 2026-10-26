import { HDNodeWallet, Wallet, getAddress, isAddress, keccak256, toUtf8Bytes } from 'ethers';
import { WalletCore } from './wallet-core.js';
import type { AccountInfo, BiometricAuthenticator, NetworkConfig, PasswordVerifier, VaultStorage, WalletKind } from './types.js';

/** A wallet entry can either control keys or be a read-only observed address. */
export type ManagedWalletKind = WalletKind | 'watch';

export interface ManagedWalletRecord {
  /** Stable local identifier. It is safe to persist and expose in UI. */
  id: string;
  label: string;
  address: string;
  kind: ManagedWalletKind;
  watchOnly: boolean;
}

/** Memory-friendly adapter for tests and hosts that already encrypt a collection. */
export class MemoryWalletManagerStorage implements WalletManagerStorage {
  constructor(private value: string | null = null) {}
  async save(value: string): Promise<void> { this.value = value; }
  async load(): Promise<string | null> { return this.value; }
  async clear(): Promise<void> { this.value = null; }
}

export interface WalletManagerStorage {
  save(value: string): Promise<void>;
  load(): Promise<string | null>;
  clear(): Promise<void>;
}

export interface WalletManagerOptions {
  networks?: NetworkConfig[];
  storage?: WalletManagerStorage;
  /** Optional secure storage used if a managed core is explicitly locked. */
  vaultStorage?: VaultStorage;
  biometric?: BiometricAuthenticator;
  passwordVerifier?: PasswordVerifier;
  transactionRecorder?: import('./types.js').WalletCoreOptions['transactionRecorder'];
}

interface ManagedWalletEnvelope {
  version: 1;
  id: string;
  label: string;
  kind: ManagedWalletKind;
  address: string;
  /** WalletCore's versioned vault envelope. Absent for watch-only entries. */
  vault?: string;
}

interface WalletManagerEnvelope {
  version: 1;
  wallets: ManagedWalletEnvelope[];
  selectedId?: string;
}

interface ManagedEntry {
  record: ManagedWalletRecord;
  core?: WalletCore;
}

const MAX_MANAGED_WALLETS = 1000;

function normalizeLabel(label: string | undefined, fallback: string): string {
  const value = typeof label === 'string' ? label.trim().slice(0, 80) : '';
  return value || fallback;
}

function defaultLabel(kind: ManagedWalletKind, sequence: number): string {
  const base = kind === 'watch' ? 'Observed wallet' : kind === 'privateKey' ? 'Imported account' : 'Wallet';
  return `${base} ${Math.max(1, sequence)}`;
}

function assertWatchAddress(address: string): string {
  if (!isAddress(address)) throw new Error('Invalid watch-only address');
  return getAddress(address);
}

function idFor(kind: ManagedWalletKind, address: string, nonce = ''): string {
  const digest = keccak256(toUtf8Bytes(`${kind}:${address.toLowerCase()}:${nonce}`)).slice(2, 18);
  return `wallet-${digest}`;
}

function coreOptions(options: WalletManagerOptions) {
  return {
    networks: options.networks,
    storage: options.vaultStorage,
    biometric: options.biometric,
    passwordVerifier: options.passwordVerifier,
    transactionRecorder: options.transactionRecorder,
  };
}

/**
 * Local wallet collection used by account management screens.
 *
 * A mnemonic or private-key import creates exactly one managed wallet entry.
 * It never derives a second entry implicitly. Watch-only entries intentionally
 * have a read-only WalletCore projection and can therefore never sign or send
 * transactions.
 */
export class WalletManager {
  private readonly entries = new Map<string, ManagedEntry>();
  private selectedId: string | null = null;
  private generation = 0;
  private readonly pendingCores = new Set<WalletCore>();

  constructor(private readonly options: WalletManagerOptions = {}) {}

  list(): ManagedWalletRecord[] {
    return [...this.entries.values()].map(({ record }) => ({ ...record }));
  }

  get(id: string): ManagedWalletRecord {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Wallet not found');
    return { ...entry.record };
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }

  setSelectedId(id: string): void {
    this.get(id);
    this.selectedId = id;
  }

  /** Update a wallet's local display name without changing its address or keys. */
  rename(id: string, label: string): ManagedWalletRecord {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Wallet not found');
    const value = typeof label === 'string' ? label.trim().slice(0, 80) : '';
    if (!value) throw new Error('Wallet name cannot be empty');
    entry.record.label = value;
    return { ...entry.record };
  }

  /** Rename a wallet and persist the updated collection atomically. */
  async renameAndPersist(id: string, label: string): Promise<ManagedWalletRecord> {
    const generation = this.generation;
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Wallet not found');
    const value = typeof label === 'string' ? label.trim().slice(0, 80) : '';
    if (!value) throw new Error('Wallet name cannot be empty');
    const next = new Map(this.entries);
    next.set(id, { ...entry, record: { ...entry.record, label: value } });
    await this.requireStorage().save(this.serializeState(next, this.selectedId));
    this.assertCurrent(generation);
    entry.record.label = value;
    return { ...entry.record };
  }

  async selectAndPersist(id: string): Promise<void> {
    const generation = this.generation;
    this.get(id);
    await this.requireStorage().save(this.serializeState(this.entries, id));
    this.assertCurrent(generation);
    this.selectedId = id;
  }

  getSelected(): ManagedWalletRecord | null {
    return this.selectedId ? this.get(this.selectedId) : null;
  }

  getSelectedCore(): WalletCore | null {
    return this.selectedId ? this.getCore(this.selectedId) : null;
  }

  getCore(id: string): WalletCore {
    const entry = this.entries.get(id);
    if (!entry?.core) throw new Error('Wallet core is unavailable');
    return entry.core;
  }

  addMnemonic(mnemonic: string, label?: string): ManagedWalletRecord {
    const core = WalletCore.fromMnemonic(mnemonic, coreOptions(this.options));
    const account = core.getAccount(0);
    return this.addControlledCore(core, 'mnemonic', account.address, normalizeLabel(label, defaultLabel('mnemonic', this.nextSequence('mnemonic'))));
  }

  addPrivateKey(privateKey: string, label?: string): ManagedWalletRecord {
    const core = WalletCore.fromPrivateKey(privateKey, coreOptions(this.options));
    const account = core.getAccount(0);
    return this.addControlledCore(core, 'privateKey', account.address, normalizeLabel(label, defaultLabel('privateKey', this.nextSequence('privateKey'))));
  }

  addWatchAddress(address: string, label?: string): ManagedWalletRecord {
    const normalized = assertWatchAddress(address);
    const record: ManagedWalletRecord = {
      id: idFor('watch', normalized),
      label: normalizeLabel(label, defaultLabel('watch', this.nextSequence('watch'))),
      address: normalized,
      kind: 'watch',
      watchOnly: true,
    };
    this.assertUniqueAddress(normalized);
    this.entries.set(record.id, { record, core: WalletCore.fromWatchAddress(normalized, coreOptions(this.options)) });
    this.selectedId ??= record.id;
    return { ...record };
  }

  /** Register an already-created core during migration from the legacy single-wallet flow. */
  addCore(core: WalletCore, label?: string): ManagedWalletRecord {
    if (core.isWatchOnly()) return this.addWatchAddress(core.getAccount(0).address, label);
    const account = core.getAccount(0);
    const kind = core.getWalletKind();
    return this.addControlledCore(core, kind, account.address, normalizeLabel(label, defaultLabel(kind, this.nextSequence(kind))));
  }

  async addCoreAndPersist(core: WalletCore, label?: string): Promise<ManagedWalletRecord> {
    const generation = this.generation;
    const record = this.recordForCore(core, label);
    this.assertUniqueAddress(record.address);
    const entry: ManagedEntry = { record, core };
    const next = new Map(this.entries);
    next.set(record.id, entry);
    const selected = this.selectedId ?? record.id;
    this.pendingCores.add(core);
    try {
      await this.requireStorage().save(this.serializeState(next, selected));
    } finally {
      this.pendingCores.delete(core);
    }
    if (generation !== this.generation) {
      if (!core.isWatchOnly()) core.vault.forget();
      throw new Error('Wallet session has expired');
    }
    this.entries.set(record.id, entry);
    this.selectedId = selected;
    return { ...record };
  }

  async addWatchAddressAndPersist(address: string, label?: string): Promise<ManagedWalletRecord> {
    const generation = this.generation;
    const normalized = assertWatchAddress(address);
    const record: ManagedWalletRecord = { id: idFor('watch', normalized), label: normalizeLabel(label, defaultLabel('watch', this.nextSequence('watch'))), address: normalized, kind: 'watch', watchOnly: true };
    this.assertUniqueAddress(normalized);
    const entry: ManagedEntry = { record, core: WalletCore.fromWatchAddress(normalized, coreOptions(this.options)) };
    const next = new Map(this.entries); next.set(record.id, entry);
    const selected = this.selectedId ?? record.id;
    await this.requireStorage().save(this.serializeState(next, selected));
    this.assertCurrent(generation);
    this.entries.set(record.id, entry); this.selectedId = selected;
    return { ...record };
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.core && !entry.core.isWatchOnly()) entry.core.vault.forget();
    if (!this.entries.delete(id)) throw new Error('Wallet not found');
    if (this.selectedId === id) this.selectedId = this.entries.keys().next().value ?? null;
  }

  async removeAndPersist(id: string): Promise<void> {
    const generation = this.generation;
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Wallet not found');
    const next = new Map(this.entries); next.delete(id);
    const selected = this.selectedId === id ? (next.keys().next().value ?? null) : this.selectedId;
    await this.requireStorage().save(this.serializeState(next, selected));
    this.assertCurrent(generation);
    entry.core?.vault?.forget?.();
    this.entries.delete(id); this.selectedId = selected;
  }

  /** Export a controlled account's raw private key after the caller's unlock gate. */
  exportPrivateKey(id: string, accountIndex = 0): string {
    const entry = this.entries.get(id);
    if (!entry?.core) throw new Error('This wallet is watch-only');
    const core = entry.core;
    const account = core.getAccount(accountIndex);
    const signer = core.getSigner(account.index);
    const key = signer instanceof Wallet || signer instanceof HDNodeWallet ? signer.privateKey : undefined;
    if (!key) throw new Error('Private key export is unavailable for this wallet');
    return key;
  }

  /** Execute a sensitive export only after the host has completed its unlock gate. */
  async exportPrivateKeyAfterUnlock(id: string, unlock: () => Promise<boolean>, accountIndex = 0): Promise<string> {
    if (!(await unlock())) throw new Error('Wallet unlock was rejected');
    return this.exportPrivateKey(id, accountIndex);
  }

  /** Export a mnemonic wallet's recovery phrase after the caller's unlock gate. */
  exportMnemonic(id: string): string {
    const entry = this.entries.get(id);
    if (!entry?.core) throw new Error('This wallet is watch-only');
    const core = entry.core;
    return core.getMnemonic();
  }

  async exportMnemonicAfterUnlock(id: string, unlock: () => Promise<boolean>): Promise<string> {
    if (!(await unlock())) throw new Error('Wallet unlock was rejected');
    return this.exportMnemonic(id);
  }

  /** Returns a public account projection suitable for account pickers. */
  listAccounts(): Array<ManagedWalletRecord & { index: number; path: string }> {
    return this.list().flatMap((record) => {
      if (record.watchOnly) return [{ ...record, index: 0, path: '' }];
      return this.getCore(record.id).listAccounts().map((account: AccountInfo) => ({ ...record, ...account }));
    });
  }

  async persist(): Promise<void> {
    await this.requireStorage().save(this.serialize());
  }

  serialize(): string { return this.serializeState(this.entries, this.selectedId); }

  async clear(): Promise<void> {
    this.dispose();
    this.entries.clear();
    this.selectedId = null;
    await this.options.storage?.clear();
  }

  /** Drop all controlled secrets from memory without removing persisted data. */
  dispose(): void {
    this.generation += 1;
    for (const core of this.pendingCores) {
      if (!core.isWatchOnly()) core.vault.forget();
    }
    this.pendingCores.clear();
    for (const { core } of this.entries.values()) {
      if (core && !core.isWatchOnly()) core.vault.forget();
    }
    this.entries.clear();
    this.selectedId = null;
  }

  static async restore(options: WalletManagerOptions = {}): Promise<WalletManager> {
    const serialized = await options.storage?.load();
    if (!serialized) return new WalletManager(options);
    return WalletManager.fromSerialized(serialized, options);
  }

  /** Parses a collection already loaded behind the host's unlock gate. */
  static fromSerialized(serialized: string, options: WalletManagerOptions = {}): WalletManager {
    const manager = new WalletManager(options);
    let parsed: unknown;
    try { parsed = JSON.parse(serialized); } catch { throw new Error('Invalid wallet manager backup'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { version?: unknown }).version !== 1 || !Array.isArray((parsed as { wallets?: unknown }).wallets)) {
      throw new Error('Invalid wallet manager backup');
    }
    const envelope = parsed as WalletManagerEnvelope;
    if (envelope.wallets.length > MAX_MANAGED_WALLETS) throw new Error('Invalid wallet manager backup');
    const ids = new Set<string>(); const addresses = new Set<string>();
    for (const item of envelope.wallets) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !/^wallet-[0-9a-f]{16}$/.test(item.id) || typeof item.address !== 'string' || typeof item.kind !== 'string' || !['mnemonic', 'privateKey', 'watch'].includes(item.kind) || typeof item.label !== 'string' || item.label.trim().length === 0 || item.label.length > 80) throw new Error('Invalid wallet manager backup');
      if (ids.has(item.id)) throw new Error('Invalid wallet manager backup'); ids.add(item.id);
      if (item.kind === 'watch') {
        if (item.vault !== undefined) throw new Error('Invalid wallet manager backup');
        const address = assertWatchAddress(item.address);
        if (addresses.has(address.toLowerCase()) || item.id !== idFor('watch', address)) throw new Error('Invalid wallet manager backup'); addresses.add(address.toLowerCase());
        manager.entries.set(item.id, { record: { id: item.id, label: normalizeLabel(item.label, 'Observed wallet'), address, kind: 'watch', watchOnly: true }, core: WalletCore.fromWatchAddress(address, coreOptions(options)) });
      } else {
        if (typeof item.vault !== 'string' || item.vault.length > 10000) throw new Error('Invalid wallet manager backup');
        const core = WalletCore.fromSerializedVault(item.vault, coreOptions(options));
        if (core.isWatchOnly() || core.getWalletKind() !== item.kind) throw new Error('Invalid wallet manager backup');
        const account = core.getAccount(0);
        if (account.address.toLowerCase() !== item.address.toLowerCase()) throw new Error('Wallet manager address mismatch');
        if (addresses.has(account.address.toLowerCase()) || item.id !== idFor(item.kind, account.address)) throw new Error('Invalid wallet manager backup'); addresses.add(account.address.toLowerCase());
        manager.entries.set(item.id, { record: { id: item.id, label: normalizeLabel(item.label, item.kind === 'mnemonic' ? 'Wallet' : 'Imported account'), address: account.address, kind: item.kind, watchOnly: false }, core });
      }
    }
    if (envelope.selectedId !== undefined && envelope.selectedId !== null && (typeof envelope.selectedId !== 'string' || !ids.has(envelope.selectedId))) throw new Error('Invalid wallet manager backup');
    const selectedId = envelope.selectedId;
    manager.selectedId = typeof selectedId === 'string' && manager.entries.has(selectedId)
      ? selectedId
      : manager.entries.keys().next().value ?? null;
    return manager;
  }

  private addControlledCore(core: WalletCore, kind: WalletKind, address: string, label: string): ManagedWalletRecord {
    this.assertUniqueAddress(address);
    const record: ManagedWalletRecord = { id: idFor(kind, address), label, address, kind, watchOnly: false };
    this.entries.set(record.id, { record, core });
    this.selectedId ??= record.id;
    return { ...record };
  }

  private recordForCore(core: WalletCore, label?: string): ManagedWalletRecord {
    const account = core.getAccount(0);
    if (core.isWatchOnly()) return { id: idFor('watch', account.address), label: normalizeLabel(label, defaultLabel('watch', this.nextSequence('watch'))), address: account.address, kind: 'watch', watchOnly: true };
    const kind = core.getWalletKind();
    return { id: idFor(kind, account.address), label: normalizeLabel(label, defaultLabel(kind, this.nextSequence(kind))), address: account.address, kind, watchOnly: false };
  }

  private serializeState(entries: Map<string, ManagedEntry>, selectedId: string | null): string {
    if (entries.size > MAX_MANAGED_WALLETS) throw new Error('The wallet collection has reached its limit');
    const ids = new Set<string>(); const addresses = new Set<string>();
    const wallets = [...entries.values()].map(({ record, core }): ManagedWalletEnvelope => {
      if (ids.has(record.id) || !/^wallet-[0-9a-f]{16}$/.test(record.id) || typeof record.label !== 'string' || record.label.trim().length === 0 || record.label.length > 80 || !isAddress(record.address)) throw new Error('Invalid wallet manager entry');
      if (addresses.has(record.address.toLowerCase())) throw new Error('Duplicate wallet address');
      ids.add(record.id); addresses.add(record.address.toLowerCase());
      if (record.watchOnly || record.kind === 'watch') {
        if (record.kind !== 'watch' || !core?.isWatchOnly() || record.id !== idFor('watch', record.address)) throw new Error('Invalid watch-only wallet entry');
        return { version: 1, id: record.id, label: record.label, kind: 'watch', address: getAddress(record.address) };
      }
      if (!core || core.isWatchOnly() || core.getWalletKind() !== record.kind || record.id !== idFor(record.kind, record.address) || core.getAccount(0).address.toLowerCase() !== record.address.toLowerCase()) throw new Error('Invalid controlled wallet entry');
      return { version: 1, id: record.id, label: record.label, kind: record.kind, address: getAddress(record.address), vault: core.vault.serialize() };
    });
    if (selectedId !== null && !ids.has(selectedId)) throw new Error('Invalid selected wallet');
    return JSON.stringify({ version: 1, selectedId: selectedId ?? undefined, wallets });
  }

  private nextSequence(kind: ManagedWalletKind): number {
    const prefix = kind === 'watch' ? 'Observed wallet' : kind === 'privateKey' ? 'Imported account' : 'Wallet';
    const used = new Set([...this.entries.values()].filter(({ record }) => record.kind === kind).map(({ record }) => record.label));
    let sequence = 1;
    while (used.has(`${prefix} ${sequence}`)) sequence += 1;
    return sequence;
  }

  private requireStorage(): WalletManagerStorage {
    if (!this.options.storage) throw new Error('A WalletManagerStorage adapter is required before persisting');
    return this.options.storage;
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new Error('Wallet session has expired');
  }

  private assertUniqueAddress(address: string): void {
    if ([...this.entries.values()].some(({ record }) => record.address.toLowerCase() === address.toLowerCase())) {
      throw new Error('This address is already in your wallet list');
    }
  }
}

