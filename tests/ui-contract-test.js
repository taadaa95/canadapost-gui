'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'base.css'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const englishLocale = require('../locales/en-CA.json');
const pkg = require('../package.json');

const requiredIds = [
  'historyTab', 'historyList', 'historyResultCount',
  'historySubmitted', 'historyNeedsAttention', 'historyRecordTotal',
  'exportHistory', 'refreshHistory',
  'claimQueueList', 'step3ActionAdvisory', 'builtinBrowserActivity', 'builtinBrowserActivityText', 'step3AutomationNotice', 'step3AutomationNoticeStatus', 'openStep3Diagnostics', 'setupWizard', 'setupReadinessList', 'setupFinish',
  'trackingClientId', 'trackingClientSecret', 'clearTrackingApiCredentials',
  'forceStopStep1', 'step1JumpLatest', 'step3JumpLatest',
  'selectAllClaims', 'clearClaimSelection'
];
for (const id of requiredIds) {
  assert.ok(html.includes(`id="${id}"`), `Missing UI element #${id}`);
}
assert.strictEqual(pkg.version, '0.4.4');
assert.doesNotMatch(`${html}\n${renderer}\n${preload}\n${main}`, /unsigned beta|beta channel|release channel|signing key/i,
  'normal update UI must not expose beta, channel, or signing-key messaging');
assert.ok(!preload.includes("note.id = 'step3CanadaPostSupport'"), 'Preload must not construct Step 3 support UI');
assert.ok(!preload.includes('document.createElement'), 'Preload must remain a narrow IPC bridge');
assert.ok(englishLocale['step3.supportGuidance'].includes('1-888-550-6333'), 'Missing Canada Post customer-service number');
assert.ok(englishLocale['step3.supportGuidance'].includes('Unsure about a claim?'), 'Missing Step 3 claim-verification guidance');
assert.match(html, /data-i18n="step3\.supportGuidance"/);
assert.ok(!renderer.includes("$('createBackup')?.addEventListener"));
assert.ok(!renderer.includes("$('clearStep3BrowserSession')?.addEventListener"));
assert.ok(!html.includes('id="reconciliationBadge"'), 'History tab must not contain a notification badge');
assert.ok(!renderer.includes("$('reconciliationBadge')"), 'Renderer must not update a removed History badge');
const historyTabMarkup = html.match(/<button id="tabHistory"[^>]*>([\s\S]*?)<\/button>/)?.[1] || '';
assert.match(historyTabMarkup, /data-i18n="nav\.history\.title"/);
assert.match(historyTabMarkup, /data-i18n="nav\.history\.detail"/, 'History tab must contain only its localized normal label');
assert.ok(/id="tabResults"[^>]*>[\s\S]*?id="notificationsBadge"[^>]*aria-hidden="true"[^>]*hidden/.test(html), 'Results notification indicator must start explicitly hidden');
assert.ok(/data-tab="historyTab"/.test(html));
for (const removed of ['dryRun', 'builtinBrowser', 'liveSubmitModal', 'checkStep3BrowserSession', 'claimQueueSearch', 'claimQueueServiceFilter', 'claimQueueUrgencyFilter', 'claimQueueDateFrom', 'claimQueueDateTo']) {
  assert.ok(!html.includes(`id="${removed}"`), `Removed Step 3 control #${removed} must stay absent`);
}
assert.match(englishLocale['step3.queue.candidateCount'], /\{count\} candidates/);
assert.doesNotMatch(englishLocale['step3.queue.candidateCount'], /blocked|executable/i,
  'normal queue count must describe only visible actionable candidates');
