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
    claimDb.finishRun(dbPath, run1, 'complete', { total: 1, success: 1 });

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
    controller.selectVisible({ service: 'DOM.XP' });
    assert.deepStrictEqual(controller.snapshot().selectedIds, [firstPreview.items[0].recordId], 'Select all must affect visible rows only');
    assert.strictEqual(controller.visible({ service: 'DOM.EP' }).length, 1);
    assert.strictEqual(controller.snapshot().selected, 1, 'filter changes must not select hidden rows');
    controller.clear();
    assert.strictEqual(controller.snapshot().selected, 0, 'Clear selection must clear globally');
    controller.selectVisible({});
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

    const run3 = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
    candidate(run3, '3333333333333333');
    claimDb.finishRun(dbPath, run3, 'complete', { total: 1, success: 1 });
    let preview = service.previewCandidates(dbPath, { now: '2026-06-05' });
    const attempt = claimDb.beginClaimAttempt(dbPath, { trackingNumber: '3333333333333333' });
    claimDb.completeClaimAttempt(dbPath, attempt, { status: 'submitted' });
    assert.throws(() => service.createRunSnapshot(dbPath, [{ recordId: preview.items[0].recordId, evidenceHash: preview.items[0].evidenceHash }], {
      csvPath: path.join(root, 'terminal.csv'), snapshotPath: path.join(root, 'terminal.json')
    }, { allowedDirectory: root }), error => error.code === 'STEP3_TERMINAL_OUTCOME');

    const run4 = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
    candidate(run4, '4444444444444444');
    claimDb.finishRun(dbPath, run4, 'complete', { total: 1, success: 1 });
    preview = service.previewCandidates(dbPath, { now: '2026-06-05' });
    claimDb.beginClaimAttempt(dbPath, { trackingNumber: '4444444444444444' });
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
    const filterController = queueUi.createController();
    filterController.load([
      { recordId: 1, evidenceHash: 'a'.repeat(64), deadlineState: 'urgent' },
      { recordId: 2, evidenceHash: 'b'.repeat(64), deadlineState: 'expired' },
      { recordId: 3, evidenceHash: 'c'.repeat(64), deadlineState: 'unavailable' },
      { recordId: 4, evidenceHash: 'd'.repeat(64), deadlineState: 'policy_review_required' }
      , { recordId: 5, evidenceHash: 'e'.repeat(64), deadlineState: 'unverified_advisory' }
    ]);
    assert.deepStrictEqual(filterController.visible({ urgency: 'urgent' }).map(item => item.recordId), [1]);
    assert.deepStrictEqual(filterController.visible({ urgency: 'expired' }).map(item => item.recordId), [2]);
    assert.deepStrictEqual(filterController.visible({ urgency: 'unavailable' }).map(item => item.recordId), [3, 4]);
    assert.deepStrictEqual(filterController.visible({ urgency: 'advisory' }).map(item => item.recordId), [5]);

    process.stdout.write('SQLite Step 3 queue, selection, snapshot and deadline tests passed.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
