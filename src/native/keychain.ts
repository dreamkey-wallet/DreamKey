import * as Keychain from "react-native-keychain";
import { NativeModules } from 'react-native';
import { hexlify, randomBytes, toUtf8Bytes } from "ethers";
import type { BiometricAuthenticator, PasswordVerifier, VaultStorage } from "../core/types.js";

const PASSWORD_ITERATIONS = 120_000;
const PASSWORD_KEY_LENGTH = 32;
const BIOMETRIC_GATE_SERVICE = 'independent-wallet.biometric-gate';

async function ensureBiometricGate(): Promise<void> {
  if (await Keychain.hasGenericPassword({ service: BIOMETRIC_GATE_SERVICE })) return;
  const saved = await Keychain.setGenericPassword('authentication', 'wallet-user-presence', {
    service: BIOMETRIC_GATE_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE,
  });
  if (!saved) throw new Error('Unable to enable biometric protection');
}

async function derivePasswordVerifier(password: string, salt: string): Promise<string> {
  const crypto = NativeModules.DreamKeyCrypto as {
    derivePasswordVerifier?: (passwordHex: string, saltHex: string, iterations: number) => Promise<string>;
  } | undefined;
  if (!crypto?.derivePasswordVerifier) throw new Error('Rebuild DreamKey to enable native password protection');
  if (!/^0x[0-9a-f]{32}$/i.test(salt)) throw new Error('Invalid password verifier salt');
  const bytes = toUtf8Bytes(password);
  try {
    if (bytes.length === 0 || bytes.length > 4096) throw new Error('Invalid wallet password length');
    const verifier = await crypto.derivePasswordVerifier(hexlify(bytes), salt, PASSWORD_ITERATIONS);
    if (typeof verifier !== 'string' || !/^0x[0-9a-f]{64}$/i.test(verifier)) throw new Error('Invalid native password verifier');
    return verifier.toLowerCase();
  } finally { bytes.fill(0); }
}

/**
 * Stores only a salted PBKDF2 verifier. The wallet secret remains in the
 * vault's OS-protected item; this service never stores or returns the clear
 * text application password.
 */
export class ReactNativeWalletPasswordVerifier implements PasswordVerifier {
  constructor(
    private readonly service = "independent-wallet.password",
    private readonly modeService = "independent-wallet.password-mode",
    private readonly biometricService = "independent-wallet.biometric-mode",
  ) {}

  async isConfigured(): Promise<boolean> {
    return Boolean(await Keychain.hasGenericPassword({ service: this.service }));
  }

  async requiresPassword(): Promise<boolean> {
    return await this.isConfigured() && !(await this.isBiometricEnabled());
  }

