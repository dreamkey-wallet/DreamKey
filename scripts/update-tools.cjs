/* Shared release helpers. No network calls, release credentials, or wallet data. */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LIMITS = Object.freeze({zip: 50 * 1024 * 1024, expanded: 150 * 1024 * 1024, file: 50 * 1024 * 1024, payloadFiles: 998});

function argumentsFor(argv, allowed) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag.startsWith('--') || !allowed.includes(flag.slice(2)) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      throw new Error(`Unknown or incomplete option: ${flag}`);
    }
    if (Object.hasOwn(args, flag.slice(2))) throw new Error(`Duplicate option: ${flag}`);
    args[flag.slice(2)] = argv[i + 1];
  }
  return args;
}

function required(args, key) {
  if (!args[key]) throw new Error(`Missing --${key}`);
  return args[key];
}

function appVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)) {
    throw new Error('app-version must be a numeric x.y.z version, for example 1.0.6');
  }
  return value;
}

function bundleVersion(value) {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(number) || number > 2147483647) throw new Error('bundle-version must be an integer from 1 to 2147483647');
  return number;
}

function versionFromGradle(source) {
  const matches = [...source.matchAll(/^\s*versionName\s+(['"])([^'"\r\n]+)\1\s*(?:\/\/[^\r\n]*)?$/gm)];
  if (matches.length !== 1) throw new Error('Cannot resolve a single literal Android versionName. Configure versionName as a numeric x.y.z string');
  return appVersion(matches[0][2]);
}

function versionFromXcode(source) {
  const versions = [];
  const names = [];
  for (const block of source.matchAll(/\bisa = XCBuildConfiguration;([\s\S]*?)\r?\n\t\t};/g)) {
    if (!/\bINFOPLIST_FILE\s*=\s*"?IndependentWallet\/Info\.plist"?\s*;/.test(block[1])) continue;
    const version = block[1].match(/\bMARKETING_VERSION\s*=\s*"?([0-9]+\.[0-9]+\.[0-9]+)"?\s*;/);
    const name = block[1].match(/\bname\s*=\s*(Debug|Release)\s*;/);
    if (!version || !name) throw new Error('Cannot resolve the iOS app MARKETING_VERSION. Configure Debug and Release as numeric x.y.z literals');
    versions.push(appVersion(version[1]));
    names.push(name[1]);
  }
  if (versions.length !== 2 || new Set(versions).size !== 1 || new Set(names).size !== 2) throw new Error('iOS app Debug and Release MARKETING_VERSION must both exist and match');
  return versions[0];
}

function nativeAppVersion(platform, root = ROOT) {
  if (!['android', 'ios'].includes(platform)) throw new Error('platform must be android or ios');
  return platform === 'android'
    ? versionFromGradle(fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8'))
    : versionFromXcode(fs.readFileSync(path.join(root, 'ios/IndependentWallet.xcodeproj/project.pbxproj'), 'utf8'));
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safePayloadPath(value) {
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9_./@+\-]+$/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe update path: ${value}`);
  if (['manifest.json', 'manifest.sig'].includes(value.toLowerCase())) throw new Error('Payload cannot contain reserved manifest files');
  if (/\.(?:map|pem|key|jks|p12|pfx|keystore)$/i.test(value)) throw new Error(`Signing material and source maps cannot be packaged: ${value}`);
  return value;
}

function payloadFiles(directory) {
  const base = fs.realpathSync(directory);
  const result = [];
  let total = 0;
  const walk = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are forbidden in update packages');
      if (!isWithin(base, fs.realpathSync(absolute))) throw new Error('Update file escapes the staging directory');
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) {
        const relative = safePayloadPath(path.relative(directory, absolute).split(path.sep).join('/'));
        if (stat.size > LIMITS.file) throw new Error(`Update file exceeds 50 MiB: ${relative}`);
        total += stat.size;
        if (total > LIMITS.expanded || result.length >= LIMITS.payloadFiles) throw new Error('Update package exceeds extraction limits');
        result.push({path: relative, data: fs.readFileSync(absolute)});
      } else throw new Error('Only regular files are allowed in update packages');
    }
  };
  walk(directory);
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function manifestFor(files, platform, version, patch) {
  if (!['android', 'ios'].includes(platform)) throw new Error('platform must be android or ios');
  if (!Array.isArray(files) || files.length === 0 || files.length > LIMITS.payloadFiles) throw new Error('Invalid update payload file count');
  const seen = new Set();
  let expanded = 0;
  for (const file of files) {
    safePayloadPath(file.path);
    if (!Buffer.isBuffer(file.data) || file.data.length > LIMITS.file) throw new Error('Invalid update payload file size');
    const folded = file.path.toLowerCase();
    if (seen.has(folded)) throw new Error('Duplicate or case-colliding update payload path');
    seen.add(folded);
    expanded += file.data.length;
    if (expanded > LIMITS.expanded) throw new Error('Update payload expands beyond 150 MiB');
  }
  for (const name of seen) {
    const segments = name.split('/');
    segments.pop();
    while (segments.length) {
      if (seen.has(segments.join('/'))) throw new Error('Update payload contains a file/directory path collision');
      segments.pop();
    }
  }
  const entryFile = `index.${platform}.bundle`;
  if (!files.some(file => file.path === entryFile && file.data.length > 0)) throw new Error(`Missing nonempty ${entryFile}`);
  return {
    schemaVersion: 1,
    platform,
    appVersion: appVersion(version),
    bundleVersion: bundleVersion(patch),
    entryFile,
    files: [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => ({path: file.path, sha256: crypto.createHash('sha256').update(file.data).digest('hex'), size: file.data.length})),
  };
}

function hermesBytecodeVersion(output) {
  const match = String(output).match(/^\s*HBC bytecode version:\s*(\d+)\s*$/m);
  const version = match && Number(match[1]);
  if (!Number.isSafeInteger(version) || version <= 0) throw new Error('Cannot resolve Hermes bytecode version from compiler -version');
  return version;
}

function verifyHermesBytecode(bytes, expectedVersion) {
  // Hermes HBC magic and bytecode version are shared across supported hosts/ABIs.
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.subarray(0, 8).toString('hex') !== 'c61fbc03c103191f'
      || bytes.readUInt32LE(8) !== expectedVersion) {
    throw new Error('Compiled bundle is not compatible Hermes bytecode');
  }
}

function publishArtifact(output, archive, staging, io = fs) {
  // The temporary file stays on the same filesystem as output. A hard link
  // publishes the complete, synced file atomically and fails if output exists;
  // rename() can overwrite another release produced concurrently on POSIX.
  const temporary = path.join(staging, '.archive.zip.part');
  let descriptor;
  try {
    descriptor = io.openSync(temporary, 'wx');
    io.writeFileSync(descriptor, archive);
    io.fsyncSync(descriptor);
    io.closeSync(descriptor);
    descriptor = undefined;
    io.mkdirSync(path.dirname(output), {recursive: true});
    io.linkSync(temporary, output);
  } finally {
    if (descriptor !== undefined) io.closeSync(descriptor);
    if (io.existsSync(temporary)) io.unlinkSync(temporary);
  }
}

function legacyArtifactAppVersion(output, platform, patch) {
  // Previous tool versions wrote platform/vN without an appVersion directory.
  // Read just the first (uncompressed manifest) entry from our release format,
  // preserving duplicate-release protection while migrating output layouts.
  const descriptor = fs.openSync(output, 'r');
  try {
    const header = Buffer.alloc(30);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length
        || header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== 0x0800
        || header.readUInt16LE(8) !== 0 || header.readUInt16LE(26) !== 13
        || header.readUInt16LE(28) !== 0 || header.readUInt32LE(18) > 256 * 1024
        || header.readUInt32LE(18) !== header.readUInt32LE(22)) throw new Error('Invalid legacy OTA manifest header');
    const nameAndData = Buffer.alloc(13 + header.readUInt32LE(18));
    if (fs.readSync(descriptor, nameAndData, 0, nameAndData.length, 30) !== nameAndData.length
        || nameAndData.subarray(0, 13).toString('utf8') !== 'manifest.json') throw new Error('Invalid legacy OTA manifest entry');
    if (crc32(nameAndData.subarray(13)) !== header.readUInt32LE(14)) throw new Error('Invalid legacy OTA manifest checksum');
    const manifest = JSON.parse(nameAndData.subarray(13).toString('utf8'));
    if (manifest.schemaVersion !== 1 || manifest.platform !== platform || manifest.bundleVersion !== patch) throw new Error('Invalid legacy OTA release identity');
    return appVersion(manifest.appVersion);
  } finally {
    fs.closeSync(descriptor);
  }
}

function packageWithManifest(files, platform, version, patch) {
  const manifest = manifestFor(files, platform, version, patch);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (bytes.length > 256 * 1024) throw new Error('Update manifest exceeds 256 KiB');
  return [{path: 'manifest.json', data: bytes}, ...files];
}

const crcTable = Array.from({length: 256}, (_, number) => {
  let value = number;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

// Standard ZIP32 STORE entries: compatible with Android ZipInputStream and the iOS reader.
// No Zip64, encryption, data descriptors, symlinks, source maps, or external zip tooling.
function zipStore(files) {
  if (files.length > 1000) throw new Error('ZIP contains too many entries');
  const local = [];
  const central = [];
  let offset = 0;
  let expanded = 0;
  const seen = new Set();
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    if (seen.has(file.path.toLowerCase())) throw new Error('ZIP contains duplicate or case-colliding paths');
    seen.add(file.path.toLowerCase());
    if (file.data.length > LIMITS.file) throw new Error('ZIP entry exceeds 50 MiB');
    expanded += file.data.length;
    if (expanded > LIMITS.expanded) throw new Error('ZIP expands beyond 150 MiB');
    const checksum = crc32(file.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0x0021, 12); // 1980-01-01: deterministic DOS date.
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(file.data.length, 18);
    header.writeUInt32LE(file.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0x0021, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(file.data.length, 20);
    directory.writeUInt32LE(file.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, file.data);
    central.push(directory, name);
    offset += header.length + name.length + file.data.length;
    if (offset > LIMITS.zip) throw new Error('ZIP exceeds the 50 MiB download limit');
  }
  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...local, directoryBytes, end]);
  if (zip.length > LIMITS.zip) throw new Error('ZIP exceeds the 50 MiB download limit');
  return zip;
}

module.exports = {ROOT, LIMITS, argumentsFor, required, appVersion, bundleVersion, versionFromGradle, versionFromXcode, nativeAppVersion, isWithin, safePayloadPath, payloadFiles, manifestFor, packageWithManifest, zipStore, crc32, hermesBytecodeVersion, verifyHermesBytecode, publishArtifact, legacyArtifactAppVersion};
