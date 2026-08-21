'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claimDb = require('../lib/claim-database');
const { classifyEligibility } = require('../lib/policy-engine');
const { parseTrackingJson } = require('../lib/tracking-json');
const { buildCanonicalShipment } = require('../lib/normalized-shipment');
const { createQueueSnapshot } = require('../lib/eligibility-revalidation');
const { DatabaseSync } = require('node:sqlite');

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
  const failedHistoryItem = claimDb.listClaimHistory(dbPath).find(item => item.id === queue[0].id);
  assert.strictEqual(failedHistoryItem.status, 'failed');
  assert.strictEqual(failedHistoryItem.needsAttention, false,
    'a failed claim must remain Failed rather than also being counted as Needs attention');

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
  assert.strictEqual(claimDb.listClaimHistory(dbPath).find(item => item.id === unknown.id).needsAttention, true,
    'an unknown latest attempt must be marked for inline History attention');
  claimDb.reconcileAttempt(dbPath, unknown.id, 'submitted', 'Confirmed in Canada Post.', 'TICKET-999');
  const manual = claimDb.latestAttemptState(dbPath, '9999999999999999');
  assert.strictEqual(manual.status, 'submitted_manual');
  assert.strictEqual(manual.confirmation_number, 'TICKET-999');
  assert.strictEqual(claimDb.listClaimHistory(dbPath).find(item => item.id === unknown.id).needsAttention, false,
    'a reconciled submitted attempt must no longer expose inline reconciliation actions');

  const dryId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: 'DRYRUN1', dryRun: true });
  assert.ok(dryId > 0);
  claimDb.markInterruptedAttempts(dbPath);
  const dryHistory = claimDb.listClaimHistory(dbPath, { status: 'dry_run_interrupted' });
  assert.strictEqual(dryHistory.length, 1);
  const firstHistoryPage = claimDb.listClaimHistory(dbPath, { limit: 1, offset: 0 });
  const secondHistoryPage = claimDb.listClaimHistory(dbPath, { limit: 1, offset: 1 });
  assert.strictEqual(firstHistoryPage.length, 1);
  assert.strictEqual(secondHistoryPage.length, 1);
  assert.notStrictEqual(firstHistoryPage[0].id, secondHistoryPage[0].id, 'History offset must advance without mutating records');
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

  const policyClaim = {
    trackingNumber: 'POLICY1', serviceCode: 'DOM.XP', shipmentDate: '2026-06-01',
    expectedDeliveryDate: '2026-06-03', firstAttemptDate: '2026-06-04', actualDeliveryDate: '2026-06-04',
    destinationProvince: 'ON', sender: { name: 'Synthetic Sender', address: '1 Test St', city: 'Ottawa', province: 'ON', postalCode: 'K1A0B1' },
    contact: { name: 'Synthetic Operator', email: 'operator@example.invalid' }, claimEvidence: ['fixture']
  };
  const classification = classifyEligibility(policyClaim, { asOf: '2026-06-10', classificationTimestamp: '2026-06-10T12:00:00Z' });
  const recorded = claimDb.recordClassification(dbPath, policyClaim.trackingNumber, classification, policyClaim);
  assert.ok(recorded.id > 0);
  assert.strictEqual(claimDb.currentClassification(dbPath, policyClaim.trackingNumber).classification, 'LATE_CANDIDATE');
  assert.strictEqual(claimDb.classificationHistory(dbPath, policyClaim.trackingNumber).length, 1);
  assert.throws(() => claimDb.withDatabase(dbPath, db => db.prepare('UPDATE classification_records SET classification = ? WHERE id = ?').run('ON_TIME', recorded.id)), /immutable/);
  const dashboardBeforeLegacyReview = claimDb.dashboard(dbPath);
  claimDb.withDatabase(dbPath, db => db.prepare(`INSERT INTO manual_reviews
    (shipment_id, classification_id, status, opened_at, created_at, updated_at) VALUES (?, ?, 'open', ?, ?, ?)`)
    .run(recorded.shipmentId, recorded.id, '2026-06-10T12:05:00Z', '2026-06-10T12:05:00Z', '2026-06-10T12:05:00Z'));
  assert.deepStrictEqual(claimDb.dashboard(dbPath), dashboardBeforeLegacyReview,
    'dormant legacy manual-review rows must not affect application readiness or dashboard counts');

  const rejectedAttemptId = claimDb.beginClaimAttempt(dbPath, {
    trackingNumber: 'REJECTED-BUSINESS-OUTCOME',
    classification: 'LATE_CANDIDATE',
    dryRun: false,
    message: 'Claim attempt started.'
  });
  const rejectedAttempt = claimDb.completeClaimAttempt(dbPath, rejectedAttemptId, {
    status: 'rejected',
    message: 'Canada Post returned: shipment is not eligible.',
    errorCode: 'CLAIM_REJECTED'
  });
  assert.strictEqual(rejectedAttempt.status, 'rejected');
  assert.match(rejectedAttempt.message, /not eligible/i);
  assert.strictEqual(claimDb.canAutomaticallyAttempt(dbPath, 'REJECTED-BUSINESS-OUTCOME').allowed, false, 'a rejection is a terminal business outcome, not a retryable crash');

  const canonicalShipment = buildCanonicalShipment({
    detail: parseTrackingJson({
      pin: policyClaim.trackingNumber,
      activeExists: true,
      archiveExists: false,
      signatureImageExists: false,
      suppressSignature: false,
      serviceName: 'Xpresspost',
      expectedDeliveryDate: '2026-06-03',
      significantEvents: [
        { eventIdentifier: 'SYN-ATTEMPT', eventDescription: 'Delivery attempt made', eventDate: '2026-06-04', eventTime: '10:00:00' },
        { eventIdentifier: '1496', eventDescription: 'Delivered', eventDate: '2026-06-05', eventTime: '10:00:00' }
      ]
    }, policyClaim.trackingNumber),
    row: { 'Shipment Date': policyClaim.shipmentDate, 'Destination Province': 'ON' },
    trackingNumber: policyClaim.trackingNumber
  });
  const savedEvents = claimDb.saveTrackingNormalization(dbPath, policyClaim.trackingNumber, canonicalShipment, []);
  assert.strictEqual(savedEvents.eventIds.length, canonicalShipment.normalizedEvents.length);
  assert.deepStrictEqual(claimDb.withDatabase(dbPath, db => db.prepare('SELECT DISTINCT raw_json FROM tracking_events WHERE shipment_id = ?').all(savedEvents.shipmentId)).map(item => item.raw_json), ['{}']);

  const needsReview = classifyEligibility({ ...policyClaim, expectedDeliveryDate: '' }, { asOf: '2026-06-10', classificationTimestamp: '2026-06-10T13:00:00Z' });
  assert.strictEqual(needsReview.classification, 'REVIEW_REQUIRED');
  const legacyReviewCount = claimDb.withDatabase(dbPath, db => Number(db.prepare('SELECT COUNT(*) AS n FROM manual_reviews').get().n));
  claimDb.recordClassification(dbPath, policyClaim.trackingNumber, needsReview, { ...policyClaim, contact: {} });
  assert.strictEqual(claimDb.withDatabase(dbPath, db => Number(db.prepare('SELECT COUNT(*) AS n FROM manual_reviews').get().n)), legacyReviewCount,
    'REVIEW_REQUIRED must remain conservative without creating eligibility-review workflow rows');
  assert.strictEqual(claimDb.classificationHistory(dbPath, policyClaim.trackingNumber).length, 2);
  assert.strictEqual(claimDb.currentClassification(dbPath, policyClaim.trackingNumber).classification, 'REVIEW_REQUIRED');

  claimDb.recordClassification(dbPath, policyClaim.trackingNumber, classification, policyClaim);
  const snapshot = createQueueSnapshot([policyClaim], { asOf: '2026-06-10', createdAt: '2026-06-10T12:00:00Z' });
  const snapshotId = claimDb.saveQueueSnapshot(dbPath, snapshot);
  assert.ok(snapshotId > 0);
  assert.ok(claimDb.recordWorkerRevalidation(dbPath, { snapshotId, trackingNumber: 'POLICY1', allowed: true, reason: 'REVALIDATED', snapshotHash: snapshot.snapshotHash, result: classification }) > 0);

  // Representative schema-v4 database migrates forward without losing shipment rows.
  const v4Path = path.join(root, 'v4.sqlite');
  const v4 = new DatabaseSync(v4Path);
  v4.exec(`CREATE TABLE shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tracking_number TEXT NOT NULL UNIQUE, service_code TEXT NOT NULL DEFAULT '',
    reference_number TEXT NOT NULL DEFAULT '', destination_postal_code TEXT NOT NULL DEFAULT '', ship_date TEXT NOT NULL DEFAULT '',
    expected_date TEXT NOT NULL DEFAULT '', delivery_date TEXT NOT NULL DEFAULT '', current_status TEXT NOT NULL DEFAULT '',
    classification TEXT NOT NULL DEFAULT '', eligibility_reason TEXT NOT NULL DEFAULT '', last_checked_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, raw_json TEXT NOT NULL DEFAULT '{}');
    INSERT INTO shipments (tracking_number, created_at, updated_at) VALUES ('MIGRATE4', '2026-01-01', '2026-01-01');
    PRAGMA user_version = 4;`);
  v4.close();
  const migratedV4 = claimDb.openDatabase(v4Path);
  assert.strictEqual(migratedV4.prepare('PRAGMA user_version').get().user_version, claimDb.SCHEMA_VERSION);
  assert.strictEqual(migratedV4.prepare("SELECT tracking_number FROM shipments WHERE tracking_number = 'MIGRATE4'").get().tracking_number, 'MIGRATE4');
  assert.ok(migratedV4.prepare("SELECT name FROM pragma_table_info('shipments') WHERE name = 'first_attempt_date'").get());
  migratedV4.close();

  console.log('Database tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
