/* Verify real wallet transfer encoding with a capture-only signer. Never broadcasts. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Interface, parseUnits } = require('ethers');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-transfer-'));
require('./compile-ts-fixture.cjs')('src/core/wallet-core.ts', output);

async function verify() {
  const { WalletCore } = require(path.join(output, 'core/wallet-core.js'));
  // Public fixture only; no user secret or real balance is accessed.
  const wallet = WalletCore.fromMnemonic('test test test test test test test test test test test junk', {
    accountCount: 2,
    networks: [{ id: 'fixture', chainId: 56, name: 'Fixture', rpcUrl: 'https://fixture.invalid' }],
  });
  assert.equal(wallet.listAccounts().length, 2);
  const recipient = `0x${'1'.repeat(40)}`;
  const contract = `0x${'2'.repeat(40)}`;
  let chain = '0x38';
  let captured;
  let calls = 0;
  // The provider never makes a network request. The signer only captures calldata.
  wallet.providers.set('fixture', { send: async (method) => { assert.equal(method, 'eth_chainId'); return chain; } });
  wallet.getSigner = (index, network) => {
    assert.equal(index, 1);
    assert.equal(network, 'fixture');
    return { sendTransaction: async (tx) => { captured = tx; calls += 1; return { hash: '0xfixture' }; } };
  };
  await wallet.sendNative(1, 'fixture', recipient, '0.123456789012345678', { gasLimit: 26000n, gasPrice: 2n, to: contract, value: 0n });
  assert.equal(captured.to, recipient, 'fee overrides cannot change the recipient');
  assert.equal(captured.value, parseUnits('0.123456789012345678', 18));
  assert.equal(captured.gasLimit, 26000n);
  assert.equal(captured.gasPrice, 2n);

  await wallet.sendErc20(1, 'fixture', { address: contract, symbol: 'TEST', decimals: 6 }, recipient, '12.345678', { gasLimit: 72000n, maxFeePerGas: 4n, maxPriorityFeePerGas: 1n });
  const abi = new Interface(['function transfer(address to,uint256 amount) returns (bool)']);
  const decoded = abi.decodeFunctionData('transfer', captured.data);
  assert.equal(captured.to.toLowerCase(), contract.toLowerCase());
  assert.equal(decoded[0].toLowerCase(), recipient.toLowerCase());
  assert.equal(decoded[1], 12345678n, 'ERC-20 amounts use token decimals');
  assert.equal(captured.gasLimit, 72000n);
  assert.equal(captured.maxFeePerGas, 4n);
  assert.equal(captured.maxPriorityFeePerGas, 1n);
  await assert.rejects(wallet.sendErc20(1, 'fixture', { address: contract, decimals: 6 }, recipient, '1.1234567'));
  chain = '0x1';
  await assert.rejects(wallet.sendNative(1, 'fixture', recipient, '1'), /RPC chain/);
  await assert.rejects(wallet.sendErc20(1, 'fixture', { address: contract, decimals: 6 }, recipient, '1'), /RPC chain/);
  assert.equal(calls, 2, 'invalid precision and mismatched chains cannot broadcast');
  console.log('Transfer verification passed: account restore, native value, ERC-20 decimals/calldata, reviewed fee overrides and RPC chain guard. No transaction broadcast.');
}
verify().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(output, { recursive: true, force: true }));
