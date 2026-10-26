/** Network and transaction types used by the wallet core. */

export type WalletKind = "mnemonic" | "privateKey";

export interface NetworkConfig {
  /** Stable application identifier, e.g. `ethereum-mainnet` or `local-anvil`. */
  id: string;
  /** EVM chain id. */
  chainId: number;
  name: string;
  /** User supplied JSON-RPC endpoint. No hosted provider is assumed. */
  rpcUrl: string;
  /** Trusted same-chain endpoints used for slow or unavailable read requests. */
  rpcFallbackUrls?: string[];
  nativeSymbol?: string;
  explorerUrl?: string;
}

export interface AccountInfo {
  index: number;
  /** BIP-44 path; empty for an account imported directly from a private key. */
  path: string;
  address: string;
}

export interface TransactionStatus {
  hash: string;
  state: "pending" | "confirmed" | "failed" | "not-found";
  blockNumber?: number;
  confirmations?: number;
  gasUsed?: string;
  effectiveGasPrice?: string;
}

export interface Erc20Token {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
}

export interface Erc20Balance {
  token: Erc20Token;
  /** Raw integer amount as a decimal string. */
  raw: string;
  /** Human readable amount formatted using token decimals. */
  formatted: string;
}

export interface VaultStorage {
  save(value: string): Promise<void>;
  load(): Promise<string | null>;
  clear(): Promise<void>;
}

/**
 * Adapter for the platform biometric prompt (Keychain/Keystore on mobile,
 * WebAuthn or another implementation on the web). The core never talks to a
 * platform API directly.
 */
export interface BiometricAuthenticator {
  authenticate(reason: string): Promise<boolean>;
}

/**
 * Optional application-password gate used when the device has no biometric
 * hardware, or when the user explicitly chooses a wallet password. The
 * implementation must keep only a salted verifier and must never persist the
 * clear-text password.
 */
export interface PasswordVerifier {
  verify(password: string): Promise<boolean>;
  /** Optional fast presence check used to select the password UI. */
  isConfigured?(): boolean | Promise<boolean>;
  /** If true, callers must supply the application password instead of a biometric prompt. */
  requiresPassword?(): boolean | Promise<boolean>;
  /** Independent preference. False disables the biometric unlock path even when an adapter exists. */
  isBiometricEnabled?(): boolean | Promise<boolean>;
}

export interface WalletCoreOptions {
  networks?: NetworkConfig[];
  /** Restore derived account count (1 through 1000); private-key wallets require 1. */
  accountCount?: number;
  /** Optional storage used by lock/unlock. The value should be encrypted by the adapter. */
  storage?: VaultStorage;
  biometric?: BiometricAuthenticator;
  /** Optional app-level password verifier. A supplied password can unlock alongside enabled biometrics. */
  passwordVerifier?: PasswordVerifier;
  /** Public submitted transaction history. Storage failure never retries a broadcast. */
  transactionRecorder?: (record: import('./asset-history.js').AssetTransaction) => Promise<void> | void;
}
