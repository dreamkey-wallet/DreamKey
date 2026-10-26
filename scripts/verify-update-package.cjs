/* Offline release protocol regression, using mock bundles and isolated build trees only. */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {LIMITS, argumentsFor, appVersion, bundleVersion, versionFromGradle, versionFromXcode, nativeAppVersion, safePayloadPath, payloadFiles, manifestFor, packageWithManifest, zipStore, crc32, hermesBytecodeVersion, verifyHermesBytecode, publishArtifact} = require('./update-tools.cjs');
const {buildBundle} = require('./update-bundle.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamkey-update-test-'));
try {
  assert.throws(() => argumentsFor(['--out'], ['out']), /incomplete/);
  assert.throws(() => argumentsFor(['--out', 'a', '--out', 'b'], ['out']), /Duplicate/);
  for (const value of ['1.0.0', '1.0.6', '1.0.10', '999999999.0.0']) assert.equal(appVersion(value), value);
  for (const value of ['1.0', '1.0.01', '1.0.0-beta', '1.0.0\n', '-1.0.0', '1000000000.0.0']) assert.throws(() => appVersion(value));
  for (const value of [1, '5', 2147483647]) assert.equal(bundleVersion(value), Number(value));
  for (const value of [0, -1, 1.5, '05', '5\n', 2147483648, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => bundleVersion(value));
  assert.equal(versionFromGradle('defaultConfig {\n versionName "1.0.6" // current\n}'), '1.0.6');
  assert.throws(() => versionFromGradle('versionName project.VERSION'), /literal/);
  assert.throws(() => versionFromGradle('versionName "1.0.6"\nversionName "1.0.7"'), /single/);
  const xcodeBlock = (name, version, plist = 'IndependentWallet/Info.plist') => `isa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\nINFOPLIST_FILE = ${plist};\nMARKETING_VERSION = ${version};\n};\nname = ${name};\n\t\t};`;
  assert.equal(versionFromXcode(xcodeBlock('Debug', '1.0.6') + xcodeBlock('Release', '1.0.6') + xcodeBlock('Debug', '9.9.9', 'IndependentWalletTests/Info.plist')), '1.0.6');
  assert.throws(() => versionFromXcode(xcodeBlock('Debug', '1.0.6') + xcodeBlock('Release', '1.0.7')), /match/);
  assert.throws(() => versionFromXcode(xcodeBlock('Debug', '$(VERSION)') + xcodeBlock('Release', '1.0.6')), /resolve/);
  assert.throws(() => versionFromXcode(xcodeBlock('Release', '1.0.6')), /both/);
  assert.equal(nativeAppVersion('android').split('.').length, 3);
  assert.equal(nativeAppVersion('ios').split('.').length, 3);
  assert.throws(() => nativeAppVersion('windows'), /platform/);

  for (const name of ['../escape', '/absolute', 'a\\b', 'a//b', 'a/../b', 'C:/escape', 'a b', 'manifest.json', 'MANIFEST.JSON', 'manifest.sig', 'Manifest.Sig', 'secret.pem', 'a.map', 'a.p12']) assert.throws(() => safePayloadPath(name));
  assert.equal(safePayloadPath('drawable-mdpi/assets_images_logo.png'), 'drawable-mdpi/assets_images_logo.png');
  const staging = path.join(temporary, 'payload');
  fs.mkdirSync(path.join(staging, 'drawable-mdpi'), {recursive: true});
  fs.writeFileSync(path.join(staging, 'index.android.bundle'), 'TEST-ONLY-HERMES-BUNDLE');
  fs.writeFileSync(path.join(staging, 'drawable-mdpi/logo.png'), Buffer.from([137, 80, 78, 71]));
  const payload = payloadFiles(staging);
  const archiveFiles = packageWithManifest(payload, 'android', '1.0.6', 5);
  const manifest = JSON.parse(archiveFiles[0].data);
  assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'platform', 'appVersion', 'bundleVersion', 'entryFile', 'files']);
  assert.equal(manifest.entryFile, 'index.android.bundle');
  assert.deepEqual(manifest.files.map(file => file.path), ['drawable-mdpi/logo.png', 'index.android.bundle']);
  assert.equal(archiveFiles.some(file => file.path === 'manifest.sig'), false, 'Unsigned OTA packages do not include manifest.sig');
  for (const file of payload) {
    const expected = manifest.files.find(record => record.path === file.path);
    assert.equal(expected.sha256, crypto.createHash('sha256').update(file.data).digest('hex'));
    assert.equal(expected.size, file.data.length);
    const tampered = Buffer.from(file.data);
    tampered[0] ^= 1;
    assert.notEqual(expected.sha256, crypto.createHash('sha256').update(tampered).digest('hex'));
  }
  assert.throws(() => manifestFor(payload, 'ios', '1.0.6', 5), /index.ios.bundle/);
  assert.throws(() => manifestFor(payload, 'windows', '1.0.6', 5), /platform/);
  assert.throws(() => manifestFor([...payload, payload[0]], 'android', '1.0.6', 5), /Duplicate/);
  assert.throws(() => manifestFor([...payload, {path: 'drawable-mdpi', data: Buffer.from('x')}], 'android', '1.0.6', 5), /path collision/);
  assert.throws(() => manifestFor([{path: '../index.android.bundle', data: Buffer.from('x')}], 'android', '1.0.6', 5), /Unsafe/);
  assert.throws(() => manifestFor([{path: 'index.android.bundle', data: Buffer.alloc(0)}], 'android', '1.0.6', 5), /nonempty/);
  assert.throws(() => manifestFor(Array.from({length: 999}, (_, n) => ({path: `asset${n}`, data: Buffer.from('x')})), 'android', '1.0.6', 5), /count/);
  assert.throws(() => manifestFor([{path: 'index.android.bundle', data: Buffer.alloc(LIMITS.file + 1)}], 'android', '1.0.6', 5), /size/);
  const block = Buffer.alloc(26 * 1024 * 1024);
  assert.throws(() => zipStore([{path: 'a', data: block}, {path: 'b', data: block}]), /50 MiB/);

  const zip = zipStore(archiveFiles);
  assert.ok(zip.length < LIMITS.zip);
  fs.writeFileSync(path.join(temporary, 'test-only.zip'), zip);
  // Independently inspect the wire format consumed by the native readers.
  const localEntries = [];
  let cursor = 0;
  while (zip.readUInt32LE(cursor) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(cursor + 6), 0x0800, 'UTF8 only, no encryption/data descriptor');
    assert.equal(zip.readUInt16LE(cursor + 8), 0, 'STORE only');
    const size = zip.readUInt32LE(cursor + 18);
    assert.equal(size, zip.readUInt32LE(cursor + 22));
    const length = zip.readUInt16LE(cursor + 26);
    assert.equal(zip.readUInt16LE(cursor + 28), 0, 'No extra fields');
    const name = zip.subarray(cursor + 30, cursor + 30 + length).toString('utf8');
    const data = zip.subarray(cursor + 30 + length, cursor + 30 + length + size);
    assert.equal(crc32(data), zip.readUInt32LE(cursor + 14));
    const expected = archiveFiles.find(file => file.path === name);
    assert.ok(expected);
    assert.deepEqual(data, expected.data);
    localEntries.push({name, offset: cursor});
    cursor += 30 + length + size;
  }
  const centralOffset = cursor;
  for (const record of localEntries) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    assert.equal(zip.readUInt16LE(cursor + 8), 0x0800);
    assert.equal(zip.readUInt16LE(cursor + 10), 0);
    assert.equal(zip.readUInt16LE(cursor + 30), 0, 'No central extra fields');
    assert.equal(zip.readUInt16LE(cursor + 32), 0, 'No central comments');
    assert.equal(zip.readUInt32LE(cursor + 42), record.offset);
    const length = zip.readUInt16LE(cursor + 28);
    assert.equal(zip.subarray(cursor + 46, cursor + 46 + length).toString('utf8'), record.name);
    cursor += 46 + length;
  }
  assert.equal(zip.readUInt32LE(cursor), 0x06054b50);
  assert.equal(zip.readUInt16LE(cursor + 8), archiveFiles.length);
  assert.equal(zip.readUInt16LE(cursor + 10), archiveFiles.length);
  assert.equal(zip.readUInt32LE(cursor + 12), cursor - centralOffset);
  assert.equal(zip.readUInt32LE(cursor + 16), centralOffset);
  assert.equal(zip.readUInt16LE(cursor + 20), 0);
  assert.equal(cursor + 22, zip.length, 'No trailing bytes');
  assert.throws(() => zipStore([...archiveFiles, archiveFiles[0]]), /duplicate/);

  assert.equal(hermesBytecodeVersion('Hermes compiler\n HBC bytecode version: 96\n Features:'), 96);
  assert.throws(() => hermesBytecodeVersion('not a Hermes compiler'), /Cannot resolve/);
  const bytecode = version => {
    const bytes = Buffer.alloc(64);
    Buffer.from('c61fbc03c103191f', 'hex').copy(bytes);
    bytes.writeUInt32LE(version, 8);
    return bytes;
  };
  verifyHermesBytecode(bytecode(96), 96);
  assert.throws(() => verifyHermesBytecode(bytecode(95), 96), /compatible/);
  assert.throws(() => verifyHermesBytecode(Buffer.from('plaintext script'), 96), /compatible/);

  const releaseDirectory = path.join(temporary, 'publish');
  fs.mkdirSync(releaseDirectory);
  const artifact = path.join(releaseDirectory, 'release.zip');
  const interruptedIo = {...fs, writeFileSync(descriptor, bytes) {
    fs.writeSync(descriptor, bytes.subarray(0, 16));
    throw new Error('fixture disk full');
  }};
  assert.throws(() => publishArtifact(artifact, zip, releaseDirectory, interruptedIo), /disk full/);
  assert.equal(fs.existsSync(artifact), false, 'A partial write must never create a final release artifact');
  assert.deepEqual(fs.readdirSync(releaseDirectory), [], 'Failed partial write is cleaned up');
  const unsyncedIo = {...fs, fsyncSync() {throw new Error('fixture failed sync');}};
  assert.throws(() => publishArtifact(artifact, zip, releaseDirectory, unsyncedIo), /failed sync/);
  assert.equal(fs.existsSync(artifact), false, 'Unsynced data must never be published');
  publishArtifact(artifact, zip, releaseDirectory);
  assert.deepEqual(fs.readFileSync(artifact), zip);
  assert.throws(() => publishArtifact(artifact, Buffer.from('replacement'), releaseDirectory), /EEXIST/);
  assert.deepEqual(fs.readFileSync(artifact), zip, 'Concurrent publishers cannot replace an existing release');

  // Execute the real build orchestration with tiny Metro/Hermes subprocess
  // fixtures. No production bundle, signing material, or network is needed.
  const buildRoot = path.join(temporary, 'build');
  const gradle = path.join(buildRoot, 'android/app/build.gradle');
  const properties = path.join(buildRoot, 'android/gradle.properties');
  const compiler = path.join(buildRoot, 'node_modules/react-native/sdks/hermesc/win64-bin/hermesc.exe');
  fs.mkdirSync(path.dirname(gradle), {recursive: true});
  fs.mkdirSync(path.dirname(compiler), {recursive: true});
  fs.writeFileSync(compiler, 'fixture executable');
  fs.writeFileSync(properties, 'hermesEnabled=true\n');
  const setAppVersion = value => fs.writeFileSync(gradle, `defaultConfig {\n versionName "${value}"\n}`);
  setAppVersion('1.0.6');
  const calls = [];
  let fault = '';
  const options = {root: buildRoot, host: 'win32', spawnSync(command, args) {
    calls.push([command, ...args]);
    if (args[0] === '-version') return {status: 0, stdout: `HBC bytecode version: ${command === compiler ? 96 : 95}\n`};
    if (args.includes('bundle')) {
      const output = args[args.indexOf('--bundle-output') + 1];
      fs.writeFileSync(output, 'global.fixture=1;');
      fs.mkdirSync(path.join(path.dirname(output), 'drawable-mdpi'));
      fs.writeFileSync(path.join(path.dirname(output), 'drawable-mdpi', 'logo.png'), Buffer.from([137, 80, 78, 71]));
      if (fault === 'metro') return {status: 1};
      if (fault === 'version-change') setAppVersion('1.0.8');
      return {status: 0};
    }
    if (args[0] === '-emit-binary') {
      if (fault === 'hermes') return {status: 2};
      fs.writeFileSync(args[args.indexOf('-out') + 1], fault === 'plaintext' ? Buffer.from('bad compiler output') : bytecode(fault === 'bytecode' ? 95 : 96));
      return {status: 0};
    }
    throw new Error('Unexpected fixture process');
  }};
  const command = (version, patch) => ['--platform', 'android', '--app-version', version, '--bundle-version', String(patch)];
  const built = buildBundle(command('1.0.6', 1), options);
  assert.equal(built.output, path.join(buildRoot, 'dist/updates/android/1.0.6/v1/index.android.bundle.zip'));
  assert.equal(built.files, 2, 'Metro resource files stay alongside the Hermes bundle');
  assert.deepEqual(fs.readdirSync(path.join(buildRoot, 'dist/updates/android')), ['1.0.6']);
  assert.ok(calls.some(call => call.includes('--dev') && call.includes('false')));
  const firstArtifact = fs.readFileSync(built.output);
  assert.throws(() => buildBundle(command('1.0.6', 1), options), /already exists/);
  assert.deepEqual(fs.readFileSync(built.output), firstArtifact);
  setAppVersion('1.0.7');
  const nextApp = buildBundle(command('1.0.7', 1), options);
  assert.notEqual(built.output, nextApp.output, 'A native upgrade can restart bundleVersion at 1');
  const legacyOutput = path.join(buildRoot, 'dist/updates/android/v3/index.android.bundle.zip');
  fs.mkdirSync(path.dirname(legacyOutput), {recursive: true});
  fs.writeFileSync(legacyOutput, zipStore(packageWithManifest(payload, 'android', '1.0.7', 3)));
  assert.throws(() => buildBundle(command('1.0.7', 3), options), /previous output layout/);
  setAppVersion('1.0.8');
  assert.ok(fs.existsSync(buildBundle(command('1.0.8', 3), options).output), 'Legacy releases for an older native version do not block the new app');
  for (const failure of ['metro', 'hermes', 'plaintext', 'bytecode', 'version-change']) {
    setAppVersion('1.0.7');
    fault = failure;
    assert.throws(() => buildBundle(command('1.0.7', 2), options), /failed|compatible|changed/);
    assert.equal(fs.existsSync(path.join(buildRoot, 'dist/updates/android/1.0.7/v2/index.android.bundle.zip')), false);
    assert.equal(fs.readdirSync(path.join(buildRoot, 'dist/updates/android')).some(name => name.startsWith('.staging-')), false, 'Failed builds clean staging files');
  }
  fault = '';
  setAppVersion('1.0.7');
  assert.throws(() => buildBundle(command('1.0.6', 2), options), /must equal/);
  fs.writeFileSync(properties, 'hermesEnabled=false\n');
  assert.throws(() => buildBundle(command('1.0.7', 2), options), /hermesEnabled/);
  fs.writeFileSync(properties, 'hermesEnabled=true\n');
  const otherCompiler = path.join(temporary, 'incompatible-hermesc.exe');
  fs.writeFileSync(otherCompiler, 'fixture');
  assert.throws(() => buildBundle([...command('1.0.7', 2), '--hermesc', otherCompiler], options), /does not match/);

  console.log('OTA release protocol/build checks passed: manifest integrity, path/size limits, STORE ZIP32/CRCs, Hermes compatibility, version-isolated immutable artifacts, atomic publication and failed-build cleanup. No network or wallet access.');
} finally {
  // This path is created by mkdtemp above and cannot be supplied by callers.
  assert.equal(path.dirname(temporary), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('dreamkey-update-test-'));
  fs.rmSync(temporary, {recursive: true, force: true});
}
