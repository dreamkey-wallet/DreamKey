/* Verify the real preference store without credentials or live requests. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const A = 'https://bsc.mytokenpocket.vip';
const B = 'https://bsc-rpc.publicnode.com';
const C = 'https://bsc-dataseed1.bnbchain.org';
const ETH = 'https://web3.mytokenpocket.vip';
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(initial = {}) {
  const modules = new Map(), writes = [];
  let disk = JSON.stringify(initial), readGate, writeGate, failWrite = false;
  const keychain = {
    ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture' },
    async getGenericPassword() { const saved = disk; const gate = readGate; readGate = null; if (gate) await gate.promise; return saved ? { password: saved } : false; },
    async setGenericPassword(_user, value) { writes.push(value); const gate = writeGate; writeGate = null; if (gate) await gate.promise; if (failWrite) throw new Error('Storage unavailable'); disk = value; },
    async resetGenericPassword() { writes.push(null); if (failWrite) throw new Error('Storage unavailable'); disk = null; },
  };
  function load(relative) {
    const filename = path.resolve(__dirname, '..', relative);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, URL, require(name) {
      if (name === 'react-native-keychain') return keychain;
      assert.ok(name.startsWith('.'));
      return load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts'))));
    } }, { filename });
    return module.exports;
  }
  return {
    storage: load('src/native/rpc-preferences-storage.ts').rpcPreferencesStorage,
    endpoints: load('src/core/rpc-endpoints.ts'), writes,
    get disk() { return disk ? JSON.parse(disk) : {}; },
    holdRead() { readGate = deferred(); return readGate; },
    holdWrite() { writeGate = deferred(); return writeGate; },
    failWrites() { failWrite = true; },
  };
}
async function flush() { for (let pass = 0; pass < 12; pass += 1) await Promise.resolve(); }
async function main() {
  const saved = fixture({ 56: A, 1: ETH });
  await saved.storage.read();
  assert.equal(saved.endpoints.getPreferredRpcEndpoint(56), A);
  const pending = saved.holdRead();
  const changed = saved.storage.set(56, B);
  assert.equal(saved.endpoints.getPreferredRpcEndpoint(56), B, 'Manual choice takes effect before disk I/O');
  await flush(); pending.resolve(); await changed;
  assert.equal(saved.endpoints.getPreferredRpcEndpoint(56), B, 'Loading the previous disk value cannot undo the choice');
  assert.deepEqual(saved.disk, { 56: B, 1: ETH });
  assert.equal(await saved.storage.set(56, 'https://untrusted.invalid'), false);
  assert.equal(saved.endpoints.getPreferredRpcEndpoint(56), B);

  const rapid = fixture({ 56: A });
  const slowWrite = rapid.holdWrite();
  const first = rapid.storage.set(56, B); await flush();
  assert.equal(rapid.writes.length, 1);
  const second = rapid.storage.set(56, C), otherChain = rapid.storage.set(1, ETH);
  assert.equal(rapid.endpoints.getPreferredRpcEndpoint(56), C);
  slowWrite.resolve(); await Promise.all([first, second, otherChain]);
  assert.deepEqual(rapid.disk, { 56: C, 1: ETH }, 'Serialized writes retain the last selection and other networks');
  assert.equal(rapid.endpoints.getPreferredRpcEndpoint(56), C);

  for (const clear of [false, true]) {
    const startup = fixture({ 56: A, 1: ETH });
    const loading = startup.holdRead(), restore = startup.storage.read();
    if (clear) await startup.storage.clear(56);
    else await startup.storage.set(56, B);
    loading.resolve(); await restore;
    assert.equal(startup.endpoints.getPreferredRpcEndpoint(56), clear ? undefined : B, 'Late startup restore cannot overwrite a user action');
    assert.equal(startup.endpoints.getPreferredRpcEndpoint(1), ETH, 'Untouched networks still restore');
  }

  const clearing = fixture({ 56: A });
  const gate = clearing.holdWrite();
  const selecting = clearing.storage.set(56, B); await flush();
  const automatic = clearing.storage.clear(56);
  assert.equal(clearing.endpoints.getPreferredRpcEndpoint(56), undefined, 'Automatic takes effect immediately');
  gate.resolve(); await Promise.all([selecting, automatic]);
  assert.deepEqual(clearing.disk, {});
  assert.equal(clearing.endpoints.getPreferredRpcEndpoint(56), undefined, 'A pending manual write cannot re-enable manual mode');

  const failed = fixture({ 56: A }); failed.failWrites();
  assert.equal(await failed.storage.set(56, B), true);
  assert.equal(failed.endpoints.getPreferredRpcEndpoint(56), B, 'Storage failure retains the in-memory selection');
  await failed.storage.clear(56);
  assert.equal(failed.endpoints.getPreferredRpcEndpoint(56), undefined);
  console.log('RPC preference verification passed: saved-node replacement, immediate routing, serialized rapid/multichain writes, startup races, explicit Automatic, trust guards and storage failures. Offline fixtures only.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
