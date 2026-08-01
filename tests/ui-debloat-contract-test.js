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
assert.doesNotMatch(step3, /step3PreflightList|refreshStep3Preflight|Manual-review queue|On-time classification queue|id="canaryMode"/i);
assert.doesNotMatch(history, /financialSummary|recordFinancialEntry|financialReportTitle|privacyDataTitle|privacyTrackingNumbers/i);
assert.strictEqual((html.match(/id="manageStoredData"/g) || []).length, 1);
assert.match(html, /id="privacyDataModal" class="modal-backdrop hidden"/);
assert.match(html, /id="trackingDiagnosticModal" class="modal-backdrop hidden"/);
assert.match(html, /id="trackingDiagnosticRow"[^>]*type="number"/);
assert.match(html, /id="liveSubmitCanary"[^>]*checked/);
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
assert.match(renderer, /function closeTrackingDiagnosticModal/);
assert.match(renderer, /function openPrivacyDataModal/);
assert.match(renderer, /function closePrivacyDataModal/);
assert.match(renderer, /operationActive|deletePrivacyData/);
const startSubmitOnly = renderer.match(/async function startSubmitOnly\(\)[\s\S]*?async function refreshConfig/)?.[0] || '';
assert.ok(startSubmitOnly.indexOf('runStep3Preflight') < startSubmitOnly.indexOf('if (!selected.length)'), 'dry and live clicks must run main-process preflight before selection validation');
assert.match(main, /operationCoordinator\.assertInactive\(\)/);
assert.match(main, /function runPreflight/);
const submitHandler = main.match(/registerIpcHandler\('submit:run'[\s\S]*?registerIpcHandler\('run:requestStop'/)?.[0] || '';
assert.ok((submitHandler.match(/runPreflight\(\{ scope: 'step3'/g) || []).length >= 2, 'main must preflight and recheck immediately before snapshot creation');
assert.match(submitHandler, /selectionForRun/);
assert.match(submitHandler, /createRunSnapshot/);
assert.match(submitHandler, /MAX_CLAIMS: effectiveCanaryMode \? '1' : ''/);
assert.ok(submitHandler.indexOf('finalPreflight') < submitHandler.indexOf('createRunSnapshot'));

const rows = [{ 'Tracking PIN': '' }, { 'Tracking Number': 'SYNTHETIC-ROW-2' }, { PIN: 'SYNTHETIC-ROW-3' }];
assert.strictEqual(diagnosticSelection.firstUsableRow(rows), 2);
assert.deepStrictEqual(diagnosticSelection.validateRow(rows, 2), { row: 2, rowCount: 3 });
for (const invalid of [null, '', 0, 1, 1.5, 4, 'bad']) assert.throws(() => diagnosticSelection.validateRow(rows, invalid), /valid tracking\.csv row/);

const selected = [{ recordId: 1 }, { recordId: 2 }];
assert.deepStrictEqual(step3QueueService.selectionForRun(selected, { dryRun: false, canaryMode: true }), [{ recordId: 1 }]);
assert.deepStrictEqual(step3QueueService.selectionForRun(selected, { dryRun: false, canaryMode: false }), selected);
assert.deepStrictEqual(step3QueueService.selectionForRun(selected, { dryRun: true, canaryMode: true }), selected, 'canary must not silently limit a dry run');
assert.throws(() => inputValidation.validateSubmitOptions({ canaryMode: 'true' }), error => error.code === 'SUBMIT_CANARY_INVALID');

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
