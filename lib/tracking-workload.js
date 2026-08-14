'use strict';

const { normalizeDate } = require('./business-calendar');
const { validateClassificationInput } = require('./normalized-shipment');
const { DELIVERY_STATES, EVENT_TYPES } = require('./tracking-normalizer');

const ACTIVE_DELIVERY_STATES = new Set([
  DELIVERY_STATES.IN_TRANSIT,
  DELIVERY_STATES.DELIVERY_ATTEMPTED_NOT_DELIVERED
]);
const ACTIVE_EVENT_TYPES = new Set([
  EVENT_TYPES.ELECTRONIC_INFORMATION,
  EVENT_TYPES.ACCEPTED,
  EVENT_TYPES.ITEM_PROCESSED,
  EVENT_TYPES.IN_TRANSIT,
  EVENT_TYPES.OUT_FOR_DELIVERY,
  EVENT_TYPES.AVAILABLE_FOR_PICKUP,
  EVENT_TYPES.PICKED_UP,
  EVENT_TYPES.DELIVERY_TO_POST_OFFICE,
  EVENT_TYPES.FIRST_DELIVERY_ATTEMPT,
  EVENT_TYPES.ADDRESS_DELIVERY_ATTEMPT,
  EVENT_TYPES.NOTICE_CARD,
  EVENT_TYPES.RECIPIENT_UNAVAILABLE,
  EVENT_TYPES.ADDRESS_PROBLEM,
  EVENT_TYPES.CUSTOMS_DELAY,
  EVENT_TYPES.WEATHER_DISRUPTION,
  EVENT_TYPES.OPERATIONAL_DISRUPTION,
  EVENT_TYPES.LABOUR_DISRUPTION
]);

function text(value) { return String(value ?? '').trim(); }
function canonicalTrackingNumber(value) { return text(value).replace(/\s+/g, '').toUpperCase().slice(0, 128); }
function rowTrackingNumber(row = {}) {
  return canonicalTrackingNumber(row['Tracking PIN'] || row['Tracking Number'] || row.PIN || row.Tracking);
}
function parseObject(value) {
  const parsed = JSON.parse(String(value || ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Expected tracking classification JSON object.');
  return parsed;
}

function isActiveUnresolvedClassification(input = {}) {
  if (text(input.actualDeliveryAt) || text(input.actualDeliveryDate) || text(input.actualDeliveryCategory) === EVENT_TYPES.SUCCESSFUL_DELIVERY) return false;
  const eventTypes = new Set((Array.isArray(input.normalizedEvents) ? input.normalizedEvents : []).map(event => text(event?.type).toUpperCase()));
  if (eventTypes.has(EVENT_TYPES.SUCCESSFUL_DELIVERY) || eventTypes.has(EVENT_TYPES.RETURN_TO_SENDER)) return false;
  const state = text(input.normalizedStatus).toUpperCase();
  if (ACTIVE_DELIVERY_STATES.has(state)) return true;
  if (state === DELIVERY_STATES.NO_DELIVERY_EVIDENCE) {
    // A successful response with no recognized terminal evidence is ambiguous.
    // Keep it eligible rather than silently retiring a shipment Canada Post may update later.
    return true;
  }
  return false;
}

function carryForwardRow(input = {}) {
  return {
    'Tracking PIN': canonicalTrackingNumber(input.trackingNumber),
    'Shipment Date': normalizeDate(input.shipmentDate) || '',
    'Shipment Date Source Field': text(input.shipmentDateSourceField) || 'database carry-forward',
    'Shipment Date Provenance': text(input.shipmentDateProvenance) || 'authoritative tracking history',
    'Service Code': text(input.serviceCode),
    'Destination Postal Code': text(input.destinationPostalCode),
    'Destination Province': text(input.destinationProvince),
    'Reference #': text(input.referenceNumber),
    'Expected Delivery Date': normalizeDate(input.expectedDeliveryDate) || '',
    'Original Delivery Standard Date': normalizeDate(input.originalExpectedDeliveryDate) || '',
    'Revised Expected Delivery Date': normalizeDate(input.revisedExpectedDeliveryDate) || '',
    __carryForward: true
  };
}

function loadCarryForwardRows(dbPath, options = {}) {
  if (!dbPath) return [];
  const claimDb = options.claimDb || require('./claim-database');
  return claimDb.withDatabase(dbPath, db => {
    const rows = db.prepare(`
      SELECT s.tracking_number, cr.input_json
      FROM shipments s
      JOIN classification_records cr ON cr.id = s.current_classification_id
      JOIN runs r ON r.id = cr.run_id
      WHERE r.run_type IN ('tracking', 'full')
        AND r.status = 'complete'
        AND r.promoted_at IS NOT NULL
      ORDER BY s.id
    `).all();
    const carried = [];
    for (const row of rows) {
      try {
        const input = parseObject(row.input_json);
        validateClassificationInput(input, 'tracking-carry-forward');
        if (!isActiveUnresolvedClassification(input)) continue;
        const carry = carryForwardRow({ ...input, trackingNumber: input.trackingNumber || row.tracking_number });
        if (carry['Tracking PIN']) carried.push(carry);
      } catch (_) {
        // Corrupt or obsolete evidence is not guessed into a workload.
      }
    }
    return carried;
  });
}

function buildTrackingWorkload(recentRows = [], carryRows = []) {
  const rows = [];
  const byTracking = new Map();
  for (const row of Array.isArray(recentRows) ? recentRows : []) {
    const pin = rowTrackingNumber(row);
    if (!pin || byTracking.has(pin)) continue;
    const current = { ...row, 'Tracking PIN': pin };
    delete current.__carryForward;
    byTracking.set(pin, current);
    rows.push(current);
  }
  const recentShipmentCount = rows.length;
  let carryForwardCount = 0;
  let carryForwardDeduplicated = 0;
  for (const carry of Array.isArray(carryRows) ? carryRows : []) {
    const pin = rowTrackingNumber(carry);
    if (!pin) continue;
    const current = byTracking.get(pin);
    if (current) {
      carryForwardDeduplicated += 1;
      if (text(carry['Original Delivery Standard Date'])) {
        current['Original Delivery Standard Date'] = carry['Original Delivery Standard Date'];
      }
      continue;
    }
    const row = { ...carry, 'Tracking PIN': pin, __carryForward: true };
    byTracking.set(pin, row);
    rows.push(row);
    carryForwardCount += 1;
  }
  return Object.freeze({ rows, recentShipmentCount, carryForwardCount, carryForwardDeduplicated });
}

module.exports = {
  ACTIVE_DELIVERY_STATES,
  ACTIVE_EVENT_TYPES,
  canonicalTrackingNumber,
  rowTrackingNumber,
  isActiveUnresolvedClassification,
  carryForwardRow,
  loadCarryForwardRows,
  buildTrackingWorkload
};
