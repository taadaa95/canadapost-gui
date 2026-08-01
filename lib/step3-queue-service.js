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
  'unverified_advisory',
  'unavailable',
  'policy_review_required'
]);
const TERMINAL_CLAIM_STATES = Object.freeze(['submitted', 'submitted_manual', 'already_submitted', 'rejected']);
const UNRESOLVED_CLAIM_STATES = Object.freeze(['in_progress', 'unknown']);
const RETRYABLE_CLAIM_STATES = Object.freeze(['failed', 'not_submitted', 'retry_approved']);
const EXECUTION_STATES = Object.freeze([
  'executable',
  'submitted',
  'already_submitted',
  'unresolved_attempt',
  'terminal_failure',
  'reconciliation_required',
  'otherwise_blocked'
]);

class Step3QueueError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'Step3QueueError';
    this.code = code;
    this.recordId = Number(details.recordId || 0) || null;
    this.executionState = String(details.executionState || '');
    this.attemptId = Number(details.attemptId || 0) || null;
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

  if (input.policyGuidanceState === 'unverified_advisory' && deadline) {
    return { state: 'unverified_advisory', deadline, businessDaysRemaining: null };
  }
  if (input.policyGuidanceState === 'policy_review_required' || policyCoverageStale || (deadline && !province)) {
    return { state: 'policy_review_required', deadline: deadline || null, businessDaysRemaining: null };
  }
  if (rawDeadline !== null && rawDeadline !== undefined && String(rawDeadline).trim() && !deadline) {
    return { state: 'unavailable', deadline: null, businessDaysRemaining: null };
  }
  if (!deadline || !today) {
    return { state: 'unavailable', deadline: null, businessDaysRemaining: null };
  }
  if (input.policyVerified !== true) {
    return { state: 'policy_review_required', deadline, businessDaysRemaining: null };
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

function trackingHash(trackingNumber) {
  return crypto.createHash('sha256')
    .update(`privacy-v1|${String(trackingNumber || '').replace(/\s+/g, '').toUpperCase()}`)
    .digest('hex');
}

function executionReason(state, attempt = null, tombstone = null, maxAttempts = 3) {
  if (state === 'submitted') return 'A claim for this shipment was already submitted.';
  if (state === 'already_submitted') return 'Canada Post previously reported that a claim or inquiry already exists.';
  if (state === 'unresolved_attempt') return 'A previous claim attempt may have reached Canada Post and must be reconciled before retrying.';
  if (state === 'terminal_failure') return tombstone
    ? `A privacy-preserved ${tombstone.terminal_outcome || 'terminal'} outcome blocks resubmission.`
    : 'The latest claim attempt reached a terminal rejected state.';
  if (state === 'reconciliation_required') return `The retry limit of ${maxAttempts} attempts was reached. Review the latest attempt in History.`;
  if (state === 'otherwise_blocked') return `Claim state ${attempt?.status || tombstone?.terminal_outcome || 'unknown'} cannot be submitted automatically.`;
  return '';
}

function candidateExecutionState(db, row, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 3));
  const tombstone = db.prepare('SELECT terminal_outcome, created_at FROM claim_duplicate_tombstones WHERE tracking_hash = ? LIMIT 1')
    .get(trackingHash(row.tracking_number)) || null;
  if (tombstone) {
    const terminal = String(tombstone.terminal_outcome || '').toLowerCase();
    const executionState = terminal === 'already_submitted'
      ? 'already_submitted'
      : (['submitted', 'submitted_manual'].includes(terminal) ? 'submitted' : 'terminal_failure');
    return {
      executionState,
      executable: false,
      blockedReason: executionReason(executionState, null, tombstone, maxAttempts),
      attemptId: null,
      attemptStatus: terminal || 'terminal',
      attemptNumber: null,
      attemptStartedAt: tombstone.created_at || null,
      attemptUpdatedAt: tombstone.created_at || null,
      mayHaveSubmitted: ['submitted', 'already_submitted'].includes(executionState),
      reconciliationRequired: false
    };
  }

  const attempt = db.prepare(`
    SELECT id, status, attempt_number, started_at, completed_at, updated_at,
      last_url, page_title, message, error_code, reconciled_at, reconciliation_action
    FROM claim_attempts
    WHERE shipment_id = ? AND dry_run = 0
    ORDER BY id DESC LIMIT 1
  `).get(row.shipment_id) || null;

  let executionState = 'executable';
  if (attempt) {
    const status = String(attempt.status || '').toLowerCase();
    if (['submitted', 'submitted_manual'].includes(status)) executionState = 'submitted';
    else if (status === 'already_submitted') executionState = 'already_submitted';
    else if (UNRESOLVED_CLAIM_STATES.includes(status)) executionState = 'unresolved_attempt';
    else if (status === 'rejected') executionState = 'terminal_failure';
    else if (status === 'failed' && Number(attempt.attempt_number || 0) >= maxAttempts) executionState = 'reconciliation_required';
    else if (!RETRYABLE_CLAIM_STATES.includes(status)) executionState = 'otherwise_blocked';
  }

  const executable = executionState === 'executable';
  return {
    executionState,
    executable,
    blockedReason: executable ? '' : executionReason(executionState, attempt, null, maxAttempts),
    attemptId: attempt ? Number(attempt.id) : null,
    attemptStatus: attempt?.status || '',
    attemptNumber: attempt ? Number(attempt.attempt_number || 0) : null,
    attemptStartedAt: attempt?.started_at || null,
    attemptUpdatedAt: attempt?.updated_at || attempt?.completed_at || null,
    attemptLastStage: attempt?.page_title || attempt?.last_url || attempt?.error_code || '',
    mayHaveSubmitted: executionState === 'unresolved_attempt',
    reconciliationRequired: ['unresolved_attempt', 'reconciliation_required'].includes(executionState)
  };
}

