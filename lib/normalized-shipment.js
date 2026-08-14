'use strict';

const { normalizeDate } = require('./business-calendar');
const { sha256Canonical } = require('./canonical-json');
const { assertClassificationResult } = require('./claim-domain');
const { TRACKING_API_VERSION } = require('./tracking-contract');
const { TRACKING_PARSER_VERSION, normalizedTrackingEvents } = require('./tracking-json');
const { deriveDeliveryStatus, normalizeTrackingEvents } = require('./tracking-normalizer');
const { resolveTrackingService } = require('./tracking-service');

const NORMALIZED_SHIPMENT_SCHEMA_VERSION = 'canonical-normalized-shipment-v2';
const CLASSIFICATION_INPUT_SCHEMA_VERSION = 'canonical-classification-input-v2';
const INVARIANT_MESSAGE = 'Internal classification invariant failed: normalized first-attempt evidence was lost before policy evaluation.';
const INVARIANT_MESSAGES = Object.freeze({
  NORMALIZED_FIRST_ATTEMPT_LOST: INVARIANT_MESSAGE,
  EVIDENCE_HASH_MISMATCH: 'Policy input invariant failed: canonical evidence hash does not match the staged classification evidence.'
});

class NormalizedShipmentSchemaError extends Error {
  constructor(boundary, message, code = 'NORMALIZED_SHIPMENT_SCHEMA') {
    super(`Canonical normalized-shipment schema failed at ${boundary}: ${message}`);
    this.name = 'NormalizedShipmentSchemaError';
    this.code = code;
    this.boundary = boundary;
  }
}

class ClassificationInvariantError extends Error {
  constructor(code, details = {}) {
    super(INVARIANT_MESSAGES[code] || 'Internal classification invariant failed.');
    this.name = 'ClassificationInvariantError';
    this.code = code;
    this.details = details;
  }
}

