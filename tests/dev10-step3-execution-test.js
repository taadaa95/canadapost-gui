'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claimDb = require('../lib/claim-database');
const { classifyEligibility } = require('../lib/policy-engine');
const service = require('../lib/step3-queue-service');
const queueUi = require('../renderer/step3-queue');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-dev10-step3-'));
const dbPath = path.join(root, 'app.sqlite');

function candidate(runId, trackingNumber) {
  const input = {
    trackingNumber,
    referenceNumber: `REF-${trackingNumber}`,
    serviceCode: 'DOM.XP',
    destinationProvince: 'ON',
    destinationPostalCode: 'K1A0B1',
    originalExpectedDeliveryDate: '2026-06-01',
    expectedDeliveryDate: '2026-06-01',
    firstAttemptDate: '2026-06-02',
    actualDeliveryDate: '2026-06-03',
    exclusionSignals: [],
    conflictCodes: [],
    normalizedEvents: []
  };
  const classification = classifyEligibility(input, {
    asOf: '2026-06-05',
    classificationTimestamp: '2026-06-05T12:00:00.000Z'
  });
  assert.strictEqual(classification.classification, 'LATE_CANDIDATE');
  return claimDb.recordClassification(dbPath, trackingNumber, classification, input, { runId });
}

function complete(trackingNumber, status) {
  const id = claimDb.beginClaimAttempt(dbPath, { trackingNumber });
  claimDb.completeClaimAttempt(dbPath, id, { status });
  return id;
}

(async () => {
  try {
    await claimDb.initializeDatabase(dbPath, { backupDirectory: path.join(root, 'migration-backups') });
    const runId = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
    const numbers = {
      executable: '1000000000000001',
      submitted: '1000000000000002',
      duplicate: '1000000000000003',
      unresolved: '1000000000000004',
      rejected: '1000000000000005',
      retryLimit: '1000000000000006'
    };
    for (const tracking of Object.values(numbers)) candidate(runId, tracking);
    claimDb.finishRun(dbPath, runId, 'complete', { total: 6, success: 6 });

    complete(numbers.submitted, 'submitted');
    complete(numbers.duplicate, 'already_submitted');
    const unresolvedAttemptId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: numbers.unresolved });
    complete(numbers.rejected, 'rejected');
    for (let index = 0; index < 3; index += 1) complete(numbers.retryLimit, 'failed');

    const preview = service.previewCandidates(dbPath, { now: '2026-06-05T12:00:00.000Z' });
    assert.strictEqual(preview.count, 6);
    assert.strictEqual(preview.executableCount, 1);
    assert.strictEqual(preview.blockedCount, 5);
    assert.deepStrictEqual(preview.executionCounts, {
      executable: 1,
      submitted: 1,
      already_submitted: 1,
      unresolved_attempt: 1,
      terminal_failure: 1,
      reconciliation_required: 1,
      otherwise_blocked: 0
    });

    const byTracking = Object.fromEntries(preview.items.map(item => [item.trackingNumber, item]));
    assert.strictEqual(byTracking[numbers.executable].executable, true);
    assert.strictEqual(byTracking[numbers.submitted].executionState, 'submitted');
    assert.strictEqual(byTracking[numbers.duplicate].executionState, 'already_submitted');
    assert.strictEqual(byTracking[numbers.unresolved].executionState, 'unresolved_attempt');
    assert.strictEqual(byTracking[numbers.unresolved].attemptId, unresolvedAttemptId);
    assert.strictEqual(byTracking[numbers.unresolved].mayHaveSubmitted, true);
    assert.strictEqual(byTracking[numbers.rejected].executionState, 'terminal_failure');
    assert.strictEqual(byTracking[numbers.retryLimit].executionState, 'reconciliation_required');

    const controller = queueUi.createController();
    controller.load(preview.items);
    controller.selectVisible({});
    assert.strictEqual(controller.snapshot().selected, 1, 'Select all must select only executable rows.');
    assert.deepStrictEqual(controller.selectedRecords().map(item => item.recordId), [byTracking[numbers.executable].recordId]);
    controller.set(byTracking[numbers.unresolved].recordId, true);
    assert.strictEqual(controller.snapshot().selected, 1, 'A blocked row cannot be forced into selection.');

    const blockedDirectory = path.join(root, 'blocked-snapshot');
    fs.mkdirSync(blockedDirectory);
    assert.throws(() => service.createRunSnapshot(dbPath, [{
      recordId: byTracking[numbers.unresolved].recordId,
      evidenceHash: byTracking[numbers.unresolved].evidenceHash
    }], {
      csvPath: path.join(blockedDirectory, 'worker.csv'),
      snapshotPath: path.join(blockedDirectory, 'snapshot.json')
    }, { allowedDirectory: blockedDirectory }), error => {
      assert.strictEqual(error.code, 'STEP3_UNRESOLVED_ATTEMPT');
      assert.strictEqual(error.attemptId, unresolvedAttemptId);
      assert.strictEqual(error.executionState, 'unresolved_attempt');
      return true;
    });
    assert.strictEqual(fs.existsSync(path.join(blockedDirectory, 'worker.csv')), false);
    assert.strictEqual(fs.existsSync(path.join(blockedDirectory, 'snapshot.json')), false);

    const executableItem = byTracking[numbers.executable];
    const raceAttemptId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: numbers.executable });
    assert.throws(() => service.createRunSnapshot(dbPath, [{
      recordId: executableItem.recordId,
      evidenceHash: executableItem.evidenceHash
    }], {
      csvPath: path.join(root, 'race.csv'),
      snapshotPath: path.join(root, 'race.json')
    }, { allowedDirectory: root }), error => error.code === 'STEP3_UNRESOLVED_ATTEMPT');
    assert.ok(raceAttemptId > 0);
    assert.strictEqual(fs.existsSync(path.join(root, 'race.csv')), false);

    process.stdout.write('Dev.10 Step 3 executable-queue tests passed.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