  async setPasswordMode(enabled: boolean): Promise<void> {
    if (!enabled) {
      await Keychain.resetGenericPassword({ service: this.modeService });
      return;
    }
    await Keychain.setGenericPassword('mode', 'password', { service: this.modeService, accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }

  /** Biometric protection is an independent preference and may coexist with a wallet password. */
  async isBiometricEnabled(): Promise<boolean> {
    const credentials = await Keychain.getGenericPassword({ service: this.biometricService });
    if (!credentials) return true;
    return credentials.password !== 'disabled';
  }

  async setBiometricEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      await ensureBiometricGate();
      await Keychain.setGenericPassword('mode', 'enabled', { service: this.biometricService, accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      return;
    }
    await Keychain.setGenericPassword('mode', 'disabled', { service: this.biometricService, accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }

  async setPassword(password: string, canCommit: () => boolean = () => true): Promise<void> {
    const normalized = password.trim();
    if (normalized.length < 6) throw new Error("Wallet password must be at least 6 characters");
    const salt = hexlify(randomBytes(16));
    const verifier = await derivePasswordVerifier(normalized, salt);
    if (!canCommit()) throw new Error('Wallet session has expired');
    const saved = await Keychain.setGenericPassword("wallet-password", JSON.stringify({ version: 1, salt, verifier, iterations: PASSWORD_ITERATIONS }), {
      service: this.service,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (!saved) throw new Error("Unable to save wallet password");
  }

  async verify(password: string): Promise<boolean> {
    const credentials = await Keychain.getGenericPassword({ service: this.service });
    if (!credentials) return false;
    try {
      const value = JSON.parse(credentials.password) as { version?: unknown; salt?: unknown; verifier?: unknown; iterations?: unknown };
      if (value.version !== 1 || value.iterations !== PASSWORD_ITERATIONS || typeof value.salt !== "string" || typeof value.verifier !== "string" || !/^0x[0-9a-f]{64}$/i.test(value.verifier)) return false;
      // setPassword has always normalized surrounding whitespace. Apply the
      // same rule when authenticating, including pre-existing verifiers.
      const expected = await derivePasswordVerifier(password.trim(), value.salt);
      // PBKDF2 output is fixed length; constant-time comparison avoids an
      // early-exit difference for incorrect guesses.
      if (expected.length !== value.verifier.length) return false;
      let diff = 0;
      for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ value.verifier.charCodeAt(index);
      return diff === 0;
    } catch {
      return false;
    }
  }

  async clearPassword(): Promise<void> {
    await Keychain.resetGenericPassword({ service: this.service });
    await this.setPasswordMode(false);
  }
}

/**
 * React Native CLI adapter backed by iOS Keychain / Android Keystore.
 * The versioned wallet secret is stored as the keychain password; the host app should use
 * the strongest available access-control policy for its threat model.
 */
export class ReactNativeKeychainVaultStorage implements VaultStorage {
  private passwordMode = false;
  private biometricEnabled = true;
  constructor(private readonly service = "independent-wallet.vault") {}

  /** Password mode uses the OS keystore for encryption and the app password as the user gate. */
  setPasswordMode(enabled: boolean): void { this.passwordMode = enabled; }
  setBiometricEnabled(enabled: boolean): void { this.biometricEnabled = enabled; }

  /** Presence only; never reads wallet secrets or triggers a biometric prompt. */
  async hasWallet(): Promise<boolean> {
    return Boolean(await Keychain.hasGenericPassword({ service: this.service }));
  }

  async save(value: string): Promise<void> {
    // Android Keystore tries StrongBox, then hardware-backed keys, before
    // falling back to a Keystore software key. Requiring hardware makes an
    // otherwise protected wallet unusable on emulators and older devices.
    const availableLevel = await Keychain.getSecurityLevel();
    const securityLevel = availableLevel === Keychain.SECURITY_LEVEL.SECURE_HARDWARE
      ? Keychain.SECURITY_LEVEL.SECURE_HARDWARE
      : Keychain.SECURITY_LEVEL.SECURE_SOFTWARE;
    const saved = await Keychain.setGenericPassword("wallet", value, {
      service: this.service,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      // The vault item is kept in the OS keystore, while the user-facing
      // biometric gate lives in BIOMETRIC_GATE_SERVICE. Keeping these gates
      // separate lets a configured password and biometrics coexist: either
      // method authenticates before the vault item is loaded.
      securityLevel,
    });
    if (!saved) throw new Error("Unable to securely save wallet");
  }

  async load(): Promise<string | null> {
    const credentials = await Keychain.getGenericPassword({
      service: this.service,
    });
    return credentials ? credentials.password : null;
  }

  async clear(): Promise<void> {
    await Keychain.resetGenericPassword({ service: this.service });
  }
}

/**
 * Prompts the user through native Keychain/Keystore user presence controls.
 * Configure the keychain item with access control in a production app and
 * provide a custom adapter if the product needs a separate biometric flow.
 */
export class ReactNativeKeychainBiometricAuthenticator implements BiometricAuthenticator {
  constructor(private readonly service = "independent-wallet.vault") {}

  async isAvailable(): Promise<boolean> {
    // Some Android vendors do not complete capability queries when no sensor
    // is enrolled. Treat a stalled query as unavailable so password UI stays usable.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Keychain.getSupportedBiometryType(),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1_500); }),
      ]);
      return Boolean(result);
    } catch { return false; }
    finally { if (timer) clearTimeout(timer); }
  }

  async authenticate(reason: string): Promise<boolean> {
    // Android Keychain can otherwise select a non-biometric cipher when the
    // device has no enrolled biometrics. Never treat that item read as auth.
    if (!(await this.isAvailable())) return false;
    await ensureBiometricGate();
    const credentials = await Keychain.getGenericPassword({
      service: BIOMETRIC_GATE_SERVICE,
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE,
      authenticationPrompt: { title: reason },
    });
    return credentials !== false;
  }
}

/** Stores the local managed-wallet collection in a separate protected keychain item. */
export class ReactNativeWalletManagerStorage implements VaultStorage {
  private passwordMode = false;
  private biometricEnabled = true;
  constructor(private readonly service = "independent-wallet.manager") {}
  setPasswordMode(enabled: boolean): void { this.passwordMode = enabled; }
  setBiometricEnabled(enabled: boolean): void { this.biometricEnabled = enabled; }
  /** Presence only; keeps the locked welcome flow from reading the collection. */
  async hasWallet(): Promise<boolean> { return Boolean(await Keychain.hasGenericPassword({ service: this.service })); }
  async save(value: string): Promise<void> {
    const availableLevel = await Keychain.getSecurityLevel();
    const securityLevel = availableLevel === Keychain.SECURITY_LEVEL.SECURE_HARDWARE ? Keychain.SECURITY_LEVEL.SECURE_HARDWARE : Keychain.SECURITY_LEVEL.SECURE_SOFTWARE;
    const saved = await Keychain.setGenericPassword("wallet-manager", value, { service: this.service, accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY, securityLevel });
    if (!saved) throw new Error("Unable to save wallet collection");
  }
  async load(): Promise<string | null> { const credentials = await Keychain.getGenericPassword({ service: this.service }); return credentials ? credentials.password : null; }
  async clear(): Promise<void> { await Keychain.resetGenericPassword({ service: this.service }); }
}

/** Stores non-sensitive app preferences in the native keychain/keystore. */
export class ReactNativeLanguageStorage {
  constructor(private readonly service = 'independent-wallet.preferences') {}

  async load(): Promise<'zh' | 'en' | null> {
    const credentials = await Keychain.getGenericPassword({ service: this.service });
    if (!credentials || (credentials.password !== 'zh' && credentials.password !== 'en')) return null;
    return credentials.password;
  }

  async save(language: 'zh' | 'en'): Promise<void> {
    await Keychain.setGenericPassword('language', language, { service: this.service });
  }
}

export interface DappBrowserRecord {
  favorites: string[];
  history: string[];
}

/** Stores the DApp browser's user-managed favorites and visit history locally. */
export class ReactNativeDappBrowserStorage {
  constructor(private readonly service = 'independent-wallet.dapp-browser') {}

  async load(): Promise<DappBrowserRecord> {
    try {
      const credentials = await Keychain.getGenericPassword({ service: this.service });
      if (!credentials) return { favorites: [], history: [] };
      const parsed: unknown = JSON.parse(credentials.password);
      if (!parsed || typeof parsed !== 'object') return { favorites: [], history: [] };
      const value = parsed as { favorites?: unknown; history?: unknown };
      return {
        favorites: Array.isArray(value.favorites) ? value.favorites.filter((item): item is string => typeof item === 'string') : [],
        history: Array.isArray(value.history) ? value.history.filter((item): item is string => typeof item === 'string') : [],
      };
    } catch {
      return { favorites: [], history: [] };
    }
  }

  async save(value: DappBrowserRecord): Promise<void> {
    await Keychain.setGenericPassword('dapp-browser', JSON.stringify(value), { service: this.service });
  }
}
