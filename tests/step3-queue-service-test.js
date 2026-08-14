'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claimDb = require('../lib/claim-database');
const claimQueue = require('../lib/claim-queue');
const { classifyEligibility } = require('../lib/policy-engine');
const { walkBusinessDays } = require('../lib/business-calendar');
const service = require('../lib/step3-queue-service');
const queueUi = require('../renderer/step3-queue');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-step3-db-'));
const dbPath = path.join(root, 'app.sqlite');

function candidate(runId, trackingNumber, expected = '2026-06-01', delivered = '2026-06-03') {
  const input = {
    trackingNumber,
    referenceNumber: `REF-${trackingNumber}`,
    serviceCode: 'DOM.XP',
    destinationProvince: 'ON',
    destinationPostalCode: 'K1A0B1',
    originalExpectedDeliveryDate: expected,
    expectedDeliveryDate: expected,
    firstAttemptDate: '2026-06-02',
    actualDeliveryDate: delivered,
    exclusionSignals: [],
    conflictCodes: [],
    normalizedEvents: []
  };
  const classification = classifyEligibility(input, { asOf: '2026-06-05', classificationTimestamp: '2026-06-05T12:00:00.000Z' });
  assert.strictEqual(classification.classification, 'LATE_CANDIDATE');
  assert.strictEqual(classification.automaticallyEligible, false);
  return claimDb.recordClassification(dbPath, trackingNumber, classification, input, { runId });
}

