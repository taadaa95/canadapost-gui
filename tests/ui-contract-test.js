'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const pkg = require('../package.json');

const requiredIds = [
  'historyTab', 'historySearch', 'historyStatusFilter', 'historyList',
  'reconciliationList', 'reconciliationBadge', 'reconciliationCountPill',
  'historyShipments', 'historySubmitted', 'historyReconciliation', 'historyFailed',
  'databaseIntegrity', 'createBackup', 'restoreBackup', 'createDiagnostics',
  'runSiteHealth', 'siteHealthResult', 'exportHistory', 'refreshHistory',
  'dryRun', 'builtinBrowserActivity', 'builtinBrowserActivityText', 'openStep3Diagnostics', 'addManualShipment', 'manualShipmentList'
];
for (const id of requiredIds) {
  assert.ok(html.includes(`id="${id}"`), `Missing UI element #${id}`);
}
assert.strictEqual(pkg.version, '0.3.6');
assert.ok(renderer.includes("$('createBackup')?.addEventListener"));
assert.ok(renderer.includes("$('runSiteHealth')?.addEventListener"));
assert.ok(renderer.includes("$('historySearch')?.addEventListener"));
assert.ok(/data-tab="historyTab"/.test(html));
assert.ok(/Dry run.+stop before final review or submission/i.test(html));
assert.ok(!html.includes('Reliability, Testing &amp; Retention'), 'Reliability settings section should be removed');
assert.ok(renderer.includes('function setBuiltinBrowserActivity'));
assert.ok(renderer.includes('onBrowserActivity'));
assert.ok(/browser-activity-track/.test(html), 'Missing dynamic browser loading bar');

assert.ok(renderer.includes("window.addEventListener('scroll', scheduleBuiltinBrowserReposition"), 'Built-in browser must track nested scroll events');
assert.ok(renderer.includes('new ResizeObserver(scheduleBuiltinBrowserReposition)'), 'Built-in browser must track slot size changes');
assert.ok(renderer.includes('window.visualViewport?.addEventListener'), 'Built-in browser must track visual viewport movement');

assert.ok(html.includes('save password securely on this device'));
assert.ok(html.includes('AES-256-GCM device-local encryption'));
assert.ok(renderer.includes('function setSiteHealthRunning'));
assert.ok(renderer.includes('Saved password available — leave blank to reuse'));

assert.ok(!html.includes('aria-label="Workflow summary"'), 'Obsolete workflow summary panel should be removed');
assert.ok(/\.step-tab \.notification-badge\.hidden\s*\{[^}]*display:\s*none\s*!important/s.test(html), 'Hidden notification badges must stay hidden');
assert.ok(/\.settings-section \.field\s*\{[^}]*border:\s*0\s*!important/s.test(html), 'Settings field wrappers must not draw boxes around labels');
console.log('UI contract tests passed.');

assert.ok(renderer.includes("$('openStep3Diagnostics')?.addEventListener"), 'Missing Step 3 diagnostics open action');
