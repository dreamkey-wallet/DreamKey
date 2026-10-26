/* Verify common contracts, persisted hiding and legacy imports without a wallet or network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { isAddress, getAddress } = require('ethers');
const root = path.resolve(__dirname, '..');
const credentials = new Map();
let failNextWrite = false;
const keychain = {
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' },
  getGenericPassword: async ({ service }) => credentials.has(service) ? { password: credentials.get(service) } : false,
  setGenericPassword: async (user, password, { service }) => {
    if (failNextWrite) { failNextWrite = false; return false; }
    credentials.set(service, password);
    return true;
  },
};
function createLoader() {
  const modules = new Map();
  const load = (relativePath) => {
    const filename = path.join(root, relativePath);
    if (modules.has(filename)) return modules.get(filename).exports;
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const entry = new Module(filename, module);
    entry.filename = filename;
    entry.paths = Module._nodeModulePaths(path.dirname(filename));
    const normalRequire = entry.require.bind(entry);
    entry.require = (specifier) => {
      if (specifier === 'react-native-keychain') return keychain;
      const source = specifier.startsWith('.') ? path.resolve(path.dirname(filename), specifier.replace(/\.js$/, '.ts')) : undefined;
      return source && fs.existsSync(source) ? load(path.relative(root, source)) : normalRequire(specifier);
    };
    modules.set(filename, entry);
    entry._compile(compiled, filename);
    return entry.exports;
  };
  return load;
}
const service = (chainId) => `independent-wallet.tokens.${chainId}`;
const token = (value) => ({ address: `0x${value.repeat(40)}`, symbol: 'USER', name: 'Imported coin', decimals: 9 });
const expectedDefaults = {
  56: ['USDT'],
  1: ['USDT', 'USDC'],
  42161: ['USDC'],
  137: ['USDC'],
  8453: ['USDC'],
};
const previousDefaults = {
  56: ['USDT', 'USDC', 'ETH', 'BTCB'],
  1: ['USDT', 'USDC', 'WBTC', 'LINK'],
  42161: ['USD₮0', 'USDC', 'WBTC', 'ARB'],
  137: ['USDT0', 'USDC', 'WETH', 'WBTC'],
  8453: ['USDC', 'WETH', 'cbBTC', 'AERO'],
};

async function verify() {
  const load = createLoader();
  const { getCommonTokens, getKnownTokens, getCommonToken } = load('src/core/common-tokens.ts');
  const { DEFAULT_NETWORKS } = load('src/core/networks.ts');
  const { getTokenIconId } = load('src/ui/token-icon-registry.ts');
  const storage = load('src/native/token-storage.ts');
  assert.equal(DEFAULT_NETWORKS.length, 5);
  for (const { chainId } of DEFAULT_NETWORKS) {
    const list = getCommonTokens(chainId);
    assert.equal(list.length, expectedDefaults[chainId].length, 'keep each mainnet directory bounded');
    assert.deepEqual(list.map(({ symbol }) => symbol), expectedDefaults[chainId], 'selected frequent assets remain in display order');
    assert.equal(getKnownTokens(chainId).length, 7, 'retain full verified catalog for imports');
    assert.equal(new Set(list.map(({ address }) => address.toLowerCase())).size, list.length);
    for (const item of getKnownTokens(chainId)) {
      assert.ok(isAddress(item.address), `invalid ${chainId}:${item.symbol}`);
      assert.equal(item.address, getAddress(item.address), 'checksummed built-in contract');
      assert.ok(Number.isInteger(item.decimals) && item.decimals >= 0 && item.decimals <= 18);
      assert.ok(getTokenIconId({ chainId, address: item.address }), `missing known logo ${chainId}:${item.symbol}`);
      assert.equal(getTokenIconId({ chainId: 999999, address: item.address }), undefined);
    }
    assert.deepEqual(await storage.loadTokens(chainId), list, 'fresh install contains defaults without storage writes');
  }
  assert.equal(credentials.size, 0);
  for (const { chainId } of DEFAULT_NETWORKS) {
    const defaults = getCommonTokens(chainId);
    const retired = getKnownTokens(chainId).filter(({ symbol }) => previousDefaults[chainId].includes(symbol) && !expectedDefaults[chainId].includes(symbol));
    const emptyVersioned = JSON.stringify({ version: 1, tokens: [], hiddenBuiltIns: retired.map(({ address }) => address.toLowerCase()) });
    for (const savedEmpty of [JSON.stringify([]), emptyVersioned]) {
      credentials.set(service(chainId), savedEmpty);
      assert.deepEqual(await storage.loadTokens(chainId), defaults, 'empty saved import lists use the latest reduced defaults');
      assert.equal(credentials.get(service(chainId)), savedEmpty, 'read migration does not rewrite user storage');
    }
    for (const formerDefault of retired) {
      credentials.set(service(chainId), JSON.stringify([{ ...formerDefault, symbol: 'FAKE', decimals: 0 }]));
      assert.deepEqual((await storage.loadTokens(chainId)).at(-1), formerDefault, 'legacy explicit former-default import keeps verified metadata');
      assert.deepEqual((await createLoader()('src/native/token-storage.ts').loadTokens(chainId)).at(-1), formerDefault, 'legacy former-default import survives restart');
      credentials.set(service(chainId), JSON.stringify({ version: 1, tokens: [{ ...formerDefault, symbol: 'FAKE', decimals: 0 }], hiddenBuiltIns: [formerDefault.address.toLowerCase()] }));
      assert.deepEqual((await storage.loadTokens(chainId)).at(-1), formerDefault, 'former hidden-default state does not discard an explicit manual import');
      await storage.removeToken(chainId, formerDefault.address);
      assert.deepEqual(await createLoader()('src/native/token-storage.ts').loadTokens(chainId), defaults, 'removed former-default import stays absent after restart');
      await storage.saveToken(chainId, { ...formerDefault, symbol: 'FAKE', decimals: 0 });
      assert.deepEqual((await createLoader()('src/native/token-storage.ts').loadTokens(chainId)).at(-1), formerDefault, 'former-default token can be explicitly reimported after removal');
      const saved = JSON.parse(credentials.get(service(chainId)));
      assert.deepEqual(saved.tokens, [formerDefault], 'only the explicit former-default import is persisted');
      assert.deepEqual(saved.hiddenBuiltIns, [], 'explicit reimport clears old hidden-default state');
    }
    credentials.delete(service(chainId));
  }
  assert.deepEqual(getCommonTokens(999999), []);
  assert.deepEqual(getKnownTokens(999999), []);
  assert.deepEqual(await storage.loadTokens(999999), []);
  assert.equal(getCommonTokens(56).find(({ symbol }) => symbol === 'USDT').decimals, 18);
  assert.equal(getCommonTokens(1).find(({ symbol }) => symbol === 'USDT').decimals, 6);
  assert.deepEqual(getCommonTokens(42161).map(({ symbol }) => symbol), ['USDC']);
  assert.deepEqual(getCommonTokens(137).map(({ symbol }) => symbol), ['USDC']);
  assert.deepEqual(getCommonTokens(8453).map(({ symbol }) => symbol), ['USDC']);
  for (const chainId of [42161, 137]) {
    const coins = getKnownTokens(chainId);
    const native = coins.find(({ symbol }) => symbol === 'USDC');
    const bridged = coins.find(({ symbol }) => symbol === 'USDC.e');
    assert.notEqual(native.address, bridged.address);
    assert.notEqual(getTokenIconId({ chainId, address: native.address }), getTokenIconId({ chainId, address: bridged.address }));
  }
  const disposable = getCommonTokens(1);
  disposable[0].decimals = 0;
  assert.equal(getCommonTokens(1)[0].decimals, 6, 'callers cannot modify bundled metadata');
  const disposableKnown = getKnownTokens(1);
  disposableKnown.find(({ symbol }) => symbol === 'UNI').decimals = 0;
  assert.equal(getKnownTokens(1).find(({ symbol }) => symbol === 'UNI').decimals, 18, 'catalog copies protect optional import metadata');
  const common = getCommonTokens(1)[0];
  credentials.set(service(1), JSON.stringify([token('1'), token('1'), { ...common, symbol: 'FAKE', decimals: 0 }, { address: 'invalid' }]));
  const migrated = await storage.loadTokens(1);
  assert.equal(migrated.length, 3);
  assert.deepEqual(migrated[0], common, 'legacy same-address metadata cannot override known decimals');
  assert.equal(migrated.at(-1).symbol, 'USER');
  assert.equal((await storage.loadTokens(56)).length, 1, 'imports are chain-specific');
  const knownOptional = getKnownTokens(56).find(({ symbol }) => symbol === 'CAKE');
  assert.ok(knownOptional);
  await storage.saveToken(56, { ...knownOptional, symbol: 'FAKE', decimals: 0 });
  assert.deepEqual((await storage.loadTokens(56)).at(-1), knownOptional, 'known optional imports retain verified metadata');
  assert.deepEqual(JSON.parse(credentials.get(service(56))).tokens, [knownOptional], 'non-default known token is persisted as an explicit import');
  assert.deepEqual((await createLoader()('src/native/token-storage.ts').loadTokens(56)).at(-1), knownOptional, 'optional known import stays visible after restart');
  await storage.removeToken(56, knownOptional.address);
  assert.equal((await storage.loadTokens(56)).length, 1);
  assert.equal((await createLoader()('src/native/token-storage.ts').loadTokens(56)).length, 1, 'removed optional token stays absent after restart');
  await storage.saveToken(56, knownOptional);
  assert.deepEqual((await createLoader()('src/native/token-storage.ts').loadTokens(56)).at(-1), knownOptional, 'optional token can be reimported after removal');
  credentials.set(service(56), JSON.stringify({ version: 1, tokens: [], hiddenBuiltIns: [knownOptional.address.toLowerCase()] }));
  await storage.saveToken(56, knownOptional);
  assert.deepEqual(JSON.parse(credentials.get(service(56))).hiddenBuiltIns, [], 'reimport clears former default hiding state');
  const optionalEth = getKnownTokens(1).find(({ symbol }) => symbol === 'UNI');
  credentials.set(service(1), JSON.stringify([{ ...optionalEth, symbol: 'FAKE', decimals: 0 }]));
  assert.deepEqual((await storage.loadTokens(1)).at(-1), optionalEth, 'legacy manual import of a former default survives catalog reduction');
  credentials.set(service(1), JSON.stringify({ version: 1, tokens: [{ ...optionalEth, symbol: 'FAKE', decimals: 0 }], hiddenBuiltIns: [optionalEth.address.toLowerCase()] }));
  assert.deepEqual((await storage.loadTokens(1)).at(-1), optionalEth, 'an old former-default hiding entry does not discard an explicit manual import');
  credentials.set(service(1), JSON.stringify([token('1'), token('1'), { ...common, symbol: 'FAKE', decimals: 0 }, { address: 'invalid' }]));

  let notifications = 0;
  const unsubscribe = storage.subscribeTokens(1, () => { notifications += 1; });
  await storage.removeToken(1, common.address);
  assert.ok(!(await storage.loadTokens(1)).some(({ address }) => address === common.address));
  const written = JSON.parse(credentials.get(service(1)));
  assert.equal(written.version, 1);
  assert.deepEqual(written.hiddenBuiltIns, [common.address.toLowerCase()]);
  assert.ok(!written.tokens.some(({ address }) => address === common.address), 'built-ins are not copied into persistent imports');
  const restartedStorage = createLoader()('src/native/token-storage.ts');
  assert.ok(!(await restartedStorage.loadTokens(1)).some(({ address }) => address === common.address), 'hidden coin stays hidden after app restart');
  await storage.saveToken(1, { ...common, symbol: 'FAKE', decimals: 0 });
  assert.deepEqual((await storage.loadTokens(1))[0], common, 'reimport restores built-in metadata');
  assert.deepEqual(JSON.parse(credentials.get(service(1))).hiddenBuiltIns, []);
  await Promise.all([storage.saveToken(1, token('2')), storage.saveToken(1, token('3'))]);
  assert.equal((await storage.loadTokens(1)).length, 5, 'concurrent imports retain both writes');
  await storage.removeToken(1, token('2').address);
  assert.ok(!(await storage.loadTokens(1)).some(({ address }) => address === token('2').address));
  failNextWrite = true;
  await assert.rejects(storage.saveToken(1, token('4')), /Could not save/);
  await storage.saveToken(1, token('5'));
  assert.ok((await storage.loadTokens(1)).some(({ address }) => address === token('5').address), 'failed save cannot poison later writes');
  assert.equal(notifications, 6);
  unsubscribe();
  await storage.saveToken(1, token('6'));
  assert.equal(notifications, 6);
  await assert.rejects(storage.loadTokens(0), /Invalid chain ID/);
  await assert.rejects(storage.removeToken(1, 'invalid'), /Invalid token address/);
  assert.deepEqual(getCommonToken(1, common.address.toLowerCase()), common);
  console.log('Common-token verification passed: 6 minimal defaults, 35 verified contracts/icons, empty stored-list upgrades, explicit former-default imports across all networks including BSC USDC, restart persistence, chain isolation, bridge identity, metadata protection, persistent hiding/restoration, concurrent imports and failed-save recovery. Offline fixtures only.');
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
