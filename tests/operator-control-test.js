'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateSubmitOptions } = require('../lib/input-validation');
const { buildPreflightReport } = require('../lib/preflight');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

const live = validateSubmitOptions({ dryRun: false, liveSubmissionConfirmed: false, browserMode: 'external' });
assert.strictEqual(live.browserMode, 'builtin');
assert.strictEqual(live.liveSubmissionConfirmed, false);

const report = buildPreflightReport({
  scope: 'step3', storageWritable: true, databaseIntegrity: { ok: true },
  webUsernameAvailable: true, webPasswordAvailable: true, claimAddressAvailable: true,
  claimCount: 1, builtinBrowserRequired: true, reconciliationCount: 1
});
assert.strictEqual(report.ready, true, 'reconciliation warnings should not block unrelated selected claims');
assert.strictEqual(report.warningCount, 1);

assert.match(main, /Live submission was not explicitly confirmed/);
assert.match(main, /await requestNativeAuthorization\(/, 'main process must require a second native live-submission confirmation');
assert.match(main, /step3QueueService\.createRunSnapshot/);
assert.doesNotMatch(main, /claims-selected-run-/);
assert.doesNotMatch(main, /writeSelectedClaimsCsv/);
assert.match(main, /registerIpcHandler\('preflight:run'/);
assert.match(main, /registerIpcHandler\('claims:preview'/);
assert.match(renderer, /selectedClassificationRecords: selectedClassificationRecords\(\)/);
assert.match(renderer, /confirmLiveSubmission/);
assert.match(preload, /runPreflight/);
assert.match(preload, /previewClaims/);

console.log('Step 3 operator-control tests passed.');
require('./live-submission-authorization-test');
