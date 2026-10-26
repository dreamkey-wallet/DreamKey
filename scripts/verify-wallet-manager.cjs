/* Verify managed wallet collection semantics with public fixtures only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-manager-'));
require('./compile-ts-fixture.cjs')('src/core/wallet-manager.ts', out);

async function run() {
  const { WalletManager, MemoryWalletManagerStorage } = require(path.join(out, 'core/wallet-manager.js'));
  const PRIVATE_KEY = `0x${'0'.repeat(63)}1`;
  const MNEMONIC = 'test test test test test test test test test test test junk';
  const networks = [{ id: 'fixture', chainId: 1, name: 'Fixture', rpcUrl: 'https://fixture.invalid' }];
  const storage = new MemoryWalletManagerStorage();
  const manager = new WalletManager({ storage, networks });
  const imported = manager.addPrivateKey(PRIVATE_KEY, 'Imported');
  const mnemonic = manager.addMnemonic(MNEMONIC, 'Recovery');
  const watched = manager.addWatchAddress(`0x${'2'.repeat(40)}`, 'Observed');
  assert.equal(manager.list().length, 3);
  assert.equal(manager.get(watched.id).watchOnly, true);
  assert.throws(() => manager.getCore(watched.id).getSigner(), /watch-only/);
  assert.throws(() => manager.exportPrivateKey(watched.id), /watch-only/);
  assert.equal(manager.exportPrivateKey(imported.id).length, 66);
  assert.throws(() => manager.exportMnemonic(imported.id), /has no mnemonic/, 'Private-key wallets cannot export a fabricated recovery phrase');
  assert.equal(manager.getCore(imported.id).canDeriveAccounts(), false);
  assert.throws(() => manager.getCore(imported.id).addAccount(), /cannot be derived/);
  assert.equal(manager.exportMnemonic(mnemonic.id), MNEMONIC);
  manager.setSelectedId(watched.id);
  await manager.persist();
  const restored = await WalletManager.restore({ storage, networks });
  assert.equal(restored.getSelectedId(), watched.id);
  assert.equal(restored.get(watched.id).watchOnly, true);
  assert.equal(restored.getCore(watched.id).getAccount(0).address.toLowerCase(), watched.address.toLowerCase());
  assert.equal(restored.get(imported.id).kind, 'privateKey');
  assert.equal(restored.exportPrivateKey(imported.id), PRIVATE_KEY, 'Private-key backups restore without a mnemonic');
  assert.throws(() => restored.exportMnemonic(imported.id), /has no mnemonic/);
  assert.equal(restored.getCore(imported.id).listAccounts().length, 1);
  assert.equal(restored.getCore(imported.id).canDeriveAccounts(), false);
  restored.remove(imported.id);
  assert.equal(restored.list().some((wallet) => wallet.id === imported.id), false);
  let finishSave;
  const late = new WalletManager({ networks, storage: { save() { return new Promise((resolve) => { finishSave = resolve; }); } } });
  const { WalletCore } = require(path.join(out, 'core/wallet-core.js'));
  const lateCore = WalletCore.fromPrivateKey(PRIVATE_KEY, { networks });
  const adding = late.addCoreAndPersist(lateCore);
  late.dispose();
  assert.equal(lateCore.vault.isLocked(), true, 'Disposal drops pending import keys before the storage promise resolves');
  finishSave();
  await assert.rejects(adding, /session has expired/);
  assert.equal(late.list().length, 0, 'A delayed storage completion cannot repopulate a locked collection');
  assert.equal(lateCore.vault.isLocked(), true, 'A failed late import must also drop its pending key material');
  console.log('Wallet manager verification passed: controlled imports, observation-only account, exports, selected wallet persistence and removal.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(out, { recursive: true, force: true }));

