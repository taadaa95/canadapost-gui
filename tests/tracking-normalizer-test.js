'use strict';

const assert = require('assert');
const { DELIVERY_STATES, EVENT_TYPES, deriveDeliveryStatus, normalizeTrackingEvents } = require('../lib/tracking-normalizer');
const { classifyEligibility } = require('../lib/policy-engine');

const result = normalizeTrackingEvents([
  { code: 'A', description: 'Item delivered', timestamp: '2026-06-05T14:00:00-04:00' },
  { code: 'B', description: 'Notice card left indicating where and when to pick up item', timestamp: '2026-06-04T16:00:00-04:00' },
  { code: 'B', description: 'Notice card left indicating where and when to pick up item', timestamp: '2026-06-04T16:00:00-04:00' },
  { code: 'E', description: 'Expected delivery', date: '2026-06-03', expectedDeliveryDate: '2026-06-03' }
]);
assert.equal(result.firstAttemptDate, '2026-06-04');
assert.equal(result.actualDeliveryDate, '2026-06-05');
assert.equal(result.normalizedEventCount, 3);
assert.equal(result.events[0].type, EVENT_TYPES.EXPECTED_DELIVERY);

const french = normalizeTrackingEvents([
  { description: 'Avis de livraison laissé', eventDate: '2026-06-04' },
  { description: 'Article livré', eventDate: '2026-06-05' },
  { description: 'Retard en raison de la météo', eventDate: '2026-06-03' }
]);
assert.equal(french.firstAttemptDate, '2026-06-04');
assert.equal(french.actualDeliveryDate, '2026-06-05');
assert(french.exclusionSignals.includes('WEATHER_DISRUPTION'));

const ambiguous = normalizeTrackingEvents([
  { description: 'Delivery attempt made', eventDate: '2026-06-05', eventTime: '15:00:00', eventTimeZone: 'EDT' },
  { description: 'Recipient unavailable', eventDate: '2026-06-04', eventTime: '10:00:00', eventTimeZone: 'EDT' },
  { description: 'Unmapped synthetic status' },
  { description: 'Bad timestamp', timestamp: 'definitely-not-a-time' }
]);
assert.equal(ambiguous.firstAttemptDate, '2026-06-04', 'multiple attempts must select the earliest chronologically');
assert(!ambiguous.conflictCodes.includes('CONFLICTING_FIRST_ATTEMPT_DATES'));
assert(ambiguous.conflictCodes.includes('INVALID_EVENT_TIMESTAMP'));
assert.equal(ambiguous.unknownEventCount, 2);

const deliveryWithoutAttempt = normalizeTrackingEvents([{ description: 'Delivered', eventDate: '2026-06-05' }]);
assert.equal(deliveryWithoutAttempt.actualDeliveryDate, '2026-06-05');
assert.equal(deliveryWithoutAttempt.firstAttemptDate, '2026-06-05');
assert.equal(deliveryWithoutAttempt.firstAttemptTimestamp, deliveryWithoutAttempt.actualDeliveryTimestamp);
assert.equal(deliveryWithoutAttempt.firstAttemptAndActualDeliverySameEvent, true);
assert.equal(deliveryWithoutAttempt.sharedSuccessfulDeliveryEvent, true);

const failedThenDelivered = normalizeTrackingEvents([
  { code: 'DELIVERED-DESC', description: 'Delivered', eventDate: '2026-06-05', eventTime: '09:00:00', eventTimeZone: 'EDT' },
  { code: 'ATTEMPT-DESC', description: 'Delivery attempt made', eventDate: '2026-06-04', eventTime: '17:00:00', eventTimeZone: 'EDT' }
]);
assert.equal(failedThenDelivered.firstAttemptDate, '2026-06-04');
assert.equal(failedThenDelivered.actualDeliveryDate, '2026-06-05');
assert.equal(failedThenDelivered.firstAttemptAndActualDeliverySameEvent, false);

const noticeThenPickup = normalizeTrackingEvents([
  { description: 'Shipment picked up by Canada Post', eventDate: '2026-06-01' },
  { description: 'Notice card left', eventDate: '2026-06-04' },
  { description: 'Item available for pickup', eventDate: '2026-06-05' }
]);
assert.equal(noticeThenPickup.firstAttemptDate, '2026-06-04');
assert.equal(noticeThenPickup.actualDeliveryDate, '');

