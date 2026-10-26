/* Actual native-adapter contract test with isolated, in-memory Keychain mocks. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const ts = require('typescript');
const { pbkdf2, getBytes, toUtf8Bytes } = require('ethers');

const values = new Map();
const writes = [];
const reads = [];
let supportedLevel = 'SECURE_SOFTWARE';
let supportedBiometry = 'Fingerprint';
let saveAllowed = true;
const Keychain = {
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
  ACCESS_CONTROL: { BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE: 'BiometryCurrentSetOrDevicePasscode' },
  SECURITY_LEVEL: { SECURE_HARDWARE: 'SECURE_HARDWARE', SECURE_SOFTWARE: 'SECURE_SOFTWARE' },
  async hasGenericPassword({ service }) { return values.has(service); },
  async getGenericPassword({ service }) { reads.push(service); return values.has(service) ? { password: values.get(service) } : false; },
  async setGenericPassword(_username, password, options) { if (!saveAllowed) return false; values.set(options.service, password); writes.push({ password, options }); return true; },
  async resetGenericPassword({ service }) { return values.delete(service); },
  async getSecurityLevel() { return supportedLevel; },
  async getSupportedBiometryType() { return supportedBiometry; },
};
const nativeReact = { NativeModules: { DreamKeyCrypto: {
  async derivePasswordVerifier(passwordHex, saltHex, iterations) {
    assert.equal(iterations, 120000);
    return pbkdf2(getBytes(passwordHex), getBytes(saltHex), iterations, 32, 'sha256');
  },
} } };
const filename = path.resolve(__dirname, '../src/native/keychain.ts');
const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const entry = new Module(filename, module); entry.filename = filename; entry.paths = Module._nodeModulePaths(path.dirname(filename));
const nativeRequire = entry.require.bind(entry);
entry.require = (specifier) => specifier === 'react-native-keychain' ? Keychain : specifier === 'react-native' ? nativeReact : nativeRequire(specifier);
entry._compile(output, filename);
const { ReactNativeWalletPasswordVerifier, ReactNativeKeychainVaultStorage, ReactNativeKeychainBiometricAuthenticator, ReactNativeWalletManagerStorage } = entry.exports;

async function stalledBiometricLookupIsBounded() {
  const timers = []; const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports,
    require: (specifier) => specifier === 'react-native-keychain' ? { ...Keychain, getSupportedBiometryType: () => new Promise(() => {}) } : specifier === 'react-native' ? nativeReact : nativeRequire(specifier),
    setTimeout(callback, delay) { assert.equal(delay, 1500); const timer = { callback, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
  }, { filename: 'src/native/keychain.ts:stalled-biometric-fixture' });
  const biometric = new module.exports.ReactNativeKeychainBiometricAuthenticator();
  const operation = biometric.isAvailable(); assert.equal(timers.length, 1);
  timers[0].callback(); assert.equal(await operation, false, 'Stalled native sensor lookup must resolve as unavailable');
  assert.equal(timers[0].cleared, true, 'The timeout is cleaned up after discovery resolves');
  const readsBefore = reads.length; const writesBefore = writes.length;
  const authentication = biometric.authenticate('Public timeout fixture'); assert.equal(timers.length, 2);
  timers[1].callback(); assert.equal(await authentication, false);
  assert.equal(reads.length, readsBefore); assert.equal(writes.length, writesBefore, 'Timed-out detection must not create or read an auth gate');
}

(async () => {
  await stalledBiometricLookupIsBounded();
  const verifier = new ReactNativeWalletPasswordVerifier('fixture.password', 'fixture.password-mode', 'fixture.biometric-mode');
  assert.equal(await verifier.isConfigured(), false);
  assert.equal(await verifier.verify('correct horse battery staple'), false);
  await assert.rejects(verifier.setPassword('  short  '), /at least 6/);
  await verifier.setPassword('  correct horse battery staple  ');
  const first = JSON.parse(values.get('fixture.password'));
  assert.equal(await verifier.isConfigured(), true);
  assert.equal(await verifier.verify('correct horse battery staple'), true);
  assert.equal(await verifier.verify('  correct horse battery staple  '), true, 'Set and verify must normalize surrounding whitespace identically');
  assert.equal(await verifier.verify('wrong password'), false);
  assert.equal(values.get('fixture.password').includes('correct horse battery staple'), false, 'Protected storage must hold a salted verifier, never plaintext');
  await verifier.setPassword('correct horse battery staple');
  const second = JSON.parse(values.get('fixture.password'));
  await assert.rejects(verifier.setPassword('public expired-session password', () => false), /session has expired/);
  assert.equal(values.get('fixture.password'), JSON.stringify(second), 'A password derivation that completes after session expiry cannot replace the existing password');
  assert.notEqual(first.salt, second.salt, 'Every password write must generate a new salt');
  assert.notEqual(first.verifier, second.verifier);
  await verifier.setBiometricEnabled(false);
  assert.equal(await verifier.requiresPassword(), true);
  await verifier.setBiometricEnabled(true);
  assert.equal(await verifier.requiresPassword(), false, 'Enabled password and biometrics should coexist');
  const gate = writes.find(({ options }) => options.service === 'independent-wallet.biometric-gate');
  assert.equal(gate.options.accessControl, Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE);
  const biometric = new ReactNativeKeychainBiometricAuthenticator();
  assert.equal(await biometric.authenticate('Verify fixture'), true);
  supportedBiometry = null;
  const readsBeforeNoBiometry = reads.length; const writesBeforeNoBiometry = writes.length;
  assert.equal(await biometric.authenticate('Verify fixture'), false);
  assert.equal(reads.length, readsBeforeNoBiometry, 'An existing gate must not be read on a device without biometrics');
  assert.equal(writes.length, writesBeforeNoBiometry);
  values.delete('independent-wallet.biometric-gate');
  assert.equal(await biometric.authenticate('Verify fixture'), false);
  assert.equal(values.has('independent-wallet.biometric-gate'), false, 'A non-biometric gate must never be created');
  assert.equal(reads.length, readsBeforeNoBiometry);
  assert.equal(writes.length, writesBeforeNoBiometry);
  supportedBiometry = 'Fingerprint';
  values.set('fixture.password', '{"version":1,"salt":"invalid","verifier":"invalid"}');
  assert.equal(await verifier.verify('anything'), false, 'Malformed verification material must fail closed');
  saveAllowed = false;
  await assert.rejects(verifier.setPassword('correct horse battery staple'), /Unable to save/);
  saveAllowed = true;
  await verifier.clearPassword();
  assert.equal(await verifier.isConfigured(), false);
  assert.equal(await verifier.verify('correct horse battery staple'), false);

  const vault = new ReactNativeKeychainVaultStorage('fixture.vault');
  const readsBeforePresence = reads.length;
  assert.equal(await vault.hasWallet(), false);
  await vault.save('fixture-secret');
  assert.equal(await vault.hasWallet(), true);
  assert.equal(reads.length, readsBeforePresence, 'Wallet presence checks must not read protected contents');
  assert.equal(writes.at(-1).options.securityLevel, 'SECURE_SOFTWARE', 'Software Keystore protection must remain usable on emulators');
  supportedLevel = 'SECURE_HARDWARE';
  await vault.save('fixture-secret');
  assert.equal(writes.at(-1).options.securityLevel, 'SECURE_HARDWARE', 'Hardware protection should be selected when available');
  const manager = new ReactNativeWalletManagerStorage('fixture.manager');
  assert.equal(await manager.hasWallet(), false);
  supportedLevel = 'SECURE_SOFTWARE';
  await manager.save('fixture-wallet-collection');
  assert.equal(await manager.hasWallet(), true);
  assert.equal(writes.at(-1).options.securityLevel, 'SECURE_SOFTWARE', 'Collections also require an Android Keystore key');
  supportedLevel = 'SECURE_HARDWARE';
  await manager.save('fixture-wallet-collection');
  assert.equal(writes.at(-1).options.securityLevel, 'SECURE_HARDWARE');
  assert.equal(reads.length, readsBeforePresence, 'Collection presence checks must not load wallet secrets');
  console.log('Password adapter verification passed: salted verifier, whitespace consistency, wrong-password rejection, coexistence, no-biometric rejection, presence checks and compatible Keystore protection. No real native storage was accessed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
