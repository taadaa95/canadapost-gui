'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseTrackingJson, normalizedTrackingEvents, TRACKING_PARSER_VERSION } = require('../lib/tracking-json');
const { EVENT_TYPES, classifyEvent, normalizeTrackingEvents } = require('../lib/tracking-normalizer');
const { resolveTrackingService } = require('../lib/tracking-service');
const { buildSanitizedStructure } = require('../lib/tracking-structure');
const { evaluateTrackingSemantics, SemanticCircuitBreaker } = require('../lib/tracking-semantics');
const { buildCanonicalShipment } = require('../lib/normalized-shipment');
const { outputRow, sanitizedNormalizationEvidence } = require('../scripts/get-tracking');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tracking-details-live-shape.json'), 'utf8'));
const detail = parseTrackingJson(fixture, fixture.pin);
assert.strictEqual(detail.schema.responseShape, 'official_direct_object');
assert.strictEqual(detail.schema.parserVersion, TRACKING_PARSER_VERSION);
assert.strictEqual(detail.schema.eventCollectionPath, '$.significantEvents');
assert.strictEqual(detail.events.length, 2);
assert.strictEqual(detail.expectedDeliveryDate, '2026-06-03');
assert.strictEqual(detail.originalExpectedDeliveryDate, '2026-06-03');
assert.strictEqual(detail.revisedExpectedDeliveryDate, '2026-06-04');
assert.throws(() => parseTrackingJson({ trackingDetail: fixture }, fixture.pin), /pin is required/, 'undocumented wrappers must fail closed');

const apiService = resolveTrackingService({ apiServiceName: detail.serviceName, estServiceCode: 'INVALID-EST' });
assert.deepStrictEqual({ code: apiService.serviceCode, source: apiService.source }, { code: 'DOM.XP', source: 'tracking_api' });
const frenchService = resolveTrackingService({ apiServiceName: 'Colis accélérés' });
assert.strictEqual(frenchService.serviceCode, 'DOM.EP');
const estFallback = resolveTrackingService({ apiServiceName: '', estServiceCode: ' DOM.XP ' });
assert.deepStrictEqual({ code: estFallback.serviceCode, source: estFallback.source }, { code: 'DOM.XP', source: 'est_import' });
assert.strictEqual(resolveTrackingService({ apiServiceName: '', estServiceCode: 'UNKNOWN' }).source, 'unknown');

const normalization = normalizeTrackingEvents(normalizedTrackingEvents(detail));
const canonicalShipment = buildCanonicalShipment({
  detail,
  row: { 'Shipment Date': '2026-06-01', 'Destination Province': 'ON' },
  trackingNumber: fixture.pin
});
const evidence = JSON.stringify(sanitizedNormalizationEvidence(canonicalShipment));
assert(!evidence.includes('SYNTHETIC SITE'));
assert(!evidence.includes('Notice card left indicating'));
assert.strictEqual(normalization.expectedDeliveryDate, '2026-06-03');
assert.strictEqual(normalization.expectedDeliverySource, 'tracking_api.expectedDeliveryDate');
assert.strictEqual(normalization.originalExpectedDeliveryDate, '2026-06-03');
assert.strictEqual(normalization.revisedExpectedDeliveryDate, '2026-06-04');
assert.strictEqual(normalization.firstAttemptDate, '2026-06-05');
assert.strictEqual(normalization.firstAttemptSourceEventCode, 'SYN-ATTEMPT');
assert.strictEqual(normalization.firstAttemptSourceCategory, EVENT_TYPES.NOTICE_CARD);
assert.strictEqual(normalization.firstAttemptConfidence, 'bounded_description_mapping');
assert.strictEqual(normalization.firstAttemptProvenance, 'tracking_api_significant_event');
assert.strictEqual(normalization.actualDeliveryDate, '2026-06-06');
assert.notStrictEqual(normalization.firstAttemptDate, normalization.actualDeliveryDate);

