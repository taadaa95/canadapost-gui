'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const allowlist = require('../config/package-content-allowlist.json');

const root = path.resolve(__dirname, '..');
const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
assert.ok(!/^\s*- mock-portal\/\*\*/m.test(builder), 'the mock portal must not be packaged in production');
assert.ok(!/^\s*- tests\//m.test(builder), 'tests must not be packaged in production');
for (const script of allowlist.runtimeScripts) assert.ok(builder.includes(`scripts/${script}`), `runtime script ${script} must be explicitly packaged`);
for (const excluded of allowlist.excludedProductionRoots) assert.ok(!allowlist.allowedRoots.includes(excluded), `${excluded} must not be an allowed production root`);
assert.ok(allowlist.artifactSizeBudgets['linux-x64-appimage'] > 0);
assert.ok(allowlist.artifactSizeBudgets['windows-x64-nsis'] > 0);
process.stdout.write('Package content allowlist and size budgets passed.\n');
