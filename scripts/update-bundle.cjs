'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {ROOT, argumentsFor, required, appVersion, bundleVersion, nativeAppVersion, isWithin, payloadFiles, packageWithManifest, zipStore, hermesBytecodeVersion, verifyHermesBytecode, publishArtifact, legacyArtifactAppVersion} = require('./update-tools.cjs');

function buildBundle(argv, options = {}) {
  const root = options.root || ROOT;
  const host = options.host || process.platform;
  const spawn = options.spawnSync || spawnSync;
  const args = argumentsFor(argv, ['platform', 'app-version', 'bundle-version', 'hermesc']);
  const platform = args.platform || 'android';
  if (!['android', 'ios'].includes(platform)) throw new Error('--platform must be android or ios');
  if (platform === 'ios' && host !== 'darwin') throw new Error('Build iOS OTA packages on macOS using the matching Pods Hermes compiler');
  const version = appVersion(required(args, 'app-version'));
  const patch = bundleVersion(required(args, 'bundle-version'));
  if (version !== nativeAppVersion(platform, root)) throw new Error('--app-version must equal this checkout native app version. Build a matching native app before publishing its OTA patch');
  if (platform === 'android' && !/^\s*hermesEnabled\s*=\s*true\s*$/m.test(fs.readFileSync(path.join(root, 'android/gradle.properties'), 'utf8'))) {
    throw new Error('Android OTA bytecode requires hermesEnabled=true; an engine change requires a new native app');
  }
  const compilerDirectory = host === 'win32' ? 'win64-bin' : host === 'darwin' ? 'osx-bin' : 'linux64-bin';
  const defaultCompiler = platform === 'ios'
    ? path.join(root, 'ios/Pods/hermes-engine/destroot/bin/hermesc')
    : path.join(root, 'node_modules/react-native/sdks/hermesc', compilerDirectory, host === 'win32' ? 'hermesc.exe' : 'hermesc');
  const compiler = path.resolve(args.hermesc || defaultCompiler);
  if (!fs.existsSync(defaultCompiler) || !fs.existsSync(compiler)) throw new Error('Matching Hermes compiler is missing. Install this checkout dependencies/Pods before building OTA packages');
  const compilerVersion = executable => {
    const result = spawn(executable, ['-version'], {cwd: root, encoding: 'utf8', shell: false, timeout: 10000, maxBuffer: 1024 * 1024});
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Cannot inspect Hermes compiler (exit ${result.status})`);
    return hermesBytecodeVersion(`${result.stdout || ''}\n${result.stderr || ''}`);
  };
  const expectedBytecodeVersion = compilerVersion(defaultCompiler);
  if (compiler !== defaultCompiler && compilerVersion(compiler) !== expectedBytecodeVersion) throw new Error('--hermesc bytecode version does not match this checkout Hermes runtime');
  const platformDirectory = path.join(root, 'dist/updates', platform);
  // Bundle versions reset after an app upgrade. Keep releases for each native
  // app version separate so app 1.0.2 patch 1 does not collide with 1.0.1 patch 1.
  const outputDirectory = path.join(platformDirectory, version, `v${patch}`);
  const output = path.join(outputDirectory, `index.${platform}.bundle.zip`);
  if (fs.existsSync(output)) throw new Error(`Patch artifact already exists: ${output}. Use a new bundle-version instead of overwriting a published patch`);
  const legacyOutput = path.join(platformDirectory, `v${patch}`, `index.${platform}.bundle.zip`);
  if (fs.existsSync(legacyOutput) && legacyArtifactAppVersion(legacyOutput, platform, patch) === version) {
    throw new Error(`Patch artifact already exists in the previous output layout: ${legacyOutput}. Use a new bundle-version`);
  }
  fs.mkdirSync(platformDirectory, {recursive: true});
  const staging = fs.mkdtempSync(path.join(platformDirectory, '.staging-'));
  try {
    const entryFile = `index.${platform}.bundle`;
    const bundle = path.join(staging, entryFile);
    const run = (command, values) => {
      const result = spawn(command, values, {cwd: root, stdio: 'inherit', shell: false});
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Build command failed (exit ${result.status}): ${path.basename(command)}`);
    };
    run(process.execPath, [path.join(root, 'node_modules/react-native/cli.js'), 'bundle', '--platform', platform, '--dev', 'false', '--minify', 'true', '--entry-file', 'index.js', '--bundle-output', bundle, '--assets-dest', staging, '--max-workers', '2']);
    const bytecode = path.join(staging, '.compiled.bundle');
    run(compiler, ['-emit-binary', '-O', '-g0', '-fstrip-function-names', '-out', bytecode, bundle]);
    verifyHermesBytecode(fs.readFileSync(bytecode), expectedBytecodeVersion);
    fs.renameSync(bytecode, bundle);
    const files = payloadFiles(staging);
    const packaged = packageWithManifest(files, platform, version, patch);
    const archive = zipStore(packaged);
    if (version !== nativeAppVersion(platform, root)) throw new Error('Native app version changed while building; discard this OTA package and rebuild');
    publishArtifact(output, archive, staging);
    return {platform, version, patch, output, files: files.length, bytes: archive.length};
  } finally {
    const expected = fs.realpathSync(path.join(root, 'dist/updates'));
    const resolved = fs.realpathSync(staging);
    if (!isWithin(expected, resolved) || !path.basename(resolved).startsWith('.staging-')) throw new Error('Refusing to remove a staging path outside dist/updates');
    fs.rmSync(resolved, {recursive: true, force: true});
  }
}

if (require.main === module) {
  try {
    const result = buildBundle(process.argv.slice(2));
    console.log(`\nUnsigned ${result.platform} OTA package: ${result.output}\nApp: ${result.version}, bundle: ${result.patch}, payload files: ${result.files}, ZIP bytes: ${result.bytes}\nUpload this ZIP first, then publish the JSON with the same appVersion and bundleVersion. The ZIP contains a manifest and per-file SHA-256 hashes; do not upload staging files.`);
  } catch (error) {
    console.error(`Update bundle failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {buildBundle};
