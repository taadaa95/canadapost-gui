'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const claimDb = require('../lib/claim-database');
const startupDatabase = require('../lib/startup-database');

function digest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function legacyDatabase(filePath, { version = 4, rows = true } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE shipments (
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
    CREATE TABLE claim_attempts (
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
    );
    PRAGMA user_version = ${Number(version)};
  `);
  if (rows) {
    db.exec(`
      INSERT INTO shipments (tracking_number, service_code, reference_number, created_at, updated_at)
      VALUES ('SYNTHETIC-MIGRATION-PIN', 'DOM.EP', 'SYNTHETIC-ORDER', '2026-01-01', '2026-01-01');
      INSERT INTO claim_attempts (shipment_id, status, started_at, created_at, updated_at)
      VALUES (1, 'failed', '2026-01-02', '2026-01-02', '2026-01-02');
    `);
  }
  db.close();
}

function addLegacyClassification(filePath, { withIndex = false, withRecord = true } = {}) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE classification_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL,
      policy_version TEXT NOT NULL,
      classification TEXT NOT NULL,
      FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE RESTRICT
    );
  `);
  if (withRecord) db.exec("INSERT INTO classification_records (shipment_id, policy_version, classification) VALUES (1, 'synthetic-policy', 'MANUAL_REVIEW');");
  if (withIndex) db.exec('CREATE INDEX idx_classifications_shipment ON classification_records(shipment_id, id DESC);');
  db.close();
}

