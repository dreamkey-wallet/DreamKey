/* Exercise the real incremental asset loader without React Native or live RPC. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-assets-'));
const source = fs.readFileSync(path.join(__dirname, '../src/ui/wallet-assets-loader.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
fs.writeFileSync(path.join(output, 'loader.js'), compiled.replace(/require\("ethers"\)/g, `require(${JSON.stringify(require.resolve('ethers'))})`));
const { WalletAssetsLoader, walletAssetContextKey } = require(path.join(output, 'loader.js'));
const network = { id: 'fixture', chainId: 56, name: 'BSC fixture', nativeSymbol: 'BNB', rpcUrl: 'https://fixture.invalid' };
const token = { address: `0x${'1'.repeat(40)}`, symbol: 'TOKEN', name: 'Fixture token', decimals: 6 };
const another = { ...token, address: `0x${'2'.repeat(40)}`, symbol: 'NEW' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((done) => setImmediate(done));
const context = (core, accountIndex = 0, selectedNetwork = network) => ({ core, accountIndex, network: selectedNetwork, key: walletAssetContextKey(core, accountIndex, selectedNetwork) });

async function verify() {
  let state;
  let nativeCalls = 0;
  let tokenCalls = 0;
  let metadataCalls = 0;
  const native = deferred();
  const slowToken = deferred();
  const metadata = deferred();
  const core = {
    getNativeBalance: () => { nativeCalls += 1; return native.promise; },
    getErc20Balance: () => { tokenCalls += 1; return slowToken.promise; },
  };
  const loader = new WalletAssetsLoader(() => { metadataCalls += 1; return metadata.promise; }, (next) => { state = next; });
  const active = context(core);
  const first = loader.refresh(active);
  assert.equal(loader.refresh(active), first, 'duplicate focus/effect/pull refresh shares the same Promise');
  await tick();
  assert.equal(nativeCalls, 1);
  assert.equal(metadataCalls, 1);
  native.resolve('1.25');
  await tick();
  assert.equal(state.assets[0].balance, '1.25', 'native balance is published before metadata finishes');
  assert.equal(state.assets[0].rawBalance, '1250000000000000000');
  assert.equal(state.nativeLoading, false);
  assert.equal(state.loading, true, 'send still waits for a complete asset refresh');
  metadata.resolve([token]);
  await tick();
  assert.equal(tokenCalls, 1);
  assert.equal(state.assets[0].balance, '1.25', 'token metadata arrival preserves already completed BNB');
  assert.equal(state.assets[1].loading, true);
  slowToken.resolve({ formatted: '3.5', raw: '3500000' });
  await first;
  assert.equal(state.loading, false);
  assert.equal(state.assets[1].balance, '3.5');

  const replacement = deferred();
  const failedToken = deferred();
  core.getNativeBalance = () => replacement.promise;
  core.getErc20Balance = () => failedToken.promise;
  const second = loader.refresh(active);
  await tick();
  assert.equal(state.assets[0].balance, '1.25', 'refresh keeps the prior display balance');
  assert.equal(state.assets[1].balance, '3.5', 'metadata read does not erase a matching token balance');
  assert.equal(state.assets[1].loading, true, 'retained token balance cannot be mistaken for current balance');
  failedToken.reject(new Error('fixture failure'));
  replacement.resolve('2');
  await second;
  assert.equal(state.assets[1].balance, null, 'a failed RPC never supplies an obsolete available balance');
  assert.equal(state.assets[1].rawBalance, null);
  assert.equal(state.error, 'Balance unavailable');
  assert.equal(state.nativeLoading, false);

  const obsolete = deferred();
  core.getNativeBalance = () => obsolete.promise;
  core.getErc20Balance = async () => ({ formatted: '0', raw: '0' });
  const oldRefresh = loader.refresh(active);
  await tick();
  const differentCore = { getNativeBalance: async () => '9', getErc20Balance: async () => ({ formatted: '8', raw: '8000000' }) };
  const changed = context(differentCore);
  assert.notEqual(changed.key, active.key, 'wallet identity is part of the context even for account 0 on BSC');
  assert.notEqual(context(core, 1).key, active.key);
  assert.notEqual(context(core, 0, { ...network, rpcUrl: 'https://new.invalid' }).key, active.key);
  assert.notEqual(context(core, 0, { ...network, rpcFallbackUrls: ['https://backup.invalid'] }).key, active.key);
  const newRefresh = loader.refresh(changed);
  assert.equal(state.assets[0].balance, null, 'switching wallets cannot expose the old wallet balance');
  await newRefresh;
  await oldRefresh;
  obsolete.resolve('999');
  await tick();
  assert.equal(state.key, changed.key);
  assert.equal(state.assets[0].balance, '9', 'late results from another wallet cannot overwrite current state');

  const oldToken = deferred();
  let tokens = [token];
  let newTokenCalls = 0;
  const eventCore = {
    getNativeBalance: async () => '4',
    getErc20Balance: (_account, _network, input) => {
      if (input.address === token.address) return oldToken.promise;
      newTokenCalls += 1;
      return Promise.resolve({ formatted: '7', raw: '7000000' });
    },
  };
  const eventLoader = new WalletAssetsLoader(async () => tokens, (next) => { state = next; });
  const eventContext = context(eventCore);
  const beforeTokenChange = eventLoader.refresh(eventContext);
  await tick();
  tokens = [another];
  await eventLoader.refresh(eventContext, true);
  await beforeTokenChange;
  assert.equal(newTokenCalls, 1, 'token metadata events restart a refresh even while an old RPC is pending');
  assert.deepEqual(state.assets.map((asset) => asset.id), ['native', another.address]);
  oldToken.resolve({ formatted: '123', raw: '123000000' });
  await tick();
  assert.equal(state.assets[1].symbol, 'NEW');
  assert.equal(state.assets[1].balance, '7', 'an obsolete removed token cannot return to the list');

  let strictNativeCalls = 0;
  let strictMetadataCalls = 0;
  const strictCore = { getNativeBalance: async () => { strictNativeCalls += 1; return '6'; }, getErc20Balance: async () => ({ formatted: '0', raw: '0' }) };
  const strictLoader = new WalletAssetsLoader(async () => { strictMetadataCalls += 1; return []; }, (next) => { state = next; });
  const strictContext = context(strictCore);
  const canceled = strictLoader.refresh(strictContext);
  strictLoader.invalidate();
  await strictLoader.refresh(strictContext);
  await canceled;
  assert.equal(strictNativeCalls, 1, 'strict effect cleanup does not issue a superseded scheduled RPC');
  assert.equal(strictMetadataCalls, 1);
  assert.equal(state.assets[0].balance, '6');
  const stateAfterCleanup = state;
  strictLoader.invalidate();
  await tick();
  assert.equal(state, stateAfterCleanup);

  const metadataFailure = deferred();
  const metadataLoader = new WalletAssetsLoader(() => metadataFailure.promise, (next) => { state = next; });
  const broken = metadataLoader.refresh(strictContext);
  metadataFailure.reject(new Error('local fixture storage unavailable'));
  await broken;
  assert.equal(state.assets[0].balance, '6', 'metadata failure does not block an available native balance');
  assert.equal(state.loading, false);
  assert.equal(state.error, 'Token list unavailable');
  console.log('Asset loading verification passed: independent native/token updates, duplicate refresh deduplication, wallet isolation, stale-result rejection, token edits, cleanup and failed-balance invalidation. No live RPC or secrets.');
}
verify().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(output, { recursive: true, force: true }));
