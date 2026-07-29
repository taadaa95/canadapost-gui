'use strict';

const fs = require('fs');
const path = require('path');

function safeIdentifier(value, fallback) {
  const text = String(value || '').trim();
  return /^[A-Z0-9_]{1,80}$/i.test(text) ? text : fallback;
}

function safeStage(value) {
  return safeIdentifier(value, 'database_startup');
}

function buildDiagnostic(error, options = {}) {
  const backupPath = String(error?.backupPath || options.backupPath || '');
  return {
    format: 'canadapost-database-startup-diagnostic',
    version: 1,
    createdAt: (options.now instanceof Date ? options.now : new Date()).toISOString(),
    status: 'database_startup_failed',
    code: safeIdentifier(error?.code, 'DATABASE_STARTUP_FAILED'),
    stage: safeStage(error?.stage),
    originalSchemaVersion: Number.isSafeInteger(Number(error?.originalVersion)) ? Number(error.originalVersion) : null,
    backupLocation: backupPath,
    databaseContentsIncluded: false,
    sensitiveValuesIncluded: false,
    recovery: 'Keep the source database and backup unchanged. Open the data folder and contact support with this diagnostic only.'
  };
}

function diagnosticText(diagnostic) {
  return [
    'Canada Post Claim Runner database startup failure',
    `Code: ${diagnostic.code}`,
    `Stage: ${diagnostic.stage}`,
    `Original schema version: ${diagnostic.originalSchemaVersion ?? 'unknown'}`,
    `Backup location: ${diagnostic.backupLocation || 'No backup was created because the database was new or unreadable.'}`,
    'Database contents included: no',
    'Sensitive values included: no',
    diagnostic.recovery
  ].join('\n');
}

function writeDiagnostic(logDirectory, diagnostic) {
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(logDirectory, 0o700); } catch (_) {}
  const stamp = diagnostic.createdAt.replace(/[:.]/g, '-');
  for (let suffix = 0; suffix < 10000; suffix += 1) {
    const destination = path.join(logDirectory, `database-startup-error-${stamp}${suffix ? `-${suffix}` : ''}.json`);
    try {
      fs.writeFileSync(destination, `${JSON.stringify(diagnostic, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return destination;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('A unique startup diagnostic path could not be allocated.');
}

module.exports = { buildDiagnostic, diagnosticText, writeDiagnostic };
