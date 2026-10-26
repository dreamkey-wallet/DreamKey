import { Mnemonic, getBytes, keccak256, toUtf8Bytes } from "ethers";
import type { BiometricAuthenticator, PasswordVerifier, VaultStorage, WalletKind } from "./types.js";

const SECP256K1_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

interface VaultEnvelope {
  version: 1;
  kind: WalletKind;
  secret: string;
}

function normalizeSecret(value: string, kind: WalletKind): string {
  if (kind === "mnemonic") {
    try {
      if (typeof value !== "string") throw new Error();
      return Mnemonic.fromPhrase(value.trim().split(/\s+/).join(" ")).phrase;
    } catch {
      // Ethers validation errors can include the rejected secret as an argument.
      throw new Error("Invalid mnemonic");
    }
  }
  if (typeof value !== "string") throw new Error("Invalid private key");
  const hex = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("Invalid private key");
  const scalar = BigInt(`0x${hex}`);
  if (scalar === 0n || scalar >= SECP256K1_ORDER) throw new Error("Invalid private key");
  return `0x${hex.toLowerCase()}`;
}

function decodeStoredVault(value: string): VaultEnvelope {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid wallet backup");
  // Previous app versions persisted the mnemonic directly in secure storage.
  if (!value.trim().startsWith("{")) {
    return { version: 1, kind: "mnemonic", secret: normalizeSecret(value, "mnemonic") };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const envelope = parsed as Record<string, unknown>;
    if (envelope.version !== 1 || (envelope.kind !== "mnemonic" && envelope.kind !== "privateKey") || typeof envelope.secret !== "string") {
      throw new Error();
    }
    return { version: 1, kind: envelope.kind, secret: normalizeSecret(envelope.secret, envelope.kind) };
  } catch {
    throw new Error("Invalid wallet backup");
  }
}

/**
 * Platform-independent secret vault for a mnemonic or one imported private key.
 * The host must provide an OS-protected VaultStorage adapter before persisting.
 * Serialization is an internal storage representation, not an encrypted export.
 */
export class WalletVault {
  private secret: string | null;
  // Derive BIP-39 once per unlocked session; never serialize this material.
  private mnemonicSeed: Uint8Array | null = null;
  private unlocked = true;
  private generation = 0;
  private readonly identity: string;

  /** The default kind preserves the original MnemonicVault constructor API. */
  constructor(
    secret: string,
    private readonly storage?: VaultStorage,
    private readonly biometric?: BiometricAuthenticator,
    private readonly kind: WalletKind = "mnemonic",
    private readonly passwordVerifier?: PasswordVerifier,
  ) {
    if (kind !== "mnemonic" && kind !== "privateKey") throw new Error("Invalid wallet kind");
    this.secret = normalizeSecret(secret, kind);
    this.identity = this.fingerprint(this.secret, kind);
  }

  static fromMnemonic(mnemonic: string, storage?: VaultStorage, biometric?: BiometricAuthenticator, passwordVerifier?: PasswordVerifier): WalletVault {
    return new WalletVault(mnemonic, storage, biometric, "mnemonic", passwordVerifier);
  }

  static fromPrivateKey(privateKey: string, storage?: VaultStorage, biometric?: BiometricAuthenticator, passwordVerifier?: PasswordVerifier): WalletVault {
    return new WalletVault(privateKey, storage, biometric, "privateKey", passwordVerifier);
  }

  static fromSerializedVault(value: string, storage?: VaultStorage, biometric?: BiometricAuthenticator, passwordVerifier?: PasswordVerifier): WalletVault {
    const envelope = decodeStoredVault(value);
    return new WalletVault(envelope.secret, storage, biometric, envelope.kind, passwordVerifier);
  }

  getWalletKind(): WalletKind {
    return this.kind;
  }

  /** Only pass the result to protected storage. Never log or save in metadata. */
  serialize(): string {
    return JSON.stringify({ version: 1, kind: this.kind, secret: this.readSecret() } satisfies VaultEnvelope);
  }

