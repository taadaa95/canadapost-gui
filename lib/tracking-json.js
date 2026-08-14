'use strict';

const { normalizeDate } = require('./business-calendar');

const TRACKING_PARSER_VERSION = 'tracking-details-official-v4';

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`Tracking JSON field ${name} must be boolean.`);
  return value;
}

function optionalString(value, max = 1024) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim().slice(0, max);
}

function parseTrackingJson(input, expectedPin = '') {
  let payload;
  try {
    payload = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (_) {
    throw new Error('Canada Post Tracking response was not valid JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Canada Post Tracking response must be a JSON object.');
  }
  const pin = optionalString(payload.pin, 35);
  if (!pin) throw new Error('Tracking JSON field pin is required.');
  const normalizedExpectedPin = String(expectedPin || '').replace(/\s+/g, '').toUpperCase();
  if (normalizedExpectedPin && pin.replace(/\s+/g, '').toUpperCase() !== normalizedExpectedPin) {
    throw new Error('Tracking JSON pin did not match the requested shipment.');
  }
  const activeExists = requireBoolean(payload.activeExists, 'activeExists');
  const archiveExists = requireBoolean(payload.archiveExists, 'archiveExists');
  const signatureImageExists = requireBoolean(payload.signatureImageExists, 'signatureImageExists');
  const suppressSignature = requireBoolean(payload.suppressSignature, 'suppressSignature');
  const eventsSource = payload.significantEvents === undefined ? [] : payload.significantEvents;
  if (!Array.isArray(eventsSource)) throw new Error('Tracking JSON field significantEvents must be an array.');
  const deliveryOptionsSource = payload.deliveryOptions === undefined ? [] : payload.deliveryOptions;
  if (!Array.isArray(deliveryOptionsSource)) throw new Error('Tracking JSON field deliveryOptions must be an array.');
  const deliveryOptions = deliveryOptionsSource.map((option, index) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error(`Tracking delivery option ${index + 1} must be an object.`);
    const code = optionalString(option.deliveryOption, 128);
    const description = optionalString(option.deliveryOptionDescription, 256);
    if (!code || !description) throw new Error(`Tracking delivery option ${index + 1} requires a code and description.`);
    return { code, description };
  });
  const events = eventsSource.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error(`Tracking event ${index + 1} must be an object.`);
    const eventDate = normalizeDate(event.eventDate);
    const eventTime = optionalString(event.eventTime, 32);
    if (!eventDate || !eventTime) throw new Error(`Tracking event ${index + 1} requires eventDate and eventTime.`);
    return {
      code: optionalString(event.eventIdentifier, 128),
      description: optionalString(event.eventDescription, 1024),
      eventDate,
      eventTime,
      eventTimeZone: optionalString(event.eventTimeZone, 64),
      eventSite: optionalString(event.eventSite, 256),
      eventProvince: optionalString(event.eventProvince, 32),
      eventRetailLocationId: optionalString(event.eventRetailLocationId, 128),
      eventRetailName: optionalString(event.eventRetailName, 256)
    };
  });
  const originalExpectedDeliveryDate = normalizeDate(payload.expectedDeliveryDate);
  const revisedExpectedDeliveryDate = normalizeDate(payload.changedExpectedDate);
  return {
    pin: expectedPin || pin,
    activeExists,
    archiveExists,
    signatureImageExists,
    suppressSignature,
    // The public Delivery Standard is represented by expectedDeliveryDate. A changed
    // estimate remains useful evidence, but must not replace the original standard.
    expectedDeliveryDate: originalExpectedDeliveryDate || revisedExpectedDeliveryDate,
    originalExpectedDeliveryDate,
    revisedExpectedDeliveryDate,
    expectedDeliverySource: originalExpectedDeliveryDate
      ? 'tracking_api.expectedDeliveryDate'
      : (revisedExpectedDeliveryDate ? 'tracking_api.changedExpectedDate' : ''),
    expectedDeliverySelectionReason: originalExpectedDeliveryDate
      ? 'Original Tracking API expectedDeliveryDate selected as the Delivery Standard; changedExpectedDate retained separately.'
      : (revisedExpectedDeliveryDate
          ? 'Original expectedDeliveryDate was unavailable; changedExpectedDate used as the only API-provided estimate.'
          : 'No expected-delivery date was returned by the Tracking API.'),
    changedExpectedDeliveryReason: optionalString(payload.changedExpectedDeliveryReason, 500),
    serviceName: optionalString(payload.serviceName, 256),
    serviceName2: optionalString(payload.serviceName2, 256),
    deliveryOptions,
    postalCode: optionalString(payload.destinationPostalId, 32).replace(/\s+/g, '').toUpperCase(),
    reference: optionalString(payload.customerRef1, 256),
    reference2: optionalString(payload.customerRef2, 256),
    events,
    archiveState: archiveExists ? 'archived' : (activeExists ? 'active' : 'not_found'),
    schema: {
      parserVersion: TRACKING_PARSER_VERSION,
      responseShape: 'official_direct_object',
      statusLocated: true,
      eventCollectionLocated: true,
      eventCollectionPresent: Object.hasOwn(payload, 'significantEvents'),
      eventCollectionDocumentedEmpty: eventsSource.length === 0,
      eventCollectionPath: '$.significantEvents',
      eventCount: eventsSource.length,
      expectedDeliveryPresent: payload.expectedDeliveryDate !== undefined && payload.expectedDeliveryDate !== null,
      revisedExpectedDeliveryPresent: payload.changedExpectedDate !== undefined && payload.changedExpectedDate !== null,
      servicePathsPresent: ['serviceName', 'serviceName2'].filter(name => payload[name] !== undefined && payload[name] !== null),
      criticalErrors: []
    }
  };
}

function normalizedTrackingEvents(detail) {
  const expected = [];
  if (detail.originalExpectedDeliveryDate) expected.push({
    type: 'EXPECTED_DELIVERY', expectedDeliveryDate: detail.originalExpectedDeliveryDate,
    eventDate: detail.originalExpectedDeliveryDate, description: 'Expected delivery date from Tracking API',
    expectedDateSource: 'tracking_api.expectedDeliveryDate'
  });
  if (detail.revisedExpectedDeliveryDate) expected.push({
    type: 'EXPECTED_DELIVERY', expectedDeliveryDate: detail.revisedExpectedDeliveryDate,
    eventDate: detail.revisedExpectedDeliveryDate, description: 'Revised expected delivery date from Tracking API', revised: true,
    expectedDateSource: 'tracking_api.changedExpectedDate', revisedReason: detail.changedExpectedDeliveryReason || ''
  });
  return [...expected, ...detail.events];
}

module.exports = { TRACKING_PARSER_VERSION, parseTrackingJson, normalizedTrackingEvents };
