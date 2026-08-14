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

const live = validateSubmitOptions({ dryRun: true, browserMode: 'external' });
assert.strictEqual(live.browserMode, 'builtin');
assert.strictEqual(Object.hasOwn(live, 'dryRun'), false);

const report = buildPreflightReport({
  scope: 'step3', storageWritable: true, databaseIntegrity: { ok: true },
  webUsernameAvailable: true, webPasswordAvailable: true, claimAddressAvailable: true,
  claimCount: 1, builtinBrowserAvailable: true, reconciliationCount: 1
});
assert.strictEqual(report.ready, true, 'reconciliation warnings should not block unrelated selected claims');
assert.strictEqual(report.warningCount, 1);

assert.doesNotMatch(main, /Live submission was not explicitly confirmed|requestNativeAuthorization|LIVE_SUBMISSION_CANCELLED/);
assert.match(main, /step3QueueService\.createRunSnapshot/);
assert.doesNotMatch(main, /claims-selected-run-/);
assert.doesNotMatch(main, /writeSelectedClaimsCsv/);
assert.match(main, /registerIpcHandler\('preflight:run'/);
assert.match(main, /registerIpcHandler\('claims:preview'/);
assert.match(renderer, /selectedClassificationRecords: selectedClassificationRecords\(\)/);
assert.doesNotMatch(renderer, /confirmLiveSubmission|liveSubmitModal|liveSubmissionConfirmed/);
assert.match(preload, /runPreflight/);
assert.match(preload, /previewClaims/);

console.log('Step 3 operator-control tests passed.');
