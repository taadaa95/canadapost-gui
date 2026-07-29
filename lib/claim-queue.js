'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeTrackingNumber, validateTrackingSelection } = require('./input-validation');
const { NORMALIZED_SHIPMENT_SCHEMA_VERSION, buildClassificationInput, validateCanonicalShipment } = require('./normalized-shipment');

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function readClaimsCsv(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { headers: [], rows: [] };
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!text) return { headers: [], rows: [] };
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]).map(value => value.trim());
  const rows = lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    const row = { _rowNumber: index + 2, _rawValues: values };
    headers.forEach((header, headerIndex) => { row[header] = values[headerIndex] ?? ''; });
    return row;
  });
  return { headers, rows };
}

function firstValue(row, candidates) {
  for (const name of candidates) {
    const value = row[name];
    if (value !== undefined && String(value).trim()) return String(value).trim();
  }
  return '';
}

function trackingFromRow(row) {
  return normalizeTrackingNumber(firstValue(row, ['Tracking PIN', 'Tracking Number', 'PIN', 'pin', 'trackingNumber', 'Tracking']));
}

function previewClaims(filePath) {
  const parsed = readClaimsCsv(filePath);
  const items = parsed.rows.map(row => ({
    rowNumber: row._rowNumber,
    trackingNumber: trackingFromRow(row),
    referenceNumber: firstValue(row, ['Reference #', 'Reference Number', 'Reference', 'reference']),
    postalCode: firstValue(row, ['Destination Postal Code', 'Postal Code', 'postalCode']),
    serviceCode: firstValue(row, ['Service Code', 'serviceCode']),
    expectedDate: firstValue(row, ['Expected Delivery Date', 'Expected Date', 'expectedDate']),
    firstAttemptDate: firstValue(row, ['First Attempt Date', 'firstAttemptDate']),
    deliveryDate: firstValue(row, ['Actual Delivery Date', 'Delivery Date', 'deliveryDate']),
    shipmentDate: firstValue(row, ['Shipment Date', 'Ship Date', 'shipmentDate']),
    deadline: firstValue(row, ['Claim Submission Deadline', 'claimSubmissionDeadline']),
    businessDaysRemaining: firstValue(row, ['Business Days Remaining', 'businessDaysRemaining']),
    businessDaysLate: firstValue(row, ['Business Days Late', 'businessDaysLate']),
    policyVersion: firstValue(row, ['Policy Version', 'policyVersion']),
    holidayCalendarVersion: firstValue(row, ['Holiday Calendar Version', 'holidayCalendarVersion']),
    eligibilityReason: firstValue(row, ['Eligibility Reason', 'Reason', 'eligibilityReason']),
    manualReviewReason: firstValue(row, ['Manual Review Reason', 'manualReviewReason'])
  })).filter(item => item.trackingNumber);
  return { path: filePath, count: items.length, items };
}

