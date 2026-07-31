'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claimDb = require('../lib/claim-database');
const { classifyEligibility } = require('../lib/policy-engine');
const privacy = require('../lib/privacy-deletion');
const { OperationCoordinator } = require('../lib/operation-coordinator');
const { assertReceiptSafe } = require('../lib/deletion-receipt');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-privacy-'));
const dataDir = path.join(root, 'data');
const logDir = path.join(root, 'logs');
const dbPath = path.join(root, 'database', 'app.sqlite');

function classification(trackingNumber) {
  const input = {
    trackingNumber,
    referenceNumber: `PERSONAL-${trackingNumber}`,
    destinationPostalCode: 'K1A0B1',
    destinationProvince: 'ON',
    serviceCode: 'DOM.XP',
    originalExpectedDeliveryDate: '2026-06-01',
    expectedDeliveryDate: '2026-06-01',
    actualDeliveryDate: '2026-06-03',
    receiver: { name: 'Synthetic Receiver', address: '1 Synthetic Street', email: 'synthetic@example.test' }
  };
  return { input, result: classifyEligibility(input, { asOf: '2026-06-04', classificationTimestamp: '2026-06-04T12:00:00.000Z' }) };
}

(async () => {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    await claimDb.initializeDatabase(dbPath, { backupDirectory: path.join(root, 'migration-backups') });
    const selectedTracking = '5555555555555555';
    const unrelatedTracking = '6666666666666666';
    const failedTracking = '7777777777777777';
    const selectedClassification = classification(selectedTracking);
    const unrelatedClassification = classification(unrelatedTracking);
    claimDb.recordClassification(dbPath, selectedTracking, selectedClassification.result, selectedClassification.input);
    claimDb.recordClassification(dbPath, unrelatedTracking, unrelatedClassification.result, unrelatedClassification.input);
    const failedClassification = classification(failedTracking);
    claimDb.recordClassification(dbPath, failedTracking, failedClassification.result, failedClassification.input);
    claimDb.ingestTrackingEvent(dbPath, null, { type: 'pin_late', pin: selectedTracking, classification: 'LATE_CANDIDATE', expectedDate: '2026-06-01', deliveryDate: '2026-06-03' });
    const screenshot = path.join(dataDir, 'claim-synthetic.png');
    const pageText = path.join(logDir, 'claim-synthetic.txt');
    const generatedExport = path.join(dataDir, 'owned-export.csv');
    fs.writeFileSync(screenshot, 'synthetic png');
    fs.writeFileSync(pageText, 'synthetic page text');
    fs.writeFileSync(generatedExport, 'synthetic export');
    const attemptId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: selectedTracking });
    claimDb.completeClaimAttempt(dbPath, attemptId, { status: 'submitted', confirmationNumber: 'SYNTHETIC', screenshotPath: screenshot, textPath: pageText });
    claimDb.recordFinancialEntry(dbPath, { trackingNumber: selectedTracking, valueType: 'claimed', amountMinor: 1234, currency: 'CAD', source: 'manual', note: 'synthetic' });
    claimDb.withDatabase(dbPath, db => {
      const shipment = db.prepare('SELECT id FROM shipments WHERE tracking_number = ?').get(selectedTracking);
      const unrelatedShipment = db.prepare('SELECT id FROM shipments WHERE tracking_number = ?').get(unrelatedTracking);
      const selectedRecord = db.prepare('SELECT id, input_hash, evidence_hash FROM classification_records WHERE shipment_id = ? ORDER BY id DESC').get(shipment.id);
      const unrelatedRecord = db.prepare('SELECT id, input_hash, evidence_hash FROM classification_records WHERE shipment_id = ? ORDER BY id DESC').get(unrelatedShipment.id);
      db.prepare("INSERT INTO generated_exports (shipment_id, export_type, file_path, created_at) VALUES (?, 'claim', ?, '2026-06-04T12:00:00.000Z')").run(shipment.id, generatedExport);
      db.prepare("UPDATE claim_attempts SET reconciliation_action = 'submitted', reconciliation_note = 'synthetic' WHERE id = ?").run(attemptId);
      const snapshot = db.prepare(`INSERT INTO queue_snapshots
        (snapshot_hash, snapshot_identity, policy_data_version, status, item_count, snapshot_json, created_at)
        VALUES (?, 'synthetic-shared', 'synthetic', 'reviewed', 2, ?, '2026-06-04T12:00:00.000Z')`).run('a'.repeat(64), JSON.stringify({
          version: 1, createdAt: '2026-06-04T12:00:00.000Z', policyDataVersion: 'synthetic',
          items: [{ trackingNumber: selectedTracking }, { trackingNumber: unrelatedTracking }]
        }));
      const insertSnapshotItem = db.prepare(`INSERT INTO queue_snapshot_items
        (snapshot_id, shipment_id, classification_id, ordinal, input_hash, classification_evidence_hash) VALUES (?, ?, ?, ?, ?, ?)`);
      insertSnapshotItem.run(snapshot.lastInsertRowid, shipment.id, selectedRecord.id, 0, selectedRecord.input_hash, selectedRecord.evidence_hash);
      insertSnapshotItem.run(snapshot.lastInsertRowid, unrelatedShipment.id, unrelatedRecord.id, 1, unrelatedRecord.input_hash, unrelatedRecord.evidence_hash);
    });
    const failedAttemptId = claimDb.beginClaimAttempt(dbPath, { trackingNumber: failedTracking });
    claimDb.completeClaimAttempt(dbPath, failedAttemptId, { status: 'failed', errorCode: 'SYNTHETIC_FAILURE' });

    const preview = privacy.previewData(dbPath, { trackingNumbers: [selectedTracking] });
    assert.deepStrictEqual(preview.recordCounts, {
      shipments: 1,
      trackingChecks: 1,
      classificationRecords: 1,
      claimAttempts: 1,
      reconciliationRecords: 1,
      financialEntries: 1,
      evidenceFiles: 2,
      screenshots: 1,
      generatedExports: 1
    });
    assert.strictEqual(preview.scope.trackingNumberCount, 1);

    const coordinator = new OperationCoordinator();
    const active = coordinator.begin('step2_bulk_run');
    assert.throws(() => privacy.deleteData({ coordinator, scope: { trackingNumbers: [selectedTracking] } }), /active/i);
    coordinator.end(active);
    assert.throws(() => privacy.deleteData({
      dbPath,
      scope: { trackingNumbers: [selectedTracking] },
      locale: 'en-CA',
      confirmed: true,
      typedPhrase: 'WRONG',
      applicationVersion: '0.4.0-dev.8',
      ownedRoots: [dataDir, logDir],
      transactionRoot: path.join(root, 'transactions'),
      receiptDirectory: path.join(root, 'receipts')
    }), /phrase/i);

    const deletion = privacy.deleteData({
      dbPath,
      scope: { trackingNumbers: [selectedTracking] },
      locale: 'en-CA',
      confirmed: true,
      typedPhrase: privacy.CONFIRMATION_PHRASES['en-CA'].selected,
      secondConfirmed: false,
      applicationVersion: '0.4.0-dev.8',
      ownedRoots: [dataDir, logDir],
      transactionRoot: path.join(root, 'transactions'),
      receiptDirectory: path.join(root, 'receipts'),
      now: new Date('2026-07-30T12:00:00.000Z')
    });
    assert.strictEqual(deletion.ok, true);
    assertReceiptSafe(deletion.receipt);
    const receiptText = fs.readFileSync(deletion.receiptPath, 'utf8');
    assert.ok(!receiptText.includes(selectedTracking));
    assert.ok(!receiptText.includes('Synthetic Receiver'));
    assert.ok(!receiptText.includes('synthetic@example.test'));
    assert.strictEqual(fs.existsSync(screenshot), false);
    assert.strictEqual(fs.existsSync(pageText), false);
    assert.strictEqual(fs.existsSync(generatedExport), false);
    assert.strictEqual(claimDb.withDatabase(dbPath, db => Number(db.prepare('SELECT COUNT(*) AS n FROM shipments WHERE tracking_number = ?').get(selectedTracking).n)), 0);
    assert.strictEqual(claimDb.withDatabase(dbPath, db => Number(db.prepare('SELECT COUNT(*) AS n FROM shipments WHERE tracking_number = ?').get(unrelatedTracking).n)), 1, 'unrelated record must remain unchanged');
    const preservedSnapshot = claimDb.withDatabase(dbPath, db => db.prepare("SELECT * FROM queue_snapshots WHERE snapshot_identity = 'synthetic-shared'").get());
    assert.strictEqual(preservedSnapshot.status, 'invalidated');
    assert.strictEqual(preservedSnapshot.item_count, 1);
    assert.ok(!preservedSnapshot.snapshot_json.includes(selectedTracking), 'selected tracking must be removed from shared snapshots');
    assert.ok(preservedSnapshot.snapshot_json.includes(unrelatedTracking), 'unrelated snapshot evidence must remain');
    assert.strictEqual(claimDb.withDatabase(dbPath, db => Number(db.prepare('SELECT COUNT(*) AS n FROM queue_snapshot_items WHERE snapshot_id = ?').get(preservedSnapshot.id).n)), 1, 'unrelated snapshot item must remain unchanged');
    assert.strictEqual(claimDb.withDatabase(dbPath, db => Number(db.prepare('SELECT COUNT(*) AS n FROM claim_duplicate_tombstones').get().n)), 1);
    assert.throws(() => claimDb.beginClaimAttempt(dbPath, { trackingNumber: selectedTracking }), /privacy-preserved/i, 'anonymized tombstone must preserve duplicate protection');
    assert.deepStrictEqual(claimDb.withDatabase(dbPath, db => claimDb.validateDatabase(db)), { integrity: 'ok', foreignKeyViolations: 0 });

    const transactionRoot = path.join(root, 'interrupted-transactions');
    const interruptedId = '11111111-1111-4111-8111-111111111111';
    const interruptedDirectory = path.join(transactionRoot, `privacy-delete-${interruptedId}`);
    const interruptedSource = path.join(dataDir, 'interrupted-evidence.txt');
    const interruptedStaged = path.join(interruptedDirectory, '0-staged');
    fs.mkdirSync(interruptedDirectory, { recursive: true });
    fs.writeFileSync(interruptedStaged, 'restore after rollback');
    fs.writeFileSync(path.join(interruptedDirectory, 'transaction.json'), JSON.stringify({
      format: 'canadapost-claim-runner-privacy-transaction', version: 1,
      operationId: interruptedId, entries: [{ source: interruptedSource, destination: interruptedStaged }]
    }));
    assert.deepStrictEqual(privacy.recoverInterruptedTransactions({ dbPath, transactionRoot, ownedRoots: [dataDir, logDir] }), { restored: 1, finalized: 0 });
    assert.strictEqual(fs.readFileSync(interruptedSource, 'utf8'), 'restore after rollback');

    const committedId = '22222222-2222-4222-8222-222222222222';
    const committedDirectory = path.join(transactionRoot, `privacy-delete-${committedId}`);
    const committedSource = path.join(dataDir, 'committed-evidence.txt');
    const committedStaged = path.join(committedDirectory, '0-staged');
    fs.mkdirSync(committedDirectory, { recursive: true });
    fs.writeFileSync(committedStaged, 'delete after committed transaction');
    fs.writeFileSync(path.join(committedDirectory, 'transaction.json'), JSON.stringify({
      format: 'canadapost-claim-runner-privacy-transaction', version: 1,
      operationId: committedId, entries: [{ source: committedSource, destination: committedStaged }]
    }));
    claimDb.withDatabase(dbPath, db => db.prepare(`INSERT INTO audit_events (event_type, entity_type, detail_json, created_at)
      VALUES ('privacy_deletion_completed', 'privacy_operation', ?, '2026-07-30T12:00:00.000Z')`).run(JSON.stringify({ operationId: committedId })));
    assert.deepStrictEqual(privacy.recoverInterruptedTransactions({ dbPath, transactionRoot, ownedRoots: [dataDir, logDir] }), { restored: 0, finalized: 1 });
    assert.strictEqual(fs.existsSync(committedDirectory), false);
    assert.strictEqual(fs.existsSync(committedSource), false);

    const failedDeletion = privacy.deleteData({
      dbPath,
      scope: { trackingNumbers: [failedTracking] },
      locale: 'en-CA',
      confirmed: true,
      typedPhrase: privacy.CONFIRMATION_PHRASES['en-CA'].selected,
      applicationVersion: '0.4.0-dev.8',
      ownedRoots: [dataDir, logDir],
      transactionRoot: path.join(root, 'transactions'),
      receiptDirectory: path.join(root, 'receipts')
    });
    assert.strictEqual(failedDeletion.ok, true);
    assert.strictEqual(claimDb.withDatabase(dbPath, db => Number(db.prepare('SELECT COUNT(*) AS n FROM claim_duplicate_tombstones').get().n)), 1, 'failed attempts must not create permanent duplicate tombstones');
    assert.doesNotThrow(() => claimDb.beginClaimAttempt(dbPath, { trackingNumber: failedTracking }), 'a failed attempt may be retried after its personal data is deleted');

    const allPreview = privacy.previewData(dbPath, { allRecords: true });
    assert.strictEqual(allPreview.requiresSecondConfirmation, true);
    assert.throws(() => privacy.deleteData({
      dbPath,
      scope: { allRecords: true },
      locale: 'fr-CA',
      confirmed: true,
      typedPhrase: privacy.CONFIRMATION_PHRASES['fr-CA'].all,
      secondConfirmed: false,
      applicationVersion: '0.4.0-dev.8',
      ownedRoots: [dataDir, logDir],
      transactionRoot: path.join(root, 'transactions'),
      receiptDirectory: path.join(root, 'receipts')
    }), /second confirmation/i);

    const outside = path.join(root, '..', 'outside-evidence.txt');
    fs.writeFileSync(outside, 'outside');
    assert.throws(() => privacy.approvedPath(outside, [path.resolve(dataDir)]), /outside approved/i);
    fs.rmSync(outside, { force: true });

    process.stdout.write('Synthetic privacy preview, deletion, receipt, filesystem and duplicate-protection tests passed.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
