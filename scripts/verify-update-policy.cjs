const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadSource(relative, imports = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const entry = new Module(filename, module);
  entry.filename = filename;
  entry.require = (specifier) => {
    assert.ok(Object.hasOwn(imports, specifier), `Unexpected import: ${specifier}`);
    return imports[specifier];
  };
  entry._compile(output, filename);
  return entry.exports;
}

const policy = loadSource('src/updates/update-policy.ts');
const {compareAppVersions, parseUpdateManifest, requireHttpsUrl, selectUpdate} = policy;
const manifest = {
  appVersion: '1.0.6', bundleVersion: 5, mandatory: false,
  description: '1. Improve performance\n2. Fix issues',
  downloadAndroidUrlApk: 'https://updates.example.com/app.apk',
  downloadAndroidUrlBundle: 'https://updates.example.com/index.android.bundle.zip',
  downloadIosUrlApk: 'https://apps.apple.com/app/id123456789',
  downloadIosUrlBundle: 'https://updates.example.com/index.ios.bundle.zip',
};
const runtime = {appVersion: '1.0.6', bundleVersion: 0, pendingBundleVersion: 0, supported: true, rollback: false};
const choose = (data = manifest, state = runtime, platform = 'android') => selectUpdate(data, state, platform, ['updates.example.com'], ['apps.apple.com']);

(async () => {
  assert.ok(compareAppVersions('1.0.10', '1.0.6') > 0);
  assert.equal(compareAppVersions('1.0.6', '1.0.6'), 0);
  assert.ok(compareAppVersions('1.9.9', '2.0.0') < 0);
  for (const bad of ['1.06.0', '1.0', '1.0.0-beta', '1e2.0.0', '1.0.0.0', '9999999999.0.0']) {
    assert.throws(() => compareAppVersions(bad, '1.0.0'));
  }
  assert.deepEqual(parseUpdateManifest(manifest), manifest);
  for (const bad of [null, [], {...manifest, mandatory: 'false'}, {...manifest, bundleVersion: -1},
    {...manifest, bundleVersion: 1.5}, {...manifest, bundleVersion: 2147483648},
    {...manifest, downloadAndroidUrlBundle: undefined}, {...manifest, description: 'x'.repeat(8001)}]) {
    assert.throws(() => parseUpdateManifest(bad));
  }
  assert.equal(choose().kind, 'bundle');
  assert.equal(choose(manifest, {...runtime, appVersion: '1.0.0'}).kind, 'apk');
  assert.equal(choose(manifest, {...runtime, appVersion: '1.0.0'}, 'ios').kind, 'store');
  assert.equal(choose(manifest, runtime, 'ios').kind, 'bundle');
  for (const state of [{...runtime, appVersion: '1.0.10'}, {...runtime, bundleVersion: 5},
    {...runtime, pendingBundleVersion: 5}, {...runtime, highestBundleVersion: 8},
    {...runtime, failedBundleVersion: 5}, {...runtime, supported: false}]) {
    assert.equal(choose(manifest, state), null, 'Do not downgrade, repeat, or retry a rejected patch');
  }
  assert.equal(choose({...manifest, downloadIosUrlApk: ''}, {...runtime, appVersion: '1.0.0'}, 'ios'), null);
  assert.equal(choose({...manifest, downloadAndroidUrlBundle: ''}), null);
  assert.equal(choose(manifest, runtime, 'windows'), null);
  for (const url of ['http://updates.example.com/a', 'https://127.0.0.1/a', 'https://[::1]/a',
    'https://updates.example.com.evil.example/a', 'https://user:secret@updates.example.com/a',
    'https://updates.example.com:8443/a', 'file:///a', 'https://localhost/a', 'https://updates.example.com/a#fragment']) {
    assert.throws(() => requireHttpsUrl(url, ['updates.example.com']));
  }
  assert.throws(() => selectUpdate(manifest, runtime, 'android', [], []), 'Missing allowlist cannot start downloads');

  const {fetchUpdateManifest} = loadSource('src/updates/check-update.ts', {'./update-policy.js': policy});
  const originalFetch = global.fetch;
  let calls = 0;
  try {
    global.fetch = async (url, options) => {
      calls++;
      assert.equal(new URL(url).origin, 'https://updates.example.com');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Accept, 'application/json');
      assert.ok(!('body' in options), 'No wallet data is sent');
      return {ok: true, url, headers: new Headers(), text: async () => JSON.stringify(manifest)};
    };
    assert.deepEqual(await fetchUpdateManifest('https://updates.example.com/version.json'), manifest);
    assert.equal(calls, 1);
    await assert.rejects(fetchUpdateManifest('http://updates.example.com/version.json'));
    assert.equal(calls, 1);
    for (const response of [
      {ok: false, headers: new Headers()},
      {ok: true, url: 'https://other.example.com/version.json', headers: new Headers()},
      {ok: true, headers: new Headers({'content-length': '999999'})},
      {ok: true, headers: new Headers(), text: async () => 'x'.repeat(65537)},
      {ok: true, headers: new Headers(), text: async () => '{"invalid":true}'},
    ]) {
      global.fetch = async () => response;
      await assert.rejects(fetchUpdateManifest('https://updates.example.com/version.json'));
    }
    global.fetch = async () => { throw new Error('Offline'); };
    await assert.rejects(fetchUpdateManifest('https://updates.example.com/version.json'), /Offline/);
  } finally { global.fetch = originalFetch; }
  console.log('Update policy and GET checks passed: native/patch selection, replay prevention, URL allowlist, invalid/offline responses.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
