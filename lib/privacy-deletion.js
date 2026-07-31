'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { canonicalize } = require('./canonical-json');
const { createDeletionReceipt, writeDeletionReceipt, sanitizeScope } = require('./deletion-receipt');

const CONFIRMATION_PHRASES = Object.freeze({
  'en-CA': Object.freeze({ selected: 'DELETE SELECTED DATA', all: 'DELETE ALL APPLICATION DATA' }),
  'fr-CA': Object.freeze({ selected: 'SUPPRIMER LES DONNÉES SÉLECTIONNÉES', all: 'SUPPRIMER TOUTES LES DONNÉES DE L’APPLICATION' })
});

const COUNT_QUERIES = Object.freeze({
  shipments: 'SELECT COUNT(*) AS n FROM shipments s JOIN temp_privacy_scope scope ON scope.shipment_id = s.id',
  trackingChecks: 'SELECT COUNT(*) AS n FROM tracking_checks row JOIN temp_privacy_scope scope ON scope.shipment_id = row.shipment_id',
  classificationRecords: 'SELECT COUNT(*) AS n FROM classification_records row JOIN temp_privacy_scope scope ON scope.shipment_id = row.shipment_id',
  claimAttempts: 'SELECT COUNT(*) AS n FROM claim_attempts row JOIN temp_privacy_scope scope ON scope.shipment_id = row.shipment_id',
  reconciliationRecords: "SELECT COUNT(*) AS n FROM claim_attempts row JOIN temp_privacy_scope scope ON scope.shipment_id = row.shipment_id WHERE row.reconciliation_action <> '' OR row.status IN ('unknown', 'in_progress')",
  financialEntries: 'SELECT COUNT(*) AS n FROM financial_entries row JOIN temp_privacy_scope scope ON scope.shipment_id = row.shipment_id',
  evidenceFiles: 'SELECT COUNT(*) AS n FROM evidence row JOIN claim_attempts ca ON ca.id = row.claim_attempt_id JOIN temp_privacy_scope scope ON scope.shipment_id = ca.shipment_id',
  screenshots: "SELECT COUNT(*) AS n FROM evidence row JOIN claim_attempts ca ON ca.id = row.claim_attempt_id JOIN temp_privacy_scope scope ON scope.shipment_id = ca.shipment_id WHERE row.evidence_type = 'screenshot'",
  generatedExports: 'SELECT COUNT(*) AS n FROM generated_exports row JOIN temp_privacy_scope scope ON scope.shipment_id = row.shipment_id'
});

function open(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000; PRAGMA synchronous = FULL;');
  return db;
}

function normalizedTrackingNumbers(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 10000).map(item => String(item || '').replace(/\s+/g, '').toUpperCase()).filter(item => /^[A-Z0-9-]{1,128}$/.test(item)))];
}

function normalizedScope(scope = {}) {
  const allRecords = scope.allRecords === true;
  const trackingNumbers = normalizedTrackingNumbers(scope.trackingNumbers);
  const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(scope.dateFrom || '')) ? String(scope.dateFrom) : '';
  const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String(scope.dateTo || '')) ? String(scope.dateTo) : '';
  if (!allRecords && !trackingNumbers.length && !dateFrom && !dateTo) throw new Error('A deletion preview requires tracking numbers, a date range, or all application records.');
  if (dateFrom && dateTo && dateFrom > dateTo) throw new Error('Deletion date range is invalid.');
  return { allRecords, trackingNumbers, dateFrom, dateTo };
}

function populateScope(db, scope) {
  db.exec('DROP TABLE IF EXISTS temp_privacy_scope; CREATE TEMP TABLE temp_privacy_scope (shipment_id INTEGER PRIMARY KEY);');
  if (scope.allRecords) {
    db.exec('INSERT INTO temp_privacy_scope SELECT id FROM shipments;');
    return;
  }
  const clauses = [];
  const params = [];
  if (scope.trackingNumbers.length) {
    clauses.push(`UPPER(REPLACE(tracking_number, ' ', '')) IN (${scope.trackingNumbers.map(() => '?').join(',')})`);
    params.push(...scope.trackingNumbers);
  }
  if (scope.dateFrom) { clauses.push('date(created_at) >= date(?)'); params.push(scope.dateFrom); }
  if (scope.dateTo) { clauses.push('date(created_at) <= date(?)'); params.push(scope.dateTo); }
  db.prepare(`INSERT INTO temp_privacy_scope SELECT id FROM shipments WHERE ${clauses.join(' AND ')}`).run(...params);
}

