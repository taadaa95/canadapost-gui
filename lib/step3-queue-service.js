'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { canonicalize } = require('./canonical-json');
const { normalizeDate, calendarCoverage, countBusinessDaysAfter } = require('./business-calendar');
const { createQueueSnapshot } = require('./eligibility-revalidation');

const DEADLINE_STATES = Object.freeze([
  'known_active',
  'urgent',
  'expired',
  'unavailable',
  'policy_review_required'
]);
const TERMINAL_CLAIM_STATES = Object.freeze(['submitted', 'submitted_manual', 'already_submitted', 'rejected']);
const UNRESOLVED_CLAIM_STATES = Object.freeze(['in_progress', 'unknown']);

class Step3QueueError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'Step3QueueError';
    this.code = code;
    this.recordId = Number(details.recordId || 0) || null;
  }
}

function open(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');
  return db;
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function validFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function remainingBusinessDays(today, deadline, province) {
  if (today === deadline) return { ok: true, days: 0 };
  if (today < deadline) return countBusinessDaysAfter(today, deadline, province);
  const elapsed = countBusinessDaysAfter(deadline, today, province);
  return elapsed.ok ? { ...elapsed, days: -elapsed.days } : elapsed;
}

function deadlinePresentation(input = {}, options = {}) {
  const rawDeadline = input.deadline ?? input.claimSubmissionDeadline;
  const deadline = normalizeDate(rawDeadline);
  const today = normalizeDate(options.today || new Date().toISOString());
  const province = String(input.destinationProvince || input.province || '').trim().toUpperCase();
  const policyCoverageStale = input.policyCoverageStale === true
    || Boolean(deadline && (!calendarCoverage(deadline) || !calendarCoverage(today)));

  if (policyCoverageStale || (deadline && !province)) {
    return { state: 'policy_review_required', deadline: deadline || null, businessDaysRemaining: null };
  }
  if (rawDeadline !== null && rawDeadline !== undefined && String(rawDeadline).trim() && !deadline) {
    return { state: 'unavailable', deadline: null, businessDaysRemaining: null };
  }
  if (!deadline || !today) {
    return { state: 'unavailable', deadline: null, businessDaysRemaining: null };
  }
  const remaining = remainingBusinessDays(today, deadline, province);
  if (!remaining.ok || remaining.ambiguous) {
    return { state: 'policy_review_required', deadline, businessDaysRemaining: null };
  }
  const days = validFiniteNumber(remaining.days);
  if (days === null) return { state: 'unavailable', deadline, businessDaysRemaining: null };
  if (days < 0) return { state: 'expired', deadline, businessDaysRemaining: days };
  if (days <= 7) return { state: 'urgent', deadline, businessDaysRemaining: days };
  return { state: 'known_active', deadline, businessDaysRemaining: days };
}

function latestStep2Run(db) {
  return db.prepare("SELECT * FROM runs WHERE run_type IN ('tracking', 'full') ORDER BY id DESC LIMIT 1").get() || null;
}

function authoritativeRun(db) {
  const run = latestStep2Run(db);
  if (!run) throw new Step3QueueError('STEP2_RUN_MISSING', 'No completed promoted Step 2 run is available.');
  if (run.status !== 'complete' || !run.promoted_at) {
    throw new Step3QueueError('STEP2_RUN_NOT_AUTHORITATIVE', 'The latest Step 2 run is not complete and promoted. Recompute Step 2 successfully.');
  }
  return run;
}

function candidateRows(db, runId) {
  return db.prepare(`
    SELECT cr.id AS classification_id, cr.shipment_id, cr.run_id, cr.classification,
      cr.input_hash, cr.evidence_hash, cr.input_json, cr.evidence_json,
      cr.policy_version, cr.policy_data_version, cr.created_at,
      s.tracking_number, s.reference_number, s.service_code, s.destination_postal_code,
      s.expected_date, s.first_attempt_date, s.delivery_date
    FROM classification_records cr
    JOIN shipments s ON s.id = cr.shipment_id
    WHERE cr.run_id = ? AND cr.classification = 'LATE_CANDIDATE'
    ORDER BY cr.id
  `).all(Number(runId));
}

function publicCandidate(row, options = {}) {
  const evidence = parseObject(row.evidence_json);
  const input = parseObject(row.input_json);
  const deadline = deadlinePresentation({
    deadline: evidence.claimSubmissionDeadline,
    destinationProvince: input.destinationProvince,
    policyCoverageStale: evidence.warningCodes?.includes('CLAIM_WINDOW_UNVERIFIED_WARNING')
  }, options);
  return {
    recordId: Number(row.classification_id),
    evidenceHash: String(row.evidence_hash || ''),
    runId: Number(row.run_id),
    trackingNumber: row.tracking_number,
    referenceNumber: row.reference_number,
    postalCode: row.destination_postal_code,
    serviceCode: row.service_code,
    expectedDate: evidence.expectedDeliveryDate || row.expected_date || null,
    originalExpectedDeliveryDate: evidence.originalExpectedDeliveryDate || null,
    firstAttemptDate: evidence.firstAttemptDate || row.first_attempt_date || null,
    deliveryDate: evidence.actualDeliveryDate || row.delivery_date || null,
    deadline: deadline.deadline,
    deadlineState: deadline.state,
    businessDaysRemaining: deadline.businessDaysRemaining,
    policyVersion: row.policy_version || row.policy_data_version || '',
    eligibilityReason: evidence.explanation || '',
    automaticallyEligible: false,
    classification: 'LATE_CANDIDATE'
  };
}

function previewCandidates(dbPath, options = {}) {
  const db = open(dbPath);
  try {
    const run = authoritativeRun(db);
    const items = candidateRows(db, run.id).map(row => publicCandidate(row, options));
    return { count: items.length, items, runId: Number(run.id), refreshedAt: new Date(options.now || Date.now()).toISOString() };
  } finally {
    db.close();
  }
}

function selectionMap(selection) {
  if (!Array.isArray(selection) || !selection.length) throw new Step3QueueError('STEP3_SELECTION_EMPTY', 'Select at least one late-delivery candidate.');
  const map = new Map();
  for (const item of selection) {
    const id = Number(item?.recordId);
    const evidenceHash = String(item?.evidenceHash || '');
    if (!Number.isSafeInteger(id) || id < 1 || !/^[a-f0-9]{64}$/i.test(evidenceHash)) {
      throw new Step3QueueError('STEP3_SELECTION_INVALID', 'The selected candidate identifiers are invalid.');
    }
    if (map.has(id)) throw new Step3QueueError('STEP3_SELECTION_DUPLICATE', 'The same candidate was selected more than once.');
    map.set(id, evidenceHash.toLowerCase());
  }
  return map;
}

function selectionForRun(selection, options = {}) {
  if (!Array.isArray(selection)) return [];
  return options.canaryMode && !options.dryRun ? selection.slice(0, 1) : selection.slice();
}

function validateAttemptState(db, row) {
  const tombstone = db.prepare('SELECT terminal_outcome FROM claim_duplicate_tombstones WHERE tracking_hash = ? LIMIT 1')
    .get(crypto.createHash('sha256').update(`privacy-v1|${String(row.tracking_number || '').replace(/\s+/g, '').toUpperCase()}`).digest('hex'));
  if (tombstone) throw new Step3QueueError('STEP3_TERMINAL_OUTCOME', 'A preserved terminal claim record blocks resubmission.', { recordId: row.classification_id });
  const latest = db.prepare('SELECT status FROM claim_attempts WHERE shipment_id = ? AND dry_run = 0 ORDER BY id DESC LIMIT 1').get(row.shipment_id);
  if (!latest) return;
  if (TERMINAL_CLAIM_STATES.includes(latest.status)) {
    throw new Step3QueueError('STEP3_TERMINAL_OUTCOME', 'The shipment has already reached a terminal claim state.', { recordId: row.classification_id });
  }
  if (UNRESOLVED_CLAIM_STATES.includes(latest.status)) {
    throw new Step3QueueError('STEP3_UNRESOLVED_ATTEMPT', 'The shipment has an unresolved claim attempt that requires reconciliation.', { recordId: row.classification_id });
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function privateCsv(rows) {
  const headers = [
    'Tracking PIN', 'Reference #', 'Destination Postal Code', 'Service Code', 'Status',
    'Expected Delivery Date', 'Original Delivery Standard Date', 'First Attempt Date',
    'Actual Delivery Date', 'Eligibility Reason', 'Evidence Hash', 'Classification Input JSON'
  ];
  const values = rows.map(row => {
    const evidence = parseObject(row.evidence_json);
    const input = parseObject(row.input_json);
    return [
      row.tracking_number, row.reference_number, row.destination_postal_code, row.service_code,
      'LATE CANDIDATE',
      evidence.expectedDeliveryDate || row.expected_date, evidence.originalExpectedDeliveryDate || '',
      evidence.firstAttemptDate || row.first_attempt_date, evidence.actualDeliveryDate || row.delivery_date,
      evidence.explanation || '', row.evidence_hash, canonicalize(input)
    ];
  });
  return `${[headers, ...values].map(columns => columns.map(csvCell).join(',')).join('\n')}\n`;
}

function createRunSnapshot(dbPath, selection, destination, options = {}) {
  const selected = selectionMap(selection);
  const db = open(dbPath);
  db.exec('BEGIN IMMEDIATE;');
  try {
    const run = authoritativeRun(db);
    const placeholders = [...selected].map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT cr.id AS classification_id, cr.shipment_id, cr.run_id, cr.classification,
        cr.input_hash, cr.evidence_hash, cr.input_json, cr.evidence_json,
        cr.policy_version, cr.policy_data_version,
        s.tracking_number, s.reference_number, s.service_code, s.destination_postal_code,
        s.expected_date, s.first_attempt_date, s.delivery_date
      FROM classification_records cr JOIN shipments s ON s.id = cr.shipment_id
      WHERE cr.id IN (${placeholders}) ORDER BY cr.id
    `).all(...selected.keys());
    if (rows.length !== selected.size) throw new Step3QueueError('STEP3_RECORD_MISSING', 'One or more selected candidates no longer exist.');
    for (const row of rows) {
      if (Number(row.run_id) !== Number(run.id) || row.classification !== 'LATE_CANDIDATE') {
        throw new Step3QueueError('STEP3_CLASSIFICATION_CHANGED', 'A selected record is no longer part of the authoritative late-candidate run.', { recordId: row.classification_id });
      }
      if (String(row.evidence_hash || '').toLowerCase() !== selected.get(Number(row.classification_id))) {
        throw new Step3QueueError('STEP3_EVIDENCE_CHANGED', 'A selected candidate evidence hash changed. Refresh the candidate queue.', { recordId: row.classification_id });
      }
      validateAttemptState(db, row);
    }
    const inputs = rows.map(row => parseObject(row.input_json));
    const createdAt = new Date(options.now || Date.now()).toISOString();
    const snapshot = createQueueSnapshot(inputs, {
      createdAt,
      asOf: createdAt,
      policyDataVersion: rows[0]?.policy_data_version || ''
    });
    snapshot.sourceRunId = Number(run.id);
    snapshot.classificationRecordIds = rows.map(row => Number(row.classification_id));
    snapshot.snapshotIdentity = crypto.randomUUID();
    const saved = db.prepare(`INSERT INTO queue_snapshots
      (snapshot_hash, snapshot_identity, source_run_id, policy_data_version, status, item_count, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, 'reviewed', ?, ?, ?)`)
      .run(snapshot.snapshotHash, snapshot.snapshotIdentity, run.id, snapshot.policyDataVersion, rows.length, canonicalize(snapshot), createdAt);
    const snapshotId = Number(saved.lastInsertRowid);
    const insertItem = db.prepare(`INSERT INTO queue_snapshot_items
      (snapshot_id, shipment_id, classification_id, ordinal, input_hash, classification_evidence_hash)
      VALUES (?, ?, ?, ?, ?, ?)`);
    rows.forEach((row, index) => insertItem.run(snapshotId, row.shipment_id, row.classification_id, index, row.input_hash, row.evidence_hash));
    const csvText = privateCsv(rows);
    const snapshotJson = `${JSON.stringify(snapshot, null, 2)}\n`;
    const destinationRoot = path.resolve(options.allowedDirectory || path.dirname(destination.csvPath));
    for (const target of [destination.csvPath, destination.snapshotPath]) {
      const resolved = path.resolve(target);
      if (!(resolved === destinationRoot || resolved.startsWith(`${destinationRoot}${path.sep}`))) throw new Step3QueueError('STEP3_SNAPSHOT_PATH_INVALID', 'Private snapshot paths must remain in the approved run directory.');
      fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(destination.csvPath, csvText, { mode: 0o600, flag: 'wx' });
    try {
      fs.writeFileSync(destination.snapshotPath, snapshotJson, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      fs.rmSync(destination.csvPath, { force: true });
      throw error;
    }
    db.exec('COMMIT;');
    return {
      count: rows.length,
      snapshotId,
      snapshotIdentity: snapshot.snapshotIdentity,
      snapshotHash: snapshot.snapshotHash,
      sourceRunId: Number(run.id),
      csvPath: destination.csvPath,
      snapshotPath: destination.snapshotPath
    };
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    try { fs.rmSync(destination.csvPath, { force: true }); } catch (_) {}
    try { fs.rmSync(destination.snapshotPath, { force: true }); } catch (_) {}
    throw error;
  } finally {
    db.close();
  }
}

module.exports = {
  DEADLINE_STATES,
  TERMINAL_CLAIM_STATES,
  UNRESOLVED_CLAIM_STATES,
  Step3QueueError,
  validFiniteNumber,
  deadlinePresentation,
  selectionForRun,
  previewCandidates,
  createRunSnapshot,
  privateCsv
};