assert.ok(!html.includes('Reliability, Testing &amp; Retention'), 'Reliability settings section should be removed');
assert.ok(renderer.includes('function setBuiltinBrowserActivity'));
assert.ok(renderer.includes('onBrowserActivity'));
assert.ok(/browser-activity-track/.test(html), 'Missing dynamic browser loading bar');
assert.ok(main.includes("completed.outcome === 'EMPTY'"), 'Main process must treat a structured empty EST result as complete.');
assert.match(main, /status: 'complete', messageKey: 'event\.est\.empty'/, 'Main process must not classify an empty EST result as failed.');
assert.ok(renderer.includes("event.outcome === 'EMPTY'"), 'Renderer must recognize a structured empty EST result.');
assert.ok(main.includes('tracking_circuit_open'), 'Main process must surface the tracking circuit-breaker error.');
assert.ok(main.includes("status: blocked ? 'blocked' : 'failed'"), 'Circuit-open and semantic-failure tracking runs must be blocked, not complete.');
assert.ok(!/stdinJson:\s*\{\s*username:\s*webUsername,\s*password:\s*webPassword\s*\}[\s\S]{0,160}['"]tracking['"]/.test(main), 'Website credentials must not be sent to the tracking worker.');
assert.ok(renderer.includes('MAX_VISIBLE_LOG_LINES = 2000'));
assert.ok(renderer.includes('isLogNearBottom'));
assert.ok(renderer.includes('function jumpToLatest'));
assert.ok(renderer.includes('function testTrackingConnection'), 'Callable diagnostic support must remain available outside the normal-user UI');
assert.ok(renderer.includes('function clearTrackingApiCredentials'));
assert.ok(!renderer.includes('OVERDUE / NOT DELIVERED'), 'Delivered and overdue status text must not use the contradictory legacy label');
assert.ok(renderer.includes('first qualifying code'), 'Semantic diagnostic must report first-attempt evidence without shipment descriptions');
assert.ok(main.includes('validatePromotedTrackingSummary'), 'Step 3 authority must require proof of a fully promoted Step 2 traversal');
assert.match(html, /data-i18n="settings\.api\.clientId"/);
assert.match(englishLocale['settings.api.clientId'], /Tracking API 2\.0 platform client ID/i);
assert.doesNotMatch(html, /Legacy Developer Program credentials|Legacy API username|Legacy API password/i);
for (const removedId of ['freshTracking', 'testTrackingConnection', 'exportTrackingStructure', 'discardIncompleteTracking', 'trackingDiagnosticModal', 'trackingDiagnosticRow', 'trackingDiagnosticGate']) {
  assert.ok(!html.includes(`id="${removedId}"`), `Removed Step 2 product control #${removedId} must stay absent`);
}
for (const removedKey of ['step2.freshRun', 'step2.testConnection', 'step2.exportStructure', 'step2.discardIncomplete', 'step2.diagnostic.title', 'step2.diagnostic.message', 'step2.diagnostic.rowLabel']) {
  assert.ok(!html.includes(`data-i18n="${removedKey}"`), `Removed Step 2 product copy ${removedKey} must stay absent`);
}
assert.doesNotMatch(html, /id="runTrackingOnly"/);
assert.match(html, /id="forceStopStep1"[^>]*data-force-stop="step1"/);
assert.doesNotMatch(html, /id="forceStopStep2"/);
assert.match(main, /const diagnosticMode = options\.diagnosticMode === true/);
assert.match(preload, /tracking:diagnosticDefaultRow/);
assert.ok(!/client (?:ID|secret).{0,80}(?:length|characters)/i.test(html), 'Current credential metadata must not disclose secret lengths');
assert.ok(/scrollbar-gutter:\s*stable both-edges/.test(styles));

assert.ok(renderer.includes("window.addEventListener('scroll', scheduleBuiltinBrowserReposition"), 'Built-in browser must track nested scroll events');
assert.ok(renderer.includes("new ResizeObserver(() => requestBuiltinBrowserLayout('browser-slot-resize'))"), 'Built-in browser must force a fresh slot measurement after size changes');
assert.ok(renderer.includes('window.visualViewport?.addEventListener'), 'Built-in browser must track visual viewport movement');

assert.strictEqual(englishLocale['settings.website.remember'], 'Remember me');
assert.strictEqual(englishLocale['settings.website.passwordSavedPlaceholder'], englishLocale['settings.website.passwordPlaceholder']);
assert.match(html, /id="trackingClientId"[^>]*type="password"/);
assert.match(renderer, /const SAVED_SECRET_MASK = '••••••••'/);

assert.doesNotMatch(`${html}\n${renderer}\n${preload}\n${main}`, /runSiteHealth|siteHealth:run|portalCompatibility|portal-compatibility/,
  'health-check and portal-compatibility plumbing must be absent');
assert.doesNotMatch(html, /manualReviewList|manualReviewCountPill|Eligibility Manual Review/,
  'eligibility manual-review panel must be absent');
assert.doesNotMatch(`${renderer}\n${preload}\n${main}`, /listManualReviews|updateManualReview|manualReview:list|manualReview:update/,
  'eligibility manual-review renderer and IPC APIs must be absent');
const historyMarkup = html.match(/<section id="historyTab"[\s\S]*?<\/section>/)?.[0] || '';
for (const removedId of [
  'historySearch', 'clearHistoryFilters', 'reconciliationList',
  'reconciliationCountPill', 'addManualShipment', 'manualShipmentList',
  'historyClassificationList', 'refreshBrowserSession', 'clearBrowserSession', 'browserSessionStatus'
]) assert.ok(!historyMarkup.includes(`id="${removedId}"`), `History must not retain #${removedId}`);
assert.strictEqual((historyMarkup.match(/id="historyStatusFilter"/g) || []).length, 1, 'History must contain exactly one simple status filter');
assert.doesNotMatch(historyMarkup, /Reconciliation Queue|Manually add|classification records/i);
const settingsMarkup = html.match(/<section id="settingsTab"[\s\S]*?<section id="step1"/)?.[0] || '';
for (const id of ['trackingApiEnvironment', 'createBackup', 'restoreBackup', 'manageStoredData', 'createDiagnostics']) {
  assert.ok(!settingsMarkup.includes(`id="${id}"`), `${id} must not appear in customer Settings`);
}
assert.doesNotMatch(settingsMarkup, /advancedSettingsTitle|class="[^"]*advanced-settings/);
assert.match(settingsMarkup, /id="checkForUpdates"/);
assert.doesNotMatch(settingsMarkup, /settings\.website\.securityNote/);
assert.doesNotMatch(settingsMarkup, /settings\.api\.(?:advanced|metadataPending|accessNote)/);
assert.doesNotMatch(settingsMarkup, /id="trackingRequestDelayMs"|id="trackingResourceTimeoutMs"|id="trackingApiCredentialMetadata"/);
assert.doesNotMatch(`${renderer}\n${preload}`, /listReconciliation|listClassificationQueue|listManualShipments|addManualShipment/,
  'removed History-only preload and renderer APIs must not remain exposed');
assert.doesNotMatch(main, /registerIpcHandler\('(reconciliation:list|classification:list|shipment:listManual|shipment:manualAdd)'/,
  'removed History-only IPC handlers must not remain exposed');
assert.doesNotMatch(renderer, /reconciliationActionButton|Mark submitted|Mark not submitted|Approve retry/,
  'History must not expose reconciliation mutation actions');
assert.match(renderer, /function renderHistory[\s\S]*?history\.viewEvidence/,
  'History evidence rendering must remain available');
assert.match(preload, /reconcileAttempt/);
assert.match(main, /reconciliation:update/);
assert.ok(!html.includes('id="step3PreflightModal"'), 'The blocking Step 3 preflight modal must be removed');

assert.ok(!html.includes('aria-label="Workflow summary"'), 'Obsolete workflow summary panel should be removed');
assert.ok(!html.includes('id="buildTrustStatus"'), 'The visible build-trust badge must be absent');
assert.ok(!renderer.includes("$('buildTrustStatus')"), 'Renderer must not update the removed build-trust badge');
assert.ok(!Object.hasOwn(englishLocale, 'build.unsigned'));
assert.match(html, /id="appTitle"[^>]*data-i18n="app\.title"/);
assert.match(html, /id="appSubtitle"[^>]*data-i18n="app\.subtitle"/);
assert.ok(/\.step-tab \.notification-badge\.hidden\s*\{[^}]*display:\s*none/s.test(styles), 'Hidden notification badges must stay hidden');
assert.doesNotMatch(styles, /\.checkbox-field/, 'Removed Step 3 checkbox-panel styling must not remain');
assert.ok(/\.field label\s*\{[^}]*padding:\s*0 2px/s.test(styles), 'Standard field labels must remain plain text above their controls');
assert.ok(/input, select, textarea\s*\{[^}]*border:\s*1px solid var\(--line\)/s.test(styles), 'Interactive form controls must retain their borders');
assert.ok(/\.settings-section > button,[\s\S]*?\.settings-footer-actions > button\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*180px;[^}]*justify-self:\s*start/s.test(styles), 'Settings actions must size to their content instead of stretching across their cards');
const stepTabs = [...html.matchAll(/<button id="tab(?:Settings|Step1|Step3|History|Results)"[^>]*>([\s\S]*?)<\/button>/g)];
assert.strictEqual(stepTabs.length, 5, 'Settings, two workflow steps, History, and Results must remain');
assert.ok(!html.includes('id="tabStep2"'));
assert.strictEqual(englishLocale['nav.step3.title'], 'Step 2');
assert.match(renderer, /function mergeTrackingIntoStep1/);
for (const [, tabMarkup] of stepTabs) {
  assert.match(tabMarkup, /class="step-tab-title"/, 'Workflow tab title must use the title layout hook');
  assert.match(tabMarkup, /class="step-tab-detail"/, 'Workflow tab subtitle must use the detail layout hook');
  assert.doesNotMatch(tabMarkup, /<br\s*\/?\s*>/i, 'Workflow tab layout must not depend on an extra flex line-break element');
}
assert.ok(/\.step-tab,[\s\S]*?\.step-tab\.active\s*\{[^}]*justify-content:\s*center\s*!important;[^}]*gap:\s*4px\s*!important/s.test(styles), 'Workflow tab text must remain vertically centred with explicit title/subtitle spacing');
for (const id of ['importEstHistory', 'forceStopStep1', 'runSubmitOnly', 'stop', 'forceStopStep3']) {
  assert.match(html, new RegExp(`id="${id}"[^>]*class="[^"]*step-execution-control`), `${id} must use the shared execution-control class`);
}
assert.match(styles, /\.step-execution-control\s*\{[^}]*min-width:\s*108px\s*!important;[^}]*height:\s*48px\s*!important;/s);
assert.match(styles, /#step1 \.step-execution-control,[\s\S]*?#step3 \.step-execution-control\s*\{[^}]*width:\s*auto\s*!important;[^}]*min-width:\s*108px\s*!important;[^}]*height:\s*48px\s*!important;/s);
for (const id of ['selectCsv', 'openData', 'openLogs', 'fullRefresh', 'clearStep3BrowserSession']) {
  assert.ok(!html.includes(`id="${id}"`), `Removed customer utility #${id} must stay absent`);
}
assert.match(html, /id="step3AutomationNotice"[^>]*role="note"/);
for (const key of ['step3.automation.title', 'step3.automation.description', 'step3.automation.exceptions']) {
  assert.ok(Object.hasOwn(englishLocale, key), `Missing automated-browser localization ${key}`);
}
assert.match(englishLocale['step3.automation.exceptions'], /Do not click, type, scroll or navigate/);
assert.match(englishLocale['step3.automation.exceptions'], /login, verification or CAPTCHA/);
console.log('UI contract tests passed.');
require('./workflow-access-test');

assert.ok(renderer.includes("$('openStep3Diagnostics')?.addEventListener"), 'Missing Step 3 diagnostics open action');

assert.ok(renderer.includes('function refreshClaimQueue'), 'Missing Step 3 claim review queue');
assert.ok(renderer.includes('function runStep3Preflight'), 'Missing Step 3 preflight');
assert.ok(!renderer.includes('function confirmLiveSubmission'), 'Step 3 must not add a second submission confirmation');
assert.ok(renderer.includes('selectedClassificationRecords'), 'Step 3 selection must use stable database classification records');
assert.match(html, /class="step-workspace step3-workspace"/, 'The built-in browser workspace must be present in Step 3');
