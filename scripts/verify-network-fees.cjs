/* Verify additional Base fees without signatures, secrets or broadcasts. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { Interface, Transaction, getBytes } = require('ethers');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-network-fees-'));
const source = fs.readFileSync(path.join(__dirname, '../src/core/network-fees.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
fs.writeFileSync(path.join(output, 'network-fees.js'), compiled.replace(/require\("ethers"\)/g, `require(${JSON.stringify(require.resolve('ethers'))})`));
const { estimateAdditionalNetworkFees, NetworkFeeUnavailableError } = require(path.join(output, 'network-fees.js'));
const oracle = new Interface([
  'function getL1Fee(bytes) view returns (uint256)',
  'function getL1FeeUpperBound(uint256) view returns (uint256)',
  'function getOperatorFee(uint256) view returns (uint256)',
]);
const recipient = '0x000000000000000000000000000000000000dead';
const from = '0x0000000000000000000000000000000000000001';
const native = { from, to: recipient, value: 123n, gasLimit: 25200n, maxFeePerGas: 11000000n, maxPriorityFeePerGas: 1000000n };

async function verify() {
  for (const chain of [1, 56, 137, 42161]) {
    const result = await estimateAdditionalNetworkFees({}, chain, native, 21000n);
    assert.equal(result.estimatedExtraFee, 0n);
    assert.equal(result.bufferedExtraFee, 0n);
    assert.equal(result.totalIsEstimate, false, 'Other EVM chains need no Base oracle request');
  }

  for (const transaction of [native, { from, to: recipient, value: 0n, data: '0xa9059cbb' + '00'.repeat(64), gasLimit: 72000n, gasPrice: 6000000n }]) {
    const gasEstimate = transaction === native ? 21000n : 60000n;
    const decoded = [];
    let nonceCalls = 0;
    const provider = {
      getTransactionCount: async (address, blockTag) => { assert.equal(address, from); assert.equal(blockTag, 'pending'); nonceCalls++; return 7; },
      call: async (request) => {
        assert.equal(request.to, '0x420000000000000000000000000000000000000F');
        const parsed = oracle.parseTransaction(request);
        decoded.push(parsed);
        const value = parsed.name === 'getL1Fee' ? 101n : parsed.name === 'getL1FeeUpperBound' ? 150n : parsed.args[0] === gasEstimate ? 10n : 15n;
        return oracle.encodeFunctionResult(parsed.name, [value]);
      },
    };
    const result = await estimateAdditionalNetworkFees(provider, 8453, transaction, gasEstimate);
    assert.equal(nonceCalls, 1);
    const serialized = decoded.find((r) => r.name === 'getL1Fee').args[0];
    const unsigned = Transaction.from(serialized);
    assert.equal(unsigned.signature, null, 'No signing is performed');
    assert.equal(unsigned.chainId, 8453n);
    assert.equal(unsigned.nonce, 7);
    assert.equal(unsigned.to.toLowerCase(), recipient);
    assert.equal(unsigned.value, transaction.value);
    assert.equal(unsigned.data, transaction.data ?? '0x', 'ERC-20 calldata is included in L1 data fees');
    assert.equal(unsigned.gasLimit, transaction.gasLimit);
    assert.equal(unsigned.type, transaction === native ? 2 : 0);
    const budget = decoded.find((r) => r.name === 'getL1FeeUpperBound').args[0];
    assert.equal(budget, BigInt(getBytes(serialized).length + 16), 'The oracle itself adds signature overhead');
    assert.equal(result.estimatedExtraFee, 111n, 'Operator fee is not silently omitted');
    assert.equal(result.bufferedExtraFee, 198n, 'Upper size/gas estimate plus 20% buffer');
    assert.equal(result.totalIsEstimate, true, 'L1 fees are not a protocol fee cap');
  }

  const valid = {
    getTransactionCount: async () => 0,
    call: async (request) => { const parsed = oracle.parseTransaction(request); return oracle.encodeFunctionResult(parsed.name, [0n]); },
  };
  assert.equal((await estimateAdditionalNetworkFees(valid, 8453, native, 21000n)).bufferedExtraFee, 0n, 'Zero oracle fees are valid');
  await assert.rejects(estimateAdditionalNetworkFees({ ...valid, getTransactionCount: async () => { throw new Error('offline'); } }, 8453, native, 21000n), NetworkFeeUnavailableError);
  await assert.rejects(estimateAdditionalNetworkFees({ ...valid, call: async () => '0x' }, 8453, native, 21000n), NetworkFeeUnavailableError);
  await assert.rejects(estimateAdditionalNetworkFees({ ...valid, call: async (request) => {
    const parsed = oracle.parseTransaction(request);
    if (parsed.name === 'getOperatorFee') throw new Error('oracle unavailable');
    return oracle.encodeFunctionResult(parsed.name, [1n]);
  } }, 8453, native, 21000n), NetworkFeeUnavailableError, 'Cannot assume missing operator fees are zero');
  await assert.rejects(estimateAdditionalNetworkFees(valid, 8453, { ...native, maxPriorityFeePerGas: undefined }, 21000n), NetworkFeeUnavailableError);
  await assert.rejects(estimateAdditionalNetworkFees(valid, 8453, native, 30000n), NetworkFeeUnavailableError);
  console.log('Additional network fee verification passed: unsigned native/ERC-20 payloads, Base L1/operator fees, budget, other chains and fail-closed oracle/nonce errors. No transaction broadcast.');
}

verify().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(output, { recursive: true, force: true }));