assert.strictEqual(classifyEvent({ code: '1496', description: 'Delivery attempt made' }), EVENT_TYPES.SUCCESSFUL_DELIVERY, 'documented event code must take precedence');
assert.strictEqual(classifyEvent({ code: '1442', description: 'Synthetic unmapped status' }), EVENT_TYPES.SUCCESSFUL_DELIVERY, 'authorized semantic report confirms stable event 1442');
const operatorSanitizedStructureCodes = ['0174', '0170', '0405', '0410', '0100', '2300', '3000'];
for (const code of operatorSanitizedStructureCodes) {
  assert.strictEqual(classifyEvent({ code, description: 'Synthetic unmapped status' }), EVENT_TYPES.UNKNOWN, `safe live identifier ${code} must not be assigned an undocumented meaning`);
}
const liveIdentifierWithSafeDescription = normalizeTrackingEvents([{ code: '1442', description: 'Delivered', eventDate: '2026-06-06', eventTime: '09:30:00' }]);
assert.strictEqual(liveIdentifierWithSafeDescription.firstAttemptSourceEventCode, '1442');
assert.strictEqual(liveIdentifierWithSafeDescription.firstAttemptClassificationSource, 'documented_event_code');
assert.strictEqual(classifyEvent({ description: 'Destinataire absent' }), EVENT_TYPES.RECIPIENT_UNAVAILABLE);
assert.strictEqual(classifyEvent({ description: 'Première tentative de livraison' }), EVENT_TYPES.FIRST_DELIVERY_ATTEMPT);
assert.strictEqual(classifyEvent({ description: 'Avis de livraison laissé' }), EVENT_TYPES.NOTICE_CARD);
assert.strictEqual(classifyEvent({ description: 'Article livré' }), EVENT_TYPES.SUCCESSFUL_DELIVERY);
for (const description of ['Delivered', 'Delivered to community mailbox', 'Parcel locker', "Recipient's side door"]) {
  assert.strictEqual(classifyEvent({ description }), EVENT_TYPES.SUCCESSFUL_DELIVERY, `original successful-delivery wording must remain recognized: ${description}`);
}
for (const description of ['Not delivered', 'Unable to deliver', 'Delivery attempt']) {
  assert.notStrictEqual(classifyEvent({ description }), EVENT_TYPES.SUCCESSFUL_DELIVERY, `unsuccessful wording must not become successful delivery: ${description}`);
}
for (const [description, expected] of [
  ['Electronic information submitted by shipper', EVENT_TYPES.ELECTRONIC_INFORMATION],
  ['Item accepted at the post office', EVENT_TYPES.ACCEPTED],
  ['Item processed', EVENT_TYPES.ITEM_PROCESSED],
  ['Item in transit', EVENT_TYPES.IN_TRANSIT],
  ['Item out for delivery', EVENT_TYPES.OUT_FOR_DELIVERY],
  ['Item available for pickup', EVENT_TYPES.AVAILABLE_FOR_PICKUP]
]) assert.strictEqual(classifyEvent({ description }), expected);
const deliveredOnly = normalizeTrackingEvents([{ code: '1496', description: 'Delivered', eventDate: '2026-06-06', eventTime: '09:30:00' }]);
assert.strictEqual(deliveredOnly.actualDeliveryDate, '2026-06-06');
assert.strictEqual(deliveredOnly.firstAttemptDate, '2026-06-06', 'successful delivery is itself a qualifying first attempt');
assert.strictEqual(deliveredOnly.firstAttemptTimestamp, deliveredOnly.actualDeliveryTimestamp);
assert.strictEqual(deliveredOnly.firstAttemptAndActualDeliverySameEvent, true);
assert.strictEqual(deliveredOnly.firstAttemptConfidence, 'high_documented_identifier');

const deliveredDetail = parseTrackingJson({ ...fixture, significantEvents: [{ eventIdentifier: '1496', eventDate: '2026-06-06', eventTime: '09:30:00', eventDescription: 'Delivered' }] }, fixture.pin);
const deliveredCanonical = buildCanonicalShipment({
  detail: deliveredDetail,
  row: { 'Shipment Date': '2026-06-01', 'Destination Province': 'ON' },
  trackingNumber: fixture.pin
});

