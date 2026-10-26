/* Verify import/secure-storage compatibility with public fixtures; no RPC or broadcasting. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transaction, getBytes, verifyMessage, verifyTypedData } = require('ethers');

const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-import-'));
for (const entry of ['src/core/wallet-core.ts', 'src/provider/wallet-core-adapter.ts']) require('./compile-ts-fixture.cjs')(entry, outputRoot);

// Widely known public fixture scalar 1, never a user wallet or production key.
const PRIVATE_KEY = `0x${'0'.repeat(63)}1`;
const ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const MNEMONIC = 'test test test test test test test test test test test junk';
const networks = [
  { id: 'bsc', chainId: 56, name: 'BSC fixture', rpcUrl: 'https://fixture.invalid' },
  { id: 'eth', chainId: 1, name: 'ETH fixture', rpcUrl: 'https://fixture.invalid' },
];

function memoryStorage(value = null) {
  return {
    value, saves: 0,
    async save(next) { this.value = next; this.saves += 1; },
    async load() { return this.value; },
    async clear() { this.value = null; },
  };
}

function assertSafeFailure(action, expected, forbidden) {
  assert.throws(action, (error) => {
    assert.match(error.message, expected);
    for (const value of forbidden) {
      assert.equal(error.message.includes(value), false, 'validation errors cannot echo secret inputs');
      assert.equal(Object.hasOwn(error, 'value'), false, 'validation errors cannot carry ethers rejected-value metadata');
      assert.equal(Object.hasOwn(error, 'cause'), false, 'validation errors cannot preserve a secret-bearing cause');
    }
    return true;
  });
}

async function verify() {
  const { WalletCore } = require(path.join(outputRoot, 'core/wallet-core.js'));
  const { WalletVault, MnemonicVault } = require(path.join(outputRoot, 'core/vault.js'));
  const { createWalletProvider } = require(path.join(outputRoot, 'provider/wallet-core-adapter.js'));
  const storage = memoryStorage();
  let authenticated = true;
  let authentications = 0;
  const biometric = { async authenticate() { authentications += 1; return authenticated; } };
  const wallet = WalletCore.fromPrivateKey(PRIVATE_KEY.slice(2), { storage, biometric, networks });
  assert.equal(wallet.getWalletKind(), 'privateKey');
  assert.equal(wallet.canDeriveAccounts(), false);
  assert.deepEqual(wallet.listAccounts(), [{ index: 0, path: '', address: ADDRESS }]);
  assert.equal(WalletCore.fromPrivateKey(`  ${PRIVATE_KEY.toUpperCase()}  `).getAccount(0).address, ADDRESS, 'optional prefix, case and surrounding whitespace are accepted');
  assert.throws(() => wallet.addAccount(), /cannot be derived/);
  for (const index of [1, -1, NaN, 0.5]) {
    assert.throws(() => wallet.getAccount(index), /only contains account 0/);
    assert.throws(() => wallet.getSigner(index), /only contains account 0/);
  }
  assert.throws(() => WalletCore.fromPrivateKey(PRIVATE_KEY, { accountCount: 2 }), /one account/);
  assertSafeFailure(() => wallet.getMnemonic(), /has no mnemonic/, [PRIVATE_KEY]);

  const signature = await wallet.signMessage(0, 'Independent Wallet import verification');
  assert.equal(verifyMessage('Independent Wallet import verification', signature), ADDRESS);
  const typed = {
    domain: { name: 'Import fixture', version: '1', chainId: 56 },
    types: { Message: [{ name: 'contents', type: 'string' }] },
    message: { contents: 'No transaction is broadcast' },
  };
  const typedSignature = await wallet.getSigner().signTypedData(typed.domain, typed.types, typed.message);
  assert.equal(verifyTypedData(typed.domain, typed.types, typed.message, typedSignature), ADDRESS);
  const signedTransaction = await wallet.signTransaction(0, { to: `0x${'2'.repeat(40)}`, value: 7n, chainId: 56, nonce: 0, gasLimit: 21000n, gasPrice: 1n, type: 0 });
  const transaction = Transaction.from(signedTransaction);
  assert.equal(transaction.from, ADDRESS);
  assert.equal(transaction.chainId, 56n);
  assert.equal(transaction.value, 7n);

  await wallet.vault.persist();
  assert.deepEqual(JSON.parse(storage.value), { version: 1, kind: 'privateKey', secret: PRIVATE_KEY });
  assert.equal(WalletCore.fromSerializedVault(storage.value).getAccount(0).address, ADDRESS, 'protected storage can restore the private key after relaunch');
  await wallet.vault.lock();
  assert.equal(wallet.vault.isLocked(), true);
  assert.throws(() => wallet.vault.getPrivateKey(), /locked/);
  assert.throws(() => wallet.vault.serialize(), /locked/);
  assert.throws(() => wallet.getAccount(0), /locked/);
  assert.throws(() => wallet.getSigner(), /locked/);
  await assert.rejects(wallet.signMessage(0, 'locked fixture'), /locked/);
  const savesBeforeRepeatLock = storage.saves;
  await wallet.vault.lock();
  assert.equal(storage.saves, savesBeforeRepeatLock, 'locking twice cannot replace protected storage with empty data');
  authenticated = false;
  await assert.rejects(wallet.vault.unlock(), /authentication failed/);
  assert.equal(wallet.vault.isLocked(), true);
  authenticated = true;
  await wallet.vault.unlock();
  assert.equal(wallet.getAccount(0).address, ADDRESS);
  assert.equal(authentications, 2);

  await wallet.vault.lock();
  const correctEnvelope = storage.value;
  storage.value = WalletCore.fromMnemonic(MNEMONIC).vault.serialize();
  await assert.rejects(wallet.vault.unlock(), /does not match/);
  assert.equal(wallet.vault.isLocked(), true, 'a storage type replacement cannot change the vault signer');
  storage.value = WalletCore.fromPrivateKey(`0x${'0'.repeat(63)}2`).vault.serialize();
  await assert.rejects(wallet.vault.unlock(), /does not match/);
  assert.equal(wallet.vault.isLocked(), true, 'a different stored key cannot change the vault signer');
  storage.value = correctEnvelope;
  await wallet.vault.unlock();
  assert.equal(wallet.getAccount(0).address, ADDRESS);

  const legacyStorage = memoryStorage(MNEMONIC);
  const legacy = WalletCore.fromSerializedVault(await legacyStorage.load(), { storage: legacyStorage, accountCount: 2, biometric: { async authenticate() { return true; } } });
  const mnemonicWallet = WalletCore.fromMnemonic(MNEMONIC, { accountCount: 2 });
  assert.equal(legacy.getWalletKind(), 'mnemonic');
  assert.equal(legacy.canDeriveAccounts(), true);
  assert.deepEqual(legacy.listAccounts(), mnemonicWallet.listAccounts());
  assert.equal(legacy.addAccount().index, 2);
  await legacy.vault.persist();
  assert.equal(JSON.parse(legacyStorage.value).kind, 'mnemonic', 'legacy storage is upgraded only when saved');
  await legacy.vault.lock();
  legacyStorage.value = MNEMONIC;
  await legacy.vault.unlock();
  assert.equal(legacy.getMnemonic(), MNEMONIC, 'unlock also accepts the legacy raw mnemonic');
  assert.equal(new MnemonicVault(MNEMONIC).getMnemonic(), MNEMONIC, 'legacy exported constructor remains compatible');
  assert.equal(MnemonicVault, WalletVault);
  assert.equal(WalletCore.fromMnemonic(MNEMONIC.replaceAll(' ', '\n')).getMnemonic(), MNEMONIC, 'multiline phrases normalize before checksum validation');

  for (const key of ['', '0x1234', `0x${'g'.repeat(64)}`, `0x${'0'.repeat(64)}`, '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', `0x${'f'.repeat(64)}`, `0x${'1'.repeat(66)}`]) {
    assertSafeFailure(() => WalletCore.fromPrivateKey(key), /^Invalid private key$/, key ? [key] : []);
  }
  assertSafeFailure(() => WalletCore.fromMnemonic('secret words not valid'), /^Invalid mnemonic$/, ['secret words not valid']);
  for (const stored of ['{}', JSON.stringify({ version: 2, kind: 'privateKey', secret: PRIVATE_KEY }), JSON.stringify({ version: 1, kind: 'unknown', secret: PRIVATE_KEY }), JSON.stringify({ version: 1, kind: 'privateKey', secret: `0x${'0'.repeat(64)}` }), '{malformed']) {
    assertSafeFailure(() => WalletCore.fromSerializedVault(stored), /^Invalid wallet backup$/, [PRIVATE_KEY]);
  }
  await assert.rejects(WalletCore.fromPrivateKey(PRIVATE_KEY).vault.persist(), /secure VaultStorage/);
  await wallet.vault.clear();
  assert.equal(storage.value, null);
  assert.equal(wallet.vault.isLocked(), true);
  assert.throws(() => wallet.getSigner(), /locked/);

  // Exercise the actual EIP-1193 adapter with a real offline private-key signer.
  const providerWallet = WalletCore.fromPrivateKey(PRIVATE_KEY, { networks });
  const approvals = [];
  const provider = createWalletProvider(providerWallet, 'bsc', { approve: (request) => { approvals.push(request.method); return true; } });
  const site = provider.forOrigin('https://import-fixture.invalid');
  assert.deepEqual(await site.request({ method: 'eth_requestAccounts' }), [ADDRESS.toLowerCase()]);
  const providerMessageSignature = await site.request({ method: 'personal_sign', params: ['0x010203', ADDRESS] });
  assert.equal(verifyMessage(getBytes('0x010203'), providerMessageSignature), ADDRESS);
  const providerTypedSignature = await site.request({ method: 'eth_signTypedData_v4', params: [ADDRESS, JSON.stringify(typed)] });
  assert.equal(verifyTypedData(typed.domain, typed.types, typed.message, providerTypedSignature), ADDRESS);
  assert.deepEqual(approvals, ['eth_requestAccounts', 'personal_sign', 'eth_signTypedData_v4']);
  await assert.rejects(site.request({ method: 'personal_sign', params: ['0x010203', `0x${'2'.repeat(40)}`] }), (error) => error.code === 4100);

  console.log('Import verification passed: private-key validation, known address, message/typed-data/transaction signatures, protected storage envelope and legacy migration, lock/unlock identity guard, account limits and EIP-1193 signing. No RPC or transaction broadcast.');
}

verify().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
