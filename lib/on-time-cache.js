'use strict';

const { normalizeDate } = require('./business-calendar');
const { assertClassificationResult } = require('./claim-domain');
const { validateClassificationInput } = require('./normalized-shipment');

function text(value) {
  return String(value ?? '').trim();
}

function normalizedTracking(value) {
  return text(value).replace(/\s+/g, '').toUpperCase().slice(0, 128);
}

function identityText(value) {
  return text(value).replace(/\s+/g, ' ').toUpperCase();
}

function postalText(value) {
  return text(value).replace(/\s+/g, '').toUpperCase();
}

function value(row, names) {
  for (const name of names) {
    if (text(row?.[name])) return text(row[name]);
  }
  return '';
}

function sourceIdentity(row = {}) {
  return {
    trackingNumber: normalizedTracking(value(row, ['Tracking PIN', 'Tracking Number', 'PIN', 'Tracking'])),
    shipmentDate: normalizeDate(value(row, ['Shipment Date', 'Ship Date'])) || '',
    serviceCode: identityText(value(row, ['Service Code', 'Service'])),
    destinationPostalCode: postalText(value(row, ['Destination Postal Code', 'Postal Code'])),
    referenceNumber: identityText(value(row, ['Reference #', 'Reference Number', 'Reference']))
  };
}

function parseObject(value) {
  const parsed = JSON.parse(String(value || ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Expected a JSON object.');
  return parsed;
}

function successfulDeliveryEvidence(input) {
  if (!input.actualDeliveryAt || !input.actualDeliveryEventCode || !input.actualDeliveryProvenance || !input.actualDeliveryClassificationSource || !input.actualDeliveryConfidence) return false;
  if (identityText(input.actualDeliveryCategory) !== 'SUCCESSFUL_DELIVERY') return false;
  if (String(input.normalizedStatus || '').toUpperCase() !== 'DELIVERED') return false;
  if (!Array.isArray(input.claimEvidence) || !input.claimEvidence.some(item => /^canonical-shipment:[a-f0-9]{64}$/i.test(String(item)))) return false;
  if (!Array.isArray(input.normalizedEvents)) return false;
  return input.normalizedEvents.some(event => {
    const timestamp = text(event?.timestamp || event?.eventTimestamp);
    const code = text(event?.sourceCode || event?.code || event?.eventIdentifier);
    const type = identityText(event?.type || event?.normalizedType || event?.category);
    return timestamp === input.actualDeliveryAt
      && (!code || code === text(input.actualDeliveryEventCode))
      && (type.includes('DELIVER') || type.includes('SUCCESS'));
  });
}

function identityMatches(current, stored, shipment) {
  if (!current.trackingNumber || current.trackingNumber !== normalizedTracking(stored.trackingNumber || shipment.tracking_number)) return false;

  const storedDate = normalizeDate(stored.shipmentDate || shipment.ship_date) || '';
  if (current.shipmentDate && (!storedDate || current.shipmentDate !== storedDate)) return false;

  const comparisons = [
    [current.serviceCode, identityText(stored.serviceCode || shipment.service_code)],
    [current.destinationPostalCode, postalText(stored.destinationPostalCode || shipment.destination_postal_code)],
    [current.referenceNumber, identityText(stored.referenceNumber || shipment.reference_number)]
  ];
  return comparisons.every(([left, right]) => !left || !right || left === right);
}

function reusableConfirmedOnTime(dbPath, row = {}, options = {}) {
  if (!dbPath || options.diagnosticMode === true || options.structureExport === true) return null;
  const currentIdentity = sourceIdentity(row);
  if (!currentIdentity.trackingNumber) return null;

  try {
    const claimDb = options.claimDb || require('./claim-database');
    return claimDb.withDatabase(dbPath, db => {
      const saved = db.prepare(`
        SELECT s.*, cr.id AS classification_id, cr.run_id, cr.classification AS authoritative_classification,
          cr.input_hash, cr.evidence_hash, cr.input_json, cr.evidence_json,
          r.status AS run_status, r.promoted_at AS run_promoted_at, r.run_type
        FROM shipments s
        JOIN classification_records cr ON cr.id = s.current_classification_id
        JOIN runs r ON r.id = cr.run_id
        WHERE s.tracking_number = ?
      `).get(currentIdentity.trackingNumber);
      if (!saved || saved.authoritative_classification !== 'ON_TIME') return null;
      if (!['tracking', 'full'].includes(saved.run_type) || saved.run_status !== 'complete' || !saved.run_promoted_at) return null;

      const input = parseObject(saved.input_json);
      const classification = parseObject(saved.evidence_json);
      validateClassificationInput(input, 'on-time-cache');
      assertClassificationResult(classification);
      if (classification.classification !== 'ON_TIME') return null;
      if (classification.inputHash !== saved.input_hash || classification.evidenceHash !== saved.evidence_hash) return null;
      if (!identityMatches(currentIdentity, input, saved)) return null;

      const delivered = normalizeDate(input.actualDeliveryDate);
      const standard = normalizeDate(input.originalExpectedDeliveryDate);
      if (!delivered || !standard || delivered > standard) return null;
      if (normalizeDate(classification.actualDeliveryDate) !== delivered || normalizeDate(classification.originalExpectedDeliveryDate) !== standard) return null;
      if ((classification.missingEvidence || []).some(item => ['actualDeliveryDate', 'originalExpectedDeliveryDate'].includes(item))) return null;
      if (!successfulDeliveryEvidence(input)) return null;

      return {
        classificationId: Number(saved.classification_id),
        runId: Number(saved.run_id),
        trackingNumber: currentIdentity.trackingNumber,
        actualDeliveryDate: delivered,
        originalExpectedDeliveryDate: standard,
        expectedDeliveryDate: normalizeDate(input.expectedDeliveryDate) || standard,
        classificationInputHash: saved.input_hash,
        classificationEvidenceHash: saved.evidence_hash
      };
    });
  } catch (_) {
    return null;
  }
}

module.exports = {
  normalizedTracking,
  sourceIdentity,
  successfulDeliveryEvidence,
  identityMatches,
  reusableConfirmedOnTime
};
