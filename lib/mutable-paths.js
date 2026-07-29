'use strict';

const path = require('path');

function mutablePathManifest(userDataRoot) {
  const root = path.resolve(userDataRoot);
  const data = path.join(root, 'data');
  const logs = path.join(root, 'logs');
  const database = path.join(root, 'database', 'app.sqlite');
  return Object.freeze({
    userDataRoot: root,
    database,
    databaseWal: `${database}-wal`,
    databaseShm: `${database}-shm`,
    databaseBackups: path.join(root, 'database-backups'),
    migrationBackups: path.join(root, 'database', 'migration-backups'),
    data,
    configuration: path.join(root, 'config.json'),
    encryptedSecrets: path.join(root, 'credentials.json'),
    credentialKey: path.join(root, 'credential-key.bin'),
    trackingCsv: path.join(data, 'tracking.csv'),
    claimsCsv: path.join(data, 'claims.csv'),
    overdueCsv: path.join(data, 'overdue-undelivered.csv'),
    reviewCsv: path.join(data, 'eligibility-review.csv'),
    stopRequest: path.join(data, 'stop-requested.txt'),
    selectedClaimsPrefix: path.join(data, 'claims-selected-run-'),
    logs,
    diagnostics: path.join(logs, 'step3-runs'),
    evidence: path.join(data, 'evidence'),
    chromiumSessionData: root,
    browserPartition: path.join(root, 'Partitions', 'canadapost-claims-builtin'),
    browserProfile: path.join(data, 'browser-profile'),
    browserTemporaryProfilePrefix: path.join(data, 'browser-profile-temp-'),
    workerRuntime: path.join(root, 'worker-runtime'),
    queueSnapshotPrefix: path.join(data, 'queue-snapshot-run-'),
    trackingRunStaging: path.join(data, 'tracking-runs'),
    backupRestoreTemporary: path.join(root, 'tmp', 'backup-restore'),
    cache: path.join(root, 'cache'),
    crashDumps: path.join(root, 'crash-dumps')
  });
}

function validateMutablePathManifest(userDataBootstrap, userDataRoot) {
  const manifest = mutablePathManifest(userDataRoot);
  userDataBootstrap.assertMutablePaths(manifest);
  return manifest;
}

module.exports = { mutablePathManifest, validateMutablePathManifest };
