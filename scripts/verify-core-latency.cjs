/* Offline regression checks for account derivation and in-flight RPC validation. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HDNodeWallet, Mnemonic, Transaction, Wallet, verifyMessage, verifyTypedData } = require('ethers');

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-core-latency-'));
const phrase = 'test test test test test test test test test test test junk';
const fixtureNetwork = {
  id: 'fixture', chainId: 56, name: 'Fixture', rpcUrl: 'https://fixture.invalid',
};
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Offline verification must not access a network'); };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function queuedProvider() {
  const requests = [];
  return {
    requests,
    send(method, params) {
      assert.equal(method, 'eth_chainId');
      assert.deepEqual(params, []);
      const result = deferred();
      requests.push(result);
      return result.promise;
    },
  };
}

function secureFixtureStorage() {
  let stored = null;
  return {
    async save(value) { stored = value; },
    async load() { return stored; },
    async clear() { stored = null; },
  };
}

async function verifyAccountCache(WalletCore) {
  const expected = HDNodeWallet.fromPhrase(phrase, '', "m/44'/60'/0'/0/0");
  const originalDerive = HDNodeWallet.fromSeed;
  const originalComputeSeed = Mnemonic.prototype.computeSeed;
  let derivations = 0;
  let seedComputations = 0;
  HDNodeWallet.fromSeed = function (...args) {
    derivations += 1;
    return originalDerive.apply(this, args);
  };
  Mnemonic.prototype.computeSeed = function (...args) {
    seedComputations += 1;
    return originalComputeSeed.apply(this, args);
  };
  try {
    const wallet = WalletCore.fromMnemonic(phrase, { accountCount: 2, storage: secureFixtureStorage(), biometric: { async authenticate() { return true; } } });
    const first = wallet.getAccount(0);
    assert.equal(derivations, 1);
    assert.equal(first.address, expected.address, 'seed derivation preserves the existing BIP-44 account');
    assert.equal(seedComputations, 1);
    for (let index = 0; index < 12; index += 1) {
      assert.deepEqual(wallet.getAccount(0), first);
    }
    assert.equal(derivations, 1, 'repeated address display must not repeat the mnemonic KDF');

    first.address = 'changed outside the wallet';
    first.path = 'changed path';
    first.index = 100;
    const unchanged = wallet.getAccount(0);
    assert.notEqual(unchanged.address, first.address, 'public metadata is returned as a defensive copy');
    assert.equal(unchanged.index, 0);
    assert.equal(unchanged.path, "m/44'/60'/0'/0/0");
    const accounts = wallet.listAccounts();
    assert.equal(accounts.length, 2);
    assert.equal(derivations, 2, 'each new account is derived once for public metadata');
    accounts[1].address = 'changed in an account list';
    wallet.listAccounts();
    assert.notEqual(wallet.getAccount(1).address, accounts[1].address);
    assert.equal(derivations, 2, 'refreshing account lists must reuse public metadata');
    assert.equal(seedComputations, 1, 'additional accounts reuse the unlocked vault seed instead of repeating BIP-39');

    const signerA = wallet.getSigner(0);
    const signerB = wallet.getSigner(0);
    assert.notStrictEqual(signerA, signerB, 'signers and signing keys must not be cached for UI speed');
    assert.equal(derivations, 4, 'explicit signing still derives an ephemeral signer');
    assert.equal(seedComputations, 1, 'confirmation must not repeat the BIP-39 password derivation');
    assert.equal(signerA.address, unchanged.address);
    for (const cached of wallet.accountInfo.values()) {
      assert.deepEqual(Object.keys(cached).sort(), ['address', 'index', 'path']);
      assert.equal(cached instanceof HDNodeWallet || cached instanceof Wallet, false, 'only public account metadata is retained');
    }

    const copy = wallet.vault.getMnemonicSeed();
    const ownedSeed = wallet.vault.mnemonicSeed;
    assert.notStrictEqual(copy, ownedSeed, 'callers cannot mutate the vault-owned seed');
    copy.fill(0);
    const secondCopy = wallet.vault.getMnemonicSeed();
    assert.equal(secondCopy.some((byte) => byte !== 0), true);
    secondCopy.fill(0);
    assert.deepEqual(Object.keys(JSON.parse(wallet.vault.serialize())).sort(), ['kind', 'secret', 'version'], 'seed material is excluded from protected storage envelopes');

    const message = 'Public fixture: repeated signing is offline';
    const signature = await wallet.signMessage(0, message);
    assert.equal(verifyMessage(message, signature), expected.address);
    assert.equal(signature, await expected.signMessage(message), 'signing bytes stay identical to the previous derivation');
    const typed = {
      domain: { name: 'Latency fixture', version: '1', chainId: 56 },
      types: { Message: [{ name: 'contents', type: 'string' }] },
      message: { contents: 'No broadcast' },
    };
    const typedSignature = await wallet.getSigner(0).signTypedData(typed.domain, typed.types, typed.message);
    assert.equal(verifyTypedData(typed.domain, typed.types, typed.message, typedSignature), expected.address);
    const transaction = Transaction.from(await wallet.signTransaction(0, {
      to: `0x${'2'.repeat(40)}`, value: 7n, chainId: 56, nonce: 0, gasLimit: 21000n, gasPrice: 1n, type: 0,
    }));
    assert.equal(transaction.from, expected.address);
    assert.equal(transaction.value, 7n);
    assert.equal(seedComputations, 1, 'message, typed-data and transaction signatures share only the unlocked seed');
    const derivationsBeforeLock = derivations;

    await wallet.vault.lock();
    assert.equal(wallet.vault.mnemonicSeed, null);
    assert.equal(ownedSeed.every((byte) => byte === 0), true, 'lock overwrites the retained seed bytes');
    assert.throws(() => wallet.getAccount(0), /locked/i, 'cached metadata must not bypass the vault lock');
    assert.throws(() => wallet.listAccounts(), /locked/i);
    assert.throws(() => wallet.getSigner(0), /locked/i);
    assert.throws(() => wallet.vault.getMnemonicSeed(), /locked/i);
    await assert.rejects(wallet.signMessage(0, message), /locked/i);
    assert.equal(derivations, derivationsBeforeLock);
    await wallet.vault.unlock();
    assert.equal(wallet.getAccount(0).address, unchanged.address);
    assert.equal(derivations, derivationsBeforeLock, 'unlocking the same vault may reuse only its public metadata');
    assert.equal(wallet.vault.mnemonicSeed, null, 'unlock does not revive the previous session seed');
    assert.equal(verifyMessage(message, await wallet.signMessage(0, message)), expected.address);
    assert.equal(seedComputations, 2, 'a new unlocked session must derive a fresh seed');
    const replacementSeed = wallet.vault.mnemonicSeed;
    await wallet.vault.clear();
    assert.equal(wallet.vault.mnemonicSeed, null);
    assert.equal(replacementSeed.every((byte) => byte === 0), true, 'clear overwrites seed bytes');
    assert.throws(() => wallet.getAccount(0), /locked/i);
  } finally {
    HDNodeWallet.fromSeed = originalDerive;
    Mnemonic.prototype.computeSeed = originalComputeSeed;
  }
}

async function verifySeedFailureLifecycle(WalletCore) {
  const storage = secureFixtureStorage();
  const wallet = WalletCore.fromMnemonic(phrase, { storage, biometric: { async authenticate() { return true; } } });
  wallet.getAccount(0);
  await wallet.vault.persist();
  const seed = wallet.vault.mnemonicSeed;
  const save = storage.save;
  storage.save = async () => { throw new Error('Fixture persist failure'); };
  await assert.rejects(wallet.vault.lock(), /persist failure/);
  assert.equal(wallet.vault.isLocked(), true, 'failed persistence must still lock the wallet');
  assert.equal(wallet.vault.mnemonicSeed, null, 'failed lock clears the unlocked session');
  assert.equal(seed.every((byte) => byte === 0), true, 'failed persistence still overwrites retained seed bytes');
  storage.save = save;
  await wallet.vault.lock();
  assert.equal(seed.every((byte) => byte === 0), true);

  const envelope = await storage.load();
  await storage.save(WalletCore.fromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about').vault.serialize());
  await assert.rejects(wallet.vault.unlock(), /does not match/);
  assert.equal(wallet.vault.mnemonicSeed, null, 'failed identity validation cannot populate signing material');
  await storage.save(envelope);
  await wallet.vault.unlock();
  wallet.getSigner(0);
  const nextSeed = wallet.vault.mnemonicSeed;
  storage.clear = async () => { throw new Error('Fixture storage clear failure'); };
  await assert.rejects(wallet.vault.clear(), /clear failure/);
  assert.equal(wallet.vault.isLocked(), true);
  assert.equal(wallet.vault.mnemonicSeed, null, 'storage clear failure must still remove the in-memory seed');
  assert.equal(nextSeed.every((byte) => byte === 0), true);
  assert.throws(() => wallet.getSigner(0), /locked/i);

  const privateWallet = WalletCore.fromPrivateKey(`0x${'0'.repeat(63)}1`);
  assert.throws(() => privateWallet.vault.getMnemonicSeed(), /has no mnemonic/);
  privateWallet.getSigner(0);
  assert.equal(privateWallet.vault.mnemonicSeed, null, 'private-key imports do not populate an HD seed');
}

async function verifySharedChecks(WalletCore) {
  const wallet = WalletCore.fromMnemonic(phrase, { networks: [fixtureNetwork] });
  const provider = queuedProvider();
  wallet.providers.set('fixture', provider);

  const first = [wallet.assertNetwork('fixture'), wallet.assertNetwork('fixture'), wallet.assertNetwork('fixture')];
  assert.equal(provider.requests.length, 1, 'simultaneous balance queries must share their chain validation');
  provider.requests[0].resolve('0x38');
  await Promise.all(first);
  const next = wallet.assertNetwork('fixture');
  assert.equal(provider.requests.length, 2, 'completed validation must not become a stale persistent result');
  provider.requests[1].resolve('0x38');
  await next;

  const mismatch = [wallet.assertNetwork('fixture'), wallet.assertNetwork('fixture')];
  const mismatchResults = mismatch.map((check) => assert.rejects(check, /RPC chain/));
  assert.equal(provider.requests.length, 3);
  provider.requests[2].resolve('0x1');
  await Promise.all(mismatchResults);
  const afterMismatch = wallet.assertNetwork('fixture');
  assert.equal(provider.requests.length, 4, 'a chain mismatch must not poison future validation attempts');
  provider.requests[3].resolve('0x38');
  await afterMismatch;

  const failure = [wallet.assertNetwork('fixture'), wallet.assertNetwork('fixture')];
  const failureResults = failure.map((check) => assert.rejects(check, /fixture transport failed/));
  assert.equal(provider.requests.length, 5);
  provider.requests[4].reject(new Error('fixture transport failed'));
  await Promise.all(failureResults);
  const afterFailure = wallet.assertNetwork('fixture');
  assert.equal(provider.requests.length, 6, 'a transport failure must clear the in-flight validation');
  provider.requests[5].resolve('0x38');
  await afterFailure;
}

async function verifyNetworkChanges(WalletCore) {
  const wallet = WalletCore.fromMnemonic(phrase, { networks: [fixtureNetwork] });
  const originalProvider = queuedProvider();
  wallet.providers.set('fixture', originalProvider);
  const oldChecks = [wallet.assertNetwork('fixture'), wallet.assertNetwork('fixture')];
  assert.equal(originalProvider.requests.length, 1);

  wallet.addNetwork({ ...fixtureNetwork, chainId: 1, rpcUrl: 'https://replacement.invalid' });
  const replacementProvider = queuedProvider();
  wallet.providers.set('fixture', replacementProvider);
  const newChecks = [wallet.assertNetwork('fixture'), wallet.assertNetwork('fixture')];
  assert.equal(replacementProvider.requests.length, 1, 'a replacement network must start its own validation');
  originalProvider.requests[0].resolve('0x38');
  await Promise.all(oldChecks);
  newChecks.push(wallet.assertNetwork('fixture'));
  assert.equal(replacementProvider.requests.length, 1, 'an old completion must not delete a replacement in-flight check');
  replacementProvider.requests[0].resolve('0x1');
  await Promise.all(newChecks);

  const removedChecks = [wallet.assertNetwork('fixture'), wallet.assertNetwork('fixture')];
  assert.equal(replacementProvider.requests.length, 2);
  wallet.removeNetwork('fixture');
  await assert.rejects(wallet.assertNetwork('fixture'), /Unknown network/);
  wallet.addNetwork(fixtureNetwork);
  const recreatedProvider = queuedProvider();
  wallet.providers.set('fixture', recreatedProvider);
  const recreatedChecks = [wallet.assertNetwork('fixture'), wallet.assertNetwork('fixture')];
  assert.equal(recreatedProvider.requests.length, 1);
  replacementProvider.requests[1].resolve('0x1');
  await Promise.all(removedChecks);
  recreatedChecks.push(wallet.assertNetwork('fixture'));
  assert.equal(recreatedProvider.requests.length, 1, 'removed-network completion must not clear the recreated network check');
  recreatedProvider.requests[0].resolve('0x38');
  await Promise.all(recreatedChecks);
}

async function verify() {
  require('./compile-ts-fixture.cjs')('src/core/wallet-core.ts', output);
  const { WalletCore } = require(path.join(output, 'core/wallet-core.js'));
  await verifyAccountCache(WalletCore);
  await verifySeedFailureLifecycle(WalletCore);
  await verifySharedChecks(WalletCore);
  await verifyNetworkChanges(WalletCore);
  console.log('Core latency verification passed: public account cache, one BIP-39 computation per unlocked session, defensive seed copies, byte clearing on lock/clear including failure paths, unchanged fixture signatures, ephemeral signers, shared in-flight chain checks and safe network replacement. Offline fixtures; no transaction broadcast.');
}

verify().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  globalThis.fetch = previousFetch;
  fs.rmSync(output, { recursive: true, force: true });
});
