'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claimDb = require('../lib/claim-database');
const { classifyEligibility } = require('../lib/policy-engine');
const { parseTrackingJson } = require('../lib/tracking-json');
const { buildCanonicalShipment, buildClassificationInput } = require('../lib/normalized-shipment');
const { reusableConfirmedOnTime } = require('../lib/on-time-cache');
const { loadCarryForwardRows, buildTrackingWorkload, isActiveUnresolvedClassification } = require('../lib/tracking-workload');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-tracking-workload-'));
const dbPath = path.join(root, 'database', 'app.sqlite');
const settings = {
  sender: { name: 'Synthetic', address: '1 Synthetic', city: 'Ottawa', province: 'ON', postalCode: 'K1A0B1' },
  contact: { name: 'Synthetic', email: 'synthetic@example.invalid' }
};

function sourceRow(pin, shipmentDate, standard = '2026-06-04', overrides = {}) {
  return {
    'Tracking PIN': pin,
    'Shipment Date': shipmentDate,
    'Service Code': 'DOM.XP',
    'Destination Postal Code': 'K1A0B1',
    'Reference #': `RECENT-${pin}`,
    'Original Delivery Standard Date': standard,
    ...overrides
  };
}

function canonical(pin, { shipmentDate = '2026-04-01', standard = '2026-04-05', event = 'Item in transit', eventDate = '2026-04-03', includeExpected = true } = {}) {
  return buildCanonicalShipment({
    detail: parseTrackingJson({
      pin,
      activeExists: true,
      archiveExists: false,
      signatureImageExists: false,
      suppressSignature: false,
      serviceName: 'Xpresspost',
      ...(includeExpected ? { expectedDeliveryDate: standard, originalExpectedDeliveryDate: standard } : {}),
      significantEvents: [{
        eventIdentifier: event === 'Delivered' ? '1496' : 'SYN-ACTIVE',
        eventDescription: event,
        eventDate,
        eventTime: '10:00:00',
        eventTimeZone: 'EDT'
      }]
    }, pin),
    row: sourceRow(pin, shipmentDate, standard),
    trackingNumber: pin
  });
}

function promote(pin, shipment, asOf = '2026-08-13') {
  const input = buildClassificationInput(shipment, settings);
  const classification = classifyEligibility(input, { asOf, classificationTimestamp: `${asOf}T16:00:00Z` });
  const runId = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
  claimDb.promoteTrackingBatch(dbPath, [{ pin, canonicalShipment: shipment, rawEvents: [], classification, classificationInput: input }], { runId });
  claimDb.finishRun(dbPath, runId, 'complete', { total: 1, success: 1 });
  return { input, classification, runId };
}

