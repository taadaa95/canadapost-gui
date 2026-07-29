'use strict';

const SCHEMA_VERSION = 7;

class DatabaseMigrationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DatabaseMigrationError';
    this.code = details.code || 'DATABASE_MIGRATION_FAILED';
    this.stage = details.stage || 'schema_reconciliation';
    this.originalVersion = Number(details.originalVersion || 0);
    this.backupPath = details.backupPath || '';
    this.causeCode = details.causeCode || '';
  }
}

const TABLES = Object.freeze({
  app_metadata: `CREATE TABLE app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  runs: `CREATE TABLE runs (
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
  )`,
  shipments: `CREATE TABLE shipments (
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
  )`,
  tracking_checks: `CREATE TABLE tracking_checks (
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
  )`,
  claim_attempts: `CREATE TABLE claim_attempts (
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
  )`,
  evidence: `CREATE TABLE evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_attempt_id INTEGER NOT NULL,
    evidence_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    sha256 TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(claim_attempt_id) REFERENCES claim_attempts(id) ON DELETE CASCADE
  )`,
  tracking_events: `CREATE TABLE tracking_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id INTEGER NOT NULL,
    tracking_check_id INTEGER,
    source_index INTEGER NOT NULL DEFAULT 0,
    source_code TEXT NOT NULL DEFAULT '',
    normalized_type TEXT NOT NULL,
    event_timestamp TEXT NOT NULL DEFAULT '',
    event_date TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    raw_hash TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    normalized_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
    FOREIGN KEY(tracking_check_id) REFERENCES tracking_checks(id) ON DELETE SET NULL
  )`,
  classification_records: `CREATE TABLE classification_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id INTEGER NOT NULL,
    policy_version TEXT NOT NULL,
    policy_effective_date TEXT NOT NULL,
    policy_data_version TEXT NOT NULL,
    classification TEXT NOT NULL,
    classification_timestamp TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,
    policy_source_ids_json TEXT NOT NULL,
    reason_codes_json TEXT NOT NULL,
    input_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE RESTRICT
  )`,
  manual_reviews: `CREATE TABLE manual_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id INTEGER NOT NULL,
    classification_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    resolution TEXT NOT NULL DEFAULT '',
    resolution_note TEXT NOT NULL DEFAULT '',
    opened_at TEXT NOT NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
    FOREIGN KEY(classification_id) REFERENCES classification_records(id) ON DELETE SET NULL
  )`,
  audit_events: `CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    shipment_id INTEGER,
    entity_type TEXT NOT NULL DEFAULT '',
    entity_id INTEGER,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE SET NULL
  )`,
  queue_snapshots: `CREATE TABLE queue_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_hash TEXT NOT NULL UNIQUE,
    policy_data_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'reviewed',
    item_count INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    invalidated_at TEXT,
    invalidation_reason TEXT NOT NULL DEFAULT ''
  )`,
  queue_snapshot_items: `CREATE TABLE queue_snapshot_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id INTEGER NOT NULL,
    shipment_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    classification_evidence_hash TEXT NOT NULL,
    UNIQUE(snapshot_id, ordinal),
    UNIQUE(snapshot_id, shipment_id),
    FOREIGN KEY(snapshot_id) REFERENCES queue_snapshots(id) ON DELETE CASCADE,
    FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE RESTRICT
  )`,
  worker_revalidations: `CREATE TABLE worker_revalidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id INTEGER,
    shipment_id INTEGER NOT NULL,
    classification_id INTEGER,
    allowed INTEGER NOT NULL,
    reason TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL DEFAULT '',
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(snapshot_id) REFERENCES queue_snapshots(id) ON DELETE SET NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE RESTRICT,
    FOREIGN KEY(classification_id) REFERENCES classification_records(id) ON DELETE SET NULL
  )`,
  claim_details: `CREATE TABLE claim_details (
    shipment_id INTEGER PRIMARY KEY,
    sender_json TEXT NOT NULL DEFAULT '{}',
    contact_json TEXT NOT NULL DEFAULT '{}',
    receiver_json TEXT NOT NULL DEFAULT '{}',
    contents_description TEXT NOT NULL DEFAULT '',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
  )`,
  financial_entries: `CREATE TABLE financial_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id INTEGER NOT NULL,
    value_type TEXT NOT NULL CHECK(value_type IN ('estimated', 'claimed', 'approved', 'received', 'rejected')),
    amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'CAD' CHECK(length(currency) = 3),
    source TEXT NOT NULL CHECK(source IN ('calculated', 'claim', 'canada_post', 'manual')),
    note TEXT NOT NULL DEFAULT '',
    effective_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
  )`
});

const REQUIRED_COLUMNS = Object.freeze(Object.fromEntries(Object.entries(TABLES).map(([name, sql]) => {
  const columns = [];
  for (const line of sql.split('\n').slice(1, -1)) {
    const match = line.trim().match(/^([a-z][a-z0-9_]*)\s+/i);
    if (match && !['foreign', 'unique', 'check', 'constraint'].includes(match[1].toLowerCase())) columns.push(match[1]);
  }
  return [name, Object.freeze(columns)];
})));

const SAFE_COLUMN_ADDITIONS = Object.freeze({
  claim_attempts: Object.freeze({
    error_code: "TEXT NOT NULL DEFAULT ''",
    reconciled_at: 'TEXT',
    reconciliation_action: "TEXT NOT NULL DEFAULT ''",
    reconciliation_note: "TEXT NOT NULL DEFAULT ''"
  }),
  shipments: Object.freeze({
    first_attempt_date: "TEXT NOT NULL DEFAULT ''",
    current_classification_id: 'INTEGER',
    manual_review_state: "TEXT NOT NULL DEFAULT ''"
  }),
  classification_records: Object.freeze({
    policy_effective_date: "TEXT NOT NULL DEFAULT ''",
    policy_data_version: "TEXT NOT NULL DEFAULT ''",
    classification_timestamp: "TEXT NOT NULL DEFAULT ''",
    input_hash: "TEXT NOT NULL DEFAULT ''",
    evidence_hash: "TEXT NOT NULL DEFAULT ''",
    policy_source_ids_json: "TEXT NOT NULL DEFAULT '[]'",
    reason_codes_json: "TEXT NOT NULL DEFAULT '[]'",
    input_json: "TEXT NOT NULL DEFAULT '{}'",
    evidence_json: "TEXT NOT NULL DEFAULT '{}'",
    created_at: "TEXT NOT NULL DEFAULT ''",
    run_id: 'INTEGER REFERENCES runs(id) ON DELETE SET NULL'
  })
});

const FINAL_REQUIRED_COLUMNS = Object.freeze({
  ...REQUIRED_COLUMNS,
  shipments: Object.freeze([...REQUIRED_COLUMNS.shipments, 'first_attempt_date', 'current_classification_id', 'manual_review_state']),
  classification_records: Object.freeze([...REQUIRED_COLUMNS.classification_records, 'run_id'])
});

const INDEXES = Object.freeze({
  idx_tracking_checks_shipment: Object.freeze({ table: 'tracking_checks', columns: ['shipment_id', 'checked_at'], sql: 'CREATE INDEX idx_tracking_checks_shipment ON tracking_checks(shipment_id, checked_at DESC)' }),
  idx_claim_attempts_shipment: Object.freeze({ table: 'claim_attempts', columns: ['shipment_id', 'started_at'], sql: 'CREATE INDEX idx_claim_attempts_shipment ON claim_attempts(shipment_id, started_at DESC)' }),
  idx_claim_attempts_status: Object.freeze({ table: 'claim_attempts', columns: ['status', 'updated_at'], sql: 'CREATE INDEX idx_claim_attempts_status ON claim_attempts(status, updated_at DESC)' }),
  idx_runs_type: Object.freeze({ table: 'runs', columns: ['run_type', 'started_at'], sql: 'CREATE INDEX idx_runs_type ON runs(run_type, started_at DESC)' }),
  idx_tracking_events_shipment: Object.freeze({ table: 'tracking_events', columns: ['shipment_id', 'event_timestamp', 'id'], sql: 'CREATE INDEX idx_tracking_events_shipment ON tracking_events(shipment_id, event_timestamp, id)' }),
  idx_classifications_shipment: Object.freeze({ table: 'classification_records', columns: ['shipment_id', 'id'], sql: 'CREATE INDEX idx_classifications_shipment ON classification_records(shipment_id, id DESC)' }),
  idx_manual_reviews_status: Object.freeze({ table: 'manual_reviews', columns: ['status', 'updated_at'], sql: 'CREATE INDEX idx_manual_reviews_status ON manual_reviews(status, updated_at DESC)' }),
  idx_worker_revalidations_shipment: Object.freeze({ table: 'worker_revalidations', columns: ['shipment_id', 'id'], sql: 'CREATE INDEX idx_worker_revalidations_shipment ON worker_revalidations(shipment_id, id DESC)' }),
  idx_financial_entries_shipment: Object.freeze({ table: 'financial_entries', columns: ['shipment_id', 'value_type', 'id'], sql: 'CREATE INDEX idx_financial_entries_shipment ON financial_entries(shipment_id, value_type, id DESC)' }),
  idx_classifications_run: Object.freeze({ table: 'classification_records', columns: ['run_id', 'id'], sql: 'CREATE INDEX idx_classifications_run ON classification_records(run_id, id)' })
});

const TRIGGERS = Object.freeze({
  classification_records_no_update: Object.freeze({ table: 'classification_records', sql: "CREATE TRIGGER classification_records_no_update BEFORE UPDATE ON classification_records BEGIN SELECT RAISE(ABORT, 'classification history is immutable'); END" }),
  classification_records_no_delete: Object.freeze({ table: 'classification_records', sql: "CREATE TRIGGER classification_records_no_delete BEFORE DELETE ON classification_records BEGIN SELECT RAISE(ABORT, 'classification history is immutable'); END" }),
  tracking_events_no_update: Object.freeze({ table: 'tracking_events', sql: "CREATE TRIGGER tracking_events_no_update BEFORE UPDATE ON tracking_events BEGIN SELECT RAISE(ABORT, 'tracking evidence is immutable'); END" }),
  financial_entries_no_update: Object.freeze({ table: 'financial_entries', sql: "CREATE TRIGGER financial_entries_no_update BEFORE UPDATE ON financial_entries BEGIN SELECT RAISE(ABORT, 'financial history is append-only'); END" })
});

const MIGRATION_ORDER = Object.freeze([
  Object.freeze({ version: 1, stage: 'v1_core_tables', tables: ['app_metadata', 'runs', 'shipments', 'tracking_checks', 'claim_attempts', 'evidence'] }),
  Object.freeze({ version: 2, stage: 'v2_claim_reconciliation_columns', columns: { claim_attempts: ['error_code', 'reconciled_at', 'reconciliation_action', 'reconciliation_note'] } }),
  Object.freeze({ version: 5, stage: 'v5_classification_history', columns: { shipments: ['first_attempt_date', 'current_classification_id', 'manual_review_state'] }, tables: ['tracking_events', 'classification_records', 'manual_reviews', 'audit_events', 'queue_snapshots', 'queue_snapshot_items', 'worker_revalidations', 'claim_details'] }),
  Object.freeze({ version: 6, stage: 'v6_financial_history', tables: ['financial_entries'] }),
  Object.freeze({ version: 7, stage: 'v7_run_scoped_classifications', columns: { classification_records: ['run_id'] } }),
  Object.freeze({ version: 7, stage: 'dependent_indexes', indexes: Object.keys(INDEXES) }),
  Object.freeze({ version: 7, stage: 'immutability_triggers', triggers: Object.keys(TRIGGERS) })
]);

function sqliteObject(db, name) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'index', 'trigger', 'view')").get(name) || null;
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
}

function ensureTable(db, name) {
  const existing = sqliteObject(db, name);
  if (!existing) db.exec(`${TABLES[name]};`);
  else if (existing.type !== 'table') throw new Error(`Required schema object ${name} is not a table.`);
  validateOrRepairColumns(db, name);
}

function validateOrRepairColumns(db, table, requiredColumns = REQUIRED_COLUMNS[table]) {
  const columns = tableColumns(db, table);
  const additions = SAFE_COLUMN_ADDITIONS[table] || {};
  for (const required of requiredColumns) {
    if (columns.has(required)) continue;
    const definition = additions[required];
    if (!definition) throw new Error(`Table ${table} is incompatible: required column ${required} is absent.`);
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${required} ${definition};`);
    columns.add(required);
  }
}