const pickupOnly = normalizeTrackingEvents([{ description: 'Shipment picked up by Canada Post', eventDate: '2026-06-01' }]);
assert.equal(pickupOnly.firstAttemptDate, '', 'parcel pickup must never become first-attempt evidence');

const directToPostOffice = normalizeTrackingEvents([{ description: 'Item delivered to post office', eventDate: '2026-06-04' }]);
assert.equal(directToPostOffice.events[0].type, EVENT_TYPES.DELIVERY_TO_POST_OFFICE);
assert.equal(directToPostOffice.firstAttemptDate, '', 'delivery to a post office is not an attempt without a documented basis');
assert.equal(directToPostOffice.actualDeliveryDate, '');

const addressAttempt = normalizeTrackingEvents([{ description: 'Unable to deliver because address was incomplete', eventDate: '2026-06-04' }]);
assert.equal(addressAttempt.firstAttemptSourceCategory, EVENT_TYPES.ADDRESS_DELIVERY_ATTEMPT);

const sameDayAttempts = normalizeTrackingEvents([
  { code: 'LATER', description: 'Recipient unavailable', eventDate: '2026-06-04', eventTime: '16:00:00', eventTimeZone: 'EDT' },
  { code: 'EARLIER', description: 'Delivery attempt made', eventDate: '2026-06-04', eventTime: '09:00:00', eventTimeZone: 'EDT' }
]);
assert.equal(sameDayAttempts.firstAttemptSourceEventCode, 'EARLIER');

const repeatedCodeWithoutZone = normalizeTrackingEvents([
  { code: 'ATTEMPT', description: 'Delivery attempt made', eventDate: '2026-06-04', eventTime: '16:00:00' },
  { code: 'ATTEMPT', description: 'Delivery attempt made', eventDate: '2026-06-04', eventTime: '09:00:00' }
]);
assert.equal(repeatedCodeWithoutZone.normalizedEventCount, 2, 'distinct attempt times must not be deduplicated');
assert.match(repeatedCodeWithoutZone.firstAttemptTimestamp, /T09:00:00$/);

const eligibility = classifyEligibility({
  trackingNumber: 'SYNTHETIC-EARLIEST', serviceCode: 'DOM.XP', shipmentDate: '2026-06-01',
  expectedDeliveryDate: '2026-06-03', firstAttemptDate: failedThenDelivered.firstAttemptDate,
  actualDeliveryDate: failedThenDelivered.actualDeliveryDate, destinationProvince: 'ON',
  sender: { name: 'Synthetic', address: '1 Test', city: 'Ottawa', province: 'ON', postalCode: 'K1A0B1' },
  contact: { name: 'Synthetic', email: 'synthetic@example.invalid' }, claimEvidence: ['synthetic']
}, { asOf: '2026-06-10', classificationTimestamp: '2026-06-10T12:00:00Z' });
assert.equal(eligibility.firstAttemptDate, '2026-06-04');
assert.equal(eligibility.classification, 'LATE_CANDIDATE', 'successful delivery must control delivered-late classification');
assert.equal(eligibility.calendarDaysLate, 2, 'lateness is measured from successful delivery, not first attempt');

assert.deepEqual(deriveDeliveryStatus(deliveryWithoutAttempt, { expectedDeliveryDate: '2026-06-03', asOf: '2026-06-10' }), {
  state: DELIVERY_STATES.DELIVERED, label: 'Delivered', overdue: false
});
assert.equal(deriveDeliveryStatus(addressAttempt, { expectedDeliveryDate: '2026-06-03', asOf: '2026-06-10' }).state, DELIVERY_STATES.DELIVERY_ATTEMPTED_NOT_DELIVERED);
assert.equal(deriveDeliveryStatus(pickupOnly, { expectedDeliveryDate: '2026-06-03', asOf: '2026-06-10' }).state, DELIVERY_STATES.IN_TRANSIT);
assert.equal(deriveDeliveryStatus([], { expectedDeliveryDate: '2026-06-03', asOf: '2026-06-10' }).state, DELIVERY_STATES.NO_DELIVERY_EVIDENCE);

const timezone = normalizeTrackingEvents([{ description: 'Delivery attempt made', timestamp: '2026-06-04T00:30:00Z' }]);
assert.equal(timezone.firstAttemptDate, '2026-06-03');

console.log('Tracking normalization tests passed.');
