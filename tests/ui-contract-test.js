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
  'historyTab', 'historySearch', 'historyStatusFilter', 'historyList',
  'reconciliationList', 'reconciliationCountPill', 'historyResultCount', 'clearHistoryFilters',
  'historyShipments', 'historySubmitted', 'historyReconciliation', 'historyFailed',
  'databaseIntegrity', 'createBackup', 'restoreBackup', 'createDiagnostics',
  'exportHistory', 'refreshHistory',
  'dryRun', 'claimQueueList', 'step3ActionAdvisory', 'liveSubmitModal', 'liveSubmitCanary', 'builtinBrowserActivity', 'builtinBrowserActivityText', 'openStep3Diagnostics', 'addManualShipment', 'manualShipmentList', 'refreshBrowserSession', 'clearBrowserSession', 'browserSessionStatus', 'checkStep3BrowserSession', 'step3BrowserSessionStatus', 'setupWizard', 'setupReadinessList', 'setupFinish', 'claimQueueDateFrom', 'claimQueueDateTo',
  'trackingClientId', 'trackingClientSecret', 'trackingApiEnvironment', 'trackingRequestDelayMs', 'trackingResourceTimeoutMs', 'trackingApiCredentialMetadata', 'trackingDiagnosticGate', 'clearTrackingApiCredentials',
  'testTrackingConnection', 'exportTrackingStructure', 'discardIncompleteTracking',
  'trackingDiagnosticModal', 'trackingDiagnosticRow', 'step1JumpLatest', 'step2JumpLatest', 'step3JumpLatest',
  'selectAllClaims', 'clearClaimSelection', 'manageStoredData', 'privacyDataModal', 'privacyDataTitle', 'privacyTrackingNumbers',
  'privacyDateFrom', 'privacyDateTo', 'privacyAllRecords', 'previewPrivacyData',
  'privacyPreviewCounts', 'privacyDestructiveConfirm', 'privacyTypedPhrase',
  'privacySecondConfirm', 'deletePrivacyData'
];
for (const id of requiredIds) {
  assert.ok(html.includes(`id="${id}"`), `Missing UI element #${id}`);
}
assert.strictEqual(pkg.version, '0.4.0-beta.1');
assert.ok(!preload.includes("note.id = 'step3CanadaPostSupport'"), 'Preload must not construct Step 3 support UI');
assert.ok(!preload.includes('document.createElement'), 'Preload must remain a narrow IPC bridge');
assert.ok(englishLocale['step3.supportGuidance'].includes('1-888-550-6333'), 'Missing Canada Post customer-service number');
assert.ok(englishLocale['step3.supportGuidance'].includes('Unsure about a claim?'), 'Missing Step 3 claim-verification guidance');
assert.match(html, /data-i18n="step3\.supportGuidance"/);
assert.ok(renderer.includes("$('createBackup')?.addEventListener"));
assert.ok(renderer.includes("$('clearBrowserSession')?.addEventListener"));
assert.ok(renderer.includes("$('historySearch')?.addEventListener"));
assert.ok(renderer.includes("$('clearHistoryFilters')?.addEventListener"));
assert.ok(renderer.includes('Object.assign(historyViewState, HISTORY_DEFAULT_FILTERS)'));
assert.ok(!html.includes('id="reconciliationBadge"'), 'History tab must not contain a notification badge');
assert.ok(!renderer.includes("$('reconciliationBadge')"), 'Renderer must not update a removed History badge');
const historyTabMarkup = html.match(/<button id="tabHistory"[^>]*>([\s\S]*?)<\/button>/)?.[1] || '';
assert.match(historyTabMarkup, /data-i18n="nav\.history\.title"/);
assert.match(historyTabMarkup, /data-i18n="nav\.history\.detail"/, 'History tab must contain only its localized normal label');
assert.ok(/id="tabResults"[^>]*>[\s\S]*?id="notificationsBadge"/.test(html), 'Results notification indicator must remain unchanged');
assert.ok(/data-tab="historyTab"/.test(html));
assert.match(html, /data-i18n="step3\.dryRun"/);
assert.match(englishLocale['step3.dryRun'], /Dry run.+stop before final review or submission/i);
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
assert.ok(renderer.includes('function testTrackingConnection'));
assert.ok(renderer.includes('function clearTrackingApiCredentials'));
assert.ok(!renderer.includes('OVERDUE / NOT DELIVERED'), 'Delivered and overdue status text must not use the contradictory legacy label');
assert.ok(renderer.includes('first qualifying code'), 'Semantic diagnostic must report first-attempt evidence without shipment descriptions');
assert.ok(main.includes('validatePromotedTrackingSummary'), 'Step 3 authority must require proof of a fully promoted Step 2 traversal');
assert.match(html, /data-i18n="settings\.api\.clientId"/);
assert.match(englishLocale['settings.api.clientId'], /Tracking API 2\.0 platform client ID/i);
assert.doesNotMatch(html, /Legacy Developer Program credentials|Legacy API username|Legacy API password/i);
assert.match(html, /data-i18n="step2\.diagnostic\.message"/);
assert.match(englishLocale['step2.diagnostic.message'], /does not modify claim state/i);
assert.ok(!/client (?:ID|secret).{0,80}(?:length|characters)/i.test(html), 'Current credential metadata must not disclose secret lengths');
assert.ok(/scrollbar-gutter:\s*stable both-edges/.test(styles));