function text(value, max = 4096) { return String(value ?? '').trim().slice(0, max); }
function value(row = {}, names = []) {
  for (const name of names) if (text(row[name])) return text(row[name]);
  return '';
}
function plainObject(input) { return Boolean(input && typeof input === 'object' && !Array.isArray(input)); }
function requireString(input, name, boundary, { allowEmpty = true } = {}) {
  if (typeof input[name] !== 'string' || (!allowEmpty && !input[name])) throw new NormalizedShipmentSchemaError(boundary, `${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
}

function safeEvent(event = {}) {
  return {
    sourceIndex: Number(event.sourceIndex || 0),
    sourceCode: text(event.sourceCode, 128),
    description: text(event.description, 1024),
    type: text(event.type, 128),
    timestamp: text(event.timestamp, 64),
    date: text(event.date, 32),
    timestampPrecision: text(event.timestampPrecision, 32),
    eventTime: text(event.eventTime, 32),
    eventTimeZone: text(event.eventTimeZone, 64),
    localTimestamp: text(event.localTimestamp, 64),
    expectedDeliveryDate: text(event.expectedDeliveryDate, 32),
    expectedDateSource: text(event.expectedDateSource, 128),
    revisedExpectedReason: text(event.revisedExpectedReason, 500),
    revisedExpectedDelivery: event.revisedExpectedDelivery === true,
    explicitlyFirstAttempt: event.explicitlyFirstAttempt === true,
    classificationSource: text(event.classificationSource, 64),
    rawHash: text(event.rawHash, 128)
  };
}

function validateCanonicalShipment(input, boundary = 'unknown', options = {}) {
  if (!plainObject(input)) throw new NormalizedShipmentSchemaError(boundary, 'value must be an object.');
  if (input.schemaVersion !== NORMALIZED_SHIPMENT_SCHEMA_VERSION) throw new NormalizedShipmentSchemaError(boundary, 'schemaVersion is unsupported.');
  for (const name of [
    'trackingNumber', 'normalizedStatus', 'normalizedStatusLabel', 'serviceName', 'serviceCode', 'serviceProvenance',
    'shipmentDate', 'shipmentDateValidation', 'shipmentDateSourceField', 'shipmentDateProvenance', 'expectedDelivery', 'revisedExpectedDelivery', 'firstAttemptAt', 'firstAttemptDate',
    'firstAttemptEventCode', 'firstAttemptCategory', 'firstAttemptProvenance', 'firstAttemptConfidence',
    'actualDeliveryAt', 'actualDeliveryDate', 'actualDeliveryEventCode', 'actualDeliveryCategory',
    'parserVersion', 'apiContractVersion', 'archiveState', 'destinationProvince', 'destinationPostalCode',
    'referenceNumber', 'evidenceHash'
  ]) requireString(input, name, boundary, { allowEmpty: !['normalizedStatus', 'normalizedStatusLabel', 'parserVersion', 'apiContractVersion'].includes(name) });
  if (!options.allowRedactedTracking && !input.trackingNumber) throw new NormalizedShipmentSchemaError(boundary, 'trackingNumber is required.');
  if (input.parserVersion !== TRACKING_PARSER_VERSION) throw new NormalizedShipmentSchemaError(boundary, 'parserVersion is stale.');
  if (input.apiContractVersion !== TRACKING_API_VERSION) throw new NormalizedShipmentSchemaError(boundary, 'apiContractVersion is stale.');
  if (typeof input.firstAttemptAndActualDeliverySameEvent !== 'boolean') throw new NormalizedShipmentSchemaError(boundary, 'same-event indicator must be boolean.');
  if (!Array.isArray(input.normalizedEvents) || !Array.isArray(input.exclusionSignals) || !Array.isArray(input.conflictCodes)) throw new NormalizedShipmentSchemaError(boundary, 'event and signal collections must be arrays.');
  for (const [index, event] of input.normalizedEvents.entries()) {
    if (!plainObject(event) || !Number.isInteger(event.sourceIndex) || event.sourceIndex < 0) throw new NormalizedShipmentSchemaError(boundary, `normalizedEvents[${index}] has an invalid sourceIndex.`);
    for (const name of ['sourceCode', 'type', 'timestamp', 'date', 'timestampPrecision', 'eventTime', 'eventTimeZone', 'localTimestamp', 'expectedDeliveryDate', 'classificationSource', 'rawHash']) requireString(event, name, boundary);
    if (typeof event.revisedExpectedDelivery !== 'boolean' || typeof event.explicitlyFirstAttempt !== 'boolean') throw new NormalizedShipmentSchemaError(boundary, `normalizedEvents[${index}] has invalid flags.`);
  }
  if (!Number.isInteger(input.unknownEventCount) || input.unknownEventCount < 0) throw new NormalizedShipmentSchemaError(boundary, 'unknownEventCount must be a non-negative integer.');
  if (input.firstAttemptAt && (!input.firstAttemptDate || !input.firstAttemptCategory || !input.firstAttemptProvenance || !input.firstAttemptConfidence)) throw new NormalizedShipmentSchemaError(boundary, 'first-attempt evidence is incomplete.');
  if (input.actualDeliveryAt && (!input.actualDeliveryDate || input.actualDeliveryCategory !== 'SUCCESSFUL_DELIVERY')) throw new NormalizedShipmentSchemaError(boundary, 'actual-delivery evidence is incomplete.');
  if (input.firstAttemptAndActualDeliverySameEvent && (!input.firstAttemptAt || !input.actualDeliveryAt || input.firstAttemptAt !== input.actualDeliveryAt)) throw new NormalizedShipmentSchemaError(boundary, 'same-event timestamps are inconsistent.');
  if (!['valid', 'missing', 'invalid'].includes(input.shipmentDateValidation)) throw new NormalizedShipmentSchemaError(boundary, 'shipmentDateValidation is unsupported.');
  if (input.shipmentDateValidation === 'valid' && (!input.shipmentDate || !input.shipmentDateSourceField || !input.shipmentDateProvenance)) throw new NormalizedShipmentSchemaError(boundary, 'valid Shipment Date evidence is incomplete.');
  if (input.shipmentDateValidation !== 'valid' && input.shipmentDate) throw new NormalizedShipmentSchemaError(boundary, 'invalid or missing Shipment Date evidence contains a normalized value.');
  if (!input.evidenceHash || sha256Canonical({ ...input, evidenceHash: '' }) !== input.evidenceHash) throw new NormalizedShipmentSchemaError(boundary, 'evidenceHash does not match the canonical object.', 'EVIDENCE_HASH_MISMATCH');
  return input;
}

function buildCanonicalShipment({ detail, row = {}, trackingNumber = '' } = {}) {
  if (!plainObject(detail)) throw new NormalizedShipmentSchemaError('json-to-canonical', 'parsed Tracking detail is required.');
  const service = resolveTrackingService({
    apiServiceName: detail.serviceName,
    apiAlternateServiceName: detail.serviceName2,
    estServiceCode: value(row, ['Service Code', 'Product Code'])
  });
  const normalization = normalizeTrackingEvents(normalizedTrackingEvents(detail));
  const deliveryStatus = deriveDeliveryStatus(normalization, { expectedDeliveryDate: normalization.expectedDeliveryDate || detail.expectedDeliveryDate });
  const rawShipmentDate = value(row, ['Shipment Date', 'Ship Date', 'EST Event Date']);
  const normalizedShipmentDate = normalizeDate(rawShipmentDate);
  const shipmentDateValidation = normalizedShipmentDate ? 'valid' : rawShipmentDate ? 'invalid' : 'missing';
  const body = {
    schemaVersion: NORMALIZED_SHIPMENT_SCHEMA_VERSION,
    trackingNumber: text(trackingNumber || detail.pin, 128).replace(/\s+/g, '').toUpperCase(),
    normalizedStatus: deliveryStatus.state,
    normalizedStatusLabel: deliveryStatus.label,
    serviceName: service.normalizedService,
    serviceCode: service.serviceCode,
    serviceProvenance: service.source,
    shipmentDate: normalizedShipmentDate,
    shipmentDateValidation,
    shipmentDateSourceField: text(value(row, ['Shipment Date Source Field']) || (rawShipmentDate ? 'Shipment Date' : 'unavailable'), 128),
    shipmentDateProvenance: text(value(row, ['Shipment Date Provenance']) || (rawShipmentDate ? 'legacy-tracking-csv' : 'unavailable'), 256),
    expectedDelivery: normalization.expectedDeliveryDate || detail.expectedDeliveryDate || '',
    originalExpectedDelivery: normalization.originalExpectedDeliveryDate || detail.originalExpectedDeliveryDate || value(row, ['Original Delivery Standard Date']) || '',
    revisedExpectedDelivery: normalization.revisedExpectedDeliveryDate || detail.revisedExpectedDeliveryDate || '',
    expectedDeliverySource: normalization.expectedDeliverySource || detail.expectedDeliverySource || '',
    expectedDeliverySelectionReason: normalization.expectedDeliverySelectionReason || detail.expectedDeliverySelectionReason || '',
    revisedExpectedDeliveryReason: normalization.revisedExpectedDeliveryReason || detail.changedExpectedDeliveryReason || '',
    firstAttemptAt: normalization.firstAttemptTimestamp || '',
    firstAttemptDate: normalization.firstAttemptDate || '',
    firstAttemptEventCode: normalization.firstAttemptSourceEventCode || '',
    firstAttemptCategory: normalization.firstAttemptSourceCategory || '',
    firstAttemptProvenance: normalization.firstAttemptProvenance || '',
    firstAttemptConfidence: normalization.firstAttemptConfidence || '',
    firstAttemptDescription: normalization.firstAttemptDescription || '',
    actualDeliveryAt: normalization.actualDeliveryTimestamp || '',
    actualDeliveryDate: normalization.actualDeliveryDate || '',
    actualDeliveryEventCode: normalization.actualDeliverySourceEventCode || '',
    actualDeliveryCategory: normalization.actualDeliverySourceCategory || '',
    actualDeliveryProvenance: normalization.actualDeliveryProvenance || '',
    actualDeliveryConfidence: normalization.actualDeliveryConfidence || '',
    actualDeliveryDescription: normalization.actualDeliveryDescription || '',
    actualDeliveryClassificationSource: normalization.actualDeliveryClassificationSource || '',
    firstAttemptAndActualDeliverySameEvent: Boolean(normalization.firstAttemptAndActualDeliverySameEvent),
    normalizedEvents: normalization.events.map(safeEvent),
    exclusionSignals: [...normalization.exclusionSignals],
    conflictCodes: [...normalization.conflictCodes],
    unknownEventCount: normalization.unknownEventCount,
    parserVersion: TRACKING_PARSER_VERSION,
    apiContractVersion: TRACKING_API_VERSION,
    archiveState: text(detail.archiveState, 32),
    destinationProvince: text(value(row, ['Destination Province', 'Province']), 8).toUpperCase(),
    destinationPostalCode: text(value(row, ['Destination Postal Code', 'Postal Code']) || detail.postalCode, 32).toUpperCase(),
    referenceNumber: text(value(row, ['Reference #', 'Reference Number']) || detail.reference, 256),
    evidenceHash: ''
  };
  body.evidenceHash = sha256Canonical(body);
  return validateCanonicalShipment(body, 'json-to-canonical');
}

function sanitizeCanonicalShipment(input, options = {}) {
  validateCanonicalShipment(input, 'privacy-sanitization-input');
  const sanitized = {
    ...input,
    trackingNumber: options.includeTrackingNumber ? input.trackingNumber : '',
    destinationPostalCode: options.includePrivateMetadata ? input.destinationPostalCode : '',
    referenceNumber: options.includePrivateMetadata ? input.referenceNumber : '',
    firstAttemptDescription: options.includePrivateMetadata ? text(input.firstAttemptDescription, 1024) : '',
    actualDeliveryDescription: options.includePrivateMetadata ? text(input.actualDeliveryDescription, 1024) : '',
    normalizedEvents: input.normalizedEvents.map(event => ({
      ...safeEvent(event),
      description: options.includePrivateMetadata ? text(event.description, 1024) : ''
    })),
    evidenceHash: ''
  };
  sanitized.evidenceHash = sha256Canonical(sanitized);
  return validateCanonicalShipment(sanitized, 'privacy-sanitization-output', { allowRedactedTracking: !options.includeTrackingNumber });
}

function validateClassificationInput(input, boundary = 'classification-input') {
  if (!plainObject(input) || input.schemaVersion !== CLASSIFICATION_INPUT_SCHEMA_VERSION) throw new NormalizedShipmentSchemaError(boundary, 'classification input schemaVersion is unsupported.');
  for (const name of ['trackingNumber', 'serviceCode', 'serviceName', 'serviceProvenance', 'shipmentDate', 'shipmentDateValidation', 'shipmentDateSourceField', 'shipmentDateProvenance', 'expectedDeliveryDate', 'revisedExpectedDeliveryDate', 'firstAttemptAt', 'firstAttemptDate', 'firstAttemptEventCode', 'firstAttemptCategory', 'firstAttemptProvenance', 'firstAttemptConfidence', 'actualDeliveryAt', 'actualDeliveryDate', 'actualDeliveryEventCode', 'normalizedStatus', 'parserVersion', 'apiContractVersion', 'canonicalEvidenceHash']) requireString(input, name, boundary);
  if (!input.trackingNumber) throw new NormalizedShipmentSchemaError(boundary, 'trackingNumber is required.');
  if (input.parserVersion !== TRACKING_PARSER_VERSION || input.apiContractVersion !== TRACKING_API_VERSION) throw new NormalizedShipmentSchemaError(boundary, 'parser or API contract version is stale.');
  if (!input.canonicalEvidenceHash) throw new NormalizedShipmentSchemaError(boundary, 'canonicalEvidenceHash is required.');
  if (!Array.isArray(input.normalizedEvents) || !Array.isArray(input.claimEvidence)) throw new NormalizedShipmentSchemaError(boundary, 'classification evidence collections are required.');
  if (input.firstAttemptAt && (!input.firstAttemptDate || !input.firstAttemptCategory || !input.firstAttemptProvenance)) throw new NormalizedShipmentSchemaError(boundary, 'first-attempt evidence was truncated.');
  if (typeof input.firstAttemptAndActualDeliverySameEvent !== 'boolean') throw new NormalizedShipmentSchemaError(boundary, 'same-event indicator must be boolean.');
  if (input.firstAttemptAndActualDeliverySameEvent && (!input.firstAttemptAt || !input.actualDeliveryAt || input.firstAttemptAt !== input.actualDeliveryAt)) throw new NormalizedShipmentSchemaError(boundary, 'same-event classification evidence is inconsistent.');
  return input;
}

function buildClassificationInput(canonical, settings = {}) {
  validateCanonicalShipment(canonical, 'classification-builder-input');
  const sender = settings.sender || {};
  const contact = settings.contact || {};
  const input = {
    schemaVersion: CLASSIFICATION_INPUT_SCHEMA_VERSION,
    trackingNumber: canonical.trackingNumber,
    serviceCode: canonical.serviceCode,
    serviceName: canonical.serviceName,
    serviceProvenance: canonical.serviceProvenance,
    shipmentDate: canonical.shipmentDate,
    shipmentDateValidation: canonical.shipmentDateValidation,
    shipmentDateSourceField: canonical.shipmentDateSourceField,
    shipmentDateProvenance: canonical.shipmentDateProvenance,
    expectedDeliveryDate: canonical.expectedDelivery,
    originalExpectedDeliveryDate: canonical.originalExpectedDelivery || canonical.expectedDelivery || '',
    revisedExpectedDeliveryDate: canonical.revisedExpectedDelivery,
    expectedDeliverySource: canonical.expectedDeliverySource || '',
    expectedDeliverySelectionReason: canonical.expectedDeliverySelectionReason || '',
    revisedExpectedDeliveryReason: canonical.revisedExpectedDeliveryReason || '',
    firstAttemptAt: canonical.firstAttemptAt,
    firstAttemptDate: canonical.firstAttemptDate,
    firstAttemptEventCode: canonical.firstAttemptEventCode,
    firstAttemptCategory: canonical.firstAttemptCategory,
    firstAttemptProvenance: canonical.firstAttemptProvenance,
    firstAttemptConfidence: canonical.firstAttemptConfidence,
    firstAttemptDescription: canonical.firstAttemptDescription || '',
    actualDeliveryAt: canonical.actualDeliveryAt,
    actualDeliveryDate: canonical.actualDeliveryDate,
    actualDeliveryEventCode: canonical.actualDeliveryEventCode,
    actualDeliveryCategory: canonical.actualDeliveryCategory || '',
    actualDeliveryProvenance: canonical.actualDeliveryProvenance || '',
    actualDeliveryConfidence: canonical.actualDeliveryConfidence || '',
    actualDeliveryDescription: canonical.actualDeliveryDescription || '',
    actualDeliveryClassificationSource: canonical.actualDeliveryClassificationSource || '',
    firstAttemptAndActualDeliverySameEvent: canonical.firstAttemptAndActualDeliverySameEvent,
    normalizedStatus: canonical.normalizedStatus,
    normalizedEvents: canonical.normalizedEvents.map(safeEvent),
    exclusionSignals: [...canonical.exclusionSignals],
    conflictCodes: [...canonical.conflictCodes],
    unknownEventCount: canonical.unknownEventCount,
    parserVersion: canonical.parserVersion,
    apiContractVersion: canonical.apiContractVersion,
    canonicalEvidenceHash: canonical.evidenceHash,
    destinationProvince: canonical.destinationProvince,
    destinationPostalCode: canonical.destinationPostalCode,
    referenceNumber: canonical.referenceNumber,
    sender: { name: text(sender.name, 256), address: text(sender.address, 1024), city: text(sender.city, 256), province: text(sender.province, 8).toUpperCase(), postalCode: text(sender.postalCode, 32).toUpperCase() },
    contact: { name: text(contact.name, 256), email: text(contact.email, 320), phone: text(contact.phone, 64) },
    receiver: plainObject(settings.receiver) ? settings.receiver : {},
    contentsDescription: text(settings.contentsDescription, 2048),
    claimEvidence: [`canonical-shipment:${canonical.evidenceHash}`],
    requireReceiver: Boolean(settings.requireReceiver),
    requireContentsDescription: Boolean(settings.requireContentsDescription)
  };
  return validateClassificationInput(input, 'classification-builder-output');
}

function assertClassificationInvariant(canonical, classificationInput, classification, options = {}) {
  validateCanonicalShipment(canonical, 'classification-invariant-canonical');
  validateClassificationInput(classificationInput, 'classification-invariant-input');
  assertClassificationResult(classification);
  if (classificationInput.canonicalEvidenceHash !== canonical.evidenceHash) throw new ClassificationInvariantError('EVIDENCE_HASH_MISMATCH');
  const evidenceLost = canonical.firstAttemptAt && (
    classificationInput.firstAttemptAt !== canonical.firstAttemptAt
    || classificationInput.firstAttemptDate !== canonical.firstAttemptDate
    || classificationInput.firstAttemptEventCode !== canonical.firstAttemptEventCode
    || classificationInput.firstAttemptCategory !== canonical.firstAttemptCategory
  );
  const missing = classification.missingEvidence || [];
  const firstAttemptMissingAfterSemanticPass = options.semanticPassed === true
    && canonical.firstAttemptAt
    && missing.includes('firstAttemptDate');
  if (evidenceLost || firstAttemptMissingAfterSemanticPass) {
    throw new ClassificationInvariantError('NORMALIZED_FIRST_ATTEMPT_LOST', { evidenceLost, missingEvidence: [...missing] });
  }
  return true;
}

module.exports = {
  NORMALIZED_SHIPMENT_SCHEMA_VERSION,
  CLASSIFICATION_INPUT_SCHEMA_VERSION,
  INVARIANT_MESSAGE,
  INVARIANT_MESSAGES,
  NormalizedShipmentSchemaError,
  ClassificationInvariantError,
  validateCanonicalShipment,
  buildCanonicalShipment,
  sanitizeCanonicalShipment,
  validateClassificationInput,
  buildClassificationInput,
  assertClassificationInvariant,
  safeEvent
};
