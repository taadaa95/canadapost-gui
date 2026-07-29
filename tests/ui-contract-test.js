'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const pkg = require('../package.json');

const requiredIds = [
  'historyTab', 'historySearch', 'historyStatusFilter', 'historyList',
  'reconciliationList', 'reconciliationBadge', 'reconciliationCountPill',
  'historyShipments', 'historySubmitted', 'historyReconciliation', 'historyFailed',
  'databaseIntegrity', 'createBackup', 'restoreBackup', 'createDiagnostics',
  'runSiteHealth', 'siteHealthResult', 'exportHistory', 'refreshHistory',
  'dryRun', 'canaryMode', 'step3PreflightList', 'claimQueueList', 'liveSubmitModal', 'builtinBrowserActivity', 'builtinBrowserActivityText', 'openStep3Diagnostics', 'addManualShipment', 'manualShipmentList', 'refreshBrowserSession', 'clearBrowserSession', 'browserSessionStatus', 'setupWizard', 'setupReadinessList', 'setupFinish', 'financialSummary', 'recordFinancialEntry', 'claimQueueDateFrom', 'claimQueueDateTo', 'step3ManualQueue', 'step3IneligibleQueue'
  , 'apiUsername', 'apiPassword', 'apiEnvironment', 'apiCredentialMetadata',
  'trackingClientId', 'trackingClientSecret', 'trackingApiEnvironment', 'trackingRequestDelayMs', 'trackingResourceTimeoutMs', 'trackingApiCredentialMetadata', 'trackingDiagnosticGate', 'clearTrackingApiCredentials',
  'testTrackingConnection', 'exportTrackingStructure', 'discardIncompleteTracking',
  'diagnosticRow', 'step1JumpLatest', 'step2JumpLatest', 'step3JumpLatest'
];
for (const id of requiredIds) {
  assert.ok(html.includes(`id="${id}"`), `Missing UI element #${id}`);
}
assert.strictEqual(pkg.version, '0.4.0-dev.1');
assert.ok(renderer.includes("$('createBackup')?.addEventListener"));
assert.ok(renderer.includes("$('clearBrowserSession')?.addEventListener"));
assert.ok(renderer.includes("$('runSiteHealth')?.addEventListener"));
assert.ok(renderer.includes("$('historySearch')?.addEventListener"));
assert.ok(/data-tab="historyTab"/.test(html));
assert.ok(/Dry run.+stop before final review or submission/i.test(html));
assert.ok(!html.includes('Reliability, Testing &amp; Retention'), 'Reliability settings section should be removed');
assert.ok(renderer.includes('function setBuiltinBrowserActivity'));
assert.ok(renderer.includes('onBrowserActivity'));
assert.ok(/browser-activity-track/.test(html), 'Missing dynamic browser loading bar');
assert.ok(main.includes("completed.outcome === 'EMPTY'"), 'Main process must treat a structured empty EST result as complete.');
assert.ok(main.includes("status: 'complete', message: 'Completed — no EST orders found for the selected date range.'"), 'Main process must not classify an empty EST result as failed.');
assert.ok(renderer.includes("event.outcome === 'EMPTY'"), 'Renderer must recognize a structured empty EST result.');
assert.ok(main.includes('tracking_circuit_open'), 'Main process must surface the tracking circuit-breaker error.');
assert.ok(main.includes("status: blocked ? 'blocked' : 'failed'"), 'Circuit-open and semantic-failure tracking runs must be blocked, not complete.');
assert.ok(!/stdinJson:\s*\{\s*username:\s*webUsername,\s*password:\s*webPassword\s*\}[\s\S]{0,160}['"]tracking['"]/.test(main), 'Website credentials must not be sent to the tracking worker.');
assert.ok(renderer.includes('MAX_VISIBLE_LOG_LINES = 2000'));
assert.ok(renderer.includes('isLogNearBottom'));
assert.ok(renderer.includes('function jumpToLatest'));
assert.ok(renderer.includes('function testTrackingConnection'));
assert.ok(renderer.includes('function clearTrackingApiCredentials'));
assert.ok(!renderer.includes('OVERDUE / NOT DELIVERED'), 'Delivered and overdue status text must not use the contradictory legacy label');
assert.ok(renderer.includes('first qualifying code'), 'Semantic diagnostic must report first-attempt evidence without shipment descriptions');
assert.ok(main.includes('validatePromotedTrackingSummary'), 'Step 3 authority must require proof of a fully promoted Step 2 traversal');
assert.match(html, /Tracking API 2\.0 platform client ID/i);
assert.match(html, /Legacy Developer Program credentials[^<]*— deprecated/i);
assert.match(html, /does not modify claim state/i);
assert.ok(!/client (?:ID|secret).{0,80}(?:length|characters)/i.test(html), 'Current credential metadata must not disclose secret lengths');
assert.ok(/scrollbar-gutter:\s*stable both-edges/.test(html));

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

assert.ok(renderer.includes('function refreshClaimQueue'), 'Missing Step 3 claim review queue');
assert.ok(renderer.includes('function runStep3Preflight'), 'Missing Step 3 preflight');
assert.ok(renderer.includes('function confirmLiveSubmission'), 'Missing explicit live submission confirmation');
assert.ok(/id="builtinBrowser"[^>]*checked[^>]*disabled/.test(html), 'Built-in browser must be mandatory for Step 3');
