'use strict';

const assert = require('assert');
const { classifyEligibility, serializeClassification, policy, POLICY_COVERAGE, policyGuidanceFor } = require('../lib/policy-engine');
const { CLASSIFICATIONS } = require('../lib/claim-domain');
const { createQueueSnapshot, verifyQueueSnapshot, revalidateQueueItem } = require('../lib/eligibility-revalidation');

function shipment(overrides = {}) {
  return {
    trackingNumber: 'SYNTHETIC000001',
    serviceCode: '',
    shipmentDate: '',
    expectedDeliveryDate: '2026-06-03',
    originalExpectedDeliveryDate: '2026-06-03',
    firstAttemptDate: '2026-06-04',
    actualDeliveryDate: '2026-06-04',
    destinationProvince: 'ON',
    normalizedEvents: [],
    exclusionSignals: [],
    conflictCodes: [],
    ...overrides
  };
}

const fixed = { asOf: '2026-06-10', classificationTimestamp: '2026-06-10T12:00:00.000Z' };
assert.deepStrictEqual(CLASSIFICATIONS, ['LATE_CANDIDATE', 'ON_TIME', 'REVIEW_REQUIRED', 'TRACKING_ERROR']);

const late = classifyEligibility(shipment(), fixed);
assert.equal(late.classification, 'LATE_CANDIDATE');
assert.equal(late.expectedDeliveryDate, '2026-06-03');
assert.equal(late.firstAttemptDate, '2026-06-04');
assert.equal(late.policyVersion, '');
assert.equal(late.serviceRule.code, '');

const finalDeliveryControls = classifyEligibility(shipment({ firstAttemptDate: '2026-06-03', actualDeliveryDate: '2026-06-08' }), fixed);
assert.equal(finalDeliveryControls.classification, 'LATE_CANDIDATE');
assert(finalDeliveryControls.reasonCodes.includes('SUCCESSFUL_DELIVERY_AFTER_DELIVERY_STANDARD'));
assert.equal(finalDeliveryControls.actualDeliveryDate, '2026-06-08');

const deliveryOnlyLate = classifyEligibility(shipment({ firstAttemptDate: '', actualDeliveryDate: '2026-06-05' }), fixed);
assert.equal(deliveryOnlyLate.classification, 'LATE_CANDIDATE');
assert.equal(deliveryOnlyLate.firstAttemptDate, '2026-06-05');
assert.equal(deliveryOnlyLate.firstAttemptDerivedFromSuccessfulDelivery, true);

const deliveryOnlyOnTime = classifyEligibility(shipment({ firstAttemptDate: '', actualDeliveryDate: '2026-06-03' }), fixed);
assert.equal(deliveryOnlyOnTime.classification, 'ON_TIME');

const earlierFailedAttempt = classifyEligibility(shipment({ firstAttemptDate: '2026-06-02', actualDeliveryDate: '2026-06-05' }), fixed);
assert.equal(earlierFailedAttempt.classification, 'LATE_CANDIDATE');
assert.equal(earlierFailedAttempt.firstAttemptDate, '2026-06-02');

const missingExpected = classifyEligibility(shipment({ expectedDeliveryDate: '', originalExpectedDeliveryDate: '', revisedExpectedDeliveryDate: '' }), fixed);
assert.equal(missingExpected.classification, 'REVIEW_REQUIRED');
assert(missingExpected.missingEvidence.includes('expectedDeliveryDate'));

const missingAttempt = classifyEligibility(shipment({ firstAttemptDate: '', actualDeliveryDate: '' }), fixed);
assert.equal(missingAttempt.classification, 'REVIEW_REQUIRED');
assert(missingAttempt.missingEvidence.includes('actualDeliveryDate'));

const revisedExpected = classifyEligibility(shipment({ expectedDeliveryDate: '2026-06-03', originalExpectedDeliveryDate: '2026-06-03', revisedExpectedDeliveryDate: '2026-06-05', firstAttemptDate: '2026-06-04', actualDeliveryDate: '2026-06-04' }), fixed);
assert.equal(revisedExpected.classification, 'LATE_CANDIDATE');
assert.equal(revisedExpected.expectedDeliveryDate, '2026-06-03');

assert.equal(classifyEligibility(shipment({ serviceCode: 'UNKNOWN' }), fixed).classification, 'LATE_CANDIDATE');
assert.equal(classifyEligibility(shipment({ serviceCode: 'DOM.RP' }), fixed).classification, 'LATE_CANDIDATE');
assert.equal(classifyEligibility(shipment({ exclusionSignals: ['RETURN_TO_SENDER'] }), fixed).classification, 'LATE_CANDIDATE');
assert.equal(classifyEligibility(shipment({ shipmentDate: '2024-12-31' }), fixed).classification, 'LATE_CANDIDATE');

const contradictory = classifyEligibility(shipment({ firstAttemptDate: '2026-06-06', actualDeliveryDate: '2026-06-05' }), fixed);
assert.equal(contradictory.classification, 'LATE_CANDIDATE');
assert(contradictory.warningCodes.includes('FIRST_ATTEMPT_AFTER_DELIVERY_WARNING'));
const invalid = classifyEligibility(shipment({ expectedDeliveryDate: '2026-02-30', originalExpectedDeliveryDate: '' }), fixed);
assert.equal(invalid.classification, 'REVIEW_REQUIRED');

