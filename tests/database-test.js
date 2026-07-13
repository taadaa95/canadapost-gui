'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claimDb = require('../lib/claim-database');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-db-test-'));
const dbPath = path.join(root, 'database', 'app.sqlite');
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

try {
  const shipment = claimDb.upsertShipment(dbPath, {
    'Tracking PIN': '1234567890123456',
    'Service Code': 'DOM.EP',
    'Reference #': 'ORDER-1',
    'Destination Postal Code': 'H0H0H0',
    'Expected Delivery Date': '2026-07-01',
    'Actual Delivery Date': '2026-07-03',
    Status: 'ELIGIBLE - DELIVERED LATE',
    'Eligibility Reason': 'Delivered after guarantee.'
  });
  assert.strictEqual(shipment.tracking_number, '1234567890123456');
  assert.strictEqual(shipment.classification, 'ELIGIBLE - DELIVERED LATE');
  assert.strictEqual(shipment.eligibility_reason, 'Delivered after guarantee.');

  claimDb.upsertShipment(dbPath, {
    trackingNumber: 'MANUAL1', referenceNumber: 'MAN-REF', serviceCode: 'DOM.XP',
    classification: 'MANUAL_ENTRY', eligibilityReason: 'Entered for follow-up.'
  });
  const manualShipments = claimDb.listManualShipments(dbPath, { search: 'MAN-REF' });
  assert.strictEqual(manualShipments.length, 1);
  assert.strictEqual(manualShipments[0].trackingNumber, 'MANUAL1');

  const runId = claimDb.startRun(dbPath, 'tracking', { test: true });
  claimDb.ingestTrackingEvent(dbPath, runId, {
    type: 'pin_late', pin: '1234567890123456', classification: 'DELIVERED_LATE_ELIGIBLE',
    expectedDate: '2026-07-01', deliveryDate: '2026-07-03', serviceCode: 'DOM.EP'
  });
  claimDb.finishRun(dbPath, runId, 'complete', { total: 1, success: 1 });

  let attemptId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: '1234567890123456', maxAttempts: 3 });
  assert.throws(() => claimDb.beginClaimAttempt(dbPath, { trackingNumber: '1234567890123456', maxAttempts: 3 }), /uncertain|in_progress/i);
  claimDb.completeClaimAttempt(dbPath, attemptId, { status: 'failed', message: 'Temporary failure' });

  attemptId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: '1234567890123456', maxAttempts: 3 });
  claimDb.completeClaimAttempt(dbPath, attemptId, { status: 'failed', message: 'Temporary failure 2' });
  attemptId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: '1234567890123456', maxAttempts: 3 });
  claimDb.completeClaimAttempt(dbPath, attemptId, { status: 'failed', message: 'Temporary failure 3' });

  assert.strictEqual(claimDb.canAutomaticallyAttempt(dbPath, '1234567890123456', 3).allowed, false);
  let queue = claimDb.listReconciliation(dbPath, 100, 3);
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].status, 'failed');

  claimDb.reconcileAttempt(dbPath, queue[0].id, 'retry', 'Verified not submitted remotely.');
  assert.strictEqual(claimDb.canAutomaticallyAttempt(dbPath, '1234567890123456', 3).allowed, true);
  attemptId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: '1234567890123456', maxAttempts: 3 });
  claimDb.completeClaimAttempt(dbPath, attemptId, { status: 'submitted', confirmationNumber: 'TICKET-123' });
  assert.strictEqual(claimDb.canAutomaticallyAttempt(dbPath, '1234567890123456', 3).allowed, false);

  const unknownId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: '9999999999999999' });
  claimDb.completeClaimAttempt(dbPath, unknownId, { status: 'unknown', message: 'Connection closed after click.' });
  queue = claimDb.listReconciliation(dbPath);
  const unknown = queue.find(item => item.trackingNumber === '9999999999999999');
  assert.ok(unknown);
  claimDb.reconcileAttempt(dbPath, unknown.id, 'submitted', 'Confirmed in Canada Post.', 'TICKET-999');
  const manual = claimDb.latestAttemptState(dbPath, '9999999999999999');
  assert.strictEqual(manual.status, 'submitted_manual');
  assert.strictEqual(manual.confirmation_number, 'TICKET-999');

  const dryId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: 'DRYRUN1', dryRun: true });
  assert.ok(dryId > 0);
  claimDb.markInterruptedAttempts(dbPath);
  const dryHistory = claimDb.listClaimHistory(dbPath, { status: 'dry_run_interrupted' });
  assert.strictEqual(dryHistory.length, 1);
  assert.strictEqual(claimDb.listReconciliation(dbPath).some(item => item.trackingNumber === 'DRYRUN1'), false);

  const dashboard = claimDb.dashboard(dbPath);
  assert.strictEqual(dashboard.submitted, 2);
  assert.strictEqual(dashboard.reconciliation, 0);
  assert.ok(dashboard.dry_runs >= 1);
  assert.strictEqual(claimDb.integrityCheck(dbPath).ok, true);

  const legacyDryId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: 'PRE033DRY1', dryRun: true });
  claimDb.completeClaimAttempt(dbPath, legacyDryId, { status: 'dry_run_ready', message: 'Legacy dry run ready.' });
  const quarantine = claimDb.quarantineLegacyDryRunReadyAttempts(dbPath);
  assert.strictEqual(quarantine.quarantined, 1);
  assert.strictEqual(claimDb.quarantineLegacyDryRunReadyAttempts(dbPath).alreadyApplied, true);
  const quarantinedState = claimDb.latestAttemptState(dbPath, 'PRE033DRY1');
  assert.strictEqual(quarantinedState.status, 'unknown');
  assert.strictEqual(quarantinedState.error_code, 'PRE_033_DRY_RUN_REVIEW');
  assert.strictEqual(claimDb.canAutomaticallyAttempt(dbPath, 'PRE033DRY1').allowed, false);
  assert.ok(claimDb.listReconciliation(dbPath).some(item => item.trackingNumber === 'PRE033DRY1'));

  // Realistic v0.2 migration: CSV metadata, audit history and interrupted state.
  const legacyRoot = fs.mkdtempSync(path.join(root, 'legacy-'));
  const legacyDb = path.join(legacyRoot, 'database', 'app.sqlite');
  fs.writeFileSync(path.join(legacyRoot, 'claims.csv'), [
    'Tracking PIN,Destination Postal Code,Expected Delivery Date,Actual Delivery Date,Reference #,Service Code,Status,Eligibility Reason',
    'LEGACY1,H0H0H0,2026-06-01,2026-06-03,REF-1,DOM.EP,ELIGIBLE - DELIVERED LATE,Delivered after guarantee'
  ].join('\n'));
  fs.writeFileSync(path.join(legacyRoot, 'claim-history.jsonl'), `${JSON.stringify({ trackingNumber: 'LEGACY1', status: 'failed', attempts: 1, startedAt: '2026-06-04T00:00:00.000Z' })}\n`);
  fs.writeFileSync(path.join(legacyRoot, 'claim-state.json'), JSON.stringify({
    version: 1,
    claims: { LEGACY2: { trackingNumber: 'LEGACY2', status: 'in_progress', attempts: 1, startedAt: '2026-06-05T00:00:00.000Z' } }
  }));
  const imported = claimDb.importLegacyData(legacyDb, legacyRoot);
  assert.strictEqual(imported.imported, true);
  assert.strictEqual(claimDb.importLegacyData(legacyDb, legacyRoot).imported, false);
  assert.strictEqual(claimDb.latestAttemptState(legacyDb, 'LEGACY1').status, 'failed');
  assert.strictEqual(claimDb.latestAttemptState(legacyDb, 'LEGACY2').status, 'unknown');
  assert.strictEqual(claimDb.listClaimHistory(legacyDb, { search: 'REF-1' }).length, 1);

  console.log('Database tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
