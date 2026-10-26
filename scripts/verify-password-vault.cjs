/* Offline WalletVault password-gate contract test. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const cache = new Map();
function load(relative) {
  const filename = path.join(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const entry = new Module(filename, module); entry.filename = filename; entry.paths = Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire = entry.require.bind(entry);
  entry.require = (specifier) => {
    const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(filename), specifier.replace(/\.js$/, '.ts')) : null;
    return resolved && fs.existsSync(resolved) ? load(path.relative(root, resolved)) : nativeRequire(specifier);
  };
  cache.set(filename, entry); entry._compile(output, filename); return entry.exports;
}
const { WalletVault } = load('src/core/vault.ts');
const phrase = 'test test test test test test test test test test test junk';
const correctPassword = 'correct horse battery staple';

function fixture() {
  let value = null; let loads = 0; let authentications = 0;
  const preferences = { configured: true, passwordRequired: false, biometricsEnabled: true, biometricAllowed: true };
  const storage = {
    async save(next) { value = next; },
    async load() { loads += 1; return value; },
    async clear() { value = null; },
  };
  const verifier = {
    isConfigured: async () => preferences.configured,
    requiresPassword: async () => preferences.passwordRequired,
    isBiometricEnabled: async () => preferences.biometricsEnabled,
    verify: async (password) => preferences.configured && password === correctPassword,
  };
  const biometric = { async authenticate() { authentications += 1; return preferences.biometricAllowed; } };
  return { vault: WalletVault.fromMnemonic(phrase, storage, biometric, verifier), preferences, loads: () => loads, authentications: () => authentications };
}

async function assertLocked(vault) {
  assert.equal(vault.isLocked(), true);
  assert.throws(() => vault.getMnemonic(), /locked/i);
}

(async () => {
  const both = fixture();
  await both.vault.lock();
  await assertLocked(both.vault);
  await assert.rejects(both.vault.unlock('Unlock wallet', 'wrong'), /incorrect/);
  assert.equal(both.loads(), 0, 'Wrong passwords must not load the stored secret');
  assert.equal(both.authentications(), 0, 'An explicit wrong password must not fall back to biometrics');
  await assertLocked(both.vault);
  await both.vault.unlock('Unlock wallet', correctPassword);
  assert.equal(both.vault.getMnemonic(), phrase);
  assert.equal(both.loads(), 1);
  assert.equal(both.authentications(), 0, 'Explicit password unlock must not prompt biometrics');
  await both.vault.lock();
  await both.vault.unlock('Unlock wallet');
  assert.equal(both.authentications(), 1, 'Enabled biometrics must authenticate a locked vault');
  assert.equal(both.loads(), 2);
  assert.equal(both.vault.getMnemonic(), phrase);

  const passwordOnly = fixture();
  passwordOnly.preferences.biometricsEnabled = false;
  await passwordOnly.vault.lock();
  await assert.rejects(passwordOnly.vault.unlock(), /password is required/);
  assert.equal(passwordOnly.authentications(), 0, 'Disabled biometrics must never be invoked');
  assert.equal(passwordOnly.loads(), 0, 'Authentication must precede storage access');
  await passwordOnly.vault.unlock('Unlock wallet', correctPassword);
  assert.equal(passwordOnly.vault.getMnemonic(), phrase);
  assert.equal(passwordOnly.authentications(), 0);

  const rejectedBiometrics = fixture();
  rejectedBiometrics.preferences.biometricAllowed = false;
  await rejectedBiometrics.vault.lock();
  await assert.rejects(rejectedBiometrics.vault.unlock(), /Biometric authentication failed/);
  assert.equal(rejectedBiometrics.loads(), 0, 'Rejected biometrics must not load the stored secret');
  await assertLocked(rejectedBiometrics.vault);
  await rejectedBiometrics.vault.unlock('Unlock wallet', correctPassword);
  assert.equal(rejectedBiometrics.authentications(), 1, 'Password fallback must not retry rejected biometrics');

  const required = fixture();
  required.preferences.passwordRequired = true;
  await required.vault.lock();
  await assert.rejects(required.vault.unlock(), /password is required/);
  assert.equal(required.authentications(), 0, 'Legacy password-required hosts retain their explicit gate');
  await required.vault.unlock('Unlock wallet', correctPassword);

  const unavailable = fixture();
  unavailable.preferences.configured = false; unavailable.preferences.biometricsEnabled = false;
  await unavailable.vault.lock();
  await assert.rejects(unavailable.vault.unlock(), /disabled/);
  await assert.rejects(unavailable.vault.unlock('Unlock wallet', correctPassword), /not configured/);
  assert.equal(unavailable.loads(), 0);
  assert.equal(unavailable.authentications(), 0);
  let releaseAuthentication;
  const delayed = fixture();
  delayed.vault.biometric.authenticate = () => new Promise((resolve) => { releaseAuthentication = resolve; });
  await delayed.vault.lock();
  const unlocking = delayed.vault.unlock();
  while (!releaseAuthentication) await new Promise((resolve) => setImmediate(resolve));
  delayed.vault.forget(); releaseAuthentication(true);
  await assert.rejects(unlocking, /session has expired/);
  assert.equal(delayed.loads(), 0, 'An expired native authentication must not load a secret');
  await assertLocked(delayed.vault);
  const failedStorage = { async save() { throw new Error('Public storage fixture failure'); } };
  const failedLock = WalletVault.fromMnemonic(phrase, failedStorage);
  await assert.rejects(failedLock.lock(), /storage fixture failure/);
  await assertLocked(failedLock);
  const unprotected = WalletVault.fromMnemonic(phrase, { async save() {}, async load() { throw new Error('Secret must not be read'); } });
  await unprotected.lock();
  await assert.rejects(unprotected.unlock(), /authentication is unavailable/);
  console.log('Password vault verification passed: locked-state authentication, either unlock method, disabled biometrics and secret-read gating.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
