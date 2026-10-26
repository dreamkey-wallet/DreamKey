/* Offline broadcast-loss fixtures. No live RPC, user keys, or signed payloads. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const compile = require('./compile-ts-fixture.cjs');
const { Wallet, keccak256 } = require('ethers');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-broadcast-'));
const hash = `0x${'ab'.repeat(32)}`;
const tokenHash = `0x${'cd'.repeat(32)}`;
const recipient = `0x${'2'.repeat(40)}`;
const token = `0x${'3'.repeat(40)}`;
const network = { id: 'fixture', chainId: 56, name: 'Fixture', nativeSymbol: 'BNB', rpcUrl: 'https://fixture.invalid' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

async function verifyConcurrentDappRequests(createWalletProvider, getUncertainBroadcastHash) {
  const account = `0x${'1'.repeat(40)}`;
  const origin = 'https://concurrent.fixture.example';
  const request = { method: 'eth_sendTransaction', params: [{ from: account, to: recipient, value: '0x1' }] };
  const reordered = { ...request, params: [{ value: '0x1', to: recipient, from: account }] };
  async function fixture(options = {}) {
    const send = deferred();
    const calls = { sends: 0, approvals: 0, records: 0, queries: 0 };
    let approve = () => true;
    const wallet = {
      getNetwork: () => network, listNetworks: () => [network],
      listAccounts: () => [{ address: account, index: 0 }], getAccount: () => ({ address: account, index: 0 }),
      getSigner: () => ({ sendTransaction: () => { calls.sends += 1; return send.promise; } }),
      recordSubmittedTransaction: () => { calls.records += 1; if (options.recordFailure) throw new Error('fixture recording failure'); },
      getTransactionStatus: async () => { calls.queries += 1; return { hash, state: 'not-found' }; },
    };
    const provider = createWalletProvider(wallet, network.id, {
      requestAccounts: () => [account], approve: (approval) => { calls.approvals += 1; return approve(approval); },
    });
    const site = provider.forOrigin(origin);
    await site.request({ method: 'eth_requestAccounts' });
    return { provider, site, send, calls, setApprove: (action) => { approve = action; } };
  }
  for (const outcome of ['success', 'uncertain', 'revert']) {
    const f = await fixture();
    const results = Promise.allSettled([f.site.request(request), f.site.request(reordered)]);
    await tick();
    assert.equal(f.calls.approvals, 2, 'Each simultaneous request still requires its own approval');
    assert.equal(f.calls.sends, 1, 'Simultaneous identical requests share one signer/broadcast operation');
    if (outcome === 'success') f.send.resolve({ hash, from: account, to: recipient, value: 1n, data: '0x' });
    else if (outcome === 'uncertain') f.send.reject({ code: 'RPC_BROADCAST_UNCERTAIN', transactionHash: hash });
    else f.send.reject(Object.assign(new Error('fixture revert'), { code: 'CALL_EXCEPTION' }));
    const settled = await results;
    if (outcome === 'success') {
      assert.ok(settled.every((result) => result.status === 'fulfilled' && result.value === hash));
      assert.equal(f.calls.records, 1, 'A shared successful broadcast is recorded once');
      assert.equal(await f.site.request(request), hash);
      assert.equal(f.calls.sends, 2, 'A later explicitly approved transfer is not merged with a completed operation');
    } else if (outcome === 'uncertain') {
      assert.ok(settled.every((result) => result.status === 'rejected' && getUncertainBroadcastHash(result.reason) === hash));
      assert.equal(f.calls.records, 1, 'A shared uncertain broadcast is recorded once');
      await assert.rejects(f.site.request(request), (error) => getUncertainBroadcastHash(error) === hash);
      assert.equal(f.calls.sends, 1, 'Uncertainty continues to block replay after the in-flight operation ends');
      assert.equal(f.calls.queries, 1);
    } else {
      assert.ok(settled.every((result) => result.status === 'rejected' && result.reason.code === 'CALL_EXCEPTION'));
      await assert.rejects(f.site.request(request), (error) => error.code === 'CALL_EXCEPTION');
      assert.equal(f.calls.sends, 2, 'A definitive error clears only the in-flight entry');
      assert.equal(f.calls.records, 0);
    }
  }
  for (const guard of ['rejected', 'chain-changed', 'permission-revoked', 'disconnected']) {
    const f = await fixture();
    const first = f.site.request(request);
    await tick();
    const approval = deferred();
    f.setApprove(() => approval.promise);
    const second = f.site.request(reordered);
    const rejected = assert.rejects(second, (error) => error.code === ({ rejected: 4001, 'chain-changed': 4901, 'permission-revoked': 4100, disconnected: 4900 })[guard]);
    await tick();
    if (guard === 'chain-changed') f.provider.setChainId(1);
    if (guard === 'permission-revoked') await f.site.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
    if (guard === 'disconnected') f.provider.disconnect();
    approval.resolve(guard !== 'rejected');
    await rejected;
    assert.equal(f.calls.sends, 1, 'A rejected or stale request cannot join an existing broadcast');
    f.send.resolve({ hash, from: account, to: recipient, value: 1n, data: '0x' });
    assert.equal(await first, hash);
    assert.equal(f.calls.approvals, 2, 'In-flight sharing does not bypass the approval callback');
  }
  const storageFailure = await fixture({ recordFailure: true });
  const accepted = Promise.all([storageFailure.site.request(request), storageFailure.site.request(reordered)]);
  await tick();
  storageFailure.send.resolve({ hash, from: account, to: recipient, value: 1n, data: '0x' });
  assert.deepEqual(await accepted, [hash, hash], 'A host recording failure cannot hide an accepted hash from either caller');
  assert.equal(storageFailure.calls.sends, 1);
  assert.equal(storageFailure.calls.records, 1);
}

async function verify() {
  for (const entry of ['src/core/wallet-core.ts', 'src/provider/wallet-core-adapter.ts', 'src/core/asset-history.ts']) compile(entry, output);
  const { getUncertainBroadcastHash, RpcBroadcastUncertainError } = require(path.join(output, 'core/rpc-broadcast.js'));
  const { WalletCore } = require(path.join(output, 'core/wallet-core.js'));
  const { createWalletProvider } = require(path.join(output, 'provider/wallet-core-adapter.js'));
  const { validateAssetTransaction } = require(path.join(output, 'core/asset-history.js'));
  const { VerifiedRpcProvider } = require(path.join(output, 'core/rpc-provider.js'));
  const uncertain = (value = hash) => ({ code: 'UNKNOWN_ERROR', info: { error: { code: -32603, data: { code: 'RPC_BROADCAST_UNCERTAIN', transactionHash: value } } } });
  assert.equal(getUncertainBroadcastHash(uncertain()), hash);
  assert.equal(getUncertainBroadcastHash(new RpcBroadcastUncertainError(hash.toUpperCase().replace('0X', '0x'))), hash);
  assert.equal(getUncertainBroadcastHash({ code: 'TIMEOUT', transactionHash: hash }), null, 'A generic timeout is not proof that a signed transaction was sent');
  assert.equal(getUncertainBroadcastHash({ code: 'CALL_EXCEPTION', transactionHash: hash }), null);
  assert.equal(getUncertainBroadcastHash(uncertain('0xabc')), null);
  const cycle = { code: 'NETWORK_ERROR' }; cycle.cause = cycle;
  assert.equal(getUncertainBroadcastHash(cycle), null);

  // Exercise actual Ethers wrappers with a known public fixture signer. Its
  // raw bytes only reach this in-memory fake transport, never a network.
  const fixtureSigner = new Wallet(`0x${'0'.repeat(63)}1`);
  const raw = await fixtureSigner.signTransaction({ to: recipient, value: 1n, chainId: 56, nonce: 0, gasLimit: 21000n, gasPrice: 1n, type: 0 });
  const rawHash = keccak256(raw);
  for (const found of [false, true]) {
    let broadcastCalls = 0;
    const methods = [];
    const provider = new VerifiedRpcProvider(network, {
      fetch: async (_url, init) => {
        const payload = JSON.parse(init.body);
        methods.push(payload.method);
        if (payload.method === 'eth_sendRawTransaction') { broadcastCalls += 1; throw new Error('fixture response lost'); }
        const result = payload.method === 'eth_chainId' ? '0x38'
          : payload.method === 'eth_blockNumber' ? '0x64'
            : payload.method === 'eth_getTransactionByHash' && found ? { hash: rawHash } : null;
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: payload.id, result }) };
      },
    });
    try {
      if (found) {
        const transaction = await provider.broadcastTransaction(raw);
        assert.equal(transaction.hash, rawHash);
      } else await assert.rejects(provider.broadcastTransaction(raw), (error) => getUncertainBroadcastHash(error) === rawHash);
      assert.equal(broadcastCalls, 1, 'The Ethers broadcast path sends raw bytes once even when its response is lost');
      assert.ok(methods.includes('eth_getTransactionByHash'), 'The original hash is reconciled before reporting uncertainty');
    } finally { provider.destroy(); }
  }

  const recorded = [];
  const wallet = WalletCore.fromMnemonic('test test test test test test test test test test test junk', {
    networks: [network], transactionRecorder: (record) => recorded.push(record),
  });
  const account = wallet.getAccount(0).address;
  let sends = 0;
  let nextError = uncertain();
  let receipt = null;
  wallet.providers.set(network.id, {
    send: async () => '0x38', getTransactionReceipt: async () => receipt, getTransaction: async () => null,
    getBlockNumber: async () => 100,
  });
  wallet.getSigner = () => ({ sendTransaction: async () => { sends += 1; throw nextError; } });
  await assert.rejects(wallet.sendNative(0, network.id, recipient, '1'), (error) => getUncertainBroadcastHash(error) === hash);
  await tick();
  assert.equal(sends, 1);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].state, 'pending');
  assert.equal(recorded[0].hash, hash);
  assert.equal(recorded[0].rawValue, '1000000000000000000');
  assert.ok(validateAssetTransaction(recorded[0]), 'Uncertain submissions survive the existing persistent history validator');
  await wallet.getTransactionStatus(network.id, hash);
  await tick();
  assert.equal(recorded.length, 1, 'A missing RPC result must not mark an uncertain submission failed');
  nextError = uncertain(tokenHash);
  await assert.rejects(wallet.sendErc20(0, network.id, { address: token, decimals: 6, symbol: 'TEST' }, recipient, '1.25'), (error) => getUncertainBroadcastHash(error) === tokenHash);
  await tick();
  assert.equal(sends, 2);
  assert.equal(recorded.at(-1).to.toLowerCase(), recipient);
  assert.equal(recorded.at(-1).tokenAddress.toLowerCase(), token);
  assert.equal(recorded.at(-1).rawValue, '1250000');
  assert.ok(validateAssetTransaction(recorded.at(-1)));
  nextError = Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
  const beforeRevert = recorded.length;
  await assert.rejects(wallet.sendNative(0, network.id, recipient, '1'), (error) => error === nextError);
  await tick();
  assert.equal(recorded.length, beforeRevert, 'A real rejection or revert never becomes an uncertain pending transaction');

  let status = 'not-found', queries = 0;
  nextError = uncertain();
  const dappWallet = Object.create(wallet);
  dappWallet.getRpcTransport = () => async () => { throw new Error('Unexpected live transport'); };
  dappWallet.getTransactionStatus = async (id, transactionHash) => {
    assert.equal(id, network.id); assert.equal(transactionHash, hash); queries += 1;
    if (status === 'offline') throw new Error('fixture outage');
    return { hash, state: status };
  };
  const provider = createWalletProvider(dappWallet, network.id, { approve: async () => true, requestAccounts: () => [account] });
  const site = provider.forOrigin('https://fixture.example');
  await site.request({ method: 'eth_requestAccounts' });
  const request = { method: 'eth_sendTransaction', params: [{ from: account, to: recipient, value: '0x1' }] };
  const beforeDapp = sends;
  await assert.rejects(site.request(request), (error) => error.code === -32603 && getUncertainBroadcastHash(error) === hash);
  await tick();
  assert.equal(sends, beforeDapp + 1);
  assert.equal(recorded.at(-1).hash, hash);
  assert.equal(recorded.at(-1).rawValue, '1');
  // Sorted keys prevent a DApp from bypassing the retry guard by reordering JSON.
  const reorderedRequest = { ...request, params: [{ value: '0x1', to: recipient, from: `0x${account.slice(2).toUpperCase()}` }] };
  for (const nextStatus of ['not-found', 'offline', 'pending', 'confirmed', 'failed']) {
    status = nextStatus;
    if (status === 'not-found' || status === 'offline') {
      await assert.rejects(site.request(reorderedRequest), (error) => getUncertainBroadcastHash(error) === hash);
    } else assert.equal(await site.request(reorderedRequest), hash);
    assert.equal(sends, beforeDapp + 1, 'A repeated DApp request checks the original hash instead of signing again');
  }
  assert.equal(queries, 5);
  await verifyConcurrentDappRequests(createWalletProvider, getUncertainBroadcastHash);
  console.log('Broadcast verification passed: ethers nested errors, native/ERC-20 uncertain pending history, missing versus reverted results, DApp hash-based retries, concurrent identical requests share one broadcast, and approval/chain/permission/connection guards remain enforced. Offline public fixtures only.');
}

verify().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(output, { recursive: true, force: true }));