function ensureColumns(db, table, names) {
  if (!sqliteObject(db, table)) throw new Error(`Required predecessor table ${table} is absent.`);
  const columns = tableColumns(db, table);
  for (const name of names) {
    if (columns.has(name)) continue;
    const definition = SAFE_COLUMN_ADDITIONS[table]?.[name];
    if (!definition) throw new Error(`Table ${table} is incompatible: required column ${name} is absent.`);
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition};`);
    columns.add(name);
  }
}

function ensureIndex(db, name) {
  const spec = INDEXES[name];
  const existing = sqliteObject(db, name);
  if (!existing) {
    if (!sqliteObject(db, spec.table)) throw new Error(`Index ${name} predecessor table ${spec.table} is absent.`);
    db.exec(`${spec.sql};`);
    return;
  }
  if (existing.type !== 'index' || existing.tbl_name !== spec.table) throw new Error(`Index ${name} has an incompatible definition.`);
  const actualColumns = db.prepare(`PRAGMA index_info(${name})`).all().map(row => String(row.name));
  if (actualColumns.join(',') !== spec.columns.join(',')) throw new Error(`Index ${name} has incompatible columns.`);
}

function normalizeSql(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/;\s*$/, '').trim().toLowerCase();
}

function ensureTrigger(db, name) {
  const spec = TRIGGERS[name];
  const existing = sqliteObject(db, name);
  if (!existing) {
    if (!sqliteObject(db, spec.table)) throw new Error(`Trigger ${name} predecessor table ${spec.table} is absent.`);
    db.exec(`${spec.sql};`);
    return;
  }
  if (existing.type !== 'trigger' || existing.tbl_name !== spec.table || normalizeSql(existing.sql) !== normalizeSql(spec.sql)) {
    throw new Error(`Trigger ${name} has an incompatible definition.`);
  }
}

function schemaNeedsReconciliation(db) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (current !== SCHEMA_VERSION) return true;
  for (const [table, required] of Object.entries(FINAL_REQUIRED_COLUMNS)) {
    const object = sqliteObject(db, table);
    if (!object || object.type !== 'table') return true;
    const columns = tableColumns(db, table);
    if (required.some(column => !columns.has(column))) return true;
  }
  for (const [name, spec] of Object.entries(INDEXES)) {
    const object = sqliteObject(db, name);
    if (!object || object.type !== 'index' || object.tbl_name !== spec.table) return true;
    const columns = db.prepare(`PRAGMA index_info(${name})`).all().map(row => String(row.name));
    if (columns.join(',') !== spec.columns.join(',')) return true;
  }
  for (const [name, spec] of Object.entries(TRIGGERS)) {
    const object = sqliteObject(db, name);
    if (!object || object.type !== 'trigger' || object.tbl_name !== spec.table || normalizeSql(object.sql) !== normalizeSql(spec.sql)) return true;
  }
  return false;
}

function validateChecks(db) {
  const integrityRows = db.prepare('PRAGMA integrity_check').all();
  const integrityMessages = integrityRows.map(row => String(row.integrity_check || Object.values(row)[0] || ''));
  if (integrityMessages.length !== 1 || integrityMessages[0].toLowerCase() !== 'ok') {
    throw new DatabaseMigrationError('Database integrity validation failed. The source database was preserved.', { code: 'DATABASE_INTEGRITY_FAILED', stage: 'integrity_check' });
  }
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) {
    throw new DatabaseMigrationError('Database relationship validation failed. The source database was preserved.', { code: 'DATABASE_FOREIGN_KEY_FAILED', stage: 'foreign_key_check' });
  }
  return { integrity: 'ok', foreignKeyViolations: 0 };
}

function migrate(db, options = {}) {
  const originalVersion = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (originalVersion > SCHEMA_VERSION) {
    throw new DatabaseMigrationError('This database was created by a newer application version.', {
      code: 'DATABASE_VERSION_UNSUPPORTED', stage: 'version_check', originalVersion
    });
  }
  if (!schemaNeedsReconciliation(db)) {
    if (options.validateExisting) validateChecks(db);
    return { migrated: false, originalVersion, schemaVersion: SCHEMA_VERSION, appliedStages: [] };
  }

  const appliedStages = [];
  let stage = 'begin';
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const migration of MIGRATION_ORDER) {
      stage = migration.stage;
      for (const table of migration.tables || []) ensureTable(db, table);
      for (const [table, columns] of Object.entries(migration.columns || {})) ensureColumns(db, table, columns);
      for (const index of migration.indexes || []) ensureIndex(db, index);
      for (const trigger of migration.triggers || []) ensureTrigger(db, trigger);
      appliedStages.push(stage);
      if (options.failAfterStage === stage) throw new Error('Synthetic migration failure.');
    }
    stage = 'schema_validation';
    for (const table of Object.keys(TABLES)) validateOrRepairColumns(db, table, FINAL_REQUIRED_COLUMNS[table]);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    validateChecks(db);
    db.exec('COMMIT;');
    return { migrated: true, originalVersion, schemaVersion: SCHEMA_VERSION, appliedStages };
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    if (error instanceof DatabaseMigrationError) {
      error.originalVersion = originalVersion;
      throw error;
    }
    throw new DatabaseMigrationError(
      `Database migration could not complete safely at ${stage}. The transaction was rolled back and schema version ${originalVersion} was retained.`,
      { stage, originalVersion, causeCode: String(error?.code || '') }
    );
  }
}

function schemaManifest() {
  return {
    version: SCHEMA_VERSION,
    migrationOrder: MIGRATION_ORDER.map(item => item.stage),
    tables: Object.fromEntries(Object.entries(FINAL_REQUIRED_COLUMNS).map(([name, columns]) => [name, [...columns]])),
    indexes: Object.keys(INDEXES),
    triggers: Object.keys(TRIGGERS)
  };
}

module.exports = {
  SCHEMA_VERSION,
  DatabaseMigrationError,
  migrate,
  schemaNeedsReconciliation,
  validateChecks,
  schemaManifest,
  MIGRATION_ORDER
};
