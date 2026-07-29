'use strict';

const fs = require('fs');
const path = require('path');
const { assertClassificationResult } = require('./claim-domain');
const { validateCanonicalShipment, validateClassificationInput } = require('./normalized-shipment');

function validateTrackingStagingItem(item, boundary = 'bulk-staging') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Tracking staging item must be an object.');
  validateCanonicalShipment(item.canonicalShipment, `${boundary}-canonical`);
  validateClassificationInput(item.classificationInput, `${boundary}-classification-input`);
  assertClassificationResult(item.classification);
  if (!Array.isArray(item.rawEvents) || item.rawEvents.length !== 0) throw new Error('Raw shipment events must not enter bulk staging.');
  if (item.pin !== item.canonicalShipment.trackingNumber || item.pin !== item.classificationInput.trackingNumber) throw new Error('Tracking staging identity mismatch.');
  if (item.classificationInput.canonicalEvidenceHash !== item.canonicalShipment.evidenceHash) {
    const error = new Error('Tracking staging evidence hash mismatch.');
    error.code = 'EVIDENCE_HASH_MISMATCH';
    throw error;
  }
  return item;
}

function atomicPromoteTextFiles(files, options = {}) {
  const runId = String(options.runId || 'standalone').replace(/[^A-Za-z0-9_-]/g, '_');
  const prepared = [];
  for (const item of files) {
    const target = path.resolve(item.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.staging-${runId}`;
    fs.writeFileSync(temporary, String(item.content), { mode: 0o600 });
    prepared.push({ target, temporary, previous: fs.existsSync(target) ? fs.readFileSync(target) : null });
  }
  if (options.backupDirectory) {
    const backupDirectory = path.resolve(options.backupDirectory);
    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const manifest = [];
    for (const item of prepared) {
      const name = path.basename(item.target);
      manifest.push({ name, existed: item.previous !== null });
      if (item.previous !== null) fs.writeFileSync(path.join(backupDirectory, `${name}.previous`), item.previous, { mode: 0o600 });
    }
    fs.writeFileSync(path.join(backupDirectory, 'previous-files.json'), `${JSON.stringify({ version: 1, files: manifest }, null, 2)}\n`, { mode: 0o600 });
  }
  const promoted = [];
  try {
    for (const item of prepared) {
      fs.renameSync(item.temporary, item.target);
      promoted.push(item);
    }
    if (typeof options.afterPromote === 'function') options.afterPromote();
  } catch (error) {
    for (const item of promoted.reverse()) {
      if (item.previous === null) fs.rmSync(item.target, { force: true });
      else fs.writeFileSync(item.target, item.previous, { mode: 0o600 });
    }
    for (const item of prepared) fs.rmSync(item.temporary, { force: true });
    throw error;
  }
  return { promoted: prepared.length, runId };
}

function restorePreviousTextFiles(backupDirectory, targetDirectory) {
  const root = path.resolve(backupDirectory);
  const manifestPath = path.join(root, 'previous-files.json');
  if (!fs.existsSync(manifestPath)) return { restored: false, reason: 'backup_not_available', files: 0 };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const allowed = new Set(['claims.csv', 'eligibility-review.csv', 'overdue-undelivered.csv']);
  let restored = 0;
  for (const item of manifest.files || []) {
    const name = String(item.name || '');
    if (!allowed.has(name) || path.basename(name) !== name) throw new Error('Tracking output backup manifest contains an invalid file name.');
    const target = path.join(path.resolve(targetDirectory), name);
    if (fs.existsSync(target)) fs.copyFileSync(target, path.join(root, `${name}.discarded-current`));
    if (item.existed) fs.copyFileSync(path.join(root, `${name}.previous`), target);
    else fs.rmSync(target, { force: true });
    restored += 1;
  }
  return { restored: true, files: restored };
}

function validatePromotedTrackingSummary(summary = {}) {
  const total = Number(summary.total);
  const attempted = Number(summary.attempted);
  const complete = summary.status === 'COMPLETE'
    && summary.statePromoted === true
    && summary.queuePreserved === false
    && Number.isInteger(total)
    && total >= 0
    && attempted === total
    && summary.diagnosticMode === false;
  return complete
    ? { ok: true }
    : { ok: false, reason: 'Tracking worker did not prove a complete, promoted full traversal.' };
}

function validateTrackingRunForSubmission(run) {
  if (!run || run.status !== 'complete') {
    return { ok: false, reason: 'Step 2 has not completed and atomically promoted a full traversal.' };
  }
  return { ok: true };
}

module.exports = { atomicPromoteTextFiles, restorePreviousTextFiles, validatePromotedTrackingSummary, validateTrackingRunForSubmission, validateTrackingStagingItem };
