'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { classifyEligibility } = require('../lib/policy-engine');

const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tracking-run-284-parity-sanitized.json'), 'utf8'));
const corrected = snapshot.originalRuleLateEvidence.map(record => classifyEligibility({
  trackingNumber: record.id,
  serviceCode: 'DOM.EP',
  expectedDeliveryDate: record.standard,
  originalExpectedDeliveryDate: record.standard,
  revisedExpectedDeliveryDate: record.revised,
  firstAttemptDate: record.firstAttempt,
  actualDeliveryDate: record.delivered,
  normalizedEvents: [],
  exclusionSignals: [],
  conflictCodes: []
}, { asOf: '2026-07-29', classificationTimestamp: '2026-07-29T17:26:21.930Z' }));

assert(corrected.every(result => result.classification === 'LATE_CANDIDATE'));
assert.strictEqual(corrected.length, 19, 'audited evidence must derive the corrected candidate count');
assert.strictEqual(snapshot.originalRuleLateEvidence.filter(item => item.suppression === 'first_attempt').length, 6);
assert.strictEqual(snapshot.originalRuleLateEvidence.filter(item => item.suppression === 'revised_date').length, 8);
assert.strictEqual(snapshot.originalRuleLateEvidence.filter(item => item.priorResult === 'LATE_CANDIDATE').length, snapshot.currentCandidateCount);
assert.strictEqual(
  corrected.length + snapshot.deliveredOnOrBeforeOriginalStandard + snapshot.missingSuccessfulDeliveryEvidence,
  snapshot.totalRecords,
  'sanitized audit buckets must account for all 284 records'
);

console.log('Sanitized 284-row Step 2 classification parity test passed.');