function assertReady(filePath, expected = {}) {
  const manifest = claimDb.schemaManifest();
  const db = new DatabaseSync(filePath);
  try {
    assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, claimDb.SCHEMA_VERSION);
    for (const [table, columns] of Object.entries(manifest.tables)) {
      const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      for (const column of columns) assert.ok(actual.has(column), `${table}.${column} is required`);
    }
    for (const index of manifest.indexes) assert.strictEqual(db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(index)?.type, 'index');
    for (const trigger of manifest.triggers) assert.strictEqual(db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(trigger)?.type, 'trigger');
    assert.strictEqual(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.strictEqual(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    if (expected.shipments !== undefined) assert.strictEqual(db.prepare('SELECT count(*) AS count FROM shipments').get().count, expected.shipments);
    if (expected.claimAttempts !== undefined) assert.strictEqual(db.prepare('SELECT count(*) AS count FROM claim_attempts').get().count, expected.claimAttempts);
    if (expected.classifications !== undefined) assert.strictEqual(db.prepare('SELECT count(*) AS count FROM classification_records').get().count, expected.classifications);
    if (expected.queueSnapshots !== undefined) assert.strictEqual(db.prepare('SELECT count(*) AS count FROM queue_snapshots').get().count, expected.queueSnapshots);
  } finally {
    db.close();
  }
}

async function migrateAndRepeat(filePath, options = {}, expected = {}) {
  const backupDirectory = path.join(path.dirname(filePath), 'backups');
  const first = await claimDb.initializeDatabase(filePath, { backupDirectory, ...options });
  assert.strictEqual(first.databaseReady, true);
  assertReady(filePath, expected);
  const second = await claimDb.initializeDatabase(filePath, { backupDirectory });
  assert.strictEqual(second.migrated, false, 'second startup must be a no-op');
  assert.strictEqual(second.backupPath, '', 'no-op startup must not create another migration backup');
  assertReady(filePath, expected);
  return first;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-migration-recovery-'));
  try {
    // 1. Fresh database.
    const fresh = path.join(root, 'fresh', 'app.sqlite');
    fs.mkdirSync(path.dirname(fresh), { recursive: true });
    fs.writeFileSync(fresh, Buffer.alloc(0));
    const freshResult = await migrateAndRepeat(fresh);
    assert.ok(fs.existsSync(freshResult.backupPath));

    // 2. Current expected schema.
    const current = path.join(root, 'current', 'app.sqlite');
    claimDb.openDatabase(current).close();
    const currentResult = await migrateAndRepeat(current);
    assert.strictEqual(currentResult.migrated, false);

    // 3. Version-4/dev and old claim schema without classification_records.
    const legacy = path.join(root, 'legacy', 'app.sqlite');
    legacyDatabase(legacy);
    const legacyResult = await migrateAndRepeat(legacy, {}, { shipments: 1, claimAttempts: 1, classifications: 0 });
    assert.ok(fs.existsSync(legacyResult.backupPath));

    // Every schema version still accepted by the migration framework upgrades
    // transactionally and becomes a no-op on its second startup.
    for (const version of [0, 1, 2, 3, 5, 6, 7]) {
      const supported = path.join(root, `supported-v${version}`, 'app.sqlite');
      legacyDatabase(supported, { version });
      await migrateAndRepeat(supported, {}, { shipments: 1, claimAttempts: 1 });
    }

    // 4. classification_records exists but is missing supported newer columns.
    const oldClassification = path.join(root, 'old-classification', 'app.sqlite');
    legacyDatabase(oldClassification, { version: 6 });
    addLegacyClassification(oldClassification);
    await migrateAndRepeat(oldClassification, {}, { shipments: 1, claimAttempts: 1, classifications: 1 });

    // 5. Schema version was advanced even though classification_records is absent.
    const falselyAdvanced = path.join(root, 'advanced', 'app.sqlite');
    const advancedDb = claimDb.openDatabase(falselyAdvanced);
    advancedDb.exec(`
      INSERT INTO shipments (tracking_number, created_at, updated_at) VALUES ('SYNTHETIC-ADVANCED', '2026-01-01', '2026-01-01');
      PRAGMA foreign_keys = OFF;
      DROP TABLE classification_records;
      PRAGMA user_version = 7;
    `);
    advancedDb.close();
    await migrateAndRepeat(falselyAdvanced, {}, { shipments: 1, classifications: 0 });

    // 6. Interrupted after table creation but before dependent indexes.
    const beforeIndexes = path.join(root, 'before-indexes', 'app.sqlite');
    legacyDatabase(beforeIndexes, { version: 5 });
    addLegacyClassification(beforeIndexes);
    await migrateAndRepeat(beforeIndexes, {}, { classifications: 1 });

    // 7. Interrupted after an index but before the run_id column/version promotion.
    const beforeRunColumn = path.join(root, 'before-run-column', 'app.sqlite');
    legacyDatabase(beforeRunColumn, { version: 6 });
    addLegacyClassification(beforeRunColumn, { withIndex: true });
    await migrateAndRepeat(beforeRunColumn, {}, { classifications: 1 });

    // 8. Re-running all reconciliation is covered by every migrateAndRepeat call.

    // 9. Existing claim, queue, classification, tracking, review and audit rows survive repair.
    const populated = path.join(root, 'populated', 'app.sqlite');
    const populatedDb = claimDb.openDatabase(populated);
    populatedDb.exec(`
      INSERT INTO shipments (tracking_number, created_at, updated_at) VALUES ('SYNTHETIC-POPULATED', '2026-01-01', '2026-01-01');
      INSERT INTO runs (run_type, status, started_at) VALUES ('tracking', 'complete', '2026-01-02');
      INSERT INTO tracking_checks (shipment_id, run_id, checked_at, result) VALUES (1, 1, '2026-01-02', 'ok');
      INSERT INTO claim_attempts (shipment_id, status, started_at, created_at, updated_at) VALUES (1, 'failed', '2026-01-03', '2026-01-03', '2026-01-03');
      INSERT INTO classification_records (shipment_id, policy_version, policy_effective_date, policy_data_version, classification,
        classification_timestamp, input_hash, evidence_hash, policy_source_ids_json, reason_codes_json, input_json, evidence_json, created_at, run_id)
      VALUES (1, 'synthetic', '2026-01-01', 'synthetic', 'MANUAL_REVIEW', '2026-01-03', 'input', 'evidence', '[]', '[]', '{}', '{}', '2026-01-03', 1);
      INSERT INTO manual_reviews (shipment_id, classification_id, opened_at, created_at, updated_at) VALUES (1, 1, '2026-01-03', '2026-01-03', '2026-01-03');
      INSERT INTO audit_events (event_type, shipment_id, created_at) VALUES ('synthetic', 1, '2026-01-03');
      INSERT INTO queue_snapshots (snapshot_hash, policy_data_version, item_count, snapshot_json, created_at) VALUES ('synthetic-snapshot', 'synthetic', 1, '{}', '2026-01-03');
      INSERT INTO queue_snapshot_items (snapshot_id, shipment_id, ordinal, input_hash, classification_evidence_hash) VALUES (1, 1, 0, 'input', 'evidence');
      DROP INDEX idx_classifications_run;
    `);
    populatedDb.close();
    await migrateAndRepeat(populated, {}, { shipments: 1, claimAttempts: 1, classifications: 1, queueSnapshots: 1 });

    // 10. Corrupt input fails safely and leaves an exact recovery copy.
    const corrupt = path.join(root, 'corrupt', 'app.sqlite');
    fs.mkdirSync(path.dirname(corrupt), { recursive: true });
    fs.writeFileSync(corrupt, 'synthetic-not-a-sqlite-database');
    const corruptHash = digest(corrupt);
    let corruptError;
    try { await claimDb.initializeDatabase(corrupt, { backupDirectory: path.join(root, 'corrupt', 'backups') }); } catch (error) { corruptError = error; }
    assert.ok(corruptError instanceof claimDb.DatabaseMigrationError);
    assert.ok(corruptError.backupPath && fs.existsSync(corruptError.backupPath));
    assert.strictEqual(digest(corrupt), corruptHash);
    assert.strictEqual(digest(corruptError.backupPath), corruptHash);

    // 11. A pre-existing foreign-key violation is rejected and backed up.
    const invalidForeignKey = path.join(root, 'foreign-key', 'app.sqlite');
    const invalidDb = claimDb.openDatabase(invalidForeignKey);
    invalidDb.exec('PRAGMA foreign_keys = OFF;');
    invalidDb.exec(`INSERT INTO classification_records (shipment_id, policy_version, policy_effective_date, policy_data_version,
      classification, classification_timestamp, input_hash, evidence_hash, policy_source_ids_json, reason_codes_json,
      input_json, evidence_json, created_at) VALUES (999, 'synthetic', '2026-01-01', 'synthetic', 'MANUAL_REVIEW',
      '2026-01-01', 'input', 'evidence', '[]', '[]', '{}', '{}', '2026-01-01');`);
    invalidDb.close();
    let foreignKeyError;
    try { await claimDb.initializeDatabase(invalidForeignKey, { backupDirectory: path.join(root, 'foreign-key', 'backups') }); } catch (error) { foreignKeyError = error; }
    assert.strictEqual(foreignKeyError?.code, 'DATABASE_FOREIGN_KEY_FAILED');
    assert.ok(fs.existsSync(foreignKeyError.backupPath));
    const invalidCheck = new DatabaseSync(invalidForeignKey);
    assert.strictEqual(invalidCheck.prepare('SELECT count(*) AS count FROM classification_records WHERE shipment_id = 999').get().count, 1);
    invalidCheck.close();

    // 12. An injected migration failure rolls back every object and preserves user_version and rows.
    const rollback = path.join(root, 'rollback', 'app.sqlite');
    legacyDatabase(rollback);
    let rollbackError;
    try {
      await claimDb.initializeDatabase(rollback, {
        backupDirectory: path.join(root, 'rollback', 'backups'),
        failAfterStage: 'v5_classification_history'
      });
    } catch (error) { rollbackError = error; }
    assert.strictEqual(rollbackError?.code, 'DATABASE_MIGRATION_FAILED');
    assert.ok(fs.existsSync(rollbackError.backupPath));
    const rolledBack = new DatabaseSync(rollback);
    assert.strictEqual(rolledBack.prepare('PRAGMA user_version').get().user_version, 4);
    assert.strictEqual(rolledBack.prepare("SELECT count(*) AS count FROM shipments WHERE tracking_number = 'SYNTHETIC-MIGRATION-PIN'").get().count, 1);
    assert.strictEqual(rolledBack.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'classification_records'").get().count, 0);
    rolledBack.close();

    const diagnostic = startupDatabase.buildDiagnostic(rollbackError, { now: new Date('2026-07-28T12:00:00.000Z') });
    const diagnosticText = startupDatabase.diagnosticText(diagnostic);
    assert.match(diagnosticText, /DATABASE_MIGRATION_FAILED/);
    assert.match(diagnosticText, /Database contents included: no/);
    assert.doesNotMatch(diagnosticText, /SYNTHETIC-MIGRATION-PIN|authorization|cookie/i);
    const diagnosticPath = startupDatabase.writeDiagnostic(path.join(root, 'logs'), diagnostic);
    assert.ok(fs.existsSync(diagnosticPath));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(diagnosticPath).mode & 0o777, 0o600);

    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(mainSource, /await claimDb\.initializeDatabase\(DB_PATH/);
    assert.ok(mainSource.indexOf('await claimDb.initializeDatabase(DB_PATH') < mainSource.indexOf('databaseReady = true'));
    assert.ok(mainSource.indexOf('databaseReady = true') < mainSource.indexOf('createWindow();', mainSource.indexOf('async function startApplication')));
    assert.match(mainSource, /localizedText\('dialog\.databaseRecovery\.openData'/);
    assert.match(mainSource, /localizedText\('dialog\.databaseRecovery\.copyDiagnostic'/);
    assert.match(mainSource, /localizedText\('dialog\.databaseRecovery\.exit'/);
    const frenchLocale = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'fr-CA.json'), 'utf8'));
    assert.strictEqual(frenchLocale['dialog.databaseRecovery.openData'], 'Ouvrir le dossier de données');
    assert.strictEqual(frenchLocale['dialog.databaseRecovery.copyDiagnostic'], 'Copier le diagnostic');
    assert.strictEqual(frenchLocale['dialog.databaseRecovery.exit'], 'Quitter');
    assert.match(mainSource, /\.catch\(error => handleStartupFailure\(error\)\)/);

    console.log('Database migration recovery fixtures passed (12 states).');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
