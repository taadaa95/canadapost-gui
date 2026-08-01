'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const allowlist = require('../config/package-content-allowlist.json');
const { auditPackagePaths, collectRelativePaths, prohibitedPackagePath } = require('../lib/package-content-policy');

const root = path.resolve(__dirname, '..');
const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
assert.ok(!/^\s*- mock-portal\/\*\*/m.test(builder), 'the mock portal must not be packaged in production');
assert.ok(!/^\s*- tests\//m.test(builder), 'tests must not be packaged in production');
for (const script of allowlist.runtimeScripts) assert.ok(builder.includes(`scripts/${script}`), `runtime script ${script} must be explicitly packaged`);
for (const excluded of allowlist.excludedProductionRoots) assert.ok(!allowlist.allowedRoots.includes(excluded), `${excluded} must not be an allowed production root`);
assert.ok(allowlist.artifactSizeBudgets['linux-x64-appimage'] > 0);
assert.ok(allowlist.artifactSizeBudgets['windows-x64-nsis'] > 0);
assert.ok(allowlist.artifactSizeBudgets['linux-x64-appimage'] <= 200000000);
assert.doesNotMatch(builder, /^\s*-\s+node_modules\/playwright\/\*\*/m, 'full Playwright must not be unpacked into production');
assert.match(builder, /!node_modules\/playwright-core\/\.local-browsers/);
for (const forbidden of [
  'app.asar.unpacked/node_modules/playwright/index.js',
  'app.asar.unpacked/node_modules/playwright-core/.local-browsers/chromium/chrome',
  'app.asar.unpacked/browser-profile/Cookies',
  'app.asar/tests/mock.json',
  'app.asar/fixtures/portal.html',
  'app.asar/data/claims.csv',
  'app.asar/logs/runtime.log',
  'app.asar/main.js.map',
  'app.asar/config.local.json'
]) assert.ok(prohibitedPackagePath(forbidden), `expected ${forbidden} to be rejected`);
assert.deepStrictEqual(auditPackagePaths(['app.asar/main.js', 'app.asar.unpacked/node_modules/playwright-core/package.json']), []);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-package-content-'));
try {
  fs.writeFileSync(path.join(fixture, 'safe.txt'), 'safe');
  fs.symlinkSync(path.join(fixture, 'safe.txt'), path.join(fixture, 'nested-link'));
  assert.throws(() => collectRelativePaths(fixture), /must not contain symbolic links/i);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
process.stdout.write('Package content allowlist and size budgets passed.\n');
