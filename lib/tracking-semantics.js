'use strict';

const { EVENT_TYPES, normalizeTrackingEvents } = require('./tracking-normalizer');
const { TRACKING_PARSER_VERSION } = require('./tracking-json');
const { validateCanonicalShipment } = require('./normalized-shipment');

function evaluateTrackingSemantics({ detail, service, canonicalShipment, stateModified = false } = {}) {
  if (canonicalShipment) validateCanonicalShipment(canonicalShipment, 'semantic-validation');
  const schema = detail?.schema || {};
  const eventNormalization = canonicalShipment ? {
    events: canonicalShipment.normalizedEvents,
    firstAttemptSourceEventCode: canonicalShipment.firstAttemptEventCode,
    firstAttemptSourceCategory: canonicalShipment.firstAttemptCategory,
    firstAttemptTimestamp: canonicalShipment.firstAttemptAt,
    actualDeliveryTimestamp: canonicalShipment.actualDeliveryAt,
    firstAttemptAndActualDeliverySameEvent: canonicalShipment.firstAttemptAndActualDeliverySameEvent,
    sharedSuccessfulDeliveryEvent: canonicalShipment.firstAttemptAndActualDeliverySameEvent && canonicalShipment.firstAttemptCategory === EVENT_TYPES.SUCCESSFUL_DELIVERY,
    firstAttemptProvenance: canonicalShipment.firstAttemptProvenance,
    firstAttemptConfidence: canonicalShipment.firstAttemptConfidence
  } : normalizeTrackingEvents(detail?.events || []);
  const eventCount = Number(schema.eventCount ?? detail?.events?.length ?? 0);
  const recognizedEventCount = eventNormalization.events.filter(event => ![EVENT_TYPES.UNKNOWN, EVENT_TYPES.EXPECTED_DELIVERY].includes(event.type)).length;
  const expectedPresent = Boolean(schema.expectedDeliveryPresent || schema.revisedExpectedDeliveryPresent);
  const expectedParsed = !expectedPresent || Boolean(detail?.expectedDeliveryDate);
  const deliveryEvidence = {
    firstQualifyingEventCode: eventNormalization.firstAttemptSourceEventCode || '',
    firstQualifyingEventCategory: eventNormalization.firstAttemptSourceCategory || '',
    firstAttemptTimestampPresent: Boolean(eventNormalization.firstAttemptTimestamp),
    actualDeliveryTimestampPresent: Boolean(eventNormalization.actualDeliveryTimestamp),
    sameEvent: Boolean(eventNormalization.firstAttemptAndActualDeliverySameEvent),
    sharedSuccessfulDeliveryEvent: Boolean(eventNormalization.sharedSuccessfulDeliveryEvent),
    provenance: eventNormalization.firstAttemptProvenance || '',
    confidence: eventNormalization.firstAttemptConfidence || ''
  };
  const failures = [];
  const systemicReasons = [];

  if (schema.parserVersion !== TRACKING_PARSER_VERSION || schema.responseShape !== 'official_direct_object') failures.push('JSON_SCHEMA_NOT_RECOGNIZED');
  if (!schema.statusLocated || !detail?.archiveState) failures.push('SHIPMENT_STATUS_NOT_PARSED');
  if (!schema.eventCollectionLocated) failures.push('EVENT_COLLECTION_NOT_LOCATED');
  if (eventCount > 0 && recognizedEventCount === 0) failures.push('EVENTS_PRESENT_NONE_RECOGNIZED');
  if (!expectedParsed) failures.push('EXPECTED_DELIVERY_PRESENT_NOT_PARSED');
  if (deliveryEvidence.actualDeliveryTimestampPresent && !deliveryEvidence.firstAttemptTimestampPresent) failures.push('DELIVERED_WITHOUT_FIRST_QUALIFYING_ATTEMPT');
  if ((schema.criticalErrors || []).length) failures.push('CRITICAL_SCHEMA_MISMATCH');
  if (stateModified) failures.push('DIAGNOSTIC_STATE_CHANGED');

  if (failures.includes('EVENT_COLLECTION_NOT_LOCATED')) systemicReasons.push('event_collection_not_located');
  if (failures.includes('EVENTS_PRESENT_NONE_RECOGNIZED')) systemicReasons.push('event_collection_unrecognized');
  if (failures.includes('DELIVERED_WITHOUT_FIRST_QUALIFYING_ATTEMPT')) systemicReasons.push('first_attempt_model_mismatch');
  if (failures.includes('JSON_SCHEMA_NOT_RECOGNIZED') || failures.includes('CRITICAL_SCHEMA_MISMATCH')) systemicReasons.push('schema_mismatch');

  return {
    parserVersion: TRACKING_PARSER_VERSION,
    schemaRecognized: schema.parserVersion === TRACKING_PARSER_VERSION && schema.responseShape === 'official_direct_object',
    shipmentStatusParsed: Boolean(schema.statusLocated && detail?.archiveState),
    eventCollectionLocated: Boolean(schema.eventCollectionLocated),
    eventCollectionExplicitlyEmpty: Boolean(schema.eventCollectionLocated && eventCount === 0),
    eventCount,
    recognizedEventCount,
    expectedDeliveryPresent: expectedPresent,
    expectedDeliveryParsed: expectedParsed,
    serviceResolved: Boolean(service?.recognized),
    serviceSource: service?.source || 'unknown',
    deliveryEvidence,
    criticalSchemaMismatch: Boolean((schema.criticalErrors || []).length),
    stateModified: Boolean(stateModified),
    passed: failures.length === 0,
    failures,
    systemicReasons
  };
}

class SemanticCircuitBreaker {
  constructor({ sampleSize = 3 } = {}) {
    this.sampleSize = Math.max(3, Math.min(5, Number(sampleSize) || 3));
    this.samples = [];
    this.open = false;
    this.reason = '';
  }

  record(semantics) {
    if (this.open || this.samples.length >= this.sampleSize) return { opened: this.open, reason: this.reason, sampleCount: this.samples.length };
    this.samples.push([...(semantics?.systemicReasons || [])]);
    if (this.samples.length === this.sampleSize) {
      const common = this.samples[0].find(reason => this.samples.every(sample => sample.includes(reason)));
      if (common) {
        this.open = true;
        this.reason = common;
      }
    }
    return { opened: this.open, reason: this.reason, sampleCount: this.samples.length };
  }
}

module.exports = { evaluateTrackingSemantics, SemanticCircuitBreaker };