function parseJsonCell(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function claimInputFromRow(row, settings = {}) {
  const normalizedEvidence = parseJsonCell(firstValue(row, ['Normalized Evidence JSON', 'normalizedEvidenceJson']), {});
  const evidenceHash = firstValue(row, ['Evidence Hash', 'Classification Input Hash', 'evidenceHash']);
  const street = [settings.claimStreetNumber, settings.claimStreetName, settings.claimAddressLine2].filter(Boolean).join(' ');
  const receiver = {
    name: firstValue(row, ['Receiver Name', 'receiverName']), address: firstValue(row, ['Receiver Address', 'receiverAddress']),
    city: firstValue(row, ['Receiver City', 'receiverCity']), region: firstValue(row, ['Receiver Province', 'Receiver Region', 'receiverRegion']),
    postalCode: firstValue(row, ['Destination Postal Code', 'Receiver Postal Code', 'postalCode']), country: firstValue(row, ['Receiver Country', 'Country', 'receiverCountry'])
  };
  if (normalizedEvidence.schemaVersion === NORMALIZED_SHIPMENT_SCHEMA_VERSION) {
    validateCanonicalShipment(normalizedEvidence, 'claims-csv-revalidation');
    return buildClassificationInput(normalizedEvidence, {
      sender: {
        name: settings.claimBusinessName || settings.claimContactName || '', address: street,
        city: settings.claimCity || '', province: settings.claimProvince || '', postalCode: settings.claimPostalCode || ''
      },
      contact: { name: settings.claimContactName || '', email: settings.claimContactEmail || '', phone: settings.claimContactPhone || '' },
      receiver,
      contentsDescription: firstValue(row, ['Contents Description', 'contentsDescription']),
      requireReceiver: Boolean(firstValue(row, ['Receiver Required', 'requireReceiver'])),
      requireContentsDescription: Boolean(firstValue(row, ['Contents Description Required', 'requireContentsDescription']))
    });
  }
  return {
    trackingNumber: trackingFromRow(row),
    serviceCode: firstValue(row, ['Service Code', 'serviceCode']),
    shipmentDate: firstValue(row, ['Shipment Date', 'Ship Date', 'shipmentDate']),
    expectedDeliveryDate: firstValue(row, ['Expected Delivery Date', 'Expected Date', 'expectedDate']),
    originalExpectedDeliveryDate: firstValue(row, ['Original Delivery Standard Date', 'Original Expected Delivery Date', 'originalExpectedDeliveryDate']),
    revisedExpectedDeliveryDate: firstValue(row, ['Revised Expected Delivery Date', 'revisedExpectedDeliveryDate']),
    expectedDeliverySource: firstValue(row, ['Expected Date Source', 'expectedDeliverySource']),
    expectedDeliverySelectionReason: firstValue(row, ['Expected Date Selection Reason', 'expectedDeliverySelectionReason']),
    firstAttemptDate: firstValue(row, ['First Attempt Date', 'firstAttemptDate']) || normalizedEvidence.firstAttemptDate || '',
    firstAttemptAt: firstValue(row, ['First Attempt Timestamp', 'firstAttemptAt']),
    firstAttemptEventCode: firstValue(row, ['First Attempt Event Identifier', 'firstAttemptEventCode']),
    firstAttemptDescription: firstValue(row, ['First Attempt Event Description', 'firstAttemptDescription']),
    firstAttemptProvenance: firstValue(row, ['First Attempt Provenance', 'firstAttemptProvenance']),
    actualDeliveryDate: firstValue(row, ['Actual Delivery Date', 'Delivery Date', 'deliveryDate']) || normalizedEvidence.actualDeliveryDate || '',
    actualDeliveryAt: firstValue(row, ['Successful Delivery Timestamp', 'actualDeliveryAt']),
    actualDeliveryEventCode: firstValue(row, ['Successful Delivery Event Identifier', 'actualDeliveryEventCode']),
    actualDeliveryDescription: firstValue(row, ['Successful Delivery Event Description', 'actualDeliveryDescription']),
    actualDeliveryClassificationSource: firstValue(row, ['Successful Delivery Normalization Rule', 'actualDeliveryClassificationSource']),
    actualDeliveryProvenance: firstValue(row, ['Successful Delivery Provenance', 'actualDeliveryProvenance']),
    destinationProvince: firstValue(row, ['Destination Province', 'Province', 'destinationProvince']),
    referenceNumber: firstValue(row, ['Reference #', 'Reference Number', 'Reference', 'reference']),
    contentsDescription: firstValue(row, ['Contents Description', 'contentsDescription']),
    sender: {
      name: settings.claimBusinessName || settings.claimContactName || '',
      address: street,
      city: settings.claimCity || '', province: settings.claimProvince || '', postalCode: settings.claimPostalCode || ''
    },
    contact: { name: settings.claimContactName || '', email: settings.claimContactEmail || '', phone: settings.claimContactPhone || '' },
    receiver,
    claimEvidence: evidenceHash ? [`classification-input:${evidenceHash}`] : [],
    normalizedEvents: Array.isArray(normalizedEvidence.events) ? normalizedEvidence.events : [],
    exclusionSignals: Array.isArray(normalizedEvidence.exclusionSignals) ? normalizedEvidence.exclusionSignals : [],
    conflictCodes: Array.isArray(normalizedEvidence.conflictCodes) ? normalizedEvidence.conflictCodes : [],
    unknownEventCount: Number(normalizedEvidence.unknownEventCount || 0),
    requireReceiver: Boolean(firstValue(row, ['Receiver Required', 'requireReceiver'])),
    requireContentsDescription: Boolean(firstValue(row, ['Contents Description Required', 'requireContentsDescription']))
  };
}

function writeSelectedClaimsCsv(sourcePath, destinationPath, selectedTrackingNumbers) {
  const selected = new Set(validateTrackingSelection(selectedTrackingNumbers));
  const parsed = readClaimsCsv(sourcePath);
  if (!parsed.headers.length) throw new Error('claims.csv is empty or invalid.');
  const rows = selected.size
    ? parsed.rows.filter(row => selected.has(trackingFromRow(row)))
    : parsed.rows;
  if (!rows.length) throw new Error('No selected claims matched the current claims.csv file. Refresh the Step 3 queue and try again.');
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const lines = [
    parsed.headers.map(csvCell).join(','),
    ...rows.map(row => parsed.headers.map(header => csvCell(row[header] ?? '')).join(','))
  ];
  fs.writeFileSync(destinationPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  try { fs.chmodSync(destinationPath, 0o600); } catch (_) {}
  return { count: rows.length, path: destinationPath };
}

module.exports = {
  parseCsvLine,
  readClaimsCsv,
  previewClaims,
  writeSelectedClaimsCsv,
  trackingFromRow,
  claimInputFromRow,
  firstValue
};
