'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('../lib/canonical-json');
const { parseTrackingJson } = require('../lib/tracking-json');
const { evaluateTrackingSemantics } = require('../lib/tracking-semantics');
const { classifyEligibility } = require('../lib/policy-engine');
const {
  NORMALIZED_SHIPMENT_SCHEMA_VERSION,
  buildCanonicalShipment,
  sanitizeCanonicalShipment,
  buildClassificationInput,
  validateCanonicalShipment,
  validateClassificationInput,
  assertClassificationInvariant
} = require('../lib/normalized-shipment');
const { validateTrackingStagingItem } = require('../lib/tracking-run-staging');

const payload = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tracking-delivered-1442.json'), 'utf8'));
const detail = parseTrackingJson(payload, payload.pin);
const row = {
  'Tracking PIN': payload.pin,
  'Service Code': '',
  'Shipment Date': '2026-06-01',
  'Destination Province': 'ON',
  'Destination Postal Code': 'K1A0B1',
  'Reference #': 'SYNTHETIC-1442'
};
const settings = {
  sender: { name: 'Synthetic', address: '1 Test', city: 'Ottawa', province: 'ON', postalCode: 'K1A0B1' },
  contact: { name: 'Synthetic', email: 'synthetic@example.invalid' }
};

const diagnosticCanonical = buildCanonicalShipment({ detail, row, trackingNumber: payload.pin });
const bulkCanonical = buildCanonicalShipment({ detail, row, trackingNumber: payload.pin });
assert.strictEqual(canonicalize(diagnosticCanonical), canonicalize(bulkCanonical), 'diagnostic and bulk canonical normalization must be byte-identical');
assert.strictEqual(diagnosticCanonical.schemaVersion, NORMALIZED_SHIPMENT_SCHEMA_VERSION);
assert.strictEqual(diagnosticCanonical.serviceProvenance, 'tracking_api');
assert.strictEqual(diagnosticCanonical.firstAttemptEventCode, '1442');
assert.strictEqual(diagnosticCanonical.firstAttemptCategory, 'SUCCESSFUL_DELIVERY');
assert.strictEqual(diagnosticCanonical.firstAttemptAt, diagnosticCanonical.actualDeliveryAt);
assert.strictEqual(diagnosticCanonical.firstAttemptAndActualDeliverySameEvent, true);
validateCanonicalShipment(diagnosticCanonical, 'test-diagnostic');

const serialized = JSON.stringify(sanitizeCanonicalShipment(diagnosticCanonical, { includeTrackingNumber: true, includePrivateMetadata: true }));
const restored = JSON.parse(serialized);
validateCanonicalShipment(restored, 'test-serialized');
assert.strictEqual(restored.firstAttemptAt, diagnosticCanonical.firstAttemptAt);
assert.strictEqual(restored.actualDeliveryAt, diagnosticCanonical.actualDeliveryAt);
assert.strictEqual(restored.serviceProvenance, 'tracking_api');
assert.strictEqual(restored.firstAttemptEventCode, '1442');

const diagnosticInput = buildClassificationInput(diagnosticCanonical, settings);
const bulkInput = buildClassificationInput(bulkCanonical, settings);
validateClassificationInput(diagnosticInput, 'test-policy-input');
assert.strictEqual(canonicalize(diagnosticInput), canonicalize(bulkInput), 'diagnostic and bulk policy inputs must be byte-identical');
assert.strictEqual(diagnosticInput.firstAttemptAt, diagnosticCanonical.firstAttemptAt);
const semantics = evaluateTrackingSemantics({ detail, canonicalShipment: diagnosticCanonical, service: { recognized: true, source: diagnosticCanonical.serviceProvenance }, stateModified: false });
const diagnosticClassification = classifyEligibility(diagnosticInput, { asOf: '2026-06-10', classificationTimestamp: '2026-06-10T12:00:00Z' });
const bulkClassification = classifyEligibility(bulkInput, { asOf: '2026-06-10', classificationTimestamp: '2026-06-10T12:00:00Z' });
assert.strictEqual(canonicalize(diagnosticClassification), canonicalize(bulkClassification));
assert(!diagnosticClassification.missingEvidence.includes('firstAttemptDate'));
assert(!diagnosticClassification.missingEvidence.includes('actualDeliveryDate'));
assertClassificationInvariant(diagnosticCanonical, diagnosticInput, diagnosticClassification, { semanticPassed: semantics.passed });
validateTrackingStagingItem({ pin: payload.pin, canonicalShipment: diagnosticCanonical, classificationInput: diagnosticInput, classification: diagnosticClassification, rawEvents: [] });
assert.throws(
  () => validateTrackingStagingItem({ pin: payload.pin, canonicalShipment: diagnosticCanonical, classificationInput: diagnosticInput, classification: diagnosticClassification, rawEvents: [{ private: 'must-not-stage' }] }),
  /Raw shipment events/
);