try {
  const day36 = 'SYN-CARRY-36';
  const day90 = 'SYN-CARRY-90';
  promote(day36, canonical(day36, { shipmentDate: '2026-07-08', standard: '2026-07-12', eventDate: '2026-07-10' }));
  promote(day90, canonical(day90, { shipmentDate: '2026-05-15', standard: '2026-05-20', event: 'Item processed', eventDate: '2026-05-17' }));

  let carry = loadCarryForwardRows(dbPath);
  assert.deepStrictEqual(carry.map(row => row['Tracking PIN']).sort(), [day36, day90]);
  assert.ok(carry.every(row => row.__carryForward === true));
  assert.strictEqual(buildTrackingWorkload([], carry).carryForwardCount, 2, 'carry-forward remains a valid workload when the rolling import is empty');

  const recent = [sourceRow('SYN-RECENT', '2026-08-10'), sourceRow(day36, '2026-08-11', '2099-01-01', { 'Reference #': 'CURRENT-WINS' })];
  const workload = buildTrackingWorkload(recent, carry);
  assert.strictEqual(workload.recentShipmentCount, 2);
  assert.strictEqual(workload.carryForwardCount, 1);
  assert.strictEqual(workload.carryForwardDeduplicated, 1);
  assert.strictEqual(workload.rows.length, 3);
  const duplicate = workload.rows.find(row => row['Tracking PIN'] === day36);
  assert.strictEqual(duplicate['Reference #'], 'CURRENT-WINS', 'current Step 1 enrichment must win');
  assert.strictEqual(duplicate['Original Delivery Standard Date'], '2026-07-12', 'authoritative original standard must override conflicting recent enrichment');

  for (const status of ['failed', 'blocked']) {
    const failedRun = claimDb.startRun(dbPath, 'tracking', { syntheticFailure: status });
    claimDb.finishRun(dbPath, failedRun, status, { failure: 1 });
    carry = loadCarryForwardRows(dbPath);
    assert.ok(carry.some(row => row['Tracking PIN'] === day36), `${status} API/parser failure must preserve prior active carry-forward`);
  }

  const terminalReturn = buildClassificationInput(canonical('SYN-RETURN', { event: 'Returned to sender', eventDate: '2026-06-10' }), settings);
  assert.strictEqual(isActiveUnresolvedClassification(terminalReturn), false, 'explicit return-to-sender evidence is terminal');
  assert.strictEqual(isActiveUnresolvedClassification({ normalizedStatus: 'NO_DELIVERY_EVIDENCE', normalizedEvents: [{ type: 'WEATHER_DISRUPTION' }] }), true, 'recognized delays remain active');
  assert.strictEqual(isActiveUnresolvedClassification({ normalizedStatus: 'NO_DELIVERY_EVIDENCE', normalizedEvents: [{ type: 'UNKNOWN' }] }), true, 'ambiguous nonterminal evidence must be retained conservatively');
  assert.strictEqual(isActiveUnresolvedClassification({ normalizedStatus: 'DELIVERED', actualDeliveryDate: '2026-06-10', normalizedEvents: [] }), false);

  const originalStandard = '2026-07-12';
  const deliveredLate = canonical(day36, {
    shipmentDate: '2026-07-08', standard: originalStandard, event: 'Delivered', eventDate: '2026-07-15', includeExpected: false
  });
  assert.strictEqual(deliveredLate.originalExpectedDelivery, originalStandard, 'carry-forward row must preserve the original Delivery Standard');
  const late = promote(day36, deliveredLate);
  assert.strictEqual(late.classification.classification, 'LATE_CANDIDATE');
  assert.strictEqual(late.input.originalExpectedDeliveryDate, originalStandard);
  assert.ok(!loadCarryForwardRows(dbPath).some(row => row['Tracking PIN'] === day36), 'successful delivery retires carry-forward');

  const onTimePin = 'SYN-CARRY-ONTIME';
  const onTime = promote(onTimePin, canonical(onTimePin, {
    shipmentDate: '2026-06-01', standard: '2026-06-05', event: 'Delivered', eventDate: '2026-06-04'
  }));
  assert.strictEqual(onTime.classification.classification, 'ON_TIME');
  assert.ok(reusableConfirmedOnTime(dbPath, sourceRow(onTimePin, '2026-06-01', '2026-06-05')), 'confirmed on-time cache remains reusable');
  assert.ok(!loadCarryForwardRows(dbPath).some(row => row['Tracking PIN'] === onTimePin));

  const missingStandardPin = 'SYN-MISSING-STANDARD';
  const missing = canonical(missingStandardPin, {
    shipmentDate: '2026-04-01', standard: '', event: 'Delivered', eventDate: '2026-04-20', includeExpected: false
  });
  const missingResult = promote(missingStandardPin, missing);
  assert.strictEqual(missingResult.input.originalExpectedDeliveryDate, '');
  assert.strictEqual(missingResult.classification.classification, 'REVIEW_REQUIRED', 'missing standards must never fabricate late eligibility');

  process.stdout.write('Schema-8 persistent tracking carry-forward, terminal-state and workload contracts passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
