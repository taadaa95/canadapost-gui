'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claimDb = require('../lib/claim-database');
const { classifyEligibility } = require('../lib/policy-engine');
const { parseTrackingJson } = require('../lib/tracking-json');
const { buildCanonicalShipment, buildClassificationInput } = require('../lib/normalized-shipment');
const { atomicPromoteTextFiles, restorePreviousTextFiles, validatePromotedTrackingSummary, validateTrackingRunForSubmission } = require('../lib/tracking-run-staging');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-tracking-integrity-'));
const dbPath = path.join(root, 'database', 'app.sqlite');
const pin = 'SYNTHETIC-INTEGRITY-1';
const settings = {
  sender: { name: 'Synthetic', address: '1 Synthetic', city: 'Ottawa', province: 'ON', postalCode: 'K1A0B1' },
  contact: { name: 'Synthetic', email: 'synthetic@example.invalid' }
};

function canonicalFor(trackingNumber, events = [
  { eventIdentifier: 'SYN-ATTEMPT', eventDescription: 'Delivery attempt made', eventDate: '2025-06-04' },
  { eventIdentifier: '1496', eventDescription: 'Delivered', eventDate: '2025-06-05' }
]) {
  return buildCanonicalShipment({
    detail: parseTrackingJson({
      pin: trackingNumber,
      activeExists: true,
      archiveExists: false,
      signatureImageExists: false,
      suppressSignature: false,
      serviceName: 'Xpresspost',
      expectedDeliveryDate: '2025-06-03',
      significantEvents: events.map(event => ({ eventTime: '10:00:00', ...event }))
    }, trackingNumber),
    row: {
      'Shipment Date': '2025-06-01',
      'Destination Province': 'ON',
      'Destination Postal Code': 'K1A0B1',
      'Reference #': 'SYNTHETIC'
    },
    trackingNumber
  });
}

const canonicalShipment = canonicalFor(pin);
const baseInput = buildClassificationInput(canonicalShipment, settings);