assert.throws(() => validateCanonicalShipment({ ...diagnosticCanonical, firstAttemptAt: '', firstAttemptDate: '2026-06-04' }, 'test-loss'), /first-attempt|same-event/i);
const lostInput = { ...diagnosticInput, firstAttemptAt: '', firstAttemptDate: '' };
assert.throws(() => validateClassificationInput(lostInput, 'test-loss'), /same-event|truncated/i);
const incompleteRowCanonical = buildCanonicalShipment({ detail, row: { ...row, 'Shipment Date': '' }, trackingNumber: payload.pin });
const incompleteInput = buildClassificationInput(incompleteRowCanonical, settings);
const incompleteClassification = classifyEligibility(incompleteInput, { asOf: '2026-06-10', classificationTimestamp: '2026-06-10T12:00:00Z' });
assert.strictEqual(incompleteClassification.classification, 'LATE_CANDIDATE');
assert.strictEqual(assertClassificationInvariant(incompleteRowCanonical, incompleteInput, incompleteClassification, { semanticPassed: true }), true);

const invalidDateCanonical = buildCanonicalShipment({ detail, row: { ...row, 'Shipment Date': '2026-02-30' }, trackingNumber: payload.pin });
const invalidDateInput = buildClassificationInput(invalidDateCanonical, settings);
const invalidDateClassification = classifyEligibility(invalidDateInput, { asOf: '2026-06-10', classificationTimestamp: '2026-06-10T12:00:00Z' });
assert.strictEqual(invalidDateClassification.classification, 'LATE_CANDIDATE');
assert.strictEqual(assertClassificationInvariant(invalidDateCanonical, invalidDateInput, invalidDateClassification, { semanticPassed: true }), true);

const firstAttemptLostInput = { ...diagnosticInput, firstAttemptAt: '', firstAttemptDate: '', firstAttemptAndActualDeliverySameEvent: false };
assert.throws(
  () => assertClassificationInvariant(diagnosticCanonical, firstAttemptLostInput, diagnosticClassification, { semanticPassed: true }),
  error => error.code === 'NORMALIZED_FIRST_ATTEMPT_LOST'
);

const unresolvedCanonical = buildCanonicalShipment({ detail: { ...detail, serviceName: '', serviceName2: '' }, row: { ...row, 'Service Code': '' }, trackingNumber: payload.pin });
const unresolvedInput = buildClassificationInput(unresolvedCanonical, settings);
const unresolvedClassification = classifyEligibility(unresolvedInput, { asOf: '2026-06-10', classificationTimestamp: '2026-06-10T12:00:00Z' });
assert.strictEqual(unresolvedClassification.classification, 'LATE_CANDIDATE');
assert.strictEqual(assertClassificationInvariant(unresolvedCanonical, unresolvedInput, unresolvedClassification, { semanticPassed: true }), true);

assert.throws(
  () => assertClassificationInvariant(diagnosticCanonical, { ...diagnosticInput, canonicalEvidenceHash: '0'.repeat(64) }, diagnosticClassification, { semanticPassed: true }),
  error => error.code === 'EVIDENCE_HASH_MISMATCH'
);
assert.throws(
  () => validateCanonicalShipment({ ...diagnosticCanonical, evidenceHash: '0'.repeat(64) }, 'test-hash'),
  error => error.code === 'EVIDENCE_HASH_MISMATCH'
);

console.log('Canonical diagnostic/bulk parity and classification invariant tests passed.');
