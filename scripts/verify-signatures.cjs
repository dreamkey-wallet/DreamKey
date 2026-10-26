/* Check DApp approval payloads and actual offline signatures with public fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { Wallet, getBytes, hexlify, toUtf8Bytes, verifyMessage, verifyTypedData } = require('ethers');
const projectRoot = path.resolve(__dirname, '..');
const modules = new Map();

function load(relativePath) {
  const filename = path.join(projectRoot, relativePath);
  if (modules.has(filename)) return modules.get(filename).exports;
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const entry = new Module(filename, module);
  entry.filename = filename;
  entry.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireNormally = entry.require.bind(entry);
  entry.require = (specifier) => {
    const source = specifier.startsWith('.') ? path.resolve(path.dirname(filename), specifier.replace(/\.js$/, '.ts')) : undefined;
    return source && fs.existsSync(source) ? load(path.relative(projectRoot, source)) : requireNormally(specifier);
  };
  modules.set(filename, entry);
  entry._compile(compiled, filename);
  return entry.exports;
}

async function verify() {
  const { getSignaturePreview, normalizeSigningMessage, parseSigningTypedData } = load('src/provider/signing-payload.ts');
  const { createWalletProvider } = load('src/provider/wallet-core-adapter.ts');
  // Public scalar 1 is a widely known fixture; no user key or RPC is involved.
  const fixtureSigner = new Wallet(`0x${'0'.repeat(63)}1`);
  const account = fixtureSigner.address;
  const origin = 'https://signing-fixture.invalid';
  const siwe = `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${account}\n\n欢迎使用 DreamKey 🔑\n\nURI: ${origin}\nVersion: 1\nChain ID: 56\nNonce: abcdefgh\nIssued At: 2026-10-13T00:00:00.000Z`;
  const readableMessages = ['', '中文 + emoji 🔑 😀', siwe, 'Tabs\tand CRLF\r\nare preserved', '  Do not trim this\n'];
  for (const text of readableMessages) {
    const hex = hexlify(toUtf8Bytes(text));
    for (const method of ['personal_sign', 'eth_sign']) {
      const plainParams = method === 'personal_sign' ? [text, account] : [account, text];
      const hexParams = method === 'personal_sign' ? [hex, account] : [account, hex];
      assert.deepEqual(getSignaturePreview(method, plainParams), { kind: 'text', account, message: text });
      assert.deepEqual(getSignaturePreview(method, hexParams), { kind: 'text', account, message: text, rawMessage: hex });
      assert.equal(normalizeSigningMessage(text), text, 'plain messages retain their exact whitespace and Unicode');
      assert.deepEqual(normalizeSigningMessage(hex), getBytes(hex), 'hex messages remain bytes for signing');
    }
  }

  const binaryMessages = ['0xff', '0xc328', '0xc0af', '0xeda080', '0xf4908080', '0x010203', '0x486900', hexlify(toUtf8Bytes('pay\u202e100'))];
  for (const hex of binaryMessages) {
    for (const method of ['personal_sign', 'eth_sign']) {
      const params = method === 'personal_sign' ? [hex, account] : [account, hex];
      assert.deepEqual(getSignaturePreview(method, params), { kind: 'binary', account, message: hex, rawMessage: hex });
      assert.deepEqual(normalizeSigningMessage(hex), getBytes(hex), 'binary preview never modifies the signed bytes');
    }
  }
  const controlledTextMessages = ['hidden\u0000byte', 'pay\u202e100'];
  for (const text of controlledTextMessages) {
    assert.equal(normalizeSigningMessage(text), text, 'literal controls retain their original string signing input');
    assert.deepEqual(getSignaturePreview('personal_sign', [text, account]), {
      kind: 'binary', account, message: hexlify(toUtf8Bytes(text)), rawMessage: hexlify(toUtf8Bytes(text)),
    }, 'literal controls expose their exact bytes rather than hiding or reordering the preview');
  }
  assert.equal(getSignaturePreview('eth_sendTransaction', [{ from: account }]), undefined);
  for (const invalid of [undefined, null, 42, {}, '0x0']) {
    assert.throws(() => getSignaturePreview('personal_sign', [invalid, account]), (error) => error.code === -32602);
  }
  assert.throws(() => getSignaturePreview('personal_sign', ['hello']), (error) => error.code === -32602);

  const typed = {
    domain: { name: 'DreamKey fixture', version: '1', chainId: 56, verifyingContract: '0x1111111111111111111111111111111111111111' },
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      Person: [{ name: 'wallet', type: 'address' }, { name: 'name', type: 'string' }],
      Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person[]' }, { name: 'contents', type: 'string' }, { name: 'amount', type: 'uint256' }],
    },
    primaryType: 'Mail',
    message: { from: { wallet: account, name: '发送者 🔑' }, to: [{ wallet: account, name: '接收者' }], contents: '完整内容，不截断或改写', amount: '123456789012345678901234567890' },
  };
  const snapshot = JSON.stringify(typed);
  const normalizedTypes = { Person: typed.types.Person, Mail: typed.types.Mail };
  for (const method of ['eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4']) {
    for (const value of [typed, snapshot]) {
      const preview = getSignaturePreview(method, [account, value]);
      assert.deepEqual(preview, { kind: 'typedData', account, typedData: {
        domain: typed.domain, types: normalizedTypes, message: typed.message, primaryType: 'Mail',
      } });
    }
  }
  assert.equal(JSON.stringify(typed), snapshot, 'preview parsing cannot mutate the request object or EIP712Domain');
  const withoutPrimaryType = { ...typed };
  delete withoutPrimaryType.primaryType;
  assert.equal(parseSigningTypedData(withoutPrimaryType).primaryType, 'Mail', 'preview shows the type actually used by ethers');
  for (const invalid of [null, [], '{invalid', {}, { ...typed, domain: [] }, { ...typed, message: [] }, { ...typed, types: [] }, { ...typed, primaryType: 'Person' }, { ...typed, types: {} }]) {
    assert.throws(() => parseSigningTypedData(invalid), (error) => error.code === -32602);
  }

  const signedMessages = [];
  const signedTypedData = [];
  const approvalPreviews = [];
  let approved = true;
  const network = { id: 'bsc', chainId: 56, rpcUrl: 'https://fixture.invalid' };
  const wallet = {
    getNetwork: () => network,
    listNetworks: () => [network],
    listAccounts: () => [{ address: account, index: 0 }],
    getAccount: () => ({ address: account, index: 0 }),
    signMessage: async (index, message) => {
      signedMessages.push({ index, message });
      return fixtureSigner.signMessage(message);
    },
    getSigner: (index) => ({ signTypedData: async (domain, types, message) => {
      signedTypedData.push({ index, domain, types, message });
      return fixtureSigner.signTypedData(domain, types, message);
    } }),
  };
  const provider = createWalletProvider(wallet, 'bsc', {
    requestAccounts: () => [account],
    approve: ({ method, params }) => { approvalPreviews.push(getSignaturePreview(method, params)); return approved; },
  });
  const site = provider.forOrigin(origin);
  await site.request({ method: 'eth_requestAccounts' });
  for (const value of [siwe, ...readableMessages.map((text) => hexlify(toUtf8Bytes(text))), ...binaryMessages, ...controlledTextMessages]) {
    for (const method of ['personal_sign', 'eth_sign']) {
      const params = method === 'personal_sign' ? [value, account] : [account, value];
      const signature = await site.request({ method, params });
      const expectedInput = normalizeSigningMessage(value);
      assert.equal(verifyMessage(expectedInput, signature), account, 'display decoding leaves the actual signature unchanged');
      assert.deepEqual(signedMessages.at(-1), { index: 0, message: expectedInput });
      assert.deepEqual(approvalPreviews.at(-1), getSignaturePreview(method, params), 'approval preview uses the same request parser');
    }
  }
  for (const method of ['eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4']) {
    for (const value of [typed, snapshot]) {
      const signature = await site.request({ method, params: [account, value] });
      assert.equal(verifyTypedData(typed.domain, normalizedTypes, typed.message, signature), account);
      assert.deepEqual(signedTypedData.at(-1), { index: 0, domain: typed.domain, types: normalizedTypes, message: typed.message });
    }
  }
  const signedCount = signedMessages.length + signedTypedData.length;
  approved = false;
  await assert.rejects(site.request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(siwe)), account] }), (error) => error.code === 4001);
  await assert.rejects(site.request({ method: 'eth_signTypedData_v4', params: [account, snapshot] }), (error) => error.code === 4001);
  assert.equal(signedMessages.length + signedTypedData.length, signedCount, 'rejecting approval never signs a message or typed data');
  approved = true;
  await assert.rejects(site.request({ method: 'eth_signTypedData_v4', params: [account, { ...typed, primaryType: 'Person' }] }), (error) => error.code === -32602);
  await assert.rejects(site.request({ method: 'personal_sign', params: ['0x0', account] }), (error) => error.code === -32602);
  await assert.rejects(site.request({ method: 'personal_sign', params: ['hello', '0x2222222222222222222222222222222222222222'] }), (error) => error.code === 4100);
  assert.equal(signedMessages.length + signedTypedData.length, signedCount, 'invalid or unauthorized requests never reach signing');
  console.log('Signature verification passed: method parameter order, Chinese/emoji/SIWE, strict UTF-8 and binary fallback, empty messages, unchanged signing bytes, typed JSON/object fields and primary type, actual offline signatures, rejection and authorization guards. No RPC or broadcast.');
}

verify().catch((error) => { console.error(error); process.exitCode = 1; });
