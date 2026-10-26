/* Mount the real send screen with offline balances and capture-only RPC reads. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const ethers = require('ethers');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const account = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const tokenAddress = '0x3333333333333333333333333333333333333333';
const otherAddress = '0x4444444444444444444444444444444444444444';
const network = { id: 'bsc-fixture', chainId: 56, name: 'BSC fixture', nativeSymbol: 'BNB', rpcUrl: 'https://fixture.invalid' };
const token = { address: tokenAddress, symbol: 'USDC', name: 'Fixture USDC', decimals: 6 };

function native(extra = {}) {
  return { id: 'native', symbol: 'BNB', name: 'BSC fixture', decimals: 18, balance: '2', rawBalance: ethers.parseEther('2').toString(), loading: false, ...extra };
}

function erc20(extra = {}) {
  return { id: tokenAddress, symbol: token.symbol, name: token.name, decimals: token.decimals, token, balance: '10', rawBalance: '10000000', loading: false, ...extra };
}

function loadingOther() {
  return erc20({ id: otherAddress, symbol: 'OTHER', token: { ...token, address: otherAddress, symbol: 'OTHER' }, balance: null, rawBalance: null, loading: true });
}

function compile(relative, dependencies, appendedSource = '') {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8') + appendedSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(name) {
      if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
      if (name === 'ethers') return ethers;
      throw new Error(`Unexpected test dependency: ${name}`);
    },
    console, setTimeout, clearTimeout,
    setInterval: dependencies.__setInterval ?? setInterval,
    clearInterval: dependencies.__clearInterval ?? clearInterval,
    requestAnimationFrame: dependencies.__requestAnimationFrame ?? ((callback) => setTimeout(callback, 0)),
    cancelAnimationFrame: dependencies.__cancelAnimationFrame ?? clearTimeout,
  }, { filename: relative });
  return module.exports;
}

function createHarness({ captureModals = true } = {}) {
  const slots = [];
  let index = 0, dirty = false, mounted = false, component, props, tree;
  const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const nativeTypes = Object.fromEntries(['ActivityIndicator', 'KeyboardAvoidingView', 'Modal', 'Pressable', 'RefreshControl', 'ScrollView', 'Text', 'TextInput', 'View', 'SafeAreaView'].map((name) => [name, name]));
  const react = {
    Fragment: 'Fragment',
    useState(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      const cell = slots[position];
      return [cell.value, (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (!Object.is(value, cell.value)) { cell.value = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { kind: 'ref', value: { current: initial } };
      return slots[position].value;
    },
    useCallback(callback, deps) {
      const position = index++;
      if (!slots[position] || !sameDeps(slots[position].deps, deps)) slots[position] = { kind: 'callback', value: callback, deps };
      return slots[position].value;
    },
    useMemo(factory, deps) {
      const position = index++;
      if (!slots[position] || !sameDeps(slots[position].deps, deps)) slots[position] = { kind: 'memo', value: factory(), deps };
      return slots[position].value;
    },
    useEffect(effect, deps) {
      const position = index++;
      const previous = slots[position];
      if (!previous || !sameDeps(previous.deps, deps)) slots[position] = { kind: 'effect', deps, effect, cleanup: previous?.cleanup, pending: true };
    },
    createElement(type, config, ...children) {
      const next = { ...(config || {}) };
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      // Capture modal callbacks without sharing their hooks with the parent.
      if (captureModals && typeof type === 'function' && ['AssetPicker', 'TokenImportModal'].includes(type.name)) return { type: type.name, props: next };
      if (typeof type === 'function') return type(next);
      return { type, props: next };
    },
  };
  const nativeApi = {
    ...nativeTypes,
    Alert: { alert() { throw new Error('Unexpected alert in send readiness test'); } },
    BackHandler: { addEventListener() { return { remove() {} }; } },
    Keyboard: { dismiss() {} },
    Platform: { OS: 'android' },
    StyleSheet: { create: (value) => value, hairlineWidth: 1 },
  };
  function render() {
    dirty = false; index = 0; tree = component(props);
    const pending = slots.filter((slot) => slot.kind === 'effect' && slot.pending);
    pending.forEach((slot) => { slot.pending = false; slot.cleanup?.(); });
    pending.forEach((slot) => { slot.cleanup = slot.effect(); });
  }
  return {
    react, nativeApi,
    mount(fn, nextProps) { component = fn; props = nextProps; mounted = true; render(); },
    update(nextProps) { props = { ...props, ...nextProps }; render(); },
    get tree() { return tree; },
    async settle() { for (let pass = 0; pass < 12; pass += 1) { await tick(); if (mounted && dirty) render(); } },
    unmount() { slots.filter((slot) => slot.kind === 'effect').forEach((slot) => slot.cleanup?.()); mounted = false; },
  };
}

function textContent(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return node.props ? textContent(node.props.children) : '';
}

function findAll(node, type, result = []) {
  if (!node) return result;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, type, result)); return result; }
  if (node.type === type) result.push(node);
  if (node.props) findAll(node.props.children, type, result);
  return result;
}

function button(harness, title) {
  const found = findAll(harness.tree, 'Pressable').find((node) => textContent(node) === title);
  assert.ok(found, `Expected visible button: ${title}`);
  return found;
}

async function fixture(options = {}) {
  const harness = createHarness();
  const calls = { chains: [], signer: [], estimates: [], fees: 0, balances: [], tokens: [], refreshes: 0, priceRefreshes: [], pricesEnabled: [], broadcasts: 0, submitted: 0, submissions: [], statuses: [] };
  const freshBalances = options.freshNativeReads ?? [ethers.parseEther('2'), ethers.parseEther('2')];
  const provider = {
    async estimateGas(transaction) { calls.estimates.push(transaction); return 21000n; },
    async getFeeData() { calls.fees += 1; return { gasPrice: 1_000_000_000n, maxFeePerGas: null, maxPriorityFeePerGas: null }; },
    async getBalance(address) {
      calls.balances.push(address);
      assert.equal(address, account);
      const value = freshBalances[calls.balances.length - 1];
      assert.notEqual(value, undefined, 'Every fresh native balance read has an explicit fixture');
      return value;
    },
  };
  const core = {
    getAccount(index) { assert.equal(index, 0); return { index, address: account }; },
    async assertNetwork(id) { calls.chains.push(id); assert.equal(id, network.id); },
    getSigner(index, id) { calls.signer.push({ index, id }); assert.equal(index, 0); assert.equal(id, network.id); return { provider }; },
    async getErc20Balance(index, id, input) {
      calls.tokens.push({ index, id, address: input.address });
      assert.equal(input.address, tokenAddress);
      assert.equal(index, 0); assert.equal(id, network.id);
      const raw = options.freshTokenRaw ?? '10000000';
      return { raw, formatted: ethers.formatUnits(raw, input.decimals), token: input };
    },
    async sendNative() { calls.broadcasts += 1; if (options.sendResult) return options.sendResult; throw options.sendError ?? new Error('This test must never broadcast'); },
    async sendErc20() { calls.broadcasts += 1; if (options.sendResult) return options.sendResult; throw options.sendError ?? new Error('This test must never broadcast'); },
    async getTransactionStatus(id, hash) {
      calls.statuses.push({ id, hash });
      if (options.statusError) throw options.statusError;
      return { hash, state: options.status ?? 'not-found' };
    },
  };
  const refresh = async () => { calls.refreshes += 1; };
  const screen = compile('src/ui/TransferScreens.tsx', {
    __requestAnimationFrame: options.requestAnimationFrame,
    __cancelAnimationFrame: options.cancelAnimationFrame,
    react: harness.react,
    'react-native': { ...harness.nativeApi, Platform: { OS: options.platform ?? 'android' } },
    './SecureModal.js': { SecureModal: 'Modal' },
    '@react-native-clipboard/clipboard': { async getString() { if (options.clipboard) return options.clipboard(); throw new Error('Unexpected clipboard read'); }, setString() { throw new Error('Unexpected clipboard write'); } },
    './QRScannerModal.js': { QrScannerModal: 'QrScannerModal' },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@react-navigation/native': { useIsFocused: () => true, useFocusEffect: (callback) => harness.react.useEffect(callback, [callback]) },
    './icons.js': new Proxy({}, { get: (_target, name) => (props) => ({ type: `icon:${String(name)}`, props }) }),
    '../core/network-fees.js': compile('src/core/network-fees.ts', {}),
    '../core/rpc-broadcast.js': compile('src/core/rpc-broadcast.ts', {}),
    '../core/asset-prices.js': { formatUsd: (value) => value },
    '../i18n.js': { useI18n: () => ({ language: 'zh' }) },
    '../native/token-storage.js': { removeToken() { throw new Error('Unexpected token edit'); }, saveToken() { throw new Error('Unexpected token edit'); } },
    './useWalletAssets.js': {
      useWalletAssets: () => ({ assets: options.assets ?? [native(), loadingOther()], loading: options.loading ?? true, contextKey: 'fixture-wallet', error: null, refresh }),
      displayAssetBalance: (balance) => balance ?? '—',
    },
    './useAssetPrices.js': { useAssetPrices: (_network, _assets, _key, _loading, enabled) => {
      calls.pricesEnabled.push(enabled);
      return { assets: {}, loading: options.priceLoading ?? false, refresh: async (force = false) => { calls.priceRefreshes.push(force); } };
    } },
  }).SendFlowScreen;
  harness.mount(screen, {
    core, accountIndex: 0, network, initialAssetAddress: options.selectedToken ? tokenAddress : undefined,
    onBack() {}, onSubmitted(hash, record) { calls.submitted += 1; calls.submissions.push({ hash, record }); },
  });
  await harness.settle();
  const inputs = findAll(harness.tree, 'TextInput');
  inputs.find((node) => node.props.accessibilityLabel === '接收地址').props.onChangeText(recipient);
  inputs.find((node) => node.props.accessibilityLabel === '发送数量').props.onChangeText('1');
  await harness.settle();
  return { harness, calls };
}

async function unrelatedDefaultTokenDoesNotBlock() {
  for (const selectedToken of [false, true]) {
    const f = await fixture({ selectedToken, assets: [native(), erc20(), loadingOther()], freshNativeReads: selectedToken ? [ethers.parseEther('2')] : undefined });
    assert.match(textContent(f.harness.tree), selectedToken ? /10 USDC/ : /2 BNB/, 'Available balance belongs to the ready selected asset');
    assert.doesNotMatch(textContent(f.harness.tree), /正在读取余额/, 'An unrelated loading token does not replace selected availability');
    assert.equal(Boolean(button(f.harness, '下一步').props.disabled), false, 'A ready selected asset can proceed while another default token is loading');
    button(f.harness, '下一步').props.onPress();
    await f.harness.settle();
    assert.match(textContent(f.harness.tree), /确认转账/);
    button(f.harness, '确认发送');
    assert.deepEqual(f.calls.chains, [network.id]);
    assert.equal(f.calls.estimates.length, 1);
    assert.equal(f.calls.fees, 1);
    assert.equal(f.calls.balances.length, selectedToken ? 1 : 2, 'Fresh native funds are checked before review');
    assert.equal(f.calls.tokens.length, selectedToken ? 1 : 0, 'The selected ERC-20 gets a fresh balance read');
    if (selectedToken) {
      assert.equal(f.calls.estimates[0].to, tokenAddress);
      const transfer = new ethers.Interface(['function transfer(address to,uint256 amount) returns (bool)']);
      const decoded = transfer.decodeFunctionData('transfer', f.calls.estimates[0].data);
      assert.equal(decoded[0], recipient);
      assert.equal(decoded[1], 1000000n);
    } else {
      assert.equal(f.calls.estimates[0].to, recipient);
      assert.equal(f.calls.estimates[0].value, ethers.parseEther('1'));
    }
    assert.equal(f.calls.broadcasts, 0);
    assert.equal(f.calls.submitted, 0, 'Opening the review never submits a transaction');
    f.harness.unmount();
  }
}

async function selectedLoadingAndUnknownAreBlocked() {
  for (const selectedToken of [false, true]) {
    for (const extra of [{ loading: true }, { loading: false, balance: null, rawBalance: null, error: 'Balance unavailable' }]) {
      const selected = selectedToken ? erc20(extra) : native(extra);
      const assets = selectedToken ? [native(), selected, loadingOther()] : [selected, loadingOther()];
      const f = await fixture({ selectedToken, assets });
      assert.equal(Boolean(button(f.harness, '下一步').props.disabled), true, 'Loading or unknown selected funds cannot proceed');
      // Invoke even a disabled handler to verify the prepare guard protects a
      // stale UI event, rather than relying only on Pressable's disabled prop.
      button(f.harness, '下一步').props.onPress();
      await f.harness.settle();
      assert.match(textContent(f.harness.tree), /无法读取可用余额/);
      assert.deepEqual(f.calls.chains, [], 'Unknown selected funds cannot begin fee estimation');
      assert.equal(f.calls.estimates.length, 0);
      assert.equal(f.calls.broadcasts, 0);
      f.harness.unmount();
    }
  }
}

async function freshBalancesRemainAuthoritative() {
  const cases = [
    { options: { freshNativeReads: [ethers.parseEther('2'), ethers.parseEther('0.5')] }, message: /可用余额不足/, tokens: 0 },
    { options: { selectedToken: true, assets: [native(), erc20(), loadingOther()], freshNativeReads: [ethers.parseEther('2')], freshTokenRaw: '500000' }, message: /可用余额不足/, tokens: 1 },
    { options: { selectedToken: true, assets: [native(), erc20(), loadingOther()], freshNativeReads: [0n] }, message: /原生代币余额不足以支付网络费用/, tokens: 1 },
    { options: { freshNativeReads: [ethers.parseEther('1'), ethers.parseEther('2')] }, message: /原生代币余额不足以支付网络费用/, tokens: 0 },
  ];
  for (const item of cases) {
    const f = await fixture(item.options);
    assert.equal(Boolean(button(f.harness, '下一步').props.disabled), false, 'Cached display balance permits a fresh funds check');
    button(f.harness, '下一步').props.onPress();
    await f.harness.settle();
    assert.match(textContent(f.harness.tree), item.message);
    assert.doesNotMatch(textContent(f.harness.tree), /确认转账/, 'Insufficient fresh asset or gas funds never open review');
    assert.equal(f.calls.estimates.length, 1);
    assert.equal(f.calls.tokens.length, item.tokens);
    assert.equal(f.calls.broadcasts, 0);
    f.harness.unmount();
  }
}

async function pickerRefreshesPricesWithoutPreparingTransfers() {
  const f = await fixture({ assets: [native(), erc20()], loading: false, priceLoading: true });
  assert.equal(f.calls.pricesEnabled.at(-1), false, 'The amount form does not fetch prices before opening the asset picker');
  const balanceRefreshes = f.calls.refreshes;
  const form = findAll(f.harness.tree, 'ScrollView').find((node) => node.props.refreshControl);
  form.props.refreshControl.props.onRefresh();
  assert.equal(f.calls.refreshes, balanceRefreshes + 1);
  assert.deepEqual(f.calls.priceRefreshes, [], 'The form only refreshes its visible balances');
  findAll(f.harness.tree, 'Pressable').find((node) => node.props.accessibilityLabel === '选择币种').props.onPress();
  await f.harness.settle();
  const picker = findAll(f.harness.tree, 'AssetPicker')[0];
  assert.equal(picker.props.visible, true);
  assert.equal(picker.props.priceLoading, true, 'The picker includes price loading in its refresh indicator');
  assert.equal(f.calls.pricesEnabled.at(-1), true, 'Displayed asset quotes activate price requests');
  picker.props.onRefresh();
  assert.equal(f.calls.refreshes, balanceRefreshes + 2, 'Picker pull-to-refresh updates balances');
  assert.deepEqual(f.calls.priceRefreshes, [true], 'Picker pull-to-refresh forces fresh quotes');
  assert.deepEqual(f.calls.chains, []);
  assert.equal(f.calls.estimates.length, 0, 'Price refresh never prepares a transfer');
  assert.equal(f.calls.broadcasts, 0, 'Price refresh never broadcasts');
  picker.props.onClose();
  await f.harness.settle();
  assert.equal(f.calls.pricesEnabled.at(-1), false, 'Closing the picker disables quote requests');
  f.harness.unmount();
}

async function verify() {
  await unrelatedDefaultTokenDoesNotBlock();
  await selectedLoadingAndUnknownAreBlocked();
  await freshBalancesRemainAuthoritative();
  await pickerRefreshesPricesWithoutPreparingTransfers();
  await uncertainSubmissionCannotReplay();
  await recipientClipboardFeedbackAndRaces();
  await assetImportWaitsForPickerDismissal();
  await tokenImportGuardsRapidTapsAndOldSessions();
  await submittedTransferDetailsRemainComplete();
  await detailStatusWritesAndPollingStayScoped();
  console.log('Send readiness verification passed: selected/native/gas balances remain authoritative, picker refresh never prepares transfers, token imports guard stale sessions, submitted details retain precise metadata, and terminal detail lookups persist only their matching local transaction and stop polling. Actual components; offline fixtures only, no live broadcast.');
}

async function submittedTransferDetailsRemainComplete() {
  const hash = `0x${'cd'.repeat(32)}`;
  for (const selectedToken of [false, true]) {
    const amount = selectedToken ? '0.123456' : '0.123456789012345678';
    const f = await fixture({ selectedToken, sendResult: { hash }, assets: [native(), erc20()], loading: false,
      freshNativeReads: selectedToken ? [ethers.parseEther('2')] : undefined });
    findAll(f.harness.tree, 'TextInput').find((node) => node.props.accessibilityLabel === '发送数量').props.onChangeText(amount);
    await f.harness.settle();
    button(f.harness, '下一步').props.onPress();
    await f.harness.settle();
    button(f.harness, '确认发送').props.onPress();
    await f.harness.settle();
    assert.equal(f.calls.submissions.length, 1);
    const submission = f.calls.submissions[0];
    assert.equal(submission.hash, hash);
    assert.equal(submission.record.from, account);
    assert.equal(submission.record.to, recipient, 'ERC-20 details show the recipient, not the token contract');
    assert.equal(submission.record.symbol, selectedToken ? 'USDC' : 'BNB');
    assert.equal(submission.record.decimals, selectedToken ? 6 : 18);
    assert.equal(submission.record.tokenAddress, selectedToken ? tokenAddress : undefined);
    assert.equal(submission.record.rawValue, ethers.parseUnits(amount, selectedToken ? 6 : 18).toString(), 'The route retains base units without Number rounding');
    assert.equal(submission.record.state, 'pending');
    assert.equal(f.calls.statuses.length, 0, 'Initial detail metadata requires no extra RPC query');
    f.harness.unmount();

    const harness = createHarness();
    const core = {
      isWatchOnly: () => false,
      getNetwork: () => network,
      getAccount: () => ({ address: account }),
      getTransactionStatus: async () => ({ hash, state: 'pending' }),
    };
    const routes = compile('src/ui/transfer/TransferRouteScreens.tsx', {
      react: harness.react, 'react-native': harness.nativeApi,
      'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
      '../../i18n.js': { useI18n: () => ({ t: (key) => key }) },
      '../screens.js': { TransactionDetailScreen: 'TransactionDetailScreen' },
      '../ReceiveScreen.js': { ReceiveScreen: 'ReceiveScreen' },
      '../TransferScreens.js': { SendFlowScreen: 'SendFlowScreen' },
      '../AppSimpleScreens.js': { LoadingScreen: 'LoadingScreen' },
      '../appStyles.js': { styles: {} }, '../AuthPrimitives.js': { PrimaryButton: 'PrimaryButton' },
      '../../native/transaction-storage.js': { async saveTransaction() { throw new Error('A pending detail must not save a terminal status'); } },
      '../../context/WalletContext.js': { useWalletContext: () => ({ core, selectedAccountIndex: 0, selectedNetworkId: network.id, manager: { getSelected: () => ({ label: 'Fixture Wallet' }) } }) },
    });
    let nextRoute;
    harness.mount(routes.SendScreen, { route: { params: { networkId: network.id, accountIndex: 0 } }, navigation: { replace: (name, params) => { nextRoute = { name, params }; } } });
    findAll(harness.tree, 'SendFlowScreen')[0].props.onSubmitted(submission.hash, submission.record);
    assert.equal(nextRoute.name, 'Transaction');
    assert.equal(nextRoute.params.record, submission.record, 'The real navigation adapter carries the submitted snapshot');
    harness.mount(routes.TransactionRouteScreen, { route: nextRoute, navigation: { goBack() {} } });
    await harness.settle();
    const detail = findAll(harness.tree, 'TransactionDetailScreen')[0];
    assert.equal(detail.props.from, account);
    assert.equal(detail.props.to, recipient);
    assert.equal(detail.props.amount, `${amount} ${selectedToken ? 'USDC' : 'BNB'}`, 'The real detail route formats the precise reviewed amount');
    harness.unmount();
  }
}

async function detailStatusWritesAndPollingStayScoped() {
  const hash = `0x${'dc'.repeat(32)}`;
  const record = {
    id: `local:${hash}`, hash, chainId: network.chainId, accountAddress: account,
    symbol: 'BNB', decimals: 18, rawValue: '1000000000000000000',
    from: account, to: recipient, direction: 'out', state: 'pending', source: 'local',
  };
  function detailFixture(options = {}) {
    const harness = createHarness();
    const timers = new Map();
    const calls = { statuses: [], saves: [] };
    let timerId = 0;
    const core = {
      getAccount: () => ({ address: account }), getNetwork: () => network,
      listNetworks: () => [network],
      async getTransactionStatus(id, nextHash) {
        calls.statuses.push({ id, hash: nextHash });
        return options.status ? options.status(calls.statuses.length) : { hash, state: 'confirmed', blockNumber: 123 };
      },
    };
    const routes = compile('src/ui/transfer/TransferRouteScreens.tsx', {
      __setInterval(callback, ms) { assert.equal(ms, 8000); const id = ++timerId; timers.set(id, callback); return id; },
      __clearInterval(id) { timers.delete(id); },
      react: harness.react, 'react-native': harness.nativeApi,
      'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
      '../../i18n.js': { useI18n: () => ({ t: (key) => key }) },
      '../screens.js': { TransactionDetailScreen: 'TransactionDetailScreen' },
      '../ReceiveScreen.js': { ReceiveScreen: 'ReceiveScreen' },
      '../TransferScreens.js': { SendFlowScreen: 'SendFlowScreen' },
      '../AppSimpleScreens.js': { LoadingScreen: 'LoadingScreen' },
      '../appStyles.js': { styles: {} }, '../AuthPrimitives.js': { PrimaryButton: 'PrimaryButton' },
      '../../context/WalletContext.js': { useWalletContext: () => ({ core, selectedAccountIndex: 0, selectedNetworkId: network.id }) },
      '../../native/transaction-storage.js': { async saveTransaction(value) { calls.saves.push(value); if (options.saveFails) throw new Error('fixture storage offline'); } },
    });
    harness.mount(routes.TransactionRouteScreen, {
      route: { params: { hash: options.hash ?? hash, networkId: network.id, accountIndex: 0, record: { ...record, ...options.record } } },
      navigation: { goBack() {} },
    });
    return { harness, timers, calls, detail: () => findAll(harness.tree, 'TransactionDetailScreen')[0].props };
  }

  for (const terminalState of ['confirmed', 'failed']) {
    const f = detailFixture({ status: async (count) => ({ hash, state: count === 1 ? 'pending' : terminalState, blockNumber: count === 1 ? undefined : 456 }) });
    await f.harness.settle();
    assert.equal(f.calls.statuses.length, 1, 'opening one detail queries that transaction once');
    assert.equal(f.calls.saves.length, 0);
    assert.equal(f.timers.size, 1, 'pending detail continues its eight-second polling');
    [...f.timers.values()][0]();
    await f.harness.settle();
    assert.equal(f.detail().status.state, terminalState);
    assert.equal(f.detail().status.blockNumber, 456);
    assert.equal(f.calls.saves.length, 1, 'only the opened local transaction receives a persisted terminal state');
    assert.equal(f.calls.saves[0].hash, hash);
    assert.equal(f.calls.saves[0].chainId, network.chainId);
    assert.equal(f.calls.saves[0].accountAddress, account);
    assert.equal(f.calls.saves[0].state, terminalState);
    assert.equal(f.calls.saves[0].blockNumber, 456);
    assert.equal(f.timers.size, 0, 'terminal details stop background polling');
    f.harness.unmount();
  }

  const alreadyTerminal = detailFixture({ record: { state: 'confirmed', blockNumber: 123 } });
  await alreadyTerminal.harness.settle();
  assert.equal(alreadyTerminal.calls.statuses.length, 1, 'a confirmed history row still fetches detail fields once');
  assert.equal(alreadyTerminal.timers.size, 0, 'an initially terminal row does not start a poll timer');
  alreadyTerminal.harness.unmount();

  const storageFailure = detailFixture({ saveFails: true });
  await storageFailure.harness.settle();
  assert.equal(storageFailure.calls.saves.length, 1);
  assert.equal(storageFailure.detail().status.state, 'confirmed', 'persisting public metadata failing does not overwrite a confirmed detail');
  assert.equal(storageFailure.timers.size, 0);
  storageFailure.harness.unmount();

  for (const extra of [
    { record: { source: 'explorer' } },
    { record: { hash: `0x${'ab'.repeat(32)}` } },
    { record: { chainId: 1 } },
  ]) {
    const scoped = detailFixture(extra);
    await scoped.harness.settle();
    assert.equal(scoped.calls.saves.length, 0, 'indexed or mismatched hash/chain snapshots cannot rewrite local submissions');
    scoped.harness.unmount();
  }

  let resolveStatus;
  const late = detailFixture({ status: () => new Promise((resolve) => { resolveStatus = resolve; }) });
  await late.harness.settle();
  late.harness.unmount();
  assert.equal(late.timers.size, 0);
  resolveStatus({ hash, state: 'confirmed', blockNumber: 789 });
  await late.harness.settle();
  assert.equal(late.calls.saves.length, 0, 'a detail result arriving after unmount cannot write transaction metadata');
}

async function tokenImportGuardsRapidTapsAndOldSessions() {
  const deferred = () => {
    let resolve;
    const promise = new Promise((yes) => { resolve = yes; });
    return { promise, resolve };
  };
  const harness = createHarness({ captureModals: false });
  const lookup = deferred();
  const saving = deferred();
  const calls = { chains: 0, lookups: 0, saves: 0, imported: 0, closed: 0 };
  const core = {
    async assertNetwork() { calls.chains += 1; },
    getSigner() { return { provider: { getCode() { calls.lookups += 1; return lookup.promise; } } }; },
  };
  const modules = compile('src/ui/TransferScreens.tsx', {
    react: harness.react, 'react-native': harness.nativeApi,
    ethers: { ...ethers, Contract: function FixtureContract() { return { decimals: async () => 6, symbol: async () => 'TEST', name: async () => 'Fixture Token' }; } },
    './SecureModal.js': { SecureModal: 'Modal' },
    '@react-native-clipboard/clipboard': {},
    './QRScannerModal.js': {},
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@react-navigation/native': {},
    './icons.js': new Proxy({}, { get: (_target, name) => (props) => ({ type: `icon:${String(name)}`, props }) }),
    '../core/network-fees.js': {}, '../core/rpc-broadcast.js': {}, '../core/asset-prices.js': {}, '../i18n.js': {},
    '../native/token-storage.js': { saveToken() { calls.saves += 1; return saving.promise; } },
    './useWalletAssets.js': {}, './useAssetPrices.js': {},
  }, '\nexports.testTokenImport = TokenImportModal; exports.testImportLabels = copy.zh;');
  harness.mount(modules.testTokenImport, { visible: true, core, network, labels: modules.testImportLabels,
    onClose() { calls.closed += 1; }, onImported() { calls.imported += 1; } });
  await harness.settle();
  const input = () => findAll(harness.tree, 'TextInput')[0];
  input().props.onChangeText(tokenAddress);
  await harness.settle();
  const startLookup = button(harness, '查询代币').props.onPress;
  const staleClose = findAll(harness.tree, 'Pressable').find((node) => node.props.accessibilityLabel === '关闭').props.onPress;
  const staleChange = input().props.onChangeText;
  startLookup(); startLookup(); staleClose(); staleChange(otherAddress);
  await harness.settle();
  assert.equal(calls.chains, 1, 'Rapid lookup taps schedule only one network check');
  assert.equal(calls.lookups, 1, 'Only one metadata lookup is active');
  assert.equal(calls.closed, 0, 'A stale close callback cannot dismiss a busy import');
  assert.equal(input().props.value, tokenAddress, 'A stale input event cannot mutate an active query');
  lookup.resolve('0x1234');
  await harness.settle();
  const confirm = button(harness, '确认导入').props.onPress;
  confirm(); confirm();
  await harness.settle();
  assert.equal(calls.saves, 1, 'Rapid import taps persist a token only once');
  assert.equal(button(harness, '确认导入').props.disabled, true, 'Import progress keeps confirmation disabled');
  harness.update({ visible: false });
  harness.update({ visible: true, network: { ...network, id: 'new-session', chainId: 1 } });
  await harness.settle();
  assert.equal(input().props.value, '', 'A new modal session starts with a clean form');
  saving.resolve();
  await harness.settle();
  assert.equal(calls.imported, 0, 'A previous save cannot select a token in a different session/network');
  assert.equal(calls.closed, 0, 'A previous save cannot dismiss a newly opened import modal');
  button(harness, '查询代币');
  harness.unmount();
}

async function assetImportWaitsForPickerDismissal() {
  for (const platform of ['ios', 'android']) {
    const frames = new Map();
    let frameId = 0;
    const f = await fixture({ platform,
      requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame(id) { frames.delete(id); },
    });
    const picker = () => findAll(f.harness.tree, 'AssetPicker')[0];
    const importer = () => findAll(f.harness.tree, 'TokenImportModal')[0];
    findAll(f.harness.tree, 'Pressable').find((node) => node.props.accessibilityLabel === '选择币种').props.onPress();
    await f.harness.settle();
    assert.equal(picker().props.visible, true);
    const staleImport = picker().props.onImport;
    staleImport(); staleImport();
    await f.harness.settle();
    assert.equal(picker().props.visible, false);
    assert.equal(importer().props.visible, false, 'Import modal never opens in the render that closes the picker');
    if (platform === 'ios') {
      assert.equal(frames.size, 0, 'iOS waits for native onDismiss, not an estimated timer');
      picker().props.onDismiss();
    } else {
      assert.equal(frames.size, 1, 'Android schedules only one fallback frame despite rapid taps');
      const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback());
    }
    await f.harness.settle();
    assert.equal(importer().props.visible, true);
    importer().props.onClose(); await f.harness.settle();
    picker().props.onDismiss(); await f.harness.settle();
    assert.equal(importer().props.visible, false, 'A duplicate native dismissal cannot reopen the importer');
    f.harness.unmount();
  }
  const cancelledFrames = new Map();
  const cancelled = await fixture({ platform: 'android', requestAnimationFrame(callback) { cancelledFrames.set(1, callback); return 1; }, cancelAnimationFrame(id) { cancelledFrames.delete(id); } });
  findAll(cancelled.harness.tree, 'AssetPicker')[0].props.onImport();
  assert.equal(cancelledFrames.size, 1);
  cancelled.harness.unmount();
  assert.equal(cancelledFrames.size, 0, 'Leaving the send page cancels a queued modal presentation');
}

async function recipientClipboardFeedbackAndRaces() {
  const input = (f) => findAll(f.harness.tree, 'TextInput').find((node) => node.props.accessibilityLabel === '接收地址');
  for (const [clipboard, expected] of [
    [async () => '   ', /剪贴板为空/],
    [async () => { throw new Error('private native clipboard error'); }, /无法读取剪贴板/],
  ]) {
    const f = await fixture({ clipboard });
    button(f.harness, '粘贴').props.onPress();
    await f.harness.settle();
    assert.match(textContent(f.harness.tree), expected, 'Clipboard failures provide an actionable message');
    assert.equal(input(f).props.value, recipient, 'Clipboard failure preserves the current recipient');
    assert.doesNotMatch(textContent(f.harness.tree), /private native clipboard error/);
    assert.equal(f.calls.broadcasts, 0);
    f.harness.unmount();
  }
  const parsed = await fixture({ clipboard: async () => `ethereum:${otherAddress}@56?value=100000` });
  button(parsed.harness, '粘贴').props.onPress();
  await parsed.harness.settle();
  assert.equal(input(parsed).props.value, otherAddress, 'Pasted EIP-681 recipient is normalized consistently with scanned QR codes');
  assert.equal(findAll(parsed.harness.tree, 'TextInput').find((node) => node.props.accessibilityLabel === '发送数量').props.value, '1', 'Clipboard content never changes the amount');
  assert.equal(parsed.calls.estimates.length, 0); assert.equal(parsed.calls.broadcasts, 0);
  parsed.harness.unmount();

  let resolveClipboard;
  const delayed = await fixture({ clipboard: () => new Promise((resolve) => { resolveClipboard = resolve; }) });
  button(delayed.harness, '粘贴').props.onPress();
  input(delayed).props.onChangeText(otherAddress);
  await delayed.harness.settle();
  resolveClipboard(account);
  await delayed.harness.settle();
  assert.equal(input(delayed).props.value, otherAddress, 'A delayed paste cannot replace the address the user has since typed');
  assert.equal(delayed.calls.broadcasts, 0);
  delayed.harness.unmount();
}

async function uncertainSubmissionCannotReplay() {
  const hash = `0x${'ab'.repeat(32)}`;
  const nestedError = { code: 'UNKNOWN_ERROR', info: { error: { code: -32603, data: { code: 'RPC_BROADCAST_UNCERTAIN', transactionHash: hash } } } };
  for (const selectedToken of [false, true]) {
    for (const outcome of [{ status: 'not-found' }, { status: 'pending' }, { status: 'confirmed' }, { status: 'failed' }, { statusError: new Error('offline fixture') }]) {
      const f = await fixture({ ...outcome, selectedToken, sendError: nestedError, assets: [native(), erc20()], loading: false, freshNativeReads: selectedToken ? [ethers.parseEther('2')] : undefined });
      button(f.harness, '下一步').props.onPress();
      await f.harness.settle();
      const staleConfirm = button(f.harness, '确认发送');
      staleConfirm.props.onPress();
      await f.harness.settle();
      assert.equal(f.calls.broadcasts, 1, 'The fixture only simulates one broadcast error');
      assert.match(textContent(f.harness.tree), /发送状态待确认/);
      assert.ok(textContent(f.harness.tree).includes(hash));
      assert.ok(!findAll(f.harness.tree, 'Pressable').some((node) => ['确认发送', '修改'].includes(textContent(node))), 'An uncertain submission replaces resend and edit controls with status lookup');
      staleConfirm.props.onPress();
      await f.harness.settle();
      assert.equal(f.calls.broadcasts, 1, 'Even stale send callbacks cannot replay the transaction');
      button(f.harness, '查询交易状态').props.onPress();
      await f.harness.settle();
      assert.deepEqual(f.calls.statuses, [{ id: network.id, hash }]);
      assert.equal(f.calls.broadcasts, 1, 'Status lookup never signs or broadcasts');
      assert.equal(f.calls.submitted, outcome.status && outcome.status !== 'not-found' ? 1 : 0);
      if (f.calls.submitted) {
        const submission = f.calls.submissions[0];
        assert.equal(submission.record.to, recipient, 'Recovered broadcasts retain their reviewed recipient');
        assert.equal(submission.record.rawValue, ethers.parseUnits('1', selectedToken ? 6 : 18).toString());
        assert.equal(submission.record.state, outcome.status, 'Recovered details begin with the status already confirmed by lookup');
      }
      if (outcome.status === 'not-found') assert.match(textContent(f.harness.tree), /可能仍在传播/);
      if (outcome.statusError) assert.match(textContent(f.harness.tree), /请勿重复发送/);
      f.harness.unmount();
    }
  }
  const revert = await fixture({ sendError: { code: 'CALL_EXCEPTION' }, assets: [native()], loading: false });
  button(revert.harness, '下一步').props.onPress();
  await revert.harness.settle();
  button(revert.harness, '确认发送').props.onPress();
  await revert.harness.settle();
  assert.doesNotMatch(textContent(revert.harness.tree), /发送状态待确认/);
  assert.match(textContent(revert.harness.tree), /交易预估或发送失败/);
  button(revert.harness, '确认发送');
  revert.harness.unmount();
}

verify().catch((error) => { console.error(error); process.exitCode = 1; });
