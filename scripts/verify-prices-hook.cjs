/* Exercise the actual valuation hook with deterministic React lifecycles and public quote fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise((done) => setImmediate(done));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function compiled(relative, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: (name) => Object.prototype.hasOwnProperty.call(dependencies, name) ? dependencies[name] : require(name),
    AbortController, URL, URLSearchParams, setTimeout, clearTimeout, console,
    fetch: async () => { throw new Error('Offline hook verification must not access a network'); }, ...globals,
  }, { filename: relative });
  return module.exports;
}
const pricingApi = compiled('src/core/asset-prices.ts', { ethers: require('ethers') });
const bsc = { id: 'bsc', chainId: 56, name: 'BSC', nativeSymbol: 'BNB', rpcUrl: 'https://fixture.invalid' };
const eth = { id: 'eth', chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH', rpcUrl: 'https://eth-fixture.invalid' };
const tokenA = `0x${'a'.repeat(40)}`;
const tokenB = `0x${'b'.repeat(40)}`;
const quote = (priceUsd, stale = false) => ({ priceUsd, timestamp: Math.floor(Date.now() / 1000), stale });
const snapshot = (native = '600', tokens = {}, extra = {}) => ({ native: native === null ? null : quote(native), tokens, fetchedAt: Date.now(), error: false, ...extra });
function native(balance = '2', extra = {}) { return { id: 'native', symbol: 'BNB', name: 'BSC', decimals: 18, balance, rawBalance: null, ...extra }; }
function token(address = tokenA, balance = '100', extra = {}) { return { id: address.toLowerCase(), symbol: 'COIN', name: 'Fixture coin', decimals: 18, balance, rawBalance: null, token: { address, symbol: 'COIN', name: 'Fixture coin', decimals: 18 }, ...extra }; }

/* Effect cleanup, memo dependencies, state updates and post-unmount writes retain React semantics. */
function reactHarness() {
  const slots = [];
  let index = 0, dirty = false, mounted = false, hook, args, output, writesAfterUnmount = 0;
  const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { type: 'state', value: typeof initial === 'function' ? initial() : initial };
      const cell = slots[position];
      return [cell.value, (next) => {
        if (!mounted) { writesAfterUnmount += 1; return; }
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (!Object.is(value, cell.value)) { cell.value = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { type: 'ref', value: { current: initial } };
      return slots[position].value;
    },
    useCallback(callback, deps) {
      const position = index++;
      if (!slots[position] || !sameDeps(slots[position].deps, deps)) slots[position] = { type: 'callback', value: callback, deps };
      return slots[position].value;
    },
    useMemo(factory, deps) {
      const position = index++;
      if (!slots[position] || !sameDeps(slots[position].deps, deps)) slots[position] = { type: 'memo', value: factory(), deps };
      return slots[position].value;
    },
    useEffect(effect, deps) {
      const position = index++;
      const previous = slots[position];
      if (!previous || !sameDeps(previous.deps, deps)) slots[position] = { type: 'effect', deps, effect, cleanup: previous?.cleanup, pending: true };
    },
  };
  function render() {
    dirty = false; index = 0; output = hook(...args);
    const pending = slots.filter((slot) => slot.type === 'effect' && slot.pending);
    pending.forEach((slot) => { slot.pending = false; slot.cleanup?.(); });
    pending.forEach((slot) => { slot.cleanup = slot.effect(); });
  }
  return { react,
    mount(fn, values) { mounted = true; hook = fn; args = values; render(); },
    update(values) { assert.equal(mounted, true); args = values; render(); },
    get current() { return output; },
    get writesAfterUnmount() { return writesAfterUnmount; },
    async settle() { for (let pass = 0; pass < 12; pass += 1) { await tick(); if (mounted && dirty) render(); } },
    unmount() { slots.filter((slot) => slot.type === 'effect').forEach((slot) => slot.cleanup?.()); mounted = false; },
  };
}
function fixture(initialAssets = [native(), token()], initialEnabled = true, initialAutoRefresh = true) {
  const harness = reactHarness();
  const queries = [], timers = new Map(), appStateListeners = new Set();
  const appState = {
    currentState: 'active',
    addEventListener(event, listener) {
      assert.equal(event, 'change');
      appStateListeners.add(listener);
      return { remove() { appStateListeners.delete(listener); } };
    },
  };
  const api = { ...pricingApi, assetPriceService: {
    getQuotes(...args) {
      assert.equal(args.length, 3, 'only chain ID, contract addresses and refresh intent reach the service');
      assert.equal(typeof args[0], 'number');
      assert.ok(Array.isArray(args[1]));
      args[1].forEach((address) => assert.match(address, /^0x[0-9a-f]{40}$/));
      assert.equal(typeof args[2], 'boolean');
      const response = deferred(); queries.push({ chainId: args[0], addresses: Array.from(args[1]), force: args[2], response });
      return response.promise;
    },
  } };
  const hooks = compiled('src/ui/useAssetPrices.ts', { react: harness.react, 'react-native': { AppState: appState }, '../core/asset-prices.js': api }, {
    setInterval(callback, duration) { const id = Symbol(); timers.set(id, { callback, duration }); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  let args = [bsc, initialAssets, 'wallet-1:account-0', false, initialEnabled, initialAutoRefresh];
  harness.mount(hooks.useAssetPrices, args);
  return { harness, queries, timers, appStateListeners,
    setAppState(nextState) { appState.currentState = nextState; [...appStateListeners].forEach((listener) => listener(nextState)); },
    update(changes) { args = [changes.network ?? args[0], changes.assets ?? args[1], changes.contextKey ?? args[2], changes.balancesLoading ?? args[3], changes.enabled ?? args[4], changes.autoRefresh ?? args[5]]; harness.update(args); },
  };
}
const fQuote = () => snapshot('600', { [tokenA]: quote('1') });

async function initialDeduplicationAndRefresh() {
  const f = fixture();
  const first = f.harness.current.refresh();
  assert.equal(f.harness.current.refresh(true), first, 'effect/focus/pull refresh share the pending request');
  await f.harness.settle();
  assert.equal(f.queries.length, 1);
  assert.deepEqual(f.queries[0].addresses, [tokenA]);
  f.queries[0].response.resolve(fQuote()); await first; await f.harness.settle();
  assert.equal(f.harness.current.totalUsd, '1300');
  assert.equal(f.harness.current.complete, true);
  assert.equal(f.harness.current.assets.native.priceUsd, '600');
  assert.equal(f.harness.current.assets[tokenA].valueUsd, '100');
  const forced = f.harness.current.refresh(true); await f.harness.settle();
  assert.equal(f.queries[1].force, true, 'explicit settled pull-to-refresh bypasses public quote cache');
  assert.equal(f.harness.current.complete, false, 'refreshing valuation is not presented as current complete data');
  f.queries[1].response.resolve(fQuote()); await forced; await f.harness.settle();
  assert.equal(f.timers.size, 1);
  const timer = Array.from(f.timers.values())[0]; assert.equal(timer.duration, 60_000); timer.callback();
  await f.harness.settle(); assert.equal(f.queries.length, 3); assert.equal(f.queries[2].force, false);
  f.queries[2].response.resolve(fQuote()); await f.harness.settle();
  f.harness.unmount(); assert.equal(f.timers.size, 0, 'unmount clears periodic requests');
}

async function chainAndAccountRaceIsolation() {
  const f = fixture(); await f.harness.settle();
  f.update({ network: eth, contextKey: 'wallet-1:account-1' });
  assert.equal(f.harness.current.totalUsd, null, 'switching chain/account cannot show old quotes on new balances');
  await f.harness.settle(); assert.equal(f.queries.length, 2); assert.equal(f.queries[1].chainId, 1);
  f.queries[1].response.resolve(snapshot('3000', { [tokenA]: quote('2') })); await f.harness.settle();
  assert.equal(f.harness.current.totalUsd, '6200');
  f.queries[0].response.resolve(snapshot('1', { [tokenA]: quote('99') })); await f.harness.settle();
  assert.equal(f.harness.current.totalUsd, '6200', 'late BSC result cannot overwrite Ethereum data');
  f.update({ contextKey: 'wallet-2:account-1', assets: [native('3'), token(tokenA, '50')] });
  assert.equal(f.harness.current.totalUsd, null, 'new unlocked wallet cannot inherit previous displayed valuation');
  await f.harness.settle(); assert.equal(f.queries.length, 3);
  f.queries[2].response.resolve(snapshot('3000', { [tokenA]: quote('2') })); await f.harness.settle();
  assert.equal(f.harness.current.totalUsd, '9100', 'valuation is recomputed from current wallet balances');
  f.harness.unmount();
}

async function tokenEditsAndBalanceChanges() {
  const f = fixture(); await f.harness.settle(); f.queries[0].response.resolve(fQuote()); await f.harness.settle();
  f.update({ assets: [token(tokenA.toUpperCase().replace('0X', '0x'), '5'), native('1')] });
  await f.harness.settle();
  assert.equal(f.queries.length, 1, 'balance and order edits reuse public contract quotes');
  assert.equal(f.harness.current.totalUsd, '605');
  f.update({ assets: [native('1'), token(tokenA, '5'), token(tokenB, '2')] });
  assert.equal(f.harness.current.totalUsd, null, 'new contract set starts an isolated price scope');
  await f.harness.settle(); assert.equal(f.queries.length, 2); assert.deepEqual(f.queries[1].addresses, [tokenA, tokenB]);
  f.update({ assets: [native('1'), token(tokenB, '2')] }); await f.harness.settle();
  assert.equal(f.queries.length, 3); assert.deepEqual(f.queries[2].addresses, [tokenB]);
  f.queries[2].response.resolve(snapshot('600', { [tokenB]: quote('10') })); await f.harness.settle();
  assert.equal(f.harness.current.totalUsd, '620');
  f.queries[1].response.resolve(snapshot('600', { [tokenA]: quote('1000'), [tokenB]: quote('9000') })); await f.harness.settle();
  assert.equal(f.harness.current.totalUsd, '620', 'removed-token request cannot restore old token prices');
  assert.equal(f.harness.current.assets[tokenA], undefined);
  f.harness.unmount();
}

async function unknownPartialAndZeroBalances() {
  const f = fixture([native('2'), token(tokenA, '100'), token(tokenB, '0')]);
  await f.harness.settle(); f.queries[0].response.resolve(snapshot('600')); await f.harness.settle();
  assert.equal(f.harness.current.totalUsd, '1200', 'unknown positive asset is excluded from the known subtotal');
  assert.equal(f.harness.current.missingCount, 1);
  assert.equal(f.harness.current.complete, false);
  assert.equal(f.harness.current.assets[tokenA].valueUsd, null, 'missing price is unknown rather than zero dollars');
  assert.equal(f.harness.current.assets[tokenB].valueUsd, '0', 'known zero balance needs no invented quote');
  f.update({ assets: [native(null), token(tokenA, '0'), token(tokenB, '0')] }); await f.harness.settle();
  assert.equal(f.harness.current.complete, false, 'missing balance does not masquerade as an empty wallet');
  assert.equal(f.harness.current.missingCount, 1);
  f.update({ assets: [native('0'), token(tokenA, '0'), token(tokenB, '0')], balancesLoading: true });
  await f.harness.settle(); assert.equal(f.harness.current.totalUsd, '0'); assert.equal(f.harness.current.complete, false);
  f.update({ balancesLoading: false }); await f.harness.settle(); assert.equal(f.harness.current.complete, true);
  f.harness.unmount();
}

async function staleAndRetainedBalanceAreIncomplete() {
  const f = fixture([native('2', { loading: true }), token()]);
  await f.harness.settle(); f.queries[0].response.resolve(fQuote()); await f.harness.settle();
  assert.equal(f.harness.current.totalUsd, '1300'); assert.equal(f.harness.current.complete, false, 'retained balance while RPC loads is explicitly estimated');
  f.update({ assets: [native(), token()], balancesLoading: true }); await f.harness.settle();
  assert.equal(f.harness.current.complete, false, 'token metadata loading prevents a misleading complete total');
  f.update({ balancesLoading: false }); await f.harness.settle(); assert.equal(f.harness.current.complete, true);
  const refreshed = f.harness.current.refresh(); await f.harness.settle();
  f.queries[1].response.resolve(snapshot('600', { [tokenA]: quote('1') }, { native: quote('600', true), error: true }));
  await refreshed; await f.harness.settle();
  assert.equal(f.harness.current.totalUsd, '1300'); assert.equal(f.harness.current.stale, true); assert.equal(f.harness.current.complete, false); assert.equal(f.harness.current.error, true);
  f.harness.unmount();
}

async function failuresAndDisabledStates() {
  const f = fixture(); await f.harness.settle(); f.queries[0].response.reject(new Error('fixture quote outage')); await f.harness.settle();
  assert.equal(f.harness.current.error, true); assert.equal(f.harness.current.loading, false); assert.equal(f.harness.current.totalUsd, null); assert.equal(f.harness.current.complete, false);
  const retried = f.harness.current.refresh(true); await f.harness.settle(); f.queries[1].response.resolve(fQuote()); await retried; await f.harness.settle();
  assert.equal(f.harness.current.complete, true);
  f.update({ enabled: false }); await f.harness.settle();
  assert.equal(f.timers.size, 0); assert.equal(f.harness.current.loading, false);
  assert.equal(f.harness.current.totalUsd, null, 'disabled scope must not present retained wallet valuations');
  assert.equal(f.harness.current.complete, false, 'disabled quotes cannot claim a current complete total');
  await f.harness.current.refresh(true); assert.equal(f.queries.length, 2, 'disabled wallet sends no quote requests');
  f.update({ enabled: true }); await f.harness.settle(); assert.equal(f.queries.length, 3);
  f.queries[2].response.resolve(fQuote()); await f.harness.settle(); assert.equal(f.harness.current.totalUsd, '1300');
  f.harness.unmount();
  const neverEnabled = fixture([native()], false); await neverEnabled.harness.settle();
  assert.equal(neverEnabled.queries.length, 0); assert.equal(neverEnabled.timers.size, 0); assert.equal(neverEnabled.harness.current.complete, false);
  neverEnabled.harness.unmount();
}

async function lateDisabledAndUnmountedResultsIgnored() {
  const disabled = fixture(); await disabled.harness.settle(); disabled.update({ enabled: false }); await disabled.harness.settle();
  disabled.queries[0].response.resolve(fQuote()); await disabled.harness.settle();
  assert.equal(disabled.harness.current.totalUsd, null); assert.equal(disabled.harness.current.complete, false);
  disabled.harness.unmount();
  const unmounted = fixture(); await unmounted.harness.settle(); unmounted.harness.unmount();
  unmounted.queries[0].response.resolve(fQuote()); await tick(); await tick();
  assert.equal(unmounted.harness.writesAfterUnmount, 0, 'late service completion cannot set state after unmount');
  assert.equal(unmounted.timers.size, 0);
}

async function foregroundRecoveryAndBackgroundPause() {
  const f = fixture(); await f.harness.settle();
  f.queries[0].response.resolve(snapshot('600', { [tokenA]: quote('1', true) }, { error: true }));
  await f.harness.settle(); assert.equal(f.harness.current.stale, true);
  assert.equal(f.appStateListeners.size, 1);
  const timer = Array.from(f.timers.values())[0];
  f.setAppState('background'); timer.callback(); await f.harness.settle();
  assert.equal(f.queries.length, 1, 'background timers do not request market prices');
  f.setAppState('inactive'); timer.callback(); await f.harness.settle();
  assert.equal(f.queries.length, 1, 'inactive app does not request market prices');
  f.setAppState('active'); await f.harness.settle();
  assert.equal(f.queries.length, 2, 'returning to the app requests prices immediately');
  assert.equal(f.queries[1].force, true, 'foreground recovery bypasses recent failure cache');
  f.setAppState('active'); timer.callback(); await f.harness.settle();
  assert.equal(f.queries.length, 2, 'foreground events and periodic refresh deduplicate in-flight work');
  f.queries[1].response.resolve(fQuote()); await f.harness.settle();
  assert.equal(f.harness.current.stale, false); assert.equal(f.harness.current.complete, true);
  f.update({ enabled: false }); await f.harness.settle();
  assert.equal(f.appStateListeners.size, 0, 'disabled screens remove foreground listeners');
  f.setAppState('background'); f.setAppState('active'); await f.harness.settle();
  assert.equal(f.queries.length, 2, 'disabled screens do not request prices on foreground events');
  f.update({ enabled: true }); await f.harness.settle();
  assert.equal(f.queries.length, 3); f.queries[2].response.resolve(fQuote()); await f.harness.settle();
  f.harness.unmount(); assert.equal(f.appStateListeners.size, 0, 'unmount removes foreground listeners');
  f.setAppState('background'); f.setAppState('active');
  assert.equal(f.harness.writesAfterUnmount, 0);
}

async function snapshotModeKeepsExplicitRefreshes() {
  const f = fixture([native(), token()], true, false); await f.harness.settle();
  assert.equal(f.queries.length, 1, 'snapshot mode still performs its initial load');
  f.queries[0].response.resolve(fQuote()); await f.harness.settle();
  assert.equal(f.timers.size, 0, 'snapshot mode does not install periodic price requests');
  assert.equal(f.appStateListeners.size, 0, 'snapshot mode does not install foreground refresh listeners');
  f.setAppState('background'); f.setAppState('active'); await f.harness.settle();
  assert.equal(f.queries.length, 1, 'foreground return preserves the snapshot');
  const manual = f.harness.current.refresh(true); await f.harness.settle();
  assert.equal(f.queries.length, 2, 'snapshot mode permits explicit refresh');
  assert.equal(f.queries[1].force, true);
  f.queries[1].response.resolve(fQuote()); await manual; await f.harness.settle();
  f.update({ network: eth }); await f.harness.settle();
  assert.equal(f.queries.length, 3, 'snapshot mode loads a changed context once');
  assert.equal(f.queries[2].chainId, 1);
  f.queries[2].response.resolve(fQuote()); await f.harness.settle();
  f.update({ autoRefresh: true }); await f.harness.settle();
  assert.equal(f.queries.length, 3, 'enabling automatic refresh does not duplicate the initial load');
  assert.equal(f.timers.size, 1); assert.equal(f.appStateListeners.size, 1);
  f.update({ autoRefresh: false }); await f.harness.settle();
  assert.equal(f.timers.size, 0); assert.equal(f.appStateListeners.size, 0);
  f.harness.unmount();
}

async function verify() {
  await initialDeduplicationAndRefresh();
  await chainAndAccountRaceIsolation();
  await tokenEditsAndBalanceChanges();
  await unknownPartialAndZeroBalances();
  await staleAndRetainedBalanceAreIncomplete();
  await failuresAndDisabledStates();
  await lateDisabledAndUnmountedResultsIgnored();
  await foregroundRecoveryAndBackgroundPause();
  await snapshotModeKeepsExplicitRefreshes();
  console.log('Price hook verification passed: deduplicated refreshes, public-only queries, chain/account/wallet/token isolation, current balance recomputation, partial/zero/unknown totals, loading/stale labels, foreground recovery, background pause, manual snapshot mode and disabled/unmounted cleanup. No live RPC or wallet secrets.');
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