(async () => {
  try {
    await claimDb.initializeDatabase(dbPath, { backupDirectory: path.join(root, 'migration-backups') });
    const run1 = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
    candidate(run1, '1111111111111111');
    const excludedBase = {
      trackingNumber: 'REVIEW-EXCLUDED', serviceCode: 'DOM.XP', destinationProvince: 'ON',
      actualDeliveryDate: '2026-06-03', exclusionSignals: [], conflictCodes: [], normalizedEvents: []
    };
    const reviewRequired = classifyEligibility(excludedBase, { asOf: '2026-06-05', classificationTimestamp: '2026-06-05T12:00:00.000Z' });
    assert.strictEqual(reviewRequired.classification, 'REVIEW_REQUIRED');
    claimDb.recordClassification(dbPath, excludedBase.trackingNumber, reviewRequired, excludedBase, { runId: run1 });
    const trackingError = { ...reviewRequired, classification: 'TRACKING_ERROR', explanation: 'Synthetic tracking failure.' };
    claimDb.recordClassification(dbPath, 'TRACKING-ERROR-EXCLUDED', trackingError, { ...excludedBase, trackingNumber: 'TRACKING-ERROR-EXCLUDED' }, { runId: run1 });
    const onTimeInput = { ...excludedBase, trackingNumber: 'ON-TIME-EXCLUDED', expectedDeliveryDate: '2026-06-03', originalExpectedDeliveryDate: '2026-06-03' };
    const onTime = classifyEligibility(onTimeInput, { asOf: '2026-06-05', classificationTimestamp: '2026-06-05T12:00:00.000Z' });
    assert.strictEqual(onTime.classification, 'ON_TIME');
    claimDb.recordClassification(dbPath, onTimeInput.trackingNumber, onTime, onTimeInput, { runId: run1 });
    assert.strictEqual(claimDb.withDatabase(dbPath, db => Number(db.prepare('SELECT COUNT(*) AS n FROM manual_reviews').get().n)), 0,
      'excluded Step 2 classifications must not create eligibility-review records');
    claimDb.finishRun(dbPath, run1, 'complete', { total: 4, success: 4 });

    const csvExport = path.join(root, 'claims.csv');
    fs.writeFileSync(csvExport, 'Tracking PIN\n9999999999999999\n');
    const firstPreview = service.previewCandidates(dbPath, { now: '2026-06-05T12:00:00.000Z' });
    assert.deepStrictEqual(firstPreview.items.map(item => item.trackingNumber), ['1111111111111111']);
    fs.writeFileSync(csvExport, 'corrupt manual edit');
    assert.deepStrictEqual(service.previewCandidates(dbPath, { now: '2026-06-05' }).items.map(item => item.trackingNumber), ['1111111111111111'], 'modified claims.csv must not change the queue');
    fs.rmSync(csvExport);
    assert.strictEqual(service.previewCandidates(dbPath, { now: '2026-06-05' }).count, 1, 'deleted claims.csv must not remove the queue');

    const controller = queueUi.createController();
    controller.load([
      ...firstPreview.items,
      { ...firstPreview.items[0], recordId: 999, trackingNumber: '2222222222222222', serviceCode: 'DOM.EP', deadlineState: 'urgent' }
    ]);
    assert.strictEqual(controller.snapshot().selected, 0, 'initial queue selection must be empty');
    controller.selectAll();
    assert.strictEqual(controller.snapshot().selected, 2, 'Select all must include every actionable row');
    controller.clear();
    assert.strictEqual(controller.snapshot().selected, 0, 'Clear selection must clear globally');
    controller.selectAll();
    assert.strictEqual(controller.snapshot().selected, 2, 'selected count must remain accurate');
    controller.load(firstPreview.items);
    assert.strictEqual(controller.snapshot().selected, 0, 'queue refresh must reset selection');
    assert.throws(() => service.createRunSnapshot(dbPath, [], { csvPath: path.join(root, 'none.csv'), snapshotPath: path.join(root, 'none.json') }), /Select at least one/i);

    const selected = [{ recordId: firstPreview.items[0].recordId, evidenceHash: firstPreview.items[0].evidenceHash }];
    assert.throws(() => service.createRunSnapshot(dbPath, [{ ...selected[0], evidenceHash: 'a'.repeat(64) }], {
      csvPath: path.join(root, 'changed.csv'), snapshotPath: path.join(root, 'changed.json')
    }, { allowedDirectory: root }), error => error.code === 'STEP3_EVIDENCE_CHANGED');

    const snapshotDirectory = path.join(root, 'snapshot-1');
    fs.mkdirSync(snapshotDirectory);
    const snapshot = service.createRunSnapshot(dbPath, selected, {
      csvPath: path.join(snapshotDirectory, 'worker.csv'), snapshotPath: path.join(snapshotDirectory, 'snapshot.json')
    }, { allowedDirectory: snapshotDirectory, now: '2026-06-05T12:00:00.000Z' });
    const stableCsv = fs.readFileSync(snapshot.csvPath, 'utf8');
    const stableJson = fs.readFileSync(snapshot.snapshotPath, 'utf8');
    const workerRows = claimQueue.readClaimsCsv(snapshot.csvPath).rows;
    assert.strictEqual(workerRows[0].Status, 'LATE CANDIDATE', 'database snapshot must preserve the worker-side late-candidate guard');
    assert.strictEqual(claimQueue.claimInputFromRow(workerRows[0]).trackingNumber, '1111111111111111');

    const run2 = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
    candidate(run2, '2222222222222222');
    assert.throws(() => service.previewCandidates(dbPath), error => error.code === 'STEP2_RUN_NOT_AUTHORITATIVE', 'incomplete latest run must block old promoted runs');
    assert.strictEqual(fs.readFileSync(snapshot.csvPath, 'utf8'), stableCsv, 'transactional snapshot must remain stable after later Step 2 activity');
    assert.strictEqual(fs.readFileSync(snapshot.snapshotPath, 'utf8'), stableJson);
    claimDb.finishRun(dbPath, run2, 'failed', { failure: 1 });
    assert.throws(() => service.previewCandidates(dbPath), error => error.code === 'STEP2_RUN_NOT_AUTHORITATIVE');

    const runTampered = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
    candidate(runTampered, '2999999999999999');
    claimDb.finishRun(dbPath, runTampered, 'complete', { total: 1, success: 1 });
    const tamperedPreview = service.previewCandidates(dbPath, { now: '2026-06-05' });
    const tamperedItem = tamperedPreview.items[0];
    claimDb.withDatabase(dbPath, db => {
      const row = db.prepare('SELECT input_json FROM classification_records WHERE id = ?').get(tamperedItem.recordId);
      const input = JSON.parse(row.input_json);
      input.actualDeliveryDate = input.expectedDeliveryDate;
      db.exec('DROP TRIGGER classification_records_no_update');
      db.prepare('UPDATE classification_records SET input_json = ? WHERE id = ?').run(JSON.stringify(input), tamperedItem.recordId);
    });
    assert.throws(() => service.createRunSnapshot(dbPath, [{
      recordId: tamperedItem.recordId,
      evidenceHash: tamperedItem.evidenceHash
    }], {
      csvPath: path.join(root, 'tampered.csv'),
      snapshotPath: path.join(root, 'tampered.json')
    }, { allowedDirectory: root, now: '2026-06-05T12:00:00.000Z' }), error => (
      error.code === 'STEP3_CLASSIFICATION_CHANGED'
    ), 'snapshot creation must reclassify selected evidence inside the transaction');
    assert.strictEqual(fs.existsSync(path.join(root, 'tampered.csv')), false);
    assert.strictEqual(fs.existsSync(path.join(root, 'tampered.json')), false);

    const run3 = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
    candidate(run3, '3333333333333333');
    claimDb.finishRun(dbPath, run3, 'complete', { total: 1, success: 1 });
    let preview = service.previewCandidates(dbPath, { now: '2026-06-05' });
    const attempt = claimDb.beginClaimAttempt(dbPath, { trackingNumber: '3333333333333333' });
    claimDb.completeClaimAttempt(dbPath, attempt, { status: 'submitted' });
    assert.strictEqual(service.previewCandidates(dbPath, { now: '2026-06-05' }).count, 0, 'submitted claims must disappear from preview');
    assert.throws(() => service.createRunSnapshot(dbPath, [{ recordId: preview.items[0].recordId, evidenceHash: preview.items[0].evidenceHash }], {
      csvPath: path.join(root, 'terminal.csv'), snapshotPath: path.join(root, 'terminal.json')
    }, { allowedDirectory: root }), error => error.code === 'STEP3_TERMINAL_OUTCOME');

    const run4 = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
    candidate(run4, '4444444444444444');
    claimDb.finishRun(dbPath, run4, 'complete', { total: 1, success: 1 });
    preview = service.previewCandidates(dbPath, { now: '2026-06-05' });
    claimDb.beginClaimAttempt(dbPath, { trackingNumber: '4444444444444444' });
    assert.strictEqual(service.previewCandidates(dbPath, { now: '2026-06-05' }).count, 0, 'unresolved attempts must disappear from preview');
    assert.throws(() => service.createRunSnapshot(dbPath, [{ recordId: preview.items[0].recordId, evidenceHash: preview.items[0].evidenceHash }], {
      csvPath: path.join(root, 'unresolved.csv'), snapshotPath: path.join(root, 'unresolved.json')
    }, { allowedDirectory: root }), error => error.code === 'STEP3_UNRESOLVED_ATTEMPT');

    const today = '2026-07-30';
    for (const value of [null, undefined, '', 'not-a-date']) {
      const result = service.deadlinePresentation({ deadline: value, destinationProvince: 'ON' }, { today });
      assert.strictEqual(result.state, 'unavailable');
      assert.strictEqual(result.businessDaysRemaining, null);
    }
    assert.deepStrictEqual(service.deadlinePresentation({ deadline: today, destinationProvince: 'ON', policyVerified: true }, { today }), {
      state: 'urgent', deadline: today, businessDaysRemaining: 0
    });
    for (const days of [1, 7, 8]) {
      const deadline = walkBusinessDays(today, days, 'ON').date;
      const result = service.deadlinePresentation({ deadline, destinationProvince: 'ON', policyVerified: true }, { today });
      assert.strictEqual(result.businessDaysRemaining, days);
      assert.strictEqual(result.state, days <= 7 ? 'urgent' : 'known_active');
    }
    assert.strictEqual(service.deadlinePresentation({ deadline: '2026-07-29', destinationProvince: 'ON', policyVerified: true }, { today }).state, 'expired');
    assert.strictEqual(service.deadlinePresentation({ deadline: '2026-08-10', destinationProvince: 'ON', policyGuidanceState: 'unverified_advisory' }, { today }).state, 'unverified_advisory');
    assert.strictEqual(service.deadlinePresentation({ deadline: '2027-01-15', destinationProvince: 'ON' }, { today }).state, 'policy_review_required');
    assert.strictEqual(service.deadlinePresentation({ deadline: '2026-08-10', destinationProvince: '' }, { today }).state, 'policy_review_required');
    process.stdout.write('SQLite Step 3 queue, selection, snapshot and deadline tests passed.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
