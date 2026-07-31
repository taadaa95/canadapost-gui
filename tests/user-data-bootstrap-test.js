#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const {
  OVERRIDE_ENV,
  CONFIRM_ENV,
  CONFIRM_VALUE,
  validateIsolatedOverride,
  assertContainedPath,
  createUserDataBootstrap
} = require('../lib/user-data-bootstrap');
const { mutablePathManifest, validateMutablePathManifest } = require('../lib/mutable-paths');
const claimDb = require('../lib/claim-database');

const repositoryRoot = path.resolve(__dirname, '..');
const POSIX_SECURITY_TESTS = process.platform !== 'win32';

function canonicalPath(value) {
  try { return fs.realpathSync.native(value); } catch (_) { return fs.realpathSync(value); }
}

function privateDirectory(parent, name) {
  const directory = path.join(parent, name);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function environment(override, confirmation = CONFIRM_VALUE) {
  return { [OVERRIDE_ENV]: override, [CONFIRM_ENV]: confirmation };
}

function validate(candidate, defaultUserData, options = {}) {
  return validateIsolatedOverride({
    env: environment(candidate),
    defaultUserData,
    repositoryRoot,
    forbiddenPaths: [],
    ...options
  });
}

function rejectsCode(fn, code) {
  assert.throws(fn, error => error?.code === code, `Expected ${code}`);
}

function digestDirectory(directory) {
  const hash = crypto.createHash('sha256');
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = path.join(current, entry.name);
      hash.update(path.relative(directory, candidate));
      hash.update(String(fs.lstatSync(candidate).mode));
      if (entry.isDirectory()) walk(candidate);
      else hash.update(fs.readFileSync(candidate));
    }
  };
  walk(directory);
  return hash.digest('hex');
}

function createLegacyDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
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
    VALUES ('SYNTHETIC-ISOLATED-PROFILE', 'DOM.EP', '2026-01-01', '2026-01-01');
    PRAGMA user_version = 4;
  `);
  db.close();
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-user-data-bootstrap-'));
  fs.chmodSync(temporary, 0o700);
  try {
    const normal = privateDirectory(temporary, 'normal-profile');
    const isolated = privateDirectory(temporary, 'isolated-profile');
    const valid = validate(isolated, normal);
    assert.strictEqual(valid.active, true);
    assert.strictEqual(valid.userDataRoot, canonicalPath(isolated));

    assert.deepStrictEqual(validateIsolatedOverride({ env: {}, defaultUserData: normal, repositoryRoot }), {
      active: false,
      defaultUserData: path.resolve(normal),
      userDataRoot: path.resolve(normal)
    });
    rejectsCode(() => validateIsolatedOverride({ env: { [OVERRIDE_ENV]: isolated }, defaultUserData: normal, repositoryRoot }), 'ISOLATED_CONFIRMATION_REQUIRED');
    rejectsCode(() => validateIsolatedOverride({ env: { [CONFIRM_ENV]: CONFIRM_VALUE }, defaultUserData: normal, repositoryRoot }), 'ISOLATED_CONFIRMATION_REQUIRED');
    rejectsCode(() => validate(isolated, normal, { env: environment(isolated, 'wrong') }), 'ISOLATED_CONFIRMATION_REQUIRED');
    rejectsCode(() => validate('relative/profile', normal), 'ISOLATED_PATH_NOT_ABSOLUTE');
    rejectsCode(() => validate(path.join(temporary, 'missing'), normal), 'ISOLATED_PATH_MISSING');

    const regularFile = path.join(temporary, 'regular-file');
    fs.writeFileSync(regularFile, 'synthetic');
    rejectsCode(() => validate(regularFile, normal), 'ISOLATED_PATH_NOT_DIRECTORY');
    rejectsCode(() => validate(path.parse(temporary).root, normal), 'ISOLATED_PATH_FILESYSTEM_ROOT');
    rejectsCode(() => validate(isolated, normal, { homeDirectory: isolated }), 'ISOLATED_PATH_HOME');
    rejectsCode(() => validate(normal, normal), 'ISOLATED_PATH_DEFAULT_PROFILE');
    const normalChild = privateDirectory(normal, 'child');
    rejectsCode(() => validate(normalChild, normal), 'ISOLATED_PATH_DEFAULT_PROFILE');
    rejectsCode(() => validate(repositoryRoot, normal), 'ISOLATED_PATH_REPOSITORY');

    if (POSIX_SECURITY_TESTS) {
      const symlinkProfile = path.join(temporary, 'symlink-profile');
      fs.symlinkSync(isolated, symlinkProfile);
      rejectsCode(() => validate(symlinkProfile, normal), 'ISOLATED_PATH_SYMLINK');
      const escapeRoot = privateDirectory(temporary, 'escape-profile');
      fs.symlinkSync(temporary, path.join(escapeRoot, 'escape'));
      rejectsCode(() => validate(escapeRoot, normal), 'ISOLATED_PATH_SYMLINK_ESCAPE');

      const unsafe = privateDirectory(temporary, 'unsafe-profile');
      fs.chmodSync(unsafe, 0o777);
      rejectsCode(() => validate(unsafe, normal), 'ISOLATED_PATH_WORLD_WRITABLE');
      fs.chmodSync(unsafe, 0o700);
    }
    const asarDirectory = privateDirectory(temporary, 'app.asar.unpacked');
    rejectsCode(() => validate(asarDirectory, normal), 'ISOLATED_PATH_APPLICATION_BUNDLE');
    const appImageMount = privateDirectory(temporary, 'appimage-mount');
    rejectsCode(() => validate(appImageMount, normal, { forbiddenPaths: [appImageMount] }), 'ISOLATED_PATH_APPLICATION_BUNDLE');

    const events = [];
    const fakeApp = {
      getPath(name) { events.push(`get:${name}`); return normal; },
      setPath(name, value) { events.push(`set:${name}:${value}`); },
      setAppLogsPath(value) { events.push(`logs:${value}`); },
      getAppPath() { return repositoryRoot; }
    };
    const bootstrap = createUserDataBootstrap();
    const initialized = bootstrap.initialize(fakeApp, { env: environment(isolated), repositoryRoot, forbiddenPaths: [] });
    assert.strictEqual(initialized.active, true);
    assert.strictEqual(events[0], 'get:userData');
    assert.ok(events.some(value => value === `set:userData:${canonicalPath(isolated)}`));

    const normalEvents = [];
    const normalBootstrap = createUserDataBootstrap();
    const normalState = normalBootstrap.initialize({
      getPath(name) { normalEvents.push(`get:${name}`); return normal; },
      setPath(name) { normalEvents.push(`set:${name}`); },
      setAppLogsPath() { normalEvents.push('logs'); },
      getAppPath() { return repositoryRoot; }
    }, { env: {}, repositoryRoot, forbiddenPaths: [] });
    assert.strictEqual(normalState.active, false);
    assert.strictEqual(normalState.userDataRoot, normal);
    assert.deepStrictEqual(normalEvents, ['get:userData']);

    const manifest = validateMutablePathManifest(bootstrap, initialized.userDataRoot);
    for (const candidate of Object.values(manifest)) assert.doesNotThrow(() => assertContainedPath(initialized.userDataRoot, candidate));
    if (POSIX_SECURITY_TESTS) {
      const outside = privateDirectory(temporary, 'outside');
      const mutableLink = path.join(isolated, 'mutable-link');
      fs.symlinkSync(outside, mutableLink);
      rejectsCode(() => assertContainedPath(isolated, path.join(mutableLink, 'escape.sqlite')), 'ISOLATED_MUTABLE_PATH_SYMLINK_ESCAPE');
      fs.unlinkSync(mutableLink);
    }

    fs.writeFileSync(path.join(normal, 'sentinel'), 'NORMAL PROFILE MUST REMAIN UNCHANGED\n', { mode: 0o600 });
    const defaultBefore = digestDirectory(normal);
    const databasePath = mutablePathManifest(isolated).database;
    createLegacyDatabase(databasePath);
    const first = await claimDb.initializeDatabase(databasePath, { backupDirectory: manifest.databaseBackups });
    assert.strictEqual(first.migrated, true);
    assert.strictEqual(first.schemaVersion, 8);
    assert.ok(first.backupPath && fs.existsSync(first.backupPath));
    const backupCount = fs.readdirSync(manifest.databaseBackups).filter(name => name.endsWith('.sqlite')).length;
    assert.strictEqual(backupCount, 1);
    const second = await claimDb.initializeDatabase(databasePath, { backupDirectory: manifest.databaseBackups });
    assert.strictEqual(second.migrated, false);
    assert.strictEqual(second.backupPath, '');
    assert.strictEqual(fs.readdirSync(manifest.databaseBackups).filter(name => name.endsWith('.sqlite')).length, 1);
    const verified = claimDb.openDatabase(databasePath, { migrate: false });
    assert.strictEqual(verified.prepare("SELECT count(*) AS count FROM shipments WHERE tracking_number = 'SYNTHETIC-ISOLATED-PROFILE'").get().count, 1);
    assert.strictEqual(verified.prepare('PRAGMA user_version').get().user_version, 8);
    verified.close();
    assert.strictEqual(digestDirectory(normal), defaultBefore);

    const childProfile = privateDirectory(temporary, 'child-import-profile');
    const childCode = `
      const Module = require('module');
      const original = Module._load;
      const events = [];
      const app = { getPath(name) { events.push('get:' + name); return process.argv[1]; }, setPath(name, value) { events.push('set:' + name); }, setAppLogsPath() {}, getAppPath() { return process.argv[3]; } };
      const safeStorage = { isEncryptionAvailable() { return false; } };
      Module._load = function(request, parent, isMain) { if (request === 'electron') return { app, safeStorage }; return original.call(this, request, parent, isMain); };
      const bootstrap = require(process.argv[3] + '/lib/user-data-bootstrap');
      bootstrap.initialize(app, { repositoryRoot: process.argv[3], forbiddenPaths: [] });
      const storage = require(process.argv[3] + '/lib/app-storage');
      process.stdout.write(JSON.stringify({ root: storage.USER_DATA_ROOT, first: events[0] }));
    `;
    const childOutput = execFileSync(process.execPath, ['-e', childCode, normal, childProfile, repositoryRoot], {
      env: { ...process.env, ...environment(childProfile) }, encoding: 'utf8'
    });
    const childResult = JSON.parse(childOutput);
    assert.strictEqual(childResult.root, canonicalPath(childProfile));
    assert.strictEqual(childResult.first, 'get:userData');

    const html = fs.readFileSync(path.join(repositoryRoot, 'index.html'), 'utf8');
    const renderer = fs.readFileSync(path.join(repositoryRoot, 'renderer.js'), 'utf8');
    const main = fs.readFileSync(path.join(repositoryRoot, 'main.js'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    assert.strictEqual(packageJson.main, 'bootstrap.js');
    assert.match(html, /ISOLATED TEST DATA — changes do not affect the normal application profile/);
    assert.match(renderer, /Canada Post Claim Runner \[ISOLATED TEST DATA\]/);
    assert.match(main, /Live claim submission is disabled while isolated test data is active/);
    assert.match(main, /Update actions are disabled while isolated test data is active/);

    process.stdout.write('User-data bootstrap, containment, isolated UI guard, and migration no-op tests passed.\n');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
