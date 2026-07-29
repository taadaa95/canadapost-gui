'use strict';

// Retained as enrichment metadata for existing database and queue-snapshot formats.
// Late-candidate classification deliberately does not select or reproduce a Canada
// Post policy version; Canada Post remains the authority on claim eligibility.
const policyRules = require('../config/policy-rules.json');
const { normalizeDate, walkBusinessDays } = require('./business-calendar');
const { normalizeClaimInput, assertClassificationResult } = require('./claim-domain');
const { canonicalize, sha256Canonical } = require('./canonical-json');
const { CLASSIFICATION_INPUT_SCHEMA_VERSION, validateClassificationInput } = require('./normalized-shipment');

const LATE_CANDIDATE_MODEL_VERSION = 'late-candidate-v2';
const policy = Object.freeze({ dataVersion: LATE_CANDIDATE_MODEL_VERSION, sourceIds: [] });

function policyVersionFor() { return null; }
function peakPeriodFor() { return null; }

function serviceCodeFromName(serviceName) {
  const name = String(serviceName || '').trim().toLowerCase();
  if (!name) return '';
  if (name.includes('priority worldwide')) return 'INT.PW';
  if (name.includes('xpresspost') && name.includes('international')) return 'INT.XP';
  if (name.includes('xpresspost') && (name.includes('usa') || name.includes('u.s'))) return 'USA.XP';
  if (name.includes('expedited parcel') && (name.includes('usa') || name.includes('u.s'))) return 'USA.EP';
  if (name.includes('tracked packet')) return 'USA.TP';
  if (name.includes('regular parcel')) return 'DOM.RP';
  if (name.includes('expedited parcel')) return 'DOM.EP';
  if (name.includes('xpresspost')) return 'DOM.XP';
  if (/\bpriority\b/i.test(name)) return 'DOM.PC';
  return '';
}

function suppliedInvalidDate(rawInput, names) {
  for (const name of names) {
    const value = rawInput?.[name];
    if (value !== undefined && value !== null && String(value).trim() && !normalizeDate(value)) return true;
  }
  return false;
}

function calendarDaysAfter(expectedDate, deliveryDate) {
  if (!expectedDate || !deliveryDate) return null;
  return Math.round((new Date(`${deliveryDate}T12:00:00Z`) - new Date(`${expectedDate}T12:00:00Z`)) / 86400000);
}