function publicCandidate(row, options = {}, execution = {}) {
  const evidence = parseObject(row.evidence_json);
  const input = parseObject(row.input_json);
  const deadline = deadlinePresentation({
    deadline: evidence.claimSubmissionDeadline,
    destinationProvince: input.destinationProvince,
    policyCoverageStale: evidence.claimSubmissionDeadlineState === 'policy_review_required',
    policyGuidanceState: evidence.claimSubmissionDeadlineState || evidence.policyGuidanceState
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
    policyGuidanceState: evidence.policyGuidanceState || 'policy_review_required',
    policyVersion: row.policy_version || row.policy_data_version || '',
    eligibilityReason: evidence.explanation || '',
    automaticallyEligible: false,
    classification: 'LATE_CANDIDATE',
    executionState: execution.executionState || 'executable',
    executable: execution.executable !== false,
    blockedReason: execution.blockedReason || '',
    attemptId: execution.attemptId || null,
    attemptStatus: execution.attemptStatus || '',
    attemptNumber: execution.attemptNumber || null,
    attemptStartedAt: execution.attemptStartedAt || null,
    attemptUpdatedAt: execution.attemptUpdatedAt || null,
    attemptLastStage: execution.attemptLastStage || '',
    mayHaveSubmitted: execution.mayHaveSubmitted === true,
    reconciliationRequired: execution.reconciliationRequired === true
  };
}

function previewCandidates(dbPath, options = {}) {
  const db = open(dbPath);
  try {
    const run = authoritativeRun(db);
    const items = candidateRows(db, run.id).map(row => publicCandidate(row, options, candidateExecutionState(db, row, options)));
    const executionCounts = Object.fromEntries(EXECUTION_STATES.map(state => [state, 0]));
    for (const item of items) executionCounts[item.executionState] = Number(executionCounts[item.executionState] || 0) + 1;
    const executableCount = Number(executionCounts.executable || 0);
    return {
      count: items.length,
      executableCount,
      blockedCount: items.length - executableCount,
      executionCounts,
      items,
      runId: Number(run.id),
      refreshedAt: new Date(options.now || Date.now()).toISOString()
    };
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

function validateAttemptState(db, row, options = {}) {
  const state = candidateExecutionState(db, row, options);
  if (state.executable) return state;
  const code = ['unresolved_attempt', 'reconciliation_required'].includes(state.executionState)
    ? 'STEP3_UNRESOLVED_ATTEMPT'
    : 'STEP3_TERMINAL_OUTCOME';
  throw new Step3QueueError(code, state.blockedReason || 'The shipment cannot be submitted automatically.', {
    recordId: row.classification_id,
    executionState: state.executionState,
    attemptId: state.attemptId
  });
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
      validateAttemptState(db, row, options);
    }
    const inputs = rows.map(row => parseObject(row.input_json));
    const createdAt = new Date(options.now || Date.now()).toISOString();
    const snapshot = createQueueSnapshot(inputs, {
      createdAt,
      asOf: createdAt,
      policyDataVersion: rows[0]?.policy_data_version || ''
    });
    snapshot.items.forEach((item, index) => {
      const row = rows[index];
      if (item.classification !== row.classification) {
        throw new Step3QueueError(
          'STEP3_CLASSIFICATION_CHANGED',
          'A selected candidate no longer recomputes to the recorded late-candidate classification. Refresh and recompute Step 2.',
          { recordId: row.classification_id }
        );
      }
      if (String(item.classificationEvidenceHash || '').toLowerCase() !== String(row.evidence_hash || '').toLowerCase()) {
        throw new Step3QueueError(
          'STEP3_EVIDENCE_CHANGED',
          'A selected candidate no longer recomputes to the recorded evidence hash. Refresh and recompute Step 2.',
          { recordId: row.classification_id }
        );
      }
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
  RETRYABLE_CLAIM_STATES,
  EXECUTION_STATES,
  Step3QueueError,
  validFiniteNumber,
  deadlinePresentation,
  selectionForRun,
  candidateExecutionState,
  previewCandidates,
  createRunSnapshot,
  privateCsv
};
