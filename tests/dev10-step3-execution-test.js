'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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
      retryLimit: '1000000000000006',
      retryableFailure: '1000000000000007',
      notSubmitted: '1000000000000008',
      retryApproved: '1000000000000009',
      tombstoned: '1000000000000010'
    };
    for (const tracking of Object.values(numbers)) candidate(runId, tracking);
    claimDb.finishRun(dbPath, runId, 'complete', { total: 10, success: 10 });
    const initialPreview = service.previewCandidates(dbPath, { now: '2026-06-05T12:00:00.000Z' });
    const initialByTracking = Object.fromEntries(initialPreview.items.map(item => [item.trackingNumber, item]));

    complete(numbers.submitted, 'submitted');
    complete(numbers.duplicate, 'already_submitted');
    const unresolvedAttemptId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: numbers.unresolved });
    complete(numbers.rejected, 'rejected');
    for (let index = 0; index < 3; index += 1) complete(numbers.retryLimit, 'failed');
    complete(numbers.retryableFailure, 'failed');
    complete(numbers.notSubmitted, 'not_submitted');
    complete(numbers.retryApproved, 'retry_approved');
    claimDb.withDatabase(dbPath, db => db.prepare(`
      INSERT INTO claim_duplicate_tombstones
        (tracking_hash, terminal_outcome, application_version, schema_version, created_at)
      VALUES (?, 'submitted', 'test', 8, ?)
    `).run(
      crypto.createHash('sha256').update(`privacy-v1|${numbers.tombstoned}`).digest('hex'),
      '2026-06-05T12:00:00.000Z'
    ));

    const preview = service.previewCandidates(dbPath, { now: '2026-06-05T12:00:00.000Z' });
    assert.strictEqual(preview.count, 4, 'visible count must equal actionable rows');
    assert.strictEqual(preview.items.length, 4, 'preview must return only actionable rows');
    assert.strictEqual(preview.executableCount, 4);
    assert.strictEqual(preview.blockedCount, 6);
    assert.strictEqual(preview.excludedCount, 6);
    assert.deepStrictEqual(preview.executionCounts, {
      executable: 4,
      submitted: 2,
      already_submitted: 1,
      unresolved_attempt: 1,
      terminal_failure: 1,
      reconciliation_required: 1,
      otherwise_blocked: 0
    });

    const byTracking = Object.fromEntries(preview.items.map(item => [item.trackingNumber, item]));
    assert.strictEqual(byTracking[numbers.executable].executable, true);
    assert.strictEqual(byTracking[numbers.retryableFailure].attemptStatus, 'failed');
    assert.strictEqual(byTracking[numbers.notSubmitted].attemptStatus, 'not_submitted');
    assert.strictEqual(byTracking[numbers.retryApproved].attemptStatus, 'retry_approved');
    for (const hidden of [numbers.submitted, numbers.duplicate, numbers.unresolved, numbers.rejected, numbers.retryLimit, numbers.tombstoned]) {
      assert.strictEqual(byTracking[hidden], undefined, `${hidden} must be absent from the visible queue`);
    }
    assert.ok(claimDb.listClaimHistory(dbPath).some(item => item.trackingNumber === numbers.submitted && item.status === 'submitted'),
      'submitted claims must remain in Claim History after leaving Step 3');
    assert.ok(claimDb.listClaimHistory(dbPath).some(item => item.trackingNumber === numbers.duplicate && item.status === 'already_submitted'),
      'already-submitted claims must remain in Claim History after leaving Step 3');

    const controller = queueUi.createController();
    controller.load(preview.items);
    controller.selectAll();
    assert.strictEqual(controller.snapshot().selected, 4, 'Select all must select every displayed actionable row.');

    const blockedDirectory = path.join(root, 'blocked-snapshot');
    fs.mkdirSync(blockedDirectory);
    assert.throws(() => service.createRunSnapshot(dbPath, [{
      recordId: initialByTracking[numbers.unresolved].recordId,
      evidenceHash: initialByTracking[numbers.unresolved].evidenceHash
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

    assert.throws(() => service.createRunSnapshot(dbPath, [{
      recordId: initialByTracking[numbers.tombstoned].recordId,
      evidenceHash: initialByTracking[numbers.tombstoned].evidenceHash
    }], {
      csvPath: path.join(root, 'tombstone.csv'),
      snapshotPath: path.join(root, 'tombstone.json')
    }, { allowedDirectory: root }), error => error.code === 'STEP3_TERMINAL_OUTCOME',
    'duplicate tombstones must still block stale selections');

    assert.ok(unresolvedAttemptId > 0);
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
