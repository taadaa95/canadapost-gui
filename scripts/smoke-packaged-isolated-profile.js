#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const OVERRIDE_ENV = 'CANADA_POST_CLAIM_RUNNER_USER_DATA_DIR';
const CONFIRM_ENV = 'CANADA_POST_CLAIM_RUNNER_ISOLATED_TEST_CONFIRM';
const CONFIRM_VALUE = 'ISOLATED_MIGRATION_TEST';
const PROBE_ENV = 'CANADA_POST_CLAIM_RUNNER_HEADLESS_PROFILE_PROBE';
const PROBE_VALUE = 'PACKAGED_SYNTHETIC_ONLY';

function privateDirectory(parent, name) {
  const result = path.join(parent, name);
  fs.mkdirSync(result, { recursive: true, mode: 0o700 });
  fs.chmodSync(result, 0o700);
  return result;
}

function digestDirectory(directory) {
  const hash = crypto.createHash('sha256');
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = path.join(current, entry.name);
      hash.update(path.relative(directory, candidate));
      hash.update(String(fs.lstatSync(candidate).mode));
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(candidate));
      else hash.update(fs.readFileSync(candidate));
    }
  };
  walk(directory);
  return hash.digest('hex');
}

function createSyntheticCopiedProfile(profile) {
  const databasePath = path.join(profile, 'database', 'app.sqlite');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(profile, 'data'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'data', 'tracking.csv'), 'Tracking Number,Service\nSYNTHETIC-REDACTED,DOM.EP\n', { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'config.json'), '{"setupCompleted":true}\n', { mode: 0o600 });
  const db = new DatabaseSync(databasePath);
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
    VALUES ('SYNTHETIC-PACKAGED-ISOLATED', 'DOM.EP', '2026-01-01', '2026-01-01');
    PRAGMA user_version = 4;
  `);
  db.close();
}

async function launch(executable, executableArguments, env, expectedCode) {
  const child = spawn(executable, [...executableArguments, '--no-sandbox', '--disable-gpu', '--headless'], {
    env: { ...process.env, NODE_OPTIONS: '--unhandled-rejections=strict', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Packaged isolated-profile probe timed out.'));
    }, 30000);
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.strictEqual(exit.code, expectedCode, `Packaged probe exited ${exit.code}/${exit.signal}: ${stderr.slice(0, 1000)}`);
  assert.doesNotMatch(`${stdout}\n${stderr}`, /unhandled(?: promise)? rejection|no such table: classification_records/i);
  const jsonLines = `${stdout}\n${stderr}`.split(/\r?\n/).filter(line => /^\s*\{/.test(line));
  assert.ok(jsonLines.length >= 1, `Packaged probe emitted no JSON event: ${stderr.slice(0, 1000)}`);
  return JSON.parse(jsonLines.at(-1));
}

(async () => {
  let packageTarget = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'packages', 'linux-unpacked'));
  const targetIsAppImage = fs.statSync(packageTarget, { throwIfNoEntry: false })?.isFile() && packageTarget.endsWith('.AppImage');
  let extractedAppImage = '';
  if (targetIsAppImage) {
    extractedAppImage = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-appimage-isolated-smoke-'));
    fs.chmodSync(extractedAppImage, 0o700);
    const extraction = spawnSync(packageTarget, ['--appimage-extract'], { cwd: extractedAppImage, encoding: 'utf8' });
    assert.strictEqual(extraction.status, 0, `AppImage extraction failed: ${String(extraction.stderr || '').slice(0, 500)}`);
    packageTarget = path.join(extractedAppImage, 'squashfs-root');
  }
  const executable = path.join(packageTarget, process.platform === 'win32' ? 'Canada Post Claim Runner.exe' : 'canadapost-gui');
  const executableArguments = [];
  assert.ok(fs.statSync(executable, { throwIfNoEntry: false })?.isFile(), 'Packaged executable is missing.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-packaged-isolated-profile-'));
  fs.chmodSync(temporary, 0o700);
  try {
    const xdgRoot = privateDirectory(temporary, 'synthetic-xdg-config');
    const normalSentinelProfile = privateDirectory(xdgRoot, 'canadapost-gui');
    fs.writeFileSync(path.join(normalSentinelProfile, 'DO-NOT-TOUCH'), 'synthetic normal-profile sentinel\n', { mode: 0o600 });
    const normalBefore = digestDirectory(normalSentinelProfile);

    const profileTemplate = privateDirectory(temporary, 'copied-profile-template');
    createSyntheticCopiedProfile(profileTemplate);
    const isolatedProfile = path.join(temporary, 'isolated-profile-copy');
    fs.cpSync(profileTemplate, isolatedProfile, { recursive: true, preserveTimestamps: true });
    fs.chmodSync(isolatedProfile, 0o700);

    const baseEnvironment = {
      XDG_CONFIG_HOME: xdgRoot,
      [OVERRIDE_ENV]: isolatedProfile,
      [CONFIRM_ENV]: CONFIRM_VALUE,
      [PROBE_ENV]: PROBE_VALUE
    };
    const first = await launch(executable, executableArguments, baseEnvironment, 0);
    assert.strictEqual(first.type, 'isolated_profile_database_ready');
    assert.strictEqual(first.isolated, true);
    assert.strictEqual(first.userDataMatchesElectron, true);
    assert.strictEqual(first.schemaVersion, 8);
    assert.strictEqual(first.migrated, true);
    assert.strictEqual(first.backupCreated, true);
    assert.strictEqual(first.backupDelta, 1);
    assert.strictEqual(first.shipmentCount, 1);
    assert.strictEqual(first.liveSubmissionEnabled, false);
    assert.strictEqual(first.updateActionsEnabled, false);
    assert.strictEqual(digestDirectory(normalSentinelProfile), normalBefore);

    const backupDirectory = path.join(isolatedProfile, 'database-backups');
    const firstBackupCount = fs.readdirSync(backupDirectory).filter(name => name.endsWith('.sqlite')).length;
    assert.strictEqual(firstBackupCount, 1);
    const second = await launch(executable, executableArguments, baseEnvironment, 0);
    assert.strictEqual(second.schemaVersion, 8);
    assert.strictEqual(second.migrated, false);
    assert.strictEqual(second.backupCreated, false);
    assert.strictEqual(second.backupDelta, 0);
    assert.strictEqual(fs.readdirSync(backupDirectory).filter(name => name.endsWith('.sqlite')).length, 1);
    assert.strictEqual(digestDirectory(normalSentinelProfile), normalBefore);

    const migrated = new DatabaseSync(path.join(isolatedProfile, 'database', 'app.sqlite'));
    assert.strictEqual(migrated.prepare("SELECT count(*) AS count FROM shipments WHERE tracking_number = 'SYNTHETIC-PACKAGED-ISOLATED'").get().count, 1);
    assert.strictEqual(migrated.prepare('PRAGMA user_version').get().user_version, 8);
    assert.strictEqual(migrated.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.strictEqual(migrated.prepare('PRAGMA foreign_key_check').all().length, 0);
    migrated.close();

    const outside = privateDirectory(temporary, 'outside-symlink-target');
    const symlinkProfile = path.join(temporary, 'profile-link');
    fs.symlinkSync(outside, symlinkProfile);
    const unsafe = privateDirectory(temporary, 'world-writable-profile');
    fs.chmodSync(unsafe, 0o777);
    const asarNamed = privateDirectory(temporary, 'app.asar.unpacked');
    const rejectionCases = [
      { name: 'relative', override: 'relative-profile', code: 'ISOLATED_PATH_NOT_ABSOLUTE' },
      { name: 'missing-confirmation', override: isolatedProfile, confirmation: '', code: 'ISOLATED_CONFIRMATION_REQUIRED' },
      { name: 'symlink', override: symlinkProfile, code: 'ISOLATED_PATH_SYMLINK' },
      { name: 'world-writable', override: unsafe, code: 'ISOLATED_PATH_WORLD_WRITABLE' },
      { name: 'asar', override: asarNamed, code: 'ISOLATED_PATH_APPLICATION_BUNDLE' }
    ];
    for (const scenario of rejectionCases) {
      const result = await launch(executable, executableArguments, {
        XDG_CONFIG_HOME: xdgRoot,
        [OVERRIDE_ENV]: scenario.override,
        [CONFIRM_ENV]: Object.prototype.hasOwnProperty.call(scenario, 'confirmation') ? scenario.confirmation : CONFIRM_VALUE,
        [PROBE_ENV]: PROBE_VALUE
      }, 2);
      assert.strictEqual(result.type, 'isolated_profile_rejected', scenario.name);
      assert.strictEqual(result.code, scenario.code, scenario.name);
      assert.strictEqual(digestDirectory(normalSentinelProfile), normalBefore, scenario.name);
    }

    process.stdout.write('Packaged isolated-profile migration, second-startup no-op, containment, and rejection smokes passed.\n');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (extractedAppImage) fs.rmSync(extractedAppImage, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