function resultBase(input, rawInput, options) {
  const classificationTimestamp = new Date(options.classificationTimestamp || options.asOf || Date.now()).toISOString();
  const originalExpected = normalizeDate(input.originalExpectedDeliveryDate);
  const revisedExpected = normalizeDate(input.revisedExpectedDeliveryDate);
  const applicableExpected = originalExpected || normalizeDate(input.expectedDeliveryDate);
  const successfulDeliveryAsAttempt = !input.firstAttemptDate && Boolean(input.actualDeliveryDate);
  const firstAttemptDate = input.firstAttemptDate || input.actualDeliveryDate;
  const firstAttemptAt = input.firstAttemptAt || (successfulDeliveryAsAttempt ? input.actualDeliveryAt : '');
  const invalidDates = [];
  if (suppliedInvalidDate(rawInput, ['expectedDeliveryDate', 'expectedDate', 'Expected Delivery Date'])) invalidDates.push('expectedDeliveryDate');
  if (suppliedInvalidDate(rawInput, ['revisedExpectedDeliveryDate'])) invalidDates.push('revisedExpectedDeliveryDate');
  if (suppliedInvalidDate(rawInput, ['firstAttemptDate', 'First Attempt Date'])) invalidDates.push('firstAttemptDate');
  if (suppliedInvalidDate(rawInput, ['actualDeliveryDate', 'deliveryDate', 'Actual Delivery Date'])) invalidDates.push('actualDeliveryDate');
  const servicePolicy = policyRules.services?.[input.serviceCode];
  const asOf = normalizeDate(options.asOf || classificationTimestamp);
  const claimWindow = applicableExpected
    ? walkBusinessDays(applicableExpected, Number(policyRules.claimWindowBusinessDays || 30), input.destinationProvince)
    : { ok: false, reason: 'EXPECTED_DATE_MISSING' };
  const warningCodes = [];
  if (!input.serviceCode) warningCodes.push('SERVICE_UNKNOWN_WARNING');
  else if (!servicePolicy) warningCodes.push('SERVICE_ELIGIBILITY_UNCONFIRMED_WARNING');
  else if (servicePolicy.guaranteed === false) warningCodes.push('SERVICE_NOT_GUARANTEED_WARNING');
  else if (servicePolicy.manualReview) warningCodes.push('SERVICE_MANUAL_REVIEW_WARNING');
  if (applicableExpected && !originalExpected) warningCodes.push('ORIGINAL_DELIVERY_STANDARD_UNAVAILABLE_WARNING');
  if (claimWindow.ok && asOf && asOf > claimWindow.date) warningCodes.push('CLAIM_WINDOW_PASSED_WARNING');
  else if (applicableExpected && !claimWindow.ok) warningCodes.push('CLAIM_WINDOW_UNVERIFIED_WARNING');
  for (const signal of input.exclusionSignals) {
    warningCodes.push(signal.includes('CLAIM_WINDOW') ? `${signal}_WARNING` : `POLICY_WARNING_${signal}`);
  }
  for (const conflict of input.conflictCodes) warningCodes.push(`TRACKING_WARNING_${conflict}`);
  if (suppliedInvalidDate(rawInput, ['revisedExpectedDeliveryDate'])) warningCodes.push('REVISED_EXPECTED_DATE_INVALID_WARNING');
  if (suppliedInvalidDate(rawInput, ['firstAttemptDate', 'First Attempt Date'])) warningCodes.push('FIRST_ATTEMPT_DATE_INVALID_WARNING');
  if (input.firstAttemptDate && input.actualDeliveryDate && input.firstAttemptDate > input.actualDeliveryDate) warningCodes.push('FIRST_ATTEMPT_AFTER_DELIVERY_WARNING');
  return {
    policyVersion: '',
    policyEffectiveDate: '',
    policyDataVersion: LATE_CANDIDATE_MODEL_VERSION,
    classificationTimestamp,
    expectedDeliveryDate: applicableExpected,
    originalExpectedDeliveryDate: originalExpected,
    revisedExpectedDeliveryDate: revisedExpected,
    expectedDeliverySource: input.expectedDeliverySource,
    expectedDeliverySelectionReason: input.expectedDeliverySelectionReason,
    revisedExpectedDeliveryReason: input.revisedExpectedDeliveryReason,
    firstAttemptDate,
    firstAttemptAt,
    firstAttemptDerivedFromSuccessfulDelivery: successfulDeliveryAsAttempt,
    actualDeliveryDate: input.actualDeliveryDate,
    actualDeliveryAt: input.actualDeliveryAt,
    actualDeliveryEventCode: input.actualDeliveryEventCode,
    actualDeliveryCategory: input.actualDeliveryCategory,
    actualDeliveryProvenance: input.actualDeliveryProvenance,
    actualDeliveryConfidence: input.actualDeliveryConfidence,
    actualDeliveryDescription: input.actualDeliveryDescription,
    actualDeliveryClassificationSource: input.actualDeliveryClassificationSource,
    businessDaysLate: null,
    calendarDaysLate: calendarDaysAfter(applicableExpected, input.actualDeliveryDate),
    claimSubmissionDeadline: claimWindow.ok ? claimWindow.date : '',
    businessDaysRemaining: null,
    calendarDaysRemaining: null,
    peakPeriodStatus: { active: false, id: '', minimumBusinessDaysLate: null },
    serviceRule: {
      code: input.serviceCode,
      name: input.serviceName || policyRules.services?.[input.serviceCode]?.name || '',
      scope: policyRules.services?.[input.serviceCode]?.scope || 'UNKNOWN',
      guaranteed: servicePolicy?.guaranteed ?? null
    },
    holidayCalendarVersion: '',
    exclusionSignals: input.exclusionSignals,
    missingEvidence: [],
    reasonCodes: [],
    warningCodes: [...new Set(warningCodes)].sort(),
    explanation: '',
    policySourceIds: [],
    invalidDates,
    inputHash: sha256Canonical(input)
  };
}

