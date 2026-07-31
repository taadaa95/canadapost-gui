#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { resolveWorkerLaunch, spawnResolvedWorker } = require('../lib/runtime-workers');

function createSyntheticLegacyDatabase(filePath, { advancedVersion = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_number TEXT NOT NULL UNIQUE,
      service_code TEXT NOT NULL DEFAULT '', reference_number TEXT NOT NULL DEFAULT '',
      destination_postal_code TEXT NOT NULL DEFAULT '', ship_date TEXT NOT NULL DEFAULT '',
      expected_date TEXT NOT NULL DEFAULT '', delivery_date TEXT NOT NULL DEFAULT '',
      current_status TEXT NOT NULL DEFAULT '', classification TEXT NOT NULL DEFAULT '',
      eligibility_reason TEXT NOT NULL DEFAULT '', last_checked_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, raw_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO shipments (tracking_number, service_code, created_at, updated_at)
    VALUES ('SYNTHETIC-PACKAGED-MIGRATION', 'DOM.EP', '2026-01-01', '2026-01-01');
    PRAGMA user_version = ${advancedVersion ? 7 : 4};
  `);
  db.close();
}

async function launchProbe(packageRoot, databasePath, backupDirectory) {
  const executablePath = path.join(packageRoot, process.platform === 'win32' ? 'Canada Post Claim Runner.exe' : 'canadapost-gui');
  const resourcesPath = path.join(packageRoot, 'resources');
  const resolution = resolveWorkerLaunch('databaseStartup', {
    appPath: path.join(resourcesPath, 'app.asar'),
    resourcesPath,
    userDataPath: path.join(path.dirname(databasePath), 'probe-user-data'),
    executablePath,
    appImagePath: process.env.APPIMAGE || '',
    isPackaged: true,
    platform: process.platform
  });
  const launch = spawnResolvedWorker(resolution, {
    env: {
      NODE_ENV: 'test',
      NODE_OPTIONS: '--unhandled-rejections=strict',
      DATABASE_STARTUP_PROBE_CONFIRM: 'SYNTHETIC_DATABASE_ONLY',
      CANADAPOST_DATABASE_PROBE_PATH: databasePath,
      CANADAPOST_DATABASE_PROBE_BACKUP_DIR: backupDirectory
    }
  });
  let stdout = '';
  let stderr = '';
  launch.child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  launch.child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const started = await launch.started;
  assert.strictEqual(started.ok, true, started.error?.message || 'Database startup probe failed to spawn.');
  const exit = await new Promise(resolve => launch.child.once('close', (code, signal) => resolve({ code, signal })));
  assert.strictEqual(exit.code, 0, `Packaged database probe exited ${exit.code}: ${stderr.slice(0, 1000)}`);
  assert.doesNotMatch(`${stdout}\n${stderr}`, /no such table: classification_records|unhandled(?: promise)? rejection/i);
  const events = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'database_ready');
  assert.strictEqual(events[0].databaseReady, true);
  assert.strictEqual(events[0].integrity, 'ok');
  assert.strictEqual(events[0].foreignKeyViolations, 0);
  return events[0];
}

(async () => {
  const packageRoot = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'packages', 'linux-unpacked'));
  const scenario = String(process.argv[3] || 'legacy');
  assert.ok(['legacy', 'advanced'].includes(scenario), 'Scenario must be legacy or advanced.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `cp-packaged-database-${scenario}-`));
  try {
    const databasePath = path.join(temporary, 'copied-synthetic-database', 'app.sqlite');
    const backupDirectory = path.join(temporary, 'migration-backups');
    createSyntheticLegacyDatabase(databasePath, { advancedVersion: scenario === 'advanced' });
    const first = await launchProbe(packageRoot, databasePath, backupDirectory);
    assert.strictEqual(first.migrated, true);
    assert.strictEqual(first.backupCreated, true);
    assert.strictEqual(first.schemaVersion, 8);

    const verified = new DatabaseSync(databasePath);
    assert.strictEqual(verified.prepare("SELECT count(*) AS count FROM shipments WHERE tracking_number = 'SYNTHETIC-PACKAGED-MIGRATION'").get().count, 1);
    assert.strictEqual(verified.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'classification_records'").get().count, 1);
    assert.strictEqual(verified.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.strictEqual(verified.prepare('PRAGMA foreign_key_check').all().length, 0);
    verified.close();

    const second = await launchProbe(packageRoot, databasePath, backupDirectory);
    assert.strictEqual(second.migrated, false);
    assert.strictEqual(second.backupCreated, false);
    process.stdout.write(`Packaged database startup smoke passed (${scenario}, strict unhandled rejections).\n`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