function counts(db) {
  return Object.fromEntries(Object.entries(COUNT_QUERIES).map(([key, sql]) => [key, Number(db.prepare(sql).get().n || 0)]));
}

function previewData(dbPath, rawScope = {}) {
  const scope = normalizedScope(rawScope);
  const db = open(dbPath);
  try {
    populateScope(db, scope);
    return {
      scope: sanitizeScope({ ...scope, trackingNumberCount: scope.trackingNumbers.length }),
      recordCounts: counts(db),
      confirmationPhraseKey: scope.allRecords ? 'all' : 'selected',
      requiresSecondConfirmation: scope.allRecords
    };
  } finally {
    db.close();
  }
}

function approvedPath(filePath, roots) {
  if (!filePath) return '';
  const resolved = path.resolve(filePath);
  const allowed = roots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new Error('A referenced file is outside approved application-owned directories.');
  let current = resolved;
  while (roots.every(root => current !== root) && current !== path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not permitted in privacy deletion paths.');
    current = path.dirname(current);
  }
  return resolved;
}

function selectedFiles(db, roots) {
  const values = [];
  const evidence = db.prepare(`SELECT e.file_path FROM evidence e JOIN claim_attempts ca ON ca.id = e.claim_attempt_id
    JOIN temp_privacy_scope scope ON scope.shipment_id = ca.shipment_id WHERE e.file_path <> ''`).all();
  const attempts = db.prepare(`SELECT ca.screenshot_path, ca.text_path FROM claim_attempts ca
    JOIN temp_privacy_scope scope ON scope.shipment_id = ca.shipment_id WHERE ca.screenshot_path <> '' OR ca.text_path <> ''`).all();
  const exports = db.prepare(`SELECT ge.file_path FROM generated_exports ge
    JOIN temp_privacy_scope scope ON scope.shipment_id = ge.shipment_id WHERE ge.file_path <> ''`).all();
  for (const row of evidence) values.push(row.file_path);
  for (const row of attempts) values.push(row.screenshot_path, row.text_path);
  for (const row of exports) values.push(row.file_path);
  return [...new Set(values.filter(Boolean).map(value => approvedPath(value, roots)))];
}

function unrelatedDigest(db) {
  const hash = crypto.createHash('sha256');
  const queries = [
    ['shipments', 'SELECT * FROM shipments WHERE id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY id'],
    ['tracking_checks', 'SELECT * FROM tracking_checks WHERE shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY id'],
    ['tracking_events', 'SELECT * FROM tracking_events WHERE shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY id'],
    ['classification_records', 'SELECT * FROM classification_records WHERE shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY id'],
    ['manual_reviews', 'SELECT * FROM manual_reviews WHERE shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY id'],
    ['claim_attempts', 'SELECT * FROM claim_attempts WHERE shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY id'],
    ['claim_details', 'SELECT * FROM claim_details WHERE shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY shipment_id'],
    ['financial_entries', 'SELECT * FROM financial_entries WHERE shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY id'],
    ['worker_revalidations', 'SELECT * FROM worker_revalidations WHERE shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY id'],
    ['generated_exports', 'SELECT * FROM generated_exports WHERE shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY id'],
    ['audit_events', 'SELECT * FROM audit_events WHERE shipment_id IS NOT NULL AND shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY id'],
    ['evidence', `SELECT e.* FROM evidence e JOIN claim_attempts ca ON ca.id = e.claim_attempt_id
      WHERE ca.shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY e.id`],
    ['queue_snapshot_items', 'SELECT * FROM queue_snapshot_items WHERE shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope) ORDER BY id']
  ];
  for (const [name, sql] of queries) {
    hash.update(name);
    for (const row of db.prepare(sql).iterate()) hash.update(canonicalize(row));
  }
  return hash.digest('hex');
}

function writeTransactionManifest(stagingDirectory, manifest) {
  const destination = path.join(stagingDirectory, 'transaction.json');
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, destination);
  try { fs.chmodSync(destination, 0o600); } catch (_) {}
}

