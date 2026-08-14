'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const userDataBootstrap = require('./user-data-bootstrap');
const { validateMutablePathManifest } = require('./mutable-paths');

async function run(app) {
  const profile = userDataBootstrap.getState();
  if (!profile.active) throw Object.assign(new Error('The packaged profile probe requires an active isolated profile.'), { code: 'PROBE_ISOLATED_PROFILE_REQUIRED' });
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  if (!(profile.userDataRoot === temporaryRoot || profile.userDataRoot.startsWith(`${temporaryRoot}${path.sep}`))) {
    throw Object.assign(new Error('The packaged profile probe is restricted to temporary synthetic profiles.'), { code: 'PROBE_PATH_REJECTED' });
  }
  await app.whenReady();
  const storage = require('./app-storage');
  const claimDb = require('./claim-database');
  const paths = validateMutablePathManifest(userDataBootstrap, storage.USER_DATA_ROOT);
  fs.mkdirSync(paths.backupRestoreTemporary, { recursive: true, mode: 0o700 });
  storage.migrateLegacyData();
  const beforeBackups = fs.existsSync(paths.databaseBackups)
    ? fs.readdirSync(paths.databaseBackups).filter(name => name.endsWith('.sqlite')).length
    : 0;
  const migration = await claimDb.initializeDatabase(paths.database, { backupDirectory: paths.databaseBackups });
  const afterBackups = fs.existsSync(paths.databaseBackups)
    ? fs.readdirSync(paths.databaseBackups).filter(name => name.endsWith('.sqlite')).length
    : 0;
  const db = claimDb.openDatabase(paths.database, { migrate: false });
  let shipmentCount;
  try { shipmentCount = Number(db.prepare('SELECT count(*) AS count FROM shipments').get().count); }
  finally { db.close(); }
  process.stdout.write(`${JSON.stringify({
    type: 'isolated_profile_database_ready',
    isolated: true,
    userDataMatchesElectron: path.resolve(app.getPath('userData')) === profile.userDataRoot,
    schemaVersion: migration.schemaVersion,
    migrated: migration.migrated,
    backupCreated: Boolean(migration.backupPath),
    backupDelta: afterBackups - beforeBackups,
    shipmentCount,
    mutablePathCount: Object.keys(paths).length,
    liveSubmissionEnabled: false,
    updateActionsEnabled: false
  })}\n`);
  app.exit(0);
}

module.exports = { run };
