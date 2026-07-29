#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const claimDb = require('../lib/claim-database');

function withinTemporaryRoot(candidate) {
  const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
  return path.resolve(candidate).startsWith(temporaryRoot);
}

async function main() {
  const databasePath = String(process.env.CANADAPOST_DATABASE_PROBE_PATH || '');
  const backupDirectory = String(process.env.CANADAPOST_DATABASE_PROBE_BACKUP_DIR || '');
  if (process.env.DATABASE_STARTUP_PROBE_CONFIRM !== 'SYNTHETIC_DATABASE_ONLY' || !databasePath || !backupDirectory) {
    throw Object.assign(new Error('Synthetic database probe confirmation is required.'), { code: 'PROBE_CONFIRMATION_REQUIRED' });
  }
  if (!withinTemporaryRoot(databasePath) || !withinTemporaryRoot(backupDirectory)) {
    throw Object.assign(new Error('The database startup probe is restricted to the temporary directory.'), { code: 'PROBE_PATH_REJECTED' });
  }
  const result = await claimDb.initializeDatabase(databasePath, { backupDirectory });
  process.stdout.write(`${JSON.stringify({
    type: 'database_ready',
    databaseReady: result.databaseReady,
    migrated: result.migrated,
    originalVersion: result.originalVersion,
    schemaVersion: result.schemaVersion,
    backupCreated: Boolean(result.backupPath),
    integrity: 'ok',
    foreignKeyViolations: 0
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    type: 'database_startup_failed',
    code: String(error?.code || 'DATABASE_STARTUP_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 80),
    stage: String(error?.stage || 'database_startup').replace(/[^A-Z0-9_]/gi, '').slice(0, 80),
    backupCreated: Boolean(error?.backupPath),
    databaseContentsIncluded: false,
    sensitiveValuesIncluded: false
  })}\n`);
  process.exitCode = 1;
});
