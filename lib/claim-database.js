'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync, backup } = require('node:sqlite');

const SCHEMA_VERSION = 4;

function nowIso() {
  return new Date().toISOString();
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch (_) {}
}

function databasePathFor(userDataRoot) {
  return path.join(userDataRoot, 'database', 'app.sqlite');
}

function openDatabase(dbPath) {
  ensureParent(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = FULL;');
  db.exec('PRAGMA busy_timeout = 10000;');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (current > SCHEMA_VERSION) {
    throw new Error(`Database schema ${current} is newer than this app supports (${SCHEMA_VERSION}).`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      total_items INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      warning_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_number TEXT NOT NULL UNIQUE,
      service_code TEXT NOT NULL DEFAULT '',
      reference_number TEXT NOT NULL DEFAULT '',
      destination_postal_code TEXT NOT NULL DEFAULT '',
      ship_date TEXT NOT NULL DEFAULT '',
      expected_date TEXT NOT NULL DEFAULT '',
      delivery_date TEXT NOT NULL DEFAULT '',
      current_status TEXT NOT NULL DEFAULT '',
      classification TEXT NOT NULL DEFAULT '',
      eligibility_reason TEXT NOT NULL DEFAULT '',
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS tracking_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL,
      run_id INTEGER,
      checked_at TEXT NOT NULL,
      result TEXT NOT NULL,
      classification TEXT NOT NULL DEFAULT '',
      expected_date TEXT NOT NULL DEFAULT '',
      delivery_date TEXT NOT NULL DEFAULT '',
      raw_status TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      raw_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS claim_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL,
      run_id INTEGER,
      status TEXT NOT NULL,
      attempt_number INTEGER NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      confirmation_number TEXT NOT NULL DEFAULT '',
      last_url TEXT NOT NULL DEFAULT '',
      page_title TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      screenshot_path TEXT NOT NULL DEFAULT '',
      text_path TEXT NOT NULL DEFAULT '',
      dry_run INTEGER NOT NULL DEFAULT 0,
      error_code TEXT NOT NULL DEFAULT '',
      reconciled_at TEXT,
      reconciliation_action TEXT NOT NULL DEFAULT '',
      reconciliation_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_attempt_id INTEGER NOT NULL,
      evidence_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      sha256 TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(claim_attempt_id) REFERENCES claim_attempts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tracking_checks_shipment ON tracking_checks(shipment_id, checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_claim_attempts_shipment ON claim_attempts(shipment_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_claim_attempts_status ON claim_attempts(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_type ON runs(run_type, started_at DESC);
  `);

  if (current < 2) {
    // Older development databases may not have these columns.
    const columns = new Set(db.prepare('PRAGMA table_info(claim_attempts)').all().map(row => row.name));
    const additions = [
      ['error_code', "TEXT NOT NULL DEFAULT ''"],
      ['reconciled_at', 'TEXT'],
      ['reconciliation_action', "TEXT NOT NULL DEFAULT ''"],
      ['reconciliation_note', "TEXT NOT NULL DEFAULT ''"]
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) db.exec(`ALTER TABLE claim_attempts ADD COLUMN ${name} ${definition};`);
    }
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

function withDatabase(dbPath, callback) {
  const db = openDatabase(dbPath);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = callback();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    throw error;
  }
}

function clean(value, max = 4096) {
  return String(value ?? '').trim().slice(0, max);
}

function json(value) {
  try { return JSON.stringify(value ?? {}); } catch (_) { return '{}'; }
}

function upsertShipmentInDb(db, input = {}) {
  const trackingNumber = clean(input.trackingNumber || input.pin || input['Tracking PIN'], 128);
  if (!trackingNumber) throw new Error('Tracking number is required.');
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO shipments (
      tracking_number, service_code, reference_number, destination_postal_code,
      ship_date, expected_date, delivery_date, current_status, classification,
      eligibility_reason, last_checked_at, created_at, updated_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tracking_number) DO UPDATE SET
      service_code = CASE WHEN excluded.service_code <> '' THEN excluded.service_code ELSE shipments.service_code END,
      reference_number = CASE WHEN excluded.reference_number <> '' THEN excluded.reference_number ELSE shipments.reference_number END,
      destination_postal_code = CASE WHEN excluded.destination_postal_code <> '' THEN excluded.destination_postal_code ELSE shipments.destination_postal_code END,
      ship_date = CASE WHEN excluded.ship_date <> '' THEN excluded.ship_date ELSE shipments.ship_date END,
      expected_date = CASE WHEN excluded.expected_date <> '' THEN excluded.expected_date ELSE shipments.expected_date END,
      delivery_date = CASE WHEN excluded.delivery_date <> '' THEN excluded.delivery_date ELSE shipments.delivery_date END,
      current_status = CASE WHEN excluded.current_status <> '' THEN excluded.current_status ELSE shipments.current_status END,
      classification = CASE WHEN excluded.classification <> '' THEN excluded.classification ELSE shipments.classification END,
      eligibility_reason = CASE WHEN excluded.eligibility_reason <> '' THEN excluded.eligibility_reason ELSE shipments.eligibility_reason END,
      last_checked_at = COALESCE(excluded.last_checked_at, shipments.last_checked_at),
      updated_at = excluded.updated_at,
      raw_json = CASE WHEN excluded.raw_json <> '{}' THEN excluded.raw_json ELSE shipments.raw_json END
  `).run(
    trackingNumber,
    clean(input.serviceCode || input['Service Code'], 64),
    clean(input.referenceNumber || input.reference || input['Reference #'] || input['Reference Number'], 256),
    clean(input.destinationPostalCode || input.postalCode || input['Destination Postal Code'] || input['Postal Code'], 32),
    clean(input.shipDate || input['Ship Date'], 64),
    clean(input.expectedDate || input['Expected Delivery Date'], 64),
    clean(input.deliveryDate || input['Actual Delivery Date'], 64),
    clean(input.currentStatus || input.status || input.Status || input.eventDescription, 512),
    clean(input.classification || input.Classification || input.Status, 128),
    clean(input.eligibilityReason || input.reason || input.Reason || input['Eligibility Reason'], 1024),
    input.lastCheckedAt || null,
    timestamp,
    timestamp,
    json(input.raw || input)
  );
  return db.prepare('SELECT * FROM shipments WHERE tracking_number = ?').get(trackingNumber);
}

function upsertShipment(dbPath, input) {
  return withDatabase(dbPath, db => transaction(db, () => upsertShipmentInDb(db, input)));
}

function startRun(dbPath, runType, metadata = {}) {
  return withDatabase(dbPath, db => {
    const result = db.prepare(`
      INSERT INTO runs (run_type, status, started_at, metadata_json)
      VALUES (?, 'running', ?, ?)
    `).run(clean(runType, 64), nowIso(), json(metadata));
    return Number(result.lastInsertRowid);
  });
}

function finishRun(dbPath, runId, status, counts = {}, metadata = {}) {
  return withDatabase(dbPath, db => {
    db.prepare(`
      UPDATE runs SET status = ?, completed_at = ?, total_items = ?, success_count = ?,
        warning_count = ?, failure_count = ?, metadata_json = ? WHERE id = ?
    `).run(
      clean(status, 64), nowIso(), Number(counts.total || 0), Number(counts.success || 0),
      Number(counts.warning || 0), Number(counts.failure || 0), json(metadata), Number(runId)
    );
    return db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(runId));
  });
}

const TRACKING_EVENT_TYPES = new Set([
  'pin_late', 'pin_on_time', 'pin_overdue_in_transit', 'pin_not_delivered',
  'pin_review_required', 'pin_no_data', 'pin_error', 'pin_skipped'
]);

function ingestTrackingEvent(dbPath, runId, event = {}) {
  if (!TRACKING_EVENT_TYPES.has(event.type)) return null;
  return withDatabase(dbPath, db => transaction(db, () => {
    const shipment = upsertShipmentInDb(db, {
      trackingNumber: event.pin,
      serviceCode: event.serviceCode,
      referenceNumber: event.reference,
      destinationPostalCode: event.postalCode,
      expectedDate: event.expectedDate,
      deliveryDate: event.deliveryDate,
      currentStatus: event.eventDescription || event.type,
      classification: event.classification || event.type,
      eligibilityReason: event.eligibilityReason || event.message || '',
      lastCheckedAt: nowIso(),
      raw: event
    });
    db.prepare(`
      INSERT INTO tracking_checks (
        shipment_id, run_id, checked_at, result, classification, expected_date,
        delivery_date, raw_status, error_code, error_message, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      shipment.id,
      runId ? Number(runId) : null,
      nowIso(),
      clean(event.type, 128),
      clean(event.classification, 128),
      clean(event.expectedDate, 64),
      clean(event.deliveryDate, 64),
      clean(event.eventDescription, 512),
      event.type === 'pin_error' ? 'TRACKING_LOOKUP_FAILED' : '',
      clean(event.message, 2048),
      json(event)
    );
    return shipment;
  }));
}

function latestAttemptStateInDb(db, trackingNumber) {
  return db.prepare(`
    SELECT ca.* FROM claim_attempts ca
    JOIN shipments s ON s.id = ca.shipment_id
    WHERE s.tracking_number = ? AND ca.dry_run = 0
    ORDER BY ca.id DESC LIMIT 1
  `).get(clean(trackingNumber, 128)) || null;
}

function automaticAttemptDecision(state, maxAttempts = 3) {
  if (!state) return { allowed: true, state: null };
  if (['submitted', 'already_submitted', 'submitted_manual'].includes(state.status)) {
    return { allowed: false, reason: `Claim state is ${state.status}.`, state };
  }
  if (['unknown', 'in_progress'].includes(state.status)) {
    return { allowed: false, reason: 'Claim outcome is uncertain and requires reconciliation.', state };
  }
  if (state.status === 'failed' && Number(state.attempt_number || 0) >= Number(maxAttempts || 3)) {
    return { allowed: false, reason: `Retry limit reached (${maxAttempts}). Reconcile the result before retrying.`, state };
  }
  return { allowed: true, state };
}

function beginClaimAttempt(dbPath, input = {}) {
  return withDatabase(dbPath, db => transaction(db, () => {
    const shipment = upsertShipmentInDb(db, input);
    if (!input.dryRun) {
      const decision = automaticAttemptDecision(latestAttemptStateInDb(db, shipment.tracking_number), input.maxAttempts || 3);
      if (!decision.allowed) throw new Error(decision.reason);
    }
    const previous = db.prepare('SELECT MAX(attempt_number) AS n FROM claim_attempts WHERE shipment_id = ? AND dry_run = 0').get(shipment.id);
    const attemptNumber = input.dryRun ? 0 : Number(previous?.n || 0) + 1;
    const timestamp = nowIso();
    const result = db.prepare(`
      INSERT INTO claim_attempts (
        shipment_id, run_id, status, attempt_number, started_at, last_url,
        page_title, message, dry_run, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      shipment.id,
      input.runId ? Number(input.runId) : null,
      input.dryRun ? 'dry_run_in_progress' : 'in_progress',
      attemptNumber,
      timestamp,
      clean(input.lastUrl, 2048),
      clean(input.pageTitle, 512),
      clean(input.message, 2048),
      input.dryRun ? 1 : 0,
      timestamp,
      timestamp
    );
    return Number(result.lastInsertRowid);
  }));
}

function fileHash(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (_) {
    return '';
  }
}

function completeClaimAttempt(dbPath, attemptId, result = {}) {
  return withDatabase(dbPath, db => transaction(db, () => {
    const timestamp = nowIso();
    const current = db.prepare('SELECT * FROM claim_attempts WHERE id = ?').get(Number(attemptId));
    if (!current) throw new Error('Claim attempt not found.');
    db.prepare(`
      UPDATE claim_attempts SET status = ?, completed_at = ?, confirmation_number = ?,
        last_url = ?, page_title = ?, message = ?, screenshot_path = ?, text_path = ?,
        error_code = ?, updated_at = ? WHERE id = ?
    `).run(
      clean(result.status || 'unknown', 64),
      timestamp,
      clean(result.confirmationNumber, 256),
      clean(result.lastUrl, 2048),
      clean(result.pageTitle, 512),
      clean(result.message || result.error, 4096),
      clean(result.screenshotPath, 4096),
      clean(result.textPath, 4096),
      clean(result.errorCode, 128),
      timestamp,
      Number(attemptId)
    );
    for (const [type, filePath] of [['screenshot', result.screenshotPath], ['page_text', result.textPath]]) {
      if (!filePath) continue;
      db.prepare('DELETE FROM evidence WHERE claim_attempt_id = ? AND evidence_type = ?').run(Number(attemptId), type);
      db.prepare(`
        INSERT INTO evidence (claim_attempt_id, evidence_type, file_path, sha256, created_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(Number(attemptId), type, clean(filePath, 4096), fileHash(filePath), timestamp, '{}');
    }
    return db.prepare('SELECT * FROM claim_attempts WHERE id = ?').get(Number(attemptId));
  }));
}

function markInterruptedAttempts(dbPath) {
  return withDatabase(dbPath, db => {
    const timestamp = nowIso();
    const liveResult = db.prepare(`
      UPDATE claim_attempts
      SET status = 'unknown', completed_at = ?, updated_at = ?,
          error_code = 'INTERRUPTED',
          message = CASE WHEN message = '' THEN 'The app stopped while this claim was in progress. Verify the Canada Post outcome before retrying.' ELSE message END
      WHERE status = 'in_progress' AND dry_run = 0
    `).run(timestamp, timestamp);
    const dryResult = db.prepare(`
      UPDATE claim_attempts
      SET status = 'dry_run_interrupted', completed_at = ?, updated_at = ?,
          error_code = 'DRY_RUN_INTERRUPTED',
          message = CASE WHEN message = '' THEN 'The dry run was interrupted before validation completed.' ELSE message END
      WHERE status = 'dry_run_in_progress' OR (status = 'in_progress' AND dry_run = 1)
    `).run(timestamp, timestamp);
    return Number(liveResult.changes || 0) + Number(dryResult.changes || 0);
  });
}


function quarantineLegacyDryRunReadyAttempts(dbPath) {
  return withDatabase(dbPath, db => transaction(db, () => {
    const metadataKey = 'pre_v033_dry_run_safety_review';
    if (getMetadata(db, metadataKey) === 'complete') return { quarantined: 0, alreadyApplied: true };

    const rows = db.prepare(`
      SELECT ca.*, s.tracking_number
      FROM claim_attempts ca
      JOIN shipments s ON s.id = ca.shipment_id
      WHERE ca.dry_run = 1
        AND ca.status = 'dry_run_ready'
        AND ca.id = (
          SELECT MAX(latest.id) FROM claim_attempts latest
          WHERE latest.shipment_id = ca.shipment_id AND latest.dry_run = 1
        )
      ORDER BY ca.id
    `).all();

    const timestamp = nowIso();
    let quarantined = 0;
    for (const row of rows) {
      const laterLive = db.prepare(`
        SELECT id FROM claim_attempts
        WHERE shipment_id = ? AND dry_run = 0 AND id > ?
        ORDER BY id DESC LIMIT 1
      `).get(row.shipment_id, row.id);
      if (laterLive) continue;

      const previous = db.prepare(`
        SELECT MAX(attempt_number) AS n FROM claim_attempts
        WHERE shipment_id = ? AND dry_run = 0
      `).get(row.shipment_id);
      db.prepare(`
        INSERT INTO claim_attempts (
          shipment_id, run_id, status, attempt_number, started_at, completed_at,
          last_url, page_title, message, screenshot_path, text_path, dry_run,
          error_code, created_at, updated_at
        ) VALUES (?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, ?, 0, 'PRE_033_DRY_RUN_REVIEW', ?, ?)
      `).run(
        row.shipment_id,
        row.run_id || null,
        Number(previous?.n || 0) + 1,
        timestamp,
        timestamp,
        clean(row.last_url, 2048),
        clean(row.page_title, 512),
        'A dry run completed before v0.3.3, when the final form transition was not conservative enough. Verify the Canada Post account before retrying this tracking number.',
        clean(row.screenshot_path, 4096),
        clean(row.text_path, 4096),
        timestamp,
        timestamp
      );
      quarantined += 1;
    }

    setMetadata(db, metadataKey, 'complete');
    return { quarantined, alreadyApplied: false };
  }));
}

function latestAttemptState(dbPath, trackingNumber) {
  return withDatabase(dbPath, db => latestAttemptStateInDb(db, trackingNumber));
}

function canAutomaticallyAttempt(dbPath, trackingNumber, maxAttempts = 3) {
  return automaticAttemptDecision(latestAttemptState(dbPath, trackingNumber), maxAttempts);
}

function normalizeHistoryRow(row) {
  return {
    id: row.id,
    trackingNumber: row.tracking_number,
    serviceCode: row.service_code,
    referenceNumber: row.reference_number,
    destinationPostalCode: row.destination_postal_code,
    expectedDate: row.expected_date,
    deliveryDate: row.delivery_date,
    classification: row.classification,
    eligibilityReason: row.eligibility_reason,
    status: row.attempt_status || row.current_status || row.classification,
    attemptNumber: row.attempt_number || 0,
    attemptedAt: row.started_at || row.last_checked_at || row.updated_at,
    completedAt: row.completed_at || '',
    message: row.message || '',
    confirmationNumber: row.confirmation_number || '',
    lastUrl: row.last_url || '',
    pageTitle: row.page_title || '',
    screenshotPath: row.screenshot_path || '',
    textPath: row.text_path || '',
    errorCode: row.error_code || '',
    reconciliationAction: row.reconciliation_action || '',
    reconciliationNote: row.reconciliation_note || '',
    reconciledAt: row.reconciled_at || '',
    dryRun: Boolean(row.dry_run)
  };
}

function listManualShipments(dbPath, options = {}) {
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 250)));
  const search = clean(options.search, 256);
  return withDatabase(dbPath, db => {
    const params = [];
    let where = "classification = 'MANUAL_ENTRY'";
    if (search) {
      where += ' AND (tracking_number LIKE ? OR reference_number LIKE ? OR service_code LIKE ?)';
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }
    return db.prepare(`
      SELECT id, tracking_number, service_code, reference_number,
        destination_postal_code, expected_date, delivery_date,
        eligibility_reason, created_at, updated_at
      FROM shipments
      WHERE ${where}
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(...params, limit).map(row => ({
      id: row.id,
      trackingNumber: row.tracking_number,
      serviceCode: row.service_code,
      referenceNumber: row.reference_number,
      destinationPostalCode: row.destination_postal_code,
      expectedDate: row.expected_date,
      deliveryDate: row.delivery_date,
      note: row.eligibility_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  });
}

function listClaimHistory(dbPath, options = {}) {
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 250)));
  const search = clean(options.search, 256);
  const status = clean(options.status, 64);
  return withDatabase(dbPath, db => {
    const params = [];
    const where = [];
    if (search) {
      where.push('(s.tracking_number LIKE ? OR s.reference_number LIKE ? OR ca.confirmation_number LIKE ?)');
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }
    if (status && status !== 'all') {
      where.push('ca.status = ?');
      params.push(status);
    }
    const rows = db.prepare(`
      SELECT ca.*, ca.status AS attempt_status, s.tracking_number, s.service_code,
        s.reference_number, s.destination_postal_code, s.expected_date, s.delivery_date,
        s.classification, s.eligibility_reason, s.current_status, s.last_checked_at
      FROM claim_attempts ca
      JOIN shipments s ON s.id = ca.shipment_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ca.id DESC LIMIT ?
    `).all(...params, limit);
    return rows.map(normalizeHistoryRow);
  });
}

function listReconciliation(dbPath, limit = 250, maxAttempts = 3) {
  return withDatabase(dbPath, db => db.prepare(`
    SELECT ca.*, ca.status AS attempt_status, s.tracking_number, s.service_code,
      s.reference_number, s.destination_postal_code, s.expected_date, s.delivery_date,
      s.classification, s.eligibility_reason, s.current_status, s.last_checked_at
    FROM claim_attempts ca
    JOIN shipments s ON s.id = ca.shipment_id
    WHERE ca.dry_run = 0
      AND ca.id = (
        SELECT MAX(latest.id) FROM claim_attempts latest
        WHERE latest.shipment_id = ca.shipment_id AND latest.dry_run = 0
      )
      AND (
        ca.status IN ('unknown', 'in_progress')
        OR (ca.status = 'failed' AND ca.attempt_number >= ?)
      )
    ORDER BY ca.id DESC LIMIT ?
  `).all(Number(maxAttempts || 3), Math.max(1, Math.min(1000, Number(limit || 250)))).map(normalizeHistoryRow));
}

function reconcileAttempt(dbPath, attemptId, action, note = '', confirmationNumber = '') {
  const allowed = new Map([
    ['submitted', 'submitted_manual'],
    ['not_submitted', 'not_submitted'],
    ['retry', 'retry_approved']
  ]);
  if (!allowed.has(action)) throw new Error('Unsupported reconciliation action.');
  return withDatabase(dbPath, db => transaction(db, () => {
    const current = db.prepare('SELECT * FROM claim_attempts WHERE id = ?').get(Number(attemptId));
    if (!current) throw new Error('Claim attempt not found.');
    if (!['unknown', 'in_progress', 'failed', 'not_submitted', 'retry_approved'].includes(current.status)) {
      throw new Error(`Claim state ${current.status} cannot be reconciled.`);
    }
    const timestamp = nowIso();
    const status = allowed.get(action);
    db.prepare(`
      UPDATE claim_attempts SET status = ?, reconciled_at = ?, reconciliation_action = ?,
        reconciliation_note = ?, confirmation_number = CASE WHEN ? <> '' THEN ? ELSE confirmation_number END,
        completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE id = ?
    `).run(status, timestamp, action, clean(note, 4096), clean(confirmationNumber, 256), clean(confirmationNumber, 256), timestamp, timestamp, Number(attemptId));
    return db.prepare('SELECT * FROM claim_attempts WHERE id = ?').get(Number(attemptId));
  }));
}

function dashboard(dbPath, maxAttempts = 3) {
  return withDatabase(dbPath, db => {
    const shipments = Number(db.prepare('SELECT COUNT(*) AS n FROM shipments').get().n || 0);
    const latest = db.prepare(`
      WITH latest_attempts AS (
        SELECT ca.* FROM claim_attempts ca
        WHERE ca.dry_run = 0
          AND ca.id = (
            SELECT MAX(inner_ca.id) FROM claim_attempts inner_ca
            WHERE inner_ca.shipment_id = ca.shipment_id AND inner_ca.dry_run = 0
          )
      )
      SELECT
        SUM(CASE WHEN status IN ('submitted', 'submitted_manual') THEN 1 ELSE 0 END) AS submitted,
        SUM(CASE WHEN status = 'already_submitted' THEN 1 ELSE 0 END) AS duplicates,
        SUM(CASE WHEN status IN ('unknown', 'in_progress') OR (status = 'failed' AND attempt_number >= ?) THEN 1 ELSE 0 END) AS reconciliation,
        SUM(CASE WHEN status = 'failed' AND attempt_number < ? THEN 1 ELSE 0 END) AS failed
      FROM latest_attempts
    `).get(Number(maxAttempts || 3), Number(maxAttempts || 3));
    const dryRuns = Number(db.prepare("SELECT COUNT(*) AS n FROM claim_attempts WHERE dry_run = 1").get().n || 0);
    const byMonth = db.prepare(`
      SELECT substr(started_at, 1, 7) AS month,
        SUM(CASE WHEN status IN ('submitted', 'submitted_manual') THEN 1 ELSE 0 END) AS submitted,
        SUM(CASE WHEN status = 'already_submitted' THEN 1 ELSE 0 END) AS duplicates,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM claim_attempts
      WHERE dry_run = 0
      GROUP BY substr(started_at, 1, 7)
      ORDER BY month DESC LIMIT 12
    `).all();
    return {
      shipments,
      submitted: Number(latest.submitted || 0),
      duplicates: Number(latest.duplicates || 0),
      reconciliation: Number(latest.reconciliation || 0),
      failed: Number(latest.failed || 0),
      dry_runs: dryRuns,
      byMonth
    };
  });
}

function integrityCheck(dbPath) {
  return withDatabase(dbPath, db => {
    const row = db.prepare('PRAGMA integrity_check').get();
    return { ok: String(row.integrity_check || '').toLowerCase() === 'ok', result: row.integrity_check || '' };
  });
}

function getMetadata(db, key) {
  return db.prepare('SELECT value FROM app_metadata WHERE key = ?').get(key)?.value || '';
}

function setMetadata(db, key, value) {
  db.prepare(`
    INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), nowIso());
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      current += '"'; index += 1;
    } else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { values.push(current); current = ''; }
    else current += char;
  }
  values.push(current);
  return values;
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(value => value.trim());
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, (values[index] || '').trim()]));
  });
}

function legacyAttemptKey(value = {}) {
  return [
    clean(value.trackingNumber, 128),
    clean(value.status, 64),
    clean(value.startedAt || value.updatedAt, 64),
    Number(value.attempts || value.attemptNumber || 1)
  ].join('|');
}

function importLegacyAttemptInDb(db, value = {}, seen = new Set()) {
  const trackingNumber = clean(value.trackingNumber, 128);
  if (!trackingNumber) return false;
  const key = legacyAttemptKey(value);
  if (seen.has(key)) return false;
  seen.add(key);
  const shipment = upsertShipmentInDb(db, { trackingNumber });
  const timestamp = value.startedAt || value.createdAt || value.updatedAt || nowIso();
  let status = clean(value.status || 'unknown', 64);
  let errorCode = clean(value.errorCode, 128);
  if (status === 'in_progress') {
    status = 'unknown';
    errorCode ||= 'INTERRUPTED_LEGACY';
  }
  db.prepare(`
    INSERT INTO claim_attempts (
      shipment_id, status, attempt_number, started_at, completed_at, confirmation_number,
      last_url, page_title, message, screenshot_path, text_path, error_code,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    shipment.id,
    status,
    Math.max(1, Number(value.attempts || value.attemptNumber || 1)),
    timestamp,
    value.completedAt || (status === 'unknown' ? value.updatedAt || timestamp : null),
    clean(value.confirmationNumber, 256),
    clean(value.lastUrl, 2048),
    clean(value.pageTitle, 512),
    clean(value.message || value.error, 4096),
    clean(value.screenshotPath, 4096),
    clean(value.textPath, 4096),
    errorCode,
    timestamp,
    value.updatedAt || timestamp
  );
  return true;
}

function importLegacyData(dbPath, dataDir) {
  return withDatabase(dbPath, db => transaction(db, () => {
    if (getMetadata(db, 'legacy_import_v2') === 'complete') return { imported: false, shipments: 0, attempts: 0 };
    let shipments = 0;
    let attempts = 0;
    for (const name of ['tracking.csv', 'claims.csv', 'overdue-undelivered.csv', 'eligibility-review.csv']) {
      for (const row of readCsv(path.join(dataDir, name))) {
        const tracking = row['Tracking PIN'] || row['Tracking Number'] || row.PIN;
        if (!tracking) continue;
        upsertShipmentInDb(db, row);
        shipments += 1;
      }
    }

    const seen = new Set();
    const auditPath = path.join(dataDir, 'claim-history.jsonl');
    if (fs.existsSync(auditPath)) {
      for (const line of fs.readFileSync(auditPath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          if (importLegacyAttemptInDb(db, JSON.parse(line), seen)) attempts += 1;
        } catch (_) {}
      }
    }

    const statePath = path.join(dataDir, 'claim-state.json');
    if (fs.existsSync(statePath)) {
      let state = {};
      try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
      for (const [trackingNumber, value] of Object.entries(state.claims || {})) {
        if (importLegacyAttemptInDb(db, { ...value, trackingNumber }, seen)) attempts += 1;
      }
    }
    setMetadata(db, 'legacy_import_v1', 'complete');
    setMetadata(db, 'legacy_import_v2', 'complete');
    return { imported: true, shipments, attempts };
  }));
}

function rebaseEvidencePaths(dbPath, dataDir) {
  const base = path.resolve(dataDir);
  return withDatabase(dbPath, db => transaction(db, () => {
    let changes = 0;
    const attempts = db.prepare("SELECT id, screenshot_path, text_path FROM claim_attempts WHERE screenshot_path <> '' OR text_path <> ''").all();
    for (const attempt of attempts) {
      const screenshotPath = attempt.screenshot_path ? path.join(base, path.basename(attempt.screenshot_path)) : '';
      const textPath = attempt.text_path ? path.join(base, path.basename(attempt.text_path)) : '';
      db.prepare('UPDATE claim_attempts SET screenshot_path = ?, text_path = ?, updated_at = ? WHERE id = ?')
        .run(screenshotPath, textPath, nowIso(), attempt.id);
      changes += 1;
    }
    const evidenceRows = db.prepare("SELECT id, file_path FROM evidence WHERE file_path <> ''").all();
    for (const evidenceRow of evidenceRows) {
      db.prepare('UPDATE evidence SET file_path = ? WHERE id = ?')
        .run(path.join(base, path.basename(evidenceRow.file_path)), evidenceRow.id);
    }
    return changes;
  }));
}

async function createDatabaseBackup(dbPath, destination) {
  ensureParent(destination);
  const db = openDatabase(dbPath);
  try {
    await backup(db, destination);
  } finally {
    db.close();
  }
  try { fs.chmodSync(destination, 0o600); } catch (_) {}
  return destination;
}

module.exports = {
  SCHEMA_VERSION,
  databasePathFor,
  openDatabase,
  withDatabase,
  startRun,
  finishRun,
  upsertShipment,
  ingestTrackingEvent,
  beginClaimAttempt,
  completeClaimAttempt,
  markInterruptedAttempts,
  quarantineLegacyDryRunReadyAttempts,
  latestAttemptState,
  canAutomaticallyAttempt,
  listClaimHistory,
  listManualShipments,
  listReconciliation,
  reconcileAttempt,
  dashboard,
  integrityCheck,
  importLegacyData,
  rebaseEvidencePaths,
  createDatabaseBackup
};
