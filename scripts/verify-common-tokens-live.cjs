/* Read-only metadata verification; no wallet address, signing or broadcasts. */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { Interface } = require('ethers');
const root = path.resolve(__dirname, '..');
function load(relative) {
  const body = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const entry = { exports: {} };
  new Function('module', 'exports', body)(entry, entry.exports);
  return entry.exports;
}
const { getKnownTokens } = load('src/core/common-tokens.ts');
const { DEFAULT_NETWORKS } = load('src/core/networks.ts');
const metadata = new Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const report = { checkedAt: new Date().toISOString(), scope: 'Read-only mainnet eth_call for symbol and decimals; no balances, signing or broadcasts.', results: [] };
let requestId = 0;
async function call(url, address, method) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(12_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'eth_call', params: [{ to: address, data: metadata.encodeFunctionData(method) }, 'latest'] }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const rpc = await response.json();
  if (rpc.error || typeof rpc.result !== 'string') throw new Error('RPC metadata unavailable');
  return metadata.decodeFunctionResult(method, rpc.result)[0];
}
async function check(network, token) {
  for (const url of [network.rpcUrl, ...(network.rpcFallbackUrls ?? [])]) {
    try {
      const [symbol, precision] = await Promise.all([call(url, token.address, 'symbol'), call(url, token.address, 'decimals')]);
      const decimals = Number(precision);
      const sameDecimals = decimals === token.decimals;
      // Native/bridged and issuer names use wallet display names to preserve identity.
      const allowedSymbol = symbol.toLowerCase() === token.symbol.toLowerCase() || (token.symbol === 'USDC.e' && symbol === 'USDC')
        || (network.chainId === 56 && token.symbol === 'BTCB' && symbol === 'BTCB');
      const result = { chainId: network.chainId, address: token.address, displaySymbol: token.symbol, onChainSymbol: symbol,
        expectedDecimals: token.decimals, onChainDecimals: decimals, status: sameDecimals && allowedSymbol ? 'verified' : 'mismatch' };
      console.log(`${result.status}: ${network.chainId} ${token.symbol} ${symbol} ${decimals}`);
      return result;
    } catch { /* Try another configured endpoint without disclosing server details. */ }
  }
  console.log(`unavailable: ${network.chainId} ${token.symbol}`);
  return { chainId: network.chainId, address: token.address, displaySymbol: token.symbol, status: 'unavailable' };
}
async function verify() {
  await Promise.all(DEFAULT_NETWORKS.map(async (network) => {
    // Avoid bursts against one public endpoint; networks are independent.
    for (const token of getKnownTokens(network.chainId)) report.results.push(await check(network, token));
  }));
  report.results.sort((a, b) => a.chainId - b.chainId || a.address.localeCompare(b.address));
  fs.writeFileSync(path.join(root, 'docs', 'common-tokens-verification.json'), JSON.stringify(report, null, 2) + '\n');
  const verified = report.results.filter(({ status }) => status === 'verified').length;
  const mismatched = report.results.filter(({ status }) => status === 'mismatch').length;
  console.log(`Live common-token verification: ${verified}/${report.results.length} verified, ${mismatched} mismatches.`);
  if (verified !== report.results.length) process.exitCode = 1;
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });

