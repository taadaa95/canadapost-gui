'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const claimDb = require('../lib/claim-database');
const inputValidation = require('../lib/input-validation');
const diagnosticSelection = require('../lib/tracking-diagnostic-selection');
const step3QueueService = require('../lib/step3-queue-service');

const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = source('index.html');
const renderer = source('renderer.js');
const preload = source('preload.js');
const main = source('main.js');
const history = html.match(/<section id="historyTab"[\s\S]*?<section id="resultsTab"/)?.[0] || '';
const step3 = html.match(/<section id="step3"[\s\S]*?<section id="historyTab"/)?.[0] || '';

assert.doesNotMatch(html, /Legacy Developer Program credentials|Legacy API username|Legacy API password|Legacy API environment/i);
assert.doesNotMatch(step3, /step3PreflightList|refreshStep3Preflight|Manual-review queue|On-time classification queue/i);
assert.doesNotMatch(history, /financialSummary|recordFinancialEntry|financialReportTitle|privacyDataTitle|privacyTrackingNumbers/i);
assert.strictEqual((html.match(/id="manageStoredData"/g) || []).length, 0);
assert.doesNotMatch(html, /id="privacyDataModal"/);
assert.doesNotMatch(html, /id="trackingDiagnosticModal"|id="trackingDiagnosticRow"/);
assert.doesNotMatch(step3, /id="dryRun"|id="builtinBrowser"|id="liveSubmitModal"|id="checkStep3BrowserSession"/);
assert.doesNotMatch(preload, /financial:get|financial:record|getFinancialReport|recordFinancialEntry/);
assert.doesNotMatch(renderer, /getFinancialReport|recordFinancialEntry|refreshFinancialReport|financialSummary/);
assert.doesNotMatch(main, /registerIpcHandler\('financial:(?:get|record)'/);
const configLoadHandler = main.match(/registerIpcHandler\('config:load'[\s\S]*?registerIpcHandler\('config:save'/)?.[0] || '';
const configSaveHandler = main.match(/registerIpcHandler\('config:save'[\s\S]*?registerIpcHandler\('credentials:clearTrackingApi'/)?.[0] || '';
assert.match(configLoadHandler, /delete publicConfig\.apiCredentialsStored/);
assert.match(configLoadHandler, /delete publicConfig\.apiCredentialEnvironment/);
assert.match(configSaveHandler, /delete sanitized\.apiEnvironment/);
assert.doesNotMatch(configSaveHandler, /input\.apiUsername|input\.apiPassword|saveApiCredentials/);
const trackingHandler = main.match(/registerIpcHandler\('tracking:run'[\s\S]*?registerIpcHandler\('submit:run'/)?.[0] || '';
assert.match(trackingHandler, /ensureTrackingApiCredentials/);
assert.doesNotMatch(trackingHandler, /ensureApiCredentialFiles|resolveApiCredentials|Basic|XML/);
assert.match(preload, /tracking:diagnosticDefaultRow/);
assert.match(renderer, /requestTrackingDiagnosticRow/);
assert.match(renderer, /runTrackingDiagnostic\(\{ structureExport: false \}\)/);
assert.match(renderer, /runTrackingDiagnostic\(\{ structureExport: true \}\)/);
assert.doesNotMatch(renderer, /function closeTrackingDiagnosticModal|function confirmTrackingDiagnosticRow/);
assert.match(main, /diagnosticMode = options\.diagnosticMode === true/);
assert.doesNotMatch(renderer, /function openPrivacyDataModal|function closePrivacyDataModal|deletePrivacyData/);
assert.match(main, /registerIpcHandler\('privacy:delete'/, 'internal privacy deletion service must remain available');
const startSubmitOnly = renderer.match(/async function startSubmitOnly\(\)[\s\S]*?async function refreshConfig/)?.[0] || '';
assert.ok(startSubmitOnly.indexOf('runStep3Preflight') < startSubmitOnly.indexOf('if (!selected.length)'), 'dry and live clicks must run main-process preflight before selection validation');
assert.match(main, /operationCoordinator\.assertInactive\(\)/);
assert.match(main, /function runPreflight/);
const submitHandler = main.match(/registerIpcHandler\('submit:run'[\s\S]*?registerIpcHandler\('run:requestStop'/)?.[0] || '';
assert.ok((submitHandler.match(/runPreflight\(\{ scope: 'step3'/g) || []).length >= 2, 'main must preflight and recheck immediately before snapshot creation');
assert.match(submitHandler, /selectionForRun/);
assert.match(submitHandler, /createRunSnapshot/);
assert.match(submitHandler, /MAX_CLAIMS: ''/);
assert.ok(submitHandler.indexOf('finalPreflight') < submitHandler.indexOf('createRunSnapshot'));

const rows = [{ 'Tracking PIN': '' }, { 'Tracking Number': 'SYNTHETIC-ROW-2' }, { PIN: 'SYNTHETIC-ROW-3' }];
assert.strictEqual(diagnosticSelection.firstUsableRow(rows), 2);
assert.deepStrictEqual(diagnosticSelection.validateRow(rows, 2), { row: 2, rowCount: 3 });
for (const invalid of [null, '', 0, 1, 1.5, 4, 'bad']) assert.throws(() => diagnosticSelection.validateRow(rows, invalid), /valid tracking\.csv row/);

const selected = [{ recordId: 1 }, { recordId: 2 }];
assert.deepStrictEqual(step3QueueService.selectionForRun(selected), selected, 'all selected candidates must remain in deterministic order');
assert.strictEqual(Object.hasOwn(inputValidation.validateSubmitOptions({ dryRun: true }), 'dryRun'), false, 'product submission options must not expose dry-run mode');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-dev9-schema-'));
try {
  const dbPath = path.join(tempRoot, 'app.sqlite');
  claimDb.initializeDatabase(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.strictEqual(Number(db.prepare('PRAGMA user_version').get().user_version), 8);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'financial_entries'").get(), 'historical financial table must remain compatible');
  } finally { db.close(); }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.stdout.write('Dev.9 UI-debloat contracts passed.\n');
