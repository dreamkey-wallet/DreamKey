'use strict';

// Check only Git-visible source. Never print matched values or read ignored secrets.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const history = process.argv.includes('--history');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const failures = new Set();
const report = (file, category, scope) => failures.add(`${scope}: ${file} (${category})`);
const forbiddenFile = /(?:^|\/)(?:\.env(?:\..+)?|local\.properties|release-signing\.properties|key\.properties|keystore\.properties)$|\.(?:jks|p12|pfx|keystore|pem|key|p8|mobileprovision|provisionprofile|apk|aab|ipa|log|map)$/i;
const publicDebugKeys = new Set(['android/app/debug.keystore', 'IndependentWallet/android/app/debug.keystore']);
const rules = [
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{64,}-----END /],
  ['cloud access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['RPC key in URL', /https?:\/\/[^\s'"<>]*(?:nodereal\.io\/v1\/|infura\.io\/v3\/|alchemy\.com\/v2\/)[A-Za-z0-9_-]{16,}/],
];

function check(file, bytes, scope) {
  if (forbiddenFile.test(file) && !publicDebugKeys.has(file) && !file.endsWith('.example')) report(file, 'private/local/generated file', scope);
  if (file.startsWith('.bundle/')) report(file, 'local QA/build output', scope);
  if (bytes.includes(0)) return;
  const source = bytes.toString('utf8');
  for (const [category, pattern] of rules) if (pattern.test(source)) report(file, category, scope);
  if (file === 'android/app/build.gradle') {
    if (/\breleaseSigningInCode\s*=/.test(source)) report(file, 'inline release signing configuration', scope);
    for (const match of source.matchAll(/\b(?:storePassword|keyPassword)\s*(?::|=)?\s*['"]([^'"\r\n]+)['"]/g)) {
      if (match[1] !== 'android') report(file, 'literal signing password', scope);
    }
  }
  if (file === 'src/config/app-updates.ts') {
    if (!/UPDATE_JSON_URL\s*=\s*(['"])\1\s*;/.test(source)) report(file, 'update service must be disabled in public snapshot', scope);
    if (!/UPDATE_DOWNLOAD_HOSTS[^=]*=\s*\[\s*\]\s*;/.test(source)) report(file, 'production download hosts', scope);
  }
  if (file === 'src/config/app-links.ts' && !/APP_DOWNLOAD_URL\s*=\s*['"]https:\/\/example\.com\/dreamkey\/download['"]/.test(source)) {
    report(file, 'download link must use the public example', scope);
  }
}

const files = git('ls-files', '--cached', '-z').split('\0').filter(Boolean);
for (const file of files) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) { report(file, 'tracked file is missing; stage its deletion first', 'working tree'); continue; }
  check(file, fs.readFileSync(absolute), 'working tree');
}
if (history) {
  // Walk HEAD only. Private main/other refs are intentionally outside the public branch.
  const commits = git('rev-list', 'HEAD').trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    const scope = commit.slice(0, 12);
    for (const file of git('ls-tree', '-r', '--name-only', '-z', commit).split('\0').filter(Boolean)) {
      const bytes = execFileSync('git', ['show', `${commit}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      check(file, bytes, scope);
    }
    const identities = git('show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', commit).trim().split('\0');
    if (identities.some(value => value !== 'DreamKey contributors' && value !== 'contributors@example.invalid')) {
      report('commit metadata', 'review personal author/committer identity', scope);
    }
  }
}
if (failures.size) {
  console.error([...failures].join('\n'));
  console.error('Open-source privacy check failed. Values are intentionally omitted.');
  process.exitCode = 1;
} else {
  console.log(`Open-source privacy check passed: ${files.length} tracked files${history ? ' and HEAD history' : ''}. Heuristic checks cannot replace a manual review.`);
}
