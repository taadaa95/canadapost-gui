'use strict';

const { classifyEligibility } = require('./policy-engine');
const { policy } = require('./policy-engine');
const { sha256Canonical } = require('./canonical-json');
const { CLASSIFICATION_INPUT_SCHEMA_VERSION, validateClassificationInput } = require('./normalized-shipment');

function validatePolicyBoundary(claim, boundary) {
  if (claim?.schemaVersion === CLASSIFICATION_INPUT_SCHEMA_VERSION) validateClassificationInput(claim, boundary);
  return claim;
}

function createQueueSnapshot(claims, metadata = {}) {
  if (!Array.isArray(claims) || !claims.length) throw new Error('A queue snapshot requires at least one claim.');
  const items = claims.map(claim => {
    validatePolicyBoundary(claim, 'queue-snapshot');
    const classification = classifyEligibility(claim, { asOf: metadata.asOf || metadata.createdAt, classificationTimestamp: metadata.createdAt });
    return {
      trackingNumber: String(claim.trackingNumber || '').trim().toUpperCase(),
      inputHash: sha256Canonical(claim),
      classification: classification.classification,
      classificationEvidenceHash: classification.evidenceHash,
      policyVersion: classification.policyVersion
    };
  });
  if (items.some(item => !item.trackingNumber)) throw new Error('Every queue item requires a tracking number.');
  const snapshot = {
    version: 1,
    createdAt: String(metadata.createdAt || new Date().toISOString()),
    policyDataVersion: String(metadata.policyDataVersion || policy.dataVersion),
    items
  };
  return { ...snapshot, snapshotHash: sha256Canonical(snapshot) };
}

function verifyQueueSnapshot(snapshot, claims) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.items)) return { ok: false, reason: 'SNAPSHOT_INVALID' };
  const withoutHash = { version: snapshot.version, createdAt: snapshot.createdAt, policyDataVersion: snapshot.policyDataVersion, items: snapshot.items };
  if (sha256Canonical(withoutHash) !== snapshot.snapshotHash) return { ok: false, reason: 'SNAPSHOT_HASH_MISMATCH' };
  if (snapshot.items.length !== claims.length) return { ok: false, reason: 'QUEUE_LENGTH_CHANGED' };
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    const item = snapshot.items[index];
    if (String(claim.trackingNumber || '').trim().toUpperCase() !== item.trackingNumber || sha256Canonical(claim) !== item.inputHash) {
      return { ok: false, reason: 'QUEUE_ITEM_CHANGED', trackingNumber: item.trackingNumber };
    }
  }
  return { ok: true };
}

function revalidateQueueItem({ snapshot, claims, claim, currentEvidence, options = {} }) {
  const integrity = verifyQueueSnapshot(snapshot, claims);
  if (!integrity.ok) return { allowed: false, requiresNewSnapshot: true, reason: integrity.reason, integrity };
  if (snapshot.policyDataVersion !== policy.dataVersion) {
    return { allowed: false, requiresNewSnapshot: true, reason: 'POLICY_DATA_VERSION_CHANGED' };
  }
  const original = claims.find(item => String(item.trackingNumber || '').trim().toUpperCase() === String(claim.trackingNumber || '').trim().toUpperCase());
  if (!original) return { allowed: false, requiresNewSnapshot: true, reason: 'CLAIM_NOT_IN_SNAPSHOT' };
  const currentInput = validatePolicyBoundary({ ...original, ...currentEvidence }, 'pre-submission-revalidation');
  const current = classifyEligibility(currentInput, options);
  const snapshotItem = snapshot.items.find(item => item.trackingNumber === String(claim.trackingNumber || '').trim().toUpperCase());
  const changed = snapshotItem.classificationEvidenceHash !== current.evidenceHash || snapshotItem.classification !== current.classification || snapshotItem.policyVersion !== current.policyVersion;
  if (changed) return { allowed: false, requiresNewSnapshot: true, reason: 'CLASSIFICATION_CHANGED', snapshotItem, current };
  if (current.classification !== 'LATE_CANDIDATE') return { allowed: false, requiresNewSnapshot: false, reason: 'NOT_LATE_CANDIDATE', current };
  return { allowed: true, requiresNewSnapshot: false, reason: 'REVALIDATED', current };
}

module.exports = { createQueueSnapshot, verifyQueueSnapshot, revalidateQueueItem };