assert.ok(renderer.includes("window.addEventListener('scroll', scheduleBuiltinBrowserReposition"), 'Built-in browser must track nested scroll events');
assert.ok(renderer.includes("new ResizeObserver(() => requestBuiltinBrowserLayout('browser-slot-resize'))"), 'Built-in browser must force a fresh slot measurement after size changes');
assert.ok(renderer.includes('window.visualViewport?.addEventListener'), 'Built-in browser must track visual viewport movement');

assert.ok(englishLocale['settings.website.remember'].includes('save password securely on this device'));
assert.ok(englishLocale['settings.website.securityNote'].includes('AES-256-GCM device-local encryption'));
assert.ok(englishLocale['settings.website.passwordSavedPlaceholder'].includes('Saved password available — leave blank to reuse'));

assert.doesNotMatch(`${html}\n${renderer}\n${preload}\n${main}`, /runSiteHealth|siteHealth:run|portalCompatibility|portal-compatibility/,
  'health-check and portal-compatibility plumbing must be absent');
assert.doesNotMatch(html, /manualReviewList|manualReviewCountPill|Eligibility Manual Review/,
  'eligibility manual-review panel must be absent');
assert.doesNotMatch(`${renderer}\n${preload}\n${main}`, /listManualReviews|updateManualReview|manualReview:list|manualReview:update/,
  'eligibility manual-review renderer and IPC APIs must be absent');
const historyMarkup = html.match(/<section id="historyTab"[\s\S]*?<\/section>/)?.[0] || '';
assert.ok(historyMarkup.includes('id="refreshBrowserSession"'), 'Browser-session safety controls must remain after UI removal');
assert.ok(!/<div class="history-toolbar"[^>]*>\s*<\/div>/.test(historyMarkup), 'Health-check removal must not leave an empty toolbar');
assert.ok(!html.includes('id="step3PreflightModal"'), 'The blocking Step 3 preflight modal must be removed');

assert.ok(!html.includes('aria-label="Workflow summary"'), 'Obsolete workflow summary panel should be removed');
assert.ok(/\.step-tab \.notification-badge\.hidden\s*\{[^}]*display:\s*none/s.test(styles), 'Hidden notification badges must stay hidden');
assert.doesNotMatch(styles, /\.field,\s*\.checkbox-field,/, 'Standard field wrappers must not share the boxed checkbox-panel treatment');
assert.ok(/\.field:not\(\.checkbox-field\) label\s*\{[^}]*padding:\s*0 2px/s.test(styles), 'Standard field labels must remain plain text above their controls');
assert.ok(/input, select, textarea\s*\{[^}]*border:\s*1px solid var\(--line\)/s.test(styles), 'Interactive form controls must retain their borders');
assert.ok(/\.settings-section > button,[\s\S]*?\.settings-footer-actions > button\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*180px;[^}]*justify-self:\s*start/s.test(styles), 'Settings actions must size to their content instead of stretching across their cards');
const stepTabs = [...html.matchAll(/<button id="tab(?:Settings|Step1|Step2|Step3|History|Results)"[^>]*>([\s\S]*?)<\/button>/g)];
assert.strictEqual(stepTabs.length, 6, 'All six workflow tabs must use the shared tab structure');
for (const [, tabMarkup] of stepTabs) {
  assert.match(tabMarkup, /class="step-tab-title"/, 'Workflow tab title must use the title layout hook');
  assert.match(tabMarkup, /class="step-tab-detail"/, 'Workflow tab subtitle must use the detail layout hook');
  assert.doesNotMatch(tabMarkup, /<br\s*\/?\s*>/i, 'Workflow tab layout must not depend on an extra flex line-break element');
}
assert.ok(/\.step-tab,[\s\S]*?\.step-tab\.active\s*\{[^}]*justify-content:\s*center\s*!important;[^}]*gap:\s*4px\s*!important/s.test(styles), 'Workflow tab text must remain vertically centred with explicit title/subtitle spacing');
console.log('UI contract tests passed.');
require('./workflow-access-test');

assert.ok(renderer.includes("$('openStep3Diagnostics')?.addEventListener"), 'Missing Step 3 diagnostics open action');

assert.ok(renderer.includes('function refreshClaimQueue'), 'Missing Step 3 claim review queue');
assert.ok(renderer.includes('function runStep3Preflight'), 'Missing Step 3 preflight');
assert.ok(renderer.includes('function confirmLiveSubmission'), 'Missing explicit live submission confirmation');
assert.ok(renderer.includes('selectedClassificationRecords'), 'Step 3 selection must use stable database classification records');
assert.ok(/id="builtinBrowser"[^>]*checked[^>]*disabled/.test(html), 'Built-in browser must be mandatory for Step 3');
