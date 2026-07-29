'use strict';

const { normalizeDate } = require('./business-calendar');

const CLASSIFICATIONS = Object.freeze(['LATE_CANDIDATE', 'ON_TIME', 'REVIEW_REQUIRED', 'TRACKING_ERROR']);

function text(value, max = 4096) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeClaimInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Claim input must be an object.');
  const sender = input.sender && typeof input.sender === 'object' ? input.sender : {};
  const contact = input.contact && typeof input.contact === 'object' ? input.contact : {};
  const receiver = input.receiver && typeof input.receiver === 'object' ? input.receiver : {};
  const normalized = {
    trackingNumber: text(input.trackingNumber || input.pin || input['Tracking PIN'], 128).replace(/\s+/g, '').toUpperCase(),
    serviceCode: text(input.serviceCode || input['Service Code'], 64).toUpperCase(),
    shipmentDate: normalizeDate(input.shipmentDate || input.shipDate || input['Ship Date']),
    expectedDeliveryDate: normalizeDate(input.expectedDeliveryDate || input.expectedDate || input['Expected Delivery Date']),
    originalExpectedDeliveryDate: normalizeDate(input.originalExpectedDeliveryDate || input.originalExpectedDate),
    expectedDeliverySource: text(input.expectedDeliverySource, 128),
    expectedDeliverySelectionReason: text(input.expectedDeliverySelectionReason, 1024),
    firstAttemptDate: normalizeDate(input.firstAttemptDate || input['First Attempt Date']),
    firstAttemptAt: text(input.firstAttemptAt || input.firstAttemptTimestamp, 64),
    firstAttemptEventCode: text(input.firstAttemptEventCode, 128),
    firstAttemptCategory: text(input.firstAttemptCategory, 128),
    firstAttemptProvenance: text(input.firstAttemptProvenance, 128),
    firstAttemptConfidence: text(input.firstAttemptConfidence, 128),
    firstAttemptDescription: text(input.firstAttemptDescription, 1024),
    actualDeliveryDate: normalizeDate(input.actualDeliveryDate || input.deliveryDate || input['Actual Delivery Date']),
    actualDeliveryAt: text(input.actualDeliveryAt || input.actualDeliveryTimestamp, 64),
    actualDeliveryEventCode: text(input.actualDeliveryEventCode, 128),
    actualDeliveryCategory: text(input.actualDeliveryCategory, 128),
    actualDeliveryProvenance: text(input.actualDeliveryProvenance, 128),
    actualDeliveryConfidence: text(input.actualDeliveryConfidence, 128),
    actualDeliveryDescription: text(input.actualDeliveryDescription, 1024),
    actualDeliveryClassificationSource: text(input.actualDeliveryClassificationSource, 128),
    firstAttemptAndActualDeliverySameEvent: Boolean(input.firstAttemptAndActualDeliverySameEvent),
    schemaVersion: text(input.schemaVersion, 128),
    parserVersion: text(input.parserVersion, 128),
    apiContractVersion: text(input.apiContractVersion, 64),
    canonicalEvidenceHash: text(input.canonicalEvidenceHash, 128),
    serviceName: text(input.serviceName, 256),
    serviceProvenance: text(input.serviceProvenance, 64),
    normalizedStatus: text(input.normalizedStatus, 128),
    revisedExpectedDeliveryDate: normalizeDate(input.revisedExpectedDeliveryDate),
    revisedExpectedDeliveryReason: text(input.revisedExpectedDeliveryReason, 500),
    destinationProvince: text(input.destinationProvince || input.province, 8).toUpperCase(),
    referenceNumber: text(input.referenceNumber || input.reference || input['Reference #'], 256),
    contentsDescription: text(input.contentsDescription, 2048),
    sender: {
      name: text(sender.name || sender.businessName, 256),
      address: text(sender.address, 1024),
      city: text(sender.city, 256),
      province: text(sender.province, 8).toUpperCase(),
      postalCode: text(sender.postalCode, 32).toUpperCase()
    },
    contact: {
      name: text(contact.name, 256),
      email: text(contact.email, 320),
      phone: text(contact.phone, 64)
    },
    receiver: {
      name: text(receiver.name, 256),
      address: text(receiver.address, 1024),
      city: text(receiver.city, 256),
      region: text(receiver.region || receiver.province, 128),
      postalCode: text(receiver.postalCode, 64),
      country: text(receiver.country, 64)
    },
    claimEvidence: Array.isArray(input.claimEvidence) ? input.claimEvidence.slice(0, 1000).map(item => text(item, 4096)) : [],
    normalizedEvents: Array.isArray(input.normalizedEvents) ? input.normalizedEvents : [],
    exclusionSignals: Array.isArray(input.exclusionSignals) ? [...new Set(input.exclusionSignals.map(item => text(item, 128).toUpperCase()))].sort() : [],
    conflictCodes: Array.isArray(input.conflictCodes) ? [...new Set(input.conflictCodes.map(item => text(item, 128).toUpperCase()))].sort() : [],
    unknownEventCount: Math.max(0, Number(input.unknownEventCount || 0)),
    requireReceiver: Boolean(input.requireReceiver),
    requireContentsDescription: Boolean(input.requireContentsDescription)
  };
  return normalized;
}

function missingRequiredClaimFields(input) {
  const missing = [];
  if (!input.trackingNumber) missing.push('trackingNumber');
  if (!input.serviceCode) missing.push('serviceCode');
  if (!input.shipmentDate) missing.push('shipmentDate');
  if (!input.expectedDeliveryDate) missing.push('expectedDeliveryDate');
  if (!input.firstAttemptDate) missing.push('firstAttemptDate');
  if (!input.sender.name) missing.push('sender.name');
  if (!input.sender.address || !input.sender.city || !input.sender.province || !input.sender.postalCode) missing.push('sender.address');
  if (!input.contact.name) missing.push('contact.name');
  if (!input.contact.email && !input.contact.phone) missing.push('contact.emailOrPhone');
  if (!input.claimEvidence.length && !input.normalizedEvents.length) missing.push('claimEvidence');
  if (input.requireReceiver && (!input.receiver.name || !input.receiver.country || !input.receiver.postalCode)) missing.push('receiver');
  if (input.requireContentsDescription && !input.contentsDescription) missing.push('contentsDescription');
  return [...new Set(missing)].sort();
}

function assertClassificationResult(result) {
  if (!result || typeof result !== 'object' || !CLASSIFICATIONS.includes(result.classification)) {
    throw new TypeError('Invalid eligibility classification result.');
  }
  for (const field of ['policyVersion', 'classificationTimestamp', 'holidayCalendarVersion', 'inputHash', 'explanation']) {
    if (typeof result[field] !== 'string') throw new TypeError(`Eligibility result ${field} must be a string.`);
  }
  for (const field of ['reasonCodes', 'warningCodes', 'policySourceIds', 'exclusionSignals', 'missingEvidence']) {
    if (!Array.isArray(result[field])) throw new TypeError(`Eligibility result ${field} must be an array.`);
  }
  return result;
}

module.exports = { CLASSIFICATIONS, normalizeClaimInput, missingRequiredClaimFields, assertClassificationResult };