const deliveredRow = outputRow({
  expectedDeliveryDate: '2026-06-03', firstAttemptDate: '2026-06-06', actualDeliveryDate: '2026-06-06'
}, { classification: 'REVIEW_REQUIRED', explanation: '', businessDaysLate: null, peakPeriodStatus: {}, policyVersion: '', holidayCalendarVersion: '', evidenceHash: '' }, deliveredCanonical);
assert.match(deliveredRow.Status, /DELIVERED/);
assert.doesNotMatch(deliveredRow.Status, /NOT DELIVERED/);

const semantics = evaluateTrackingSemantics({ detail, service: apiService, stateModified: false });
assert.strictEqual(semantics.passed, true);
assert.strictEqual(semantics.deliveryEvidence.firstQualifyingEventCode, 'SYN-ATTEMPT');
assert.strictEqual(semantics.deliveryEvidence.firstQualifyingEventCategory, EVENT_TYPES.NOTICE_CARD);
assert.strictEqual(semantics.deliveryEvidence.firstAttemptTimestampPresent, true);
assert.strictEqual(semantics.deliveryEvidence.actualDeliveryTimestampPresent, true);
assert.strictEqual(semantics.deliveryEvidence.sameEvent, false);
assert.strictEqual(semantics.deliveryEvidence.provenance, 'tracking_api_significant_event');
assert.strictEqual(semantics.deliveryEvidence.confidence, 'bounded_description_mapping');

const deliveredSemantics = evaluateTrackingSemantics({ detail: deliveredDetail, service: apiService, canonicalShipment: deliveredCanonical, stateModified: false });
assert.strictEqual(deliveredSemantics.deliveryEvidence.sameEvent, true);
assert.strictEqual(deliveredSemantics.deliveryEvidence.sharedSuccessfulDeliveryEvent, true);
const badDetail = parseTrackingJson({ ...fixture, serviceName: null, serviceName2: null, significantEvents: [{ eventIdentifier: 'NEW', eventDate: '2026-06-05', eventTime: '10:00:00', eventDescription: 'Unmapped synthetic event' }] }, fixture.pin);
const badSemantics = evaluateTrackingSemantics({ detail: badDetail, service: resolveTrackingService({}), stateModified: false });
assert.strictEqual(badSemantics.passed, false);
assert(badSemantics.failures.includes('EVENTS_PRESENT_NONE_RECOGNIZED'));
assert(!badSemantics.failures.includes('SERVICE_NOT_RESOLVED'), 'unknown service is optional enrichment');

const breaker = new SemanticCircuitBreaker({ sampleSize: 3 });
assert.strictEqual(breaker.record(badSemantics).opened, false);
assert.strictEqual(breaker.record(badSemantics).opened, false);
assert.strictEqual(breaker.record(badSemantics).opened, true);
const legitimate = new SemanticCircuitBreaker({ sampleSize: 3 });
for (let index = 0; index < 3; index += 1) assert.strictEqual(legitimate.record(semantics).opened, false);

const structure = buildSanitizedStructure(fixture, { apiVersion: '1.0.0' });
const serialized = JSON.stringify(structure);
assert(structure.recognizedPaths.includes('$.serviceName'));
assert(structure.recognizedPaths.includes('$.significantEvents[*].eventIdentifier'));
assert(structure.unrecognizedPaths.includes('$.futureContractField'));
for (const privateValue of [fixture.pin, fixture.serviceName, fixture.significantEvents[0].eventDescription, fixture.significantEvents[0].eventSite]) {
  assert(!serialized.includes(privateValue), `sanitized structure leaked a value: ${privateValue}`);
}
assert(serialized.includes('1496'), 'safe documented event-code enum may be retained');

console.log('Live-shaped Tracking JSON normalization and semantic diagnostics tests passed.');