  async persist(): Promise<void> {
    if (!this.storage) throw new Error("A secure VaultStorage adapter is required before persisting");
    await this.storage.save(this.serialize());
  }

  /** Drop live key material immediately, then await protected persistence. */
  async lock(reason = "Unlock wallet"): Promise<void> {
    if (this.isLocked()) return;
    if (!this.storage) throw new Error("A secure VaultStorage adapter is required before persisting");
    const serialized = this.serialize();
    this.forget();
    await this.storage.save(serialized);
    void reason;
  }

  async unlock(reason = "Unlock wallet", password?: string): Promise<void> {
    if (!this.isLocked()) return;
    const generation = this.generation;
    const passwordConfigured = Boolean(this.passwordVerifier && (await this.passwordVerifier.isConfigured?.() ?? true));
    const passwordMode = Boolean(passwordConfigured && (await this.passwordVerifier?.requiresPassword?.() ?? false));
    const biometricEnabled = await this.passwordVerifier?.isBiometricEnabled?.() ?? true;
    if (password !== undefined) {
      if (!passwordConfigured) throw new Error("Wallet password is not configured");
      if (!(await this.passwordVerifier!.verify(password))) throw new Error("Wallet password is incorrect");
    } else if (passwordMode) {
      throw new Error("Wallet password is required");
    } else if (this.biometric && biometricEnabled) {
      if (!(await this.biometric.authenticate(reason))) throw new Error("Biometric authentication failed");
    } else if (passwordConfigured) {
      throw new Error("Wallet password is required");
    } else if (this.biometric && !biometricEnabled) {
      throw new Error("Biometric authentication is disabled");
    } else throw new Error("Wallet authentication is unavailable");
    if (generation !== this.generation) throw new Error('Wallet session has expired');
    const value = await this.storage?.load();
    if (generation !== this.generation) throw new Error('Wallet session has expired');
    if (!value) throw new Error("Wallet is locked and no secret is available");
    const envelope = decodeStoredVault(value);
    // A storage replacement must not change the signer of an existing vault.
    if (envelope.kind !== this.kind || this.fingerprint(envelope.secret, envelope.kind) !== this.identity) {
      throw new Error("Stored wallet does not match this vault");
    }
    this.secret = envelope.secret;
    // Authentication is deliberately checked before restoring the secret. The
    // storage adapter still owns encryption and platform access controls.
    this.unlocked = true;
  }

  isLocked(): boolean {
    return !this.unlocked || this.secret === null;
  }

  getMnemonic(): string {
    if (this.kind !== "mnemonic") throw new Error("This wallet was imported with a private key and has no mnemonic");
    return this.readSecret();
  }

  /** Internal signing input. The caller owns the copy and must overwrite it after use. */
  getMnemonicSeed(): Uint8Array {
    const phrase = this.getMnemonic();
    if (this.mnemonicSeed === null) {
      this.mnemonicSeed = getBytes(Mnemonic.fromPhrase(phrase).computeSeed());
    }
    return this.mnemonicSeed.slice();
  }

  getPrivateKey(): string {
    if (this.kind !== "privateKey") throw new Error("This wallet does not contain an imported private key");
    return this.readSecret();
  }

  async clear(): Promise<void> {
    this.forget();
    await this.storage?.clear();
  }

  /**
   * Drop in-memory key material without touching protected storage. Used when
   * a wallet collection is locked or an active account is removed; callers can
   * still unlock the same persisted vault later when appropriate.
   */
  forget(): void {
    this.generation += 1;
    this.secret = null;
    this.clearMnemonicSeed();
    this.unlocked = false;
  }

  private clearMnemonicSeed(): void {
    this.mnemonicSeed?.fill(0);
    this.mnemonicSeed = null;
  }

  private readSecret(): string {
    if (this.isLocked() || this.secret === null) throw new Error("Wallet is locked");
    return this.secret;
  }

  private fingerprint(secret: string, kind: WalletKind): string {
    return keccak256(toUtf8Bytes(JSON.stringify({ kind, secret })));
  }
}

/** Backward-compatible name for consumers of the original mnemonic-only vault. */
export { WalletVault as MnemonicVault };
