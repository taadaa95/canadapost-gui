'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isAllowed, isProhibited, auditFileList, sourceManifest, validateReleaseIdentity } = require('../lib/release-safety');
const { scanText, scanPaths } = require('../lib/secret-scanner');

assert(isAllowed('main.js'));
assert(isAllowed('lib/policy-engine.js'));
assert(isProhibited('data/claims.csv'));
assert(isProhibited('logs/app.log'));
assert(isProhibited('user.ini'));
assert(isProhibited('.env.example'));
assert(isProhibited('node_modules/package/index.js'));
assert(!isAllowed('surprise.bin'));
assert.deepStrictEqual(auditFileList(['main.js', 'lib/policy-engine.js']).ok, true);
assert.deepStrictEqual(auditFileList(['main.js', 'data/claims.csv']).ok, false);
assert.deepStrictEqual(auditFileList(['main.js', 'unexpected.txt']).ok, false);
const releaseIdentity = { branch: 'feature/dev11-beta-release-hardening', commit: 'a'.repeat(40) };
assert.deepStrictEqual(validateReleaseIdentity(releaseIdentity), { ...releaseIdentity, expectedBranch: 'feature/dev11-beta-release-hardening' });
assert.throws(() => validateReleaseIdentity({ ...releaseIdentity, branch: 'main' }), /must be built from/);
assert.throws(() => validateReleaseIdentity({ ...releaseIdentity, commit: 'b'.repeat(40) }, { expectedCommit: 'a'.repeat(40) }), /does not match reviewed commit/);

assert.equal(scanText('password = YOUR_PASSWORD', 'user.ini.example').length, 0);
const credentialLine = ['pass', 'word = "', 'A9v!r2Q#t7Lm4Zp', '"'].join('');
assert.equal(scanText(credentialLine, 'bad.ini').length, 1);
const privateKeyLine = ['-----BEGIN ', 'PRIVATE ', 'KEY-----'].join('');
assert.equal(scanText(privateKeyLine, 'bad.pem').length, 1);
const bearerLine = ['Author', 'ization: Bearer ', 'abcdefghijklmnopqrstuvwxyz'].join('');
const finding = scanText(bearerLine, 'bad.txt')[0];
assert.equal(finding.redacted, '[REDACTED POTENTIAL SECRET]');
assert(!Object.values(finding).join(' ').includes('abcdefghijklmnopqrstuvwxyz'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-safety-test-'));
try {
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'main.js'), 'console.log("synthetic");\n');
  fs.writeFileSync(path.join(root, 'lib', 'safe.js'), 'module.exports = true;\n');
  const manifest = sourceManifest(root, ['main.js', 'lib/safe.js']);
  assert.equal(manifest.length, 2);
  assert(manifest.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.equal(scanPaths(root).length, 0);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Release safety tests passed.');
