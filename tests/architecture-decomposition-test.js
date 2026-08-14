'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('index.html');
const css = read('renderer/base.css');
const main = read('main.js');
const renderer = read('renderer.js');
const submit = read('scripts/submit-claims.js');

assert.doesNotMatch(html, /<style\b/i, 'index.html must not own CSS');
assert.ok(html.indexOf('renderer/base.css') < html.indexOf('renderer/components.css'), 'stylesheet ownership order must be stable');
assert.ok((css.match(/!important/g) || []).length <= 567, 'legacy !important usage must not grow');
assert.doesNotMatch(main, /ipcMain\.handle\(/, 'main IPC registration must pass through focused ownership modules');
assert.match(main, /createFocusedRegistrar/);
assert.match(renderer, /RendererContext\.state/);
assert.match(renderer, /rendererEvents\.emit\('tab:changed'/);
for (const moduleName of ['navigation', 'form', 'outcome', 'browser-handshake', 'safety', 'diagnostics']) {
  assert.ok(fs.existsSync(path.join(root, 'lib', 'step3', `${moduleName}.js`)), `missing Step 3 ${moduleName} module`);
}
assert.doesNotMatch(submit, /function classifyClaimOutcome|function classifyAutomationFailure|function isFinalSubmissionLabel/);
assert.doesNotMatch(submit, /launchPersistentContext|launchClaimContext/);
process.stdout.write('Architecture decomposition and stylesheet ownership tests passed.\n');