const requiredCases = [
  [{ originalExpectedDeliveryDate: '2026-07-15', expectedDeliveryDate: '2026-07-15', firstAttemptDate: '2026-07-15', actualDeliveryDate: '2026-07-18' }, 'LATE_CANDIDATE'],
  [{ originalExpectedDeliveryDate: '2026-07-15', expectedDeliveryDate: '2026-07-15', revisedExpectedDeliveryDate: '2026-07-18', actualDeliveryDate: '2026-07-17' }, 'LATE_CANDIDATE'],
  [{ originalExpectedDeliveryDate: '2026-07-15', expectedDeliveryDate: '2026-07-15', actualDeliveryDate: '2026-07-15' }, 'ON_TIME'],
  [{ originalExpectedDeliveryDate: '2026-07-15', expectedDeliveryDate: '2026-07-15', actualDeliveryDate: '2026-07-14' }, 'ON_TIME'],
  [{ originalExpectedDeliveryDate: '2026-07-15', expectedDeliveryDate: '2026-07-15', firstAttemptDate: '2026-07-16', actualDeliveryDate: '' }, 'REVIEW_REQUIRED']
];
for (const [overrides, expected] of requiredCases) {
  assert.equal(classifyEligibility(shipment(overrides), { asOf: '2026-07-20', classificationTimestamp: '2026-07-20T12:00:00Z' }).classification, expected);
}

const serviceWarning = classifyEligibility(shipment({ serviceCode: 'DOM.RP' }), fixed);
assert.equal(serviceWarning.classification, 'LATE_CANDIDATE');
assert(serviceWarning.warningCodes.includes('SERVICE_GUARANTEE_UNVERIFIED_ADVISORY'));
const windowWarning = classifyEligibility(shipment(), { asOf: '2026-08-01', classificationTimestamp: '2026-08-01T12:00:00Z' });
assert.equal(windowWarning.classification, 'LATE_CANDIDATE');
assert(windowWarning.warningCodes.includes('CLAIM_WINDOW_UNVERIFIED_WARNING'));
assert(!windowWarning.warningCodes.includes('CLAIM_WINDOW_PASSED_WARNING'));
assert.equal(windowWarning.claimSubmissionDeadlineState, 'unverified_advisory');
assert.equal(windowWarning.policyGuidanceState, 'unverified_advisory');

const coverageBoundaries = [
  ['2025-01-05', 'policy_review_required'],
  [POLICY_COVERAGE.from, 'unverified_advisory'],
  [POLICY_COVERAGE.through, 'unverified_advisory'],
  ['2026-07-27', 'policy_review_required']
];
for (const [date, state] of coverageBoundaries) {
  const guidance = policyGuidanceFor(date);
  assert.equal(guidance.state, state, `Unexpected guidance at policy boundary ${date}`);
  const boundaryResult = classifyEligibility(shipment({
    expectedDeliveryDate: date,
    originalExpectedDeliveryDate: date,
    actualDeliveryDate: '2026-08-01'
  }), { asOf: '2026-08-01', classificationTimestamp: '2026-08-01T12:00:00Z' });
  assert.equal(boundaryResult.classification, 'LATE_CANDIDATE');
  assert.equal(boundaryResult.policyGuidanceState, state);
  assert(!boundaryResult.warningCodes.includes('CLAIM_WINDOW_PASSED_WARNING'));
}

const deterministicA = classifyEligibility(shipment(), fixed);
const deterministicB = classifyEligibility(shipment(), fixed);
assert.equal(serializeClassification(deterministicA), serializeClassification(deterministicB));
assert.equal(deterministicA.evidenceHash, deterministicB.evidenceHash);
assert.equal(deterministicA.evidenceHash, windowWarning.evidenceHash, 'time-sensitive advisory status must stay outside core evidence identity');

const snapshotClaim = shipment();
const snapshot = createQueueSnapshot([snapshotClaim], { asOf: '2026-06-10', createdAt: fixed.classificationTimestamp });
assert(verifyQueueSnapshot(snapshot, [snapshotClaim]).ok);
assert.equal(revalidateQueueItem({ snapshot, claims: [snapshotClaim], claim: snapshotClaim, currentEvidence: {}, options: fixed }).allowed, true);
const laterRevalidation = revalidateQueueItem({ snapshot, claims: [snapshotClaim], claim: snapshotClaim, currentEvidence: {}, options: { asOf: '2026-08-01', classificationTimestamp: fixed.classificationTimestamp } });
assert.equal(laterRevalidation.allowed, true, 'calendar passage does not change late-candidate evidence');
const changedPolicySnapshot = { ...snapshot, policyDataVersion: 'older-model' };
const snapshotBody = { version: changedPolicySnapshot.version, createdAt: changedPolicySnapshot.createdAt, policyDataVersion: changedPolicySnapshot.policyDataVersion, items: changedPolicySnapshot.items };
changedPolicySnapshot.snapshotHash = require('../lib/canonical-json').sha256Canonical(snapshotBody);
assert.equal(revalidateQueueItem({ snapshot: changedPolicySnapshot, claims: [snapshotClaim], claim: snapshotClaim, currentEvidence: {}, options: fixed }).reason, 'POLICY_DATA_VERSION_CHANGED');

assert.equal(policy.dataVersion, 'late-candidate-v2');
console.log('Simplified late-candidate classification tests passed.');