function stageFiles(files, stagingDirectory, operationId) {
  fs.mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
  const staged = files.filter(source => fs.existsSync(source)).map((source, index) => ({
    source,
    destination: path.join(stagingDirectory, `${index}-${crypto.randomUUID()}`)
  }));
  writeTransactionManifest(stagingDirectory, {
    format: 'canadapost-claim-runner-privacy-transaction',
    version: 1,
    operationId,
    createdAt: new Date().toISOString(),
    entries: staged
  });
  try {
    for (const item of staged) fs.renameSync(item.source, item.destination);
    return staged;
  } catch (error) {
    for (const item of staged.reverse()) {
      try { fs.renameSync(item.destination, item.source); } catch (_) {}
    }
    throw error;
  }
}

function restoreStagedFiles(staged) {
  for (const item of [...staged].reverse()) {
    try {
      fs.mkdirSync(path.dirname(item.source), { recursive: true, mode: 0o700 });
      if (fs.existsSync(item.destination)) fs.renameSync(item.destination, item.source);
    } catch (_) {}
  }
}

function recoverInterruptedTransactions(options = {}) {
  const transactionRoot = path.resolve(options.transactionRoot);
  if (!fs.existsSync(transactionRoot)) return { restored: 0, finalized: 0 };
  const roots = (options.ownedRoots || []).map(root => path.resolve(root));
  if (!roots.length) throw new Error('Privacy transaction recovery requires approved application-owned directories.');
  const db = open(options.dbPath);
  let restored = 0;
  let finalized = 0;
  try {
    for (const entry of fs.readdirSync(transactionRoot, { withFileTypes: true })) {
      if (!entry.name.startsWith('privacy-delete-')) continue;
      const directory = path.join(transactionRoot, entry.name);
      if (!entry.isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Invalid privacy transaction staging directory.');
      const manifestPath = path.join(directory, 'transaction.json');
      if (!fs.existsSync(manifestPath) || fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error('Privacy transaction recovery manifest is missing or invalid.');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest?.format !== 'canadapost-claim-runner-privacy-transaction'
        || !/^[0-9a-f-]{36}$/i.test(String(manifest.operationId || ''))
        || !Array.isArray(manifest.entries)) throw new Error('Privacy transaction recovery manifest is invalid.');
      const staged = manifest.entries.map(item => {
        const source = approvedPath(item?.source, roots);
        const destination = path.resolve(String(item?.destination || ''));
        if (!source) throw new Error('Privacy transaction recovery source path is invalid.');
        if (!(destination.startsWith(`${directory}${path.sep}`)) || path.basename(destination) === 'transaction.json') {
          throw new Error('Privacy transaction recovery path is invalid.');
        }
        return { source, destination };
      });
      const auditRows = db.prepare("SELECT detail_json FROM audit_events WHERE event_type = 'privacy_deletion_completed' AND entity_type = 'privacy_operation'").all();
      const committed = auditRows.some(row => {
        try { return JSON.parse(row.detail_json).operationId === manifest.operationId; } catch (_) { return false; }
      });
      if (committed) {
        fs.rmSync(directory, { recursive: true, force: true });
        finalized += 1;
        continue;
      }
      for (const item of [...staged].reverse()) {
        if (!fs.existsSync(item.destination)) continue;
        if (fs.existsSync(item.source)) throw new Error('Privacy transaction recovery would overwrite an existing file.');
        fs.mkdirSync(path.dirname(item.source), { recursive: true, mode: 0o700 });
        fs.renameSync(item.destination, item.source);
      }
      fs.rmSync(directory, { recursive: true, force: true });
      restored += 1;
    }
    return { restored, finalized };
  } finally {
    db.close();
  }
}

function insertTombstones(db, appVersion) {
  const rows = db.prepare(`SELECT s.tracking_number, ca.status, ca.started_at, ca.completed_at
    FROM shipments s JOIN temp_privacy_scope scope ON scope.shipment_id = s.id
    JOIN claim_attempts ca ON ca.shipment_id = s.id AND ca.dry_run = 0
    WHERE ca.id = (SELECT MAX(latest.id) FROM claim_attempts latest WHERE latest.shipment_id = s.id AND latest.dry_run = 0)
      AND ca.status IN ('submitted', 'submitted_manual', 'already_submitted', 'rejected', 'unknown', 'in_progress')`).all();
  const insert = db.prepare(`INSERT INTO claim_duplicate_tombstones
    (tracking_hash, terminal_outcome, first_attempt_at, terminal_at, application_version, schema_version, created_at)
    VALUES (?, ?, ?, ?, ?, 8, ?) ON CONFLICT(tracking_hash) DO NOTHING`);
  const now = new Date().toISOString();
  for (const row of rows) {
    const normalizedTracking = String(row.tracking_number || '').replace(/\s+/g, '').toUpperCase();
    const hash = crypto.createHash('sha256').update(`privacy-v1|${normalizedTracking}`).digest('hex');
    insert.run(hash, String(row.status || 'unknown').slice(0, 64), row.started_at || null, row.completed_at || null, String(appVersion).slice(0, 80), now);
  }
}

function redactSelectedQueueSnapshotItems(db) {
  const snapshots = db.prepare(`SELECT DISTINCT qs.* FROM queue_snapshots qs
    JOIN queue_snapshot_items qsi ON qsi.snapshot_id = qs.id
    JOIN temp_privacy_scope scope ON scope.shipment_id = qsi.shipment_id`).all();
  const selectedTracking = new Set(db.prepare(`SELECT UPPER(REPLACE(s.tracking_number, ' ', '')) AS tracking
    FROM shipments s JOIN temp_privacy_scope scope ON scope.shipment_id = s.id`).all().map(row => row.tracking));
  const update = db.prepare(`UPDATE queue_snapshots SET snapshot_hash = ?, status = 'invalidated', item_count = ?,
    snapshot_json = ?, invalidated_at = ?, invalidation_reason = 'privacy_deletion' WHERE id = ?`);
  for (const row of snapshots) {
    let parsed = {};
    try { parsed = JSON.parse(row.snapshot_json); } catch (_) {}
    const remainingItems = Array.isArray(parsed.items)
      ? parsed.items.filter(item => !selectedTracking.has(String(item?.trackingNumber || '').replace(/\s+/g, '').toUpperCase()))
      : [];
    const base = {
      version: Number(parsed.version || 1),
      createdAt: String(parsed.createdAt || row.created_at),
      policyDataVersion: String(parsed.policyDataVersion || row.policy_data_version),
      items: remainingItems
    };
    const snapshotHash = crypto.createHash('sha256').update(canonicalize(base)).digest('hex');
    const remainingCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM queue_snapshot_items qsi
      WHERE qsi.snapshot_id = ? AND qsi.shipment_id NOT IN (SELECT shipment_id FROM temp_privacy_scope)`).get(row.id).n || 0);
    update.run(snapshotHash, remainingCount, canonicalize({ ...base, snapshotHash, redactedByPrivacyDeletion: true }), new Date().toISOString(), row.id);
  }
}

function deleteRows(db, appVersion, operationId) {
  insertTombstones(db, appVersion);
  redactSelectedQueueSnapshotItems(db);
  db.exec(`
    DELETE FROM evidence WHERE claim_attempt_id IN (SELECT ca.id FROM claim_attempts ca JOIN temp_privacy_scope scope ON scope.shipment_id = ca.shipment_id);
    DELETE FROM generated_exports WHERE shipment_id IN (SELECT shipment_id FROM temp_privacy_scope);
    DELETE FROM worker_revalidations WHERE shipment_id IN (SELECT shipment_id FROM temp_privacy_scope);
    DELETE FROM queue_snapshot_items WHERE shipment_id IN (SELECT shipment_id FROM temp_privacy_scope);
    DELETE FROM manual_reviews WHERE shipment_id IN (SELECT shipment_id FROM temp_privacy_scope);
    DELETE FROM claim_details WHERE shipment_id IN (SELECT shipment_id FROM temp_privacy_scope);
    DELETE FROM financial_entries WHERE shipment_id IN (SELECT shipment_id FROM temp_privacy_scope);
    DELETE FROM tracking_events WHERE shipment_id IN (SELECT shipment_id FROM temp_privacy_scope);
    DELETE FROM tracking_checks WHERE shipment_id IN (SELECT shipment_id FROM temp_privacy_scope);
    DELETE FROM audit_events WHERE shipment_id IN (SELECT shipment_id FROM temp_privacy_scope);
    DROP TRIGGER classification_records_no_delete;
    DELETE FROM classification_records WHERE shipment_id IN (SELECT shipment_id FROM temp_privacy_scope);
    CREATE TRIGGER classification_records_no_delete BEFORE DELETE ON classification_records BEGIN SELECT RAISE(ABORT, 'classification history is immutable'); END;
    DELETE FROM claim_attempts WHERE shipment_id IN (SELECT shipment_id FROM temp_privacy_scope);
    DELETE FROM shipments WHERE id IN (SELECT shipment_id FROM temp_privacy_scope);
  `);
  db.prepare(`INSERT INTO audit_events (event_type, entity_type, detail_json, created_at)
    VALUES ('privacy_deletion_completed', 'privacy_operation', ?, ?)`)
    .run(JSON.stringify({ operationId, applicationVersion: String(appVersion).slice(0, 80) }), new Date().toISOString());
}

function validateDatabase(db) {
  const integrity = String(db.prepare('PRAGMA integrity_check').get().integrity_check || '');
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  if (integrity.toLowerCase() !== 'ok' || foreignKeyViolations) throw new Error('Post-deletion database checks failed.');
  return { integrity, foreignKeyViolations };
}

function deleteData(options = {}) {
  options.coordinator?.assertInactive();
  const scope = normalizedScope(options.scope);
  const locale = CONFIRMATION_PHRASES[options.locale] ? options.locale : 'en-CA';
  const expectedPhrase = CONFIRMATION_PHRASES[locale][scope.allRecords ? 'all' : 'selected'];
  if (options.confirmed !== true || String(options.typedPhrase || '') !== expectedPhrase) throw new Error('The destructive-action confirmation phrase does not match.');
  if (scope.allRecords && options.secondConfirmed !== true) throw new Error('Deleting all application data requires a second confirmation.');

  const operationId = String(options.operationId || crypto.randomUUID());
  const roots = (options.ownedRoots || []).map(root => path.resolve(root));
  if (!roots.length) throw new Error('Privacy deletion requires approved application-owned directories.');
  const stagingDirectory = path.join(path.resolve(options.transactionRoot), `privacy-delete-${operationId}`);
  const db = open(options.dbPath);
  let staged = [];
  let preview;
  try {
    populateScope(db, scope);
    preview = {
      scope: sanitizeScope({ ...scope, trackingNumberCount: scope.trackingNumbers.length }),
      recordCounts: counts(db)
    };
    const unrelatedBefore = unrelatedDigest(db);
    const files = selectedFiles(db, roots);
    staged = stageFiles(files, stagingDirectory, operationId);
    db.exec('BEGIN IMMEDIATE;');
    let committed = false;
    try {
      deleteRows(db, options.applicationVersion, operationId);
      const checks = validateDatabase(db);
      const unrelatedAfter = unrelatedDigest(db);
      if (unrelatedBefore !== unrelatedAfter) throw new Error('Unrelated application records changed during deletion.');
      db.exec('COMMIT;');
      committed = true;
      try { fs.rmSync(stagingDirectory, { recursive: true, force: true }); } catch (_) {}
      const receipt = createDeletionReceipt({
        timestamp: options.now,
        applicationVersion: options.applicationVersion,
        scope: preview.scope,
        recordCounts: preview.recordCounts,
        status: 'success',
        operationId,
        integrityCheck: {
          ...checks,
          referencedFilesRemoved: files.every(file => !fs.existsSync(file)),
          unrelatedRecordsUnchanged: true
        }
      });
      const receiptPath = writeDeletionReceipt(options.receiptDirectory, receipt);
      return { ok: true, receipt, receiptPath };
    } catch (error) {
      if (!committed) {
        try { db.exec('ROLLBACK;'); } catch (_) {}
        restoreStagedFiles(staged);
        try { fs.rmSync(stagingDirectory, { recursive: true, force: true }); } catch (_) {}
      }
      throw error;
    }
  } catch (error) {
    if (preview) {
      try {
        const receipt = createDeletionReceipt({
          timestamp: options.now,
          applicationVersion: options.applicationVersion,
          scope: preview.scope,
          recordCounts: preview.recordCounts,
          status: 'failure',
          operationId,
          integrityCheck: {
            integrity: 'rolled_back',
            foreignKeyViolations: 0,
            referencedFilesRemoved: false,
            unrelatedRecordsUnchanged: true
          }
        });
        error.receiptPath = writeDeletionReceipt(options.receiptDirectory, receipt);
      } catch (_) {}
    }
    throw error;
  } finally {
    db.close();
  }
}

module.exports = {
  CONFIRMATION_PHRASES,
  normalizedScope,
  previewData,
  deleteData,
  recoverInterruptedTransactions,
  approvedPath
};