function finish(base, classification, reasonCodes, missingEvidence, explanation) {
  const result = {
    ...base,
    classification,
    automaticallyEligible: false,
    lateCandidate: classification === 'LATE_CANDIDATE',
    reasonCodes: [...new Set(reasonCodes)].sort(),
    missingEvidence: [...new Set(missingEvidence)].sort(),
    explanation
  };
  // Time-sensitive advisory warnings must not change the core delivery evidence
  // identity or turn a still-late candidate into a different queue snapshot.
  result.evidenceHash = sha256Canonical({
    ...result,
    classificationTimestamp: '',
    warningCodes: [],
    claimSubmissionDeadline: '',
    businessDaysRemaining: null,
    calendarDaysRemaining: null
  });
  return assertClassificationResult(result);
}

function classifyEligibility(rawInput = {}, options = {}) {
  if (rawInput?.schemaVersion === CLASSIFICATION_INPUT_SCHEMA_VERSION) validateClassificationInput(rawInput, 'classification-entry');
  const input = normalizeClaimInput(rawInput);
  const base = resultBase(input, rawInput, options);

  if (!input.trackingNumber) {
    return finish(base, 'REVIEW_REQUIRED', ['TRACKING_PIN_MISSING'], ['trackingNumber'],
      'Lateness cannot be established because the tracking PIN is missing.');
  }
  if (!base.expectedDeliveryDate) {
    const invalid = base.invalidDates.includes('expectedDeliveryDate');
    return finish(base, 'REVIEW_REQUIRED', [invalid ? 'DELIVERY_STANDARD_DATE_INVALID' : 'DELIVERY_STANDARD_DATE_MISSING'], ['expectedDeliveryDate'],
      'Delivered-late status cannot be established because no usable original Delivery Standard date was returned.');
  }
  if (!input.actualDeliveryDate) {
    const invalid = base.invalidDates.includes('actualDeliveryDate');
    return finish(base, 'REVIEW_REQUIRED', [invalid ? 'SUCCESSFUL_DELIVERY_DATE_INVALID' : 'SUCCESSFUL_DELIVERY_EVIDENCE_MISSING'], ['actualDeliveryDate'],
      'Delivered-late status cannot be established because no usable successful-delivery evidence was returned. First-attempt evidence is retained for review but does not establish successful delivery.');
  }
  if (input.actualDeliveryDate > base.expectedDeliveryDate) {
    return finish(base, 'LATE_CANDIDATE', ['SUCCESSFUL_DELIVERY_AFTER_DELIVERY_STANDARD'], [],
      `Successful delivery occurred on ${input.actualDeliveryDate}, after the selected Delivery Standard date of ${base.expectedDeliveryDate}. First-attempt, service, policy, and claim-window information is retained as warning evidence; Canada Post will make the final claim-eligibility decision.`);
  }
  return finish(base, 'ON_TIME', ['SUCCESSFUL_DELIVERY_ON_OR_BEFORE_DELIVERY_STANDARD'], [],
    `Successful delivery occurred on ${input.actualDeliveryDate}, on or before the selected Delivery Standard date of ${base.expectedDeliveryDate}.`);
}

function serializeClassification(result) {
  assertClassificationResult(result);
  return canonicalize(result);
}

module.exports = {
  policy,
  LATE_CANDIDATE_MODEL_VERSION,
  policyVersionFor,
  peakPeriodFor,
  serviceCodeFromName,
  classifyEligibility,
  serializeClassification
};