try {
  const sharedDelivery = canonicalFor('SYNTHETIC-SHARED-DELIVERY', [
    { eventIdentifier: '1496', eventDescription: 'Delivered', eventDate: '2025-06-05', eventTime: '10:00:00', eventTimeZone: 'EDT' }
  ]);
  claimDb.saveTrackingNormalization(dbPath, 'SYNTHETIC-SHARED-DELIVERY', sharedDelivery, []);
  const sharedShipment = claimDb.withDatabase(dbPath, db => db.prepare('SELECT first_attempt_date, delivery_date FROM shipments WHERE tracking_number = ?').get('SYNTHETIC-SHARED-DELIVERY'));
  assert.strictEqual(sharedShipment.first_attempt_date, '2025-06-05');
  assert.strictEqual(sharedShipment.delivery_date, '2025-06-05', 'actual delivery must be stored separately even when its timestamp matches first attempt');
  assert.strictEqual(sharedDelivery.firstAttemptAndActualDeliverySameEvent, true);

  const completedRun = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
  const completedClassification = classifyEligibility(baseInput, { asOf: '2025-06-10', classificationTimestamp: '2025-06-10T12:00:00Z' });
  claimDb.promoteTrackingBatch(dbPath, [{ pin, canonicalShipment, rawEvents: [], classification: completedClassification, classificationInput: baseInput }], { runId: completedRun });
  claimDb.finishRun(dbPath, completedRun, 'complete', { total: 1, success: 1 });
  const completedId = claimDb.currentClassification(dbPath, pin).id;
  const persistedProvenance = claimDb.withDatabase(dbPath, db => ({
    classificationInput: JSON.parse(db.prepare('SELECT input_json FROM classification_records WHERE id = ?').get(completedId).input_json),
    deliveryEvent: db.prepare("SELECT source_code, description, normalized_json FROM tracking_events te JOIN shipments s ON s.id = te.shipment_id WHERE s.tracking_number = ? AND te.normalized_type = 'SUCCESSFUL_DELIVERY' ORDER BY te.id DESC LIMIT 1").get(pin)
  }));
  assert.strictEqual(persistedProvenance.classificationInput.originalExpectedDeliveryDate, '2025-06-03');
  assert.strictEqual(persistedProvenance.classificationInput.expectedDeliverySource, 'tracking_api.expectedDeliveryDate');
  assert.strictEqual(persistedProvenance.classificationInput.actualDeliveryEventCode, '1496');
  assert.strictEqual(persistedProvenance.deliveryEvent.source_code, '1496');
  assert.strictEqual(persistedProvenance.deliveryEvent.description, 'Delivered');

  const incompleteRun = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
  const incompleteCanonical = canonicalFor(pin, [
    { eventIdentifier: '0100', eventDescription: 'Item in transit', eventDate: '2025-06-04' }
  ]);
  const incompleteInput = buildClassificationInput(incompleteCanonical, settings);
  const incompleteClassification = classifyEligibility(incompleteInput, { asOf: '2025-06-10', classificationTimestamp: '2025-06-10T13:00:00Z' });
  claimDb.promoteTrackingBatch(dbPath, [{ pin, canonicalShipment: incompleteCanonical, rawEvents: [], classification: incompleteClassification, classificationInput: incompleteInput }], { runId: incompleteRun });
  claimDb.finishRun(dbPath, incompleteRun, 'blocked', { total: 1, failure: 1 });
  assert.notStrictEqual(claimDb.currentClassification(dbPath, pin).id, completedId);

  const discarded = claimDb.discardIncompleteTrackingRun(dbPath);
  assert.strictEqual(discarded.discarded, true);
  assert.strictEqual(discarded.historicalRecordsPreserved, true);
  assert.strictEqual(discarded.revertedClassifications, 1);
  assert.strictEqual(claimDb.currentClassification(dbPath, pin).id, completedId, 'previous completed result must become current again');
  assert.strictEqual(claimDb.classificationHistory(dbPath, pin).length, 2, 'discard must preserve immutable history');
  assert.strictEqual(claimDb.latestTrackingRun(dbPath).status, 'discarded');

  const failedRun = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
  claimDb.finishRun(dbPath, failedRun, 'failed', { failure: 1 });
  assert.strictEqual(claimDb.latestTrackingRun(dbPath).status, 'failed', 'an incomplete failed run must remain authoritative for Step 3 blocking');

  assert.deepStrictEqual(validatePromotedTrackingSummary({
    status: 'COMPLETE', statePromoted: true, queuePreserved: false,
    diagnosticMode: false, total: 2, attempted: 2
  }), { ok: true });
  assert.strictEqual(validatePromotedTrackingSummary({
    status: 'INCOMPLETE', statePromoted: false, queuePreserved: true,
    diagnosticMode: false, total: 2, attempted: 1
  }).ok, false);
  assert.strictEqual(validateTrackingRunForSubmission(null).ok, false);
  assert.strictEqual(validateTrackingRunForSubmission({ status: 'running' }).ok, false);
  assert.strictEqual(validateTrackingRunForSubmission({ status: 'stopped' }).ok, false);
  assert.strictEqual(validateTrackingRunForSubmission({ status: 'failed' }).ok, false);
  assert.strictEqual(validateTrackingRunForSubmission({ status: 'blocked' }).ok, false);
  assert.strictEqual(validateTrackingRunForSubmission({ status: 'complete_with_warnings' }).ok, false);
  assert.deepStrictEqual(validateTrackingRunForSubmission({ status: 'complete' }), { ok: true });

  const first = path.join(root, 'claims.csv');
  const second = path.join(root, 'eligibility-review.csv');
  fs.writeFileSync(first, 'previous claims\n');
  fs.writeFileSync(second, 'previous review\n');
  assert.throws(() => atomicPromoteTextFiles([
    { path: first, content: 'new claims\n' },
    { path: second, content: 'new review\n' }
  ], { runId: 'synthetic', afterPromote: () => { throw new Error('synthetic database failure'); } }), /synthetic database failure/);
  assert.strictEqual(fs.readFileSync(first, 'utf8'), 'previous claims\n');
  assert.strictEqual(fs.readFileSync(second, 'utf8'), 'previous review\n');

  const backupDirectory = path.join(root, 'tracking-runs', 'run-99');
  atomicPromoteTextFiles([
    { path: first, content: 'completed replacement claims\n' },
    { path: second, content: 'completed replacement review\n' }
  ], { runId: '99', backupDirectory });
  assert.strictEqual(fs.readFileSync(first, 'utf8'), 'completed replacement claims\n');
  const restoredFiles = restorePreviousTextFiles(backupDirectory, root);
  assert.strictEqual(restoredFiles.restored, true);
  assert.strictEqual(fs.readFileSync(first, 'utf8'), 'previous claims\n');
  assert.strictEqual(fs.readFileSync(path.join(backupDirectory, 'claims.csv.discarded-current'), 'utf8'), 'completed replacement claims\n');

  const beforeCount = claimDb.classificationHistory(dbPath, pin).length;
  assert.throws(() => claimDb.promoteTrackingBatch(dbPath, [
    { pin, canonicalShipment, rawEvents: [], classification: completedClassification, classificationInput: baseInput },
    { pin: 'SYNTHETIC-INTEGRITY-2', canonicalShipment: null, rawEvents: [], classification: completedClassification, classificationInput: { ...baseInput, trackingNumber: 'SYNTHETIC-INTEGRITY-2' } }
  ], { runId: completedRun }));
  assert.strictEqual(claimDb.classificationHistory(dbPath, pin).length, beforeCount, 'batch promotion must roll back as one database transaction');
  console.log('Incomplete Tracking run isolation and discard tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
