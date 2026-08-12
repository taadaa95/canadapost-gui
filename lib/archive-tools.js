'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');
const claimDb = require('./claim-database');
const { inspectZipBuffer } = require('./zip-safety');

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

function safeName(value) {
  return String(value || 'file').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'file';
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowsToCsv(headers, rows) {
  return [headers.map(csvCell).join(','), ...rows.map(row => headers.map(header => csvCell(row[header])).join(','))].join('\n') + '\n';
}

function publicSettings(config = {}) {
  const allowed = [
    'rememberSettings', 'webUsername', 'estCustomerNumber', 'estFrom', 'estTo',
    'historyCustomerNumber', 'historyFrom', 'historyTo', 'historyAutoMobo',
    'historyMobo', 'historyIncludeNoManifest', 'freshTracking', 'developerMode',
    'claimStreetNumber', 'claimStreetName', 'claimAddressLine2', 'claimCity',
    'claimProvince', 'claimPostalCode', 'claimBusinessName', 'claimContactName',
    'claimContactPhone', 'claimContactEmail', 'updateUrl',
    'evidenceRetentionDays'
  ];
  return Object.fromEntries(allowed.filter(key => Object.prototype.hasOwnProperty.call(config, key)).map(key => [key, config[key]]));
}

function evidenceMetadata(history) {
  return history.filter(item => item.screenshotPath || item.textPath).map(item => ({
    attemptId: item.id,
    trackingNumberMasked: maskTracking(item.trackingNumber),
    attemptedAt: item.attemptedAt,
    status: item.status,
    screenshotName: item.screenshotPath ? path.basename(item.screenshotPath) : '',
    pageTextName: item.textPath ? path.basename(item.textPath) : ''
  }));
}

function maskTracking(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (text.length <= 4) return text ? '****' : '';
  return `${'*'.repeat(Math.min(12, text.length - 4))}${text.slice(-4)}`;
}

function sanitizeText(value, sensitiveValues = []) {
  let text = String(value || '');
  for (const raw of sensitiveValues) {
    const needle = String(raw || '').trim();
    if (!needle || needle.length < 3) continue;
    text = text.split(needle).join('[REDACTED]');
  }
  text = text
    .replace(/("?(?:password|webPassword|apiPassword|token|cookie|authorization)"?\s*[:=]\s*)[^\s,;}]+/gi, '$1[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[PHONE]')
    .replace(/\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi, '[POSTAL]')
    .replace(/\b[A-Z]{2}\d{9}[A-Z]{2}\b/gi, match => maskTracking(match))
    .replace(/\b\d{11,20}\b/g, match => maskTracking(match));
  return text;
}

function writeZip(destination, entries) {
  ensureParent(destination);
  const bytes = zipSync(entries, { level: 6 });
  const temporary = `${destination}.partial-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, Buffer.from(bytes), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  try { fs.chmodSync(destination, 0o600); } catch (_) {}
  return destination;
}

function backupEligibleDataFile(name) {
  return /^(?:tracking|claims|overdue-undelivered|eligibility-review)\.csv$/i.test(name)
    || /^tracking-run-summary(?:-.*)?\.json$/i.test(name)
    || /^claim-run-summary(?:-.*)?\.json$/i.test(name)
    || /^claim-(?:error|error-global|already-submitted|submitted|captcha|dry-run)-row-.*\.(?:png|txt)$/i.test(name)
    || /^(?:claim-state\.json|claim-history\.jsonl)$/i.test(name);
}

function backupDataEntries(dataDir) {
  const entries = {};
  if (!dataDir || !fs.existsSync(dataDir)) return entries;
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile() || !backupEligibleDataFile(entry.name)) continue;
    entries[`data/${safeName(entry.name)}`] = new Uint8Array(fs.readFileSync(path.join(dataDir, entry.name)));
  }
  return entries;
}

function safeArchiveDataName(key) {
  if (!key.startsWith('data/')) return '';
  const relative = key.slice('data/'.length);
  if (!relative || relative.includes('/') || relative.includes('\\') || relative === '.' || relative === '..') return '';
  const name = path.basename(relative);
  return backupEligibleDataFile(name) ? name : '';
}

async function createBackup({ dbPath, dataDir, config, destination, appVersion, tempDirectory = os.tmpdir() }) {
  fs.mkdirSync(tempDirectory, { recursive: true, mode: 0o700 });
  const tempDatabase = path.join(tempDirectory, `canadapost-backup-${process.pid}-${Date.now()}.sqlite`);
  await claimDb.createDatabaseBackup(dbPath, tempDatabase);
  try {
    const history = claimDb.listClaimHistory(dbPath, { limit: 100000 });
    const reconciliation = claimDb.listReconciliation(dbPath, 100000);
    const manifest = {
      format: 'canadapost-claim-runner-backup',
      version: 1,
      appVersion,
      createdAt: new Date().toISOString(),
      includesPasswords: false,
      includesBrowserSession: false,
      includesEvidenceFiles: true,
      databaseSchemaVersion: claimDb.SCHEMA_VERSION,
      counts: { claimAttempts: history.length, reconciliation: reconciliation.length }
    };
    const historyCsv = rowsToCsv(
      ['Tracking', 'Attempt Time', 'Status', 'Attempt', 'Confirmation', 'Message'],
      history.map(item => ({
        Tracking: item.trackingNumber,
        'Attempt Time': item.attemptedAt,
        Status: item.status,
        Attempt: item.attemptNumber,
        Confirmation: item.confirmationNumber,
        Message: item.message
      }))
    );
    const reconciliationCsv = rowsToCsv(
      ['Attempt ID', 'Tracking', 'Attempt Time', 'Status', 'Message'],
      reconciliation.map(item => ({
        'Attempt ID': item.id,
        Tracking: item.trackingNumber,
        'Attempt Time': item.attemptedAt,
        Status: item.status,
        Message: item.message
      }))
    );
    return writeZip(destination, {
      'manifest.json': strToU8(JSON.stringify(manifest, null, 2) + '\n'),
      'database/app.sqlite': new Uint8Array(fs.readFileSync(tempDatabase)),
      'settings/settings.json': strToU8(JSON.stringify(publicSettings(config), null, 2) + '\n'),
      'exports/claim-history.csv': strToU8(historyCsv),
      'exports/reconciliation.csv': strToU8(reconciliationCsv),
      'evidence/metadata.json': strToU8(JSON.stringify(evidenceMetadata(history), null, 2) + '\n'),
      ...backupDataEntries(dataDir)
    });
  } finally {
    fs.rmSync(tempDatabase, { force: true });
  }
}

function readBackupManifest(entries) {
  if (!entries['manifest.json']) throw new Error('Backup manifest is missing.');
  let manifest;
  try { manifest = JSON.parse(strFromU8(entries['manifest.json'])); } catch (_) { throw new Error('Backup manifest is invalid.'); }
  if (manifest.format !== 'canadapost-claim-runner-backup') throw new Error('This is not a Canada Post Claim Runner backup.');
  if (!entries['database/app.sqlite']) throw new Error('Backup database is missing.');
  const header = Buffer.from(entries['database/app.sqlite']).subarray(0, 16).toString('utf8');
  if (header !== 'SQLite format 3\u0000') throw new Error('Backup database is not a valid SQLite file.');
  return manifest;
}

function restoreBackup({ source, dbPath, dataDir, configWriter }) {
  const bytes = fs.readFileSync(source);
  inspectZipBuffer(bytes);
  const entries = unzipSync(new Uint8Array(bytes));
  const manifest = readBackupManifest(entries);
  ensureParent(dbPath);
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const rollbackPath = `${dbPath}.before-restore-${timestamp()}`;
  const rollbackDataDir = dataDir ? path.join(dataDir, `before-restore-${timestamp()}`) : '';
  const tempPath = `${dbPath}.restore-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, Buffer.from(entries['database/app.sqlite']), { mode: 0o600 });
  const check = claimDb.integrityCheck(tempPath);
  if (!check.ok) {
    fs.rmSync(tempPath, { force: true });
    throw new Error(`Backup database integrity check failed: ${check.result}`);
  }
  if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, rollbackPath);

  const dataEntries = Object.entries(entries)
    .map(([key, value]) => ({ name: safeArchiveDataName(key), value }))
    .filter(item => item.name);
  if (dataEntries.length && dataDir) {
    fs.mkdirSync(rollbackDataDir, { recursive: true, mode: 0o700 });
    for (const item of dataEntries) {
      const destination = path.join(dataDir, item.name);
      if (fs.existsSync(destination)) fs.copyFileSync(destination, path.join(rollbackDataDir, item.name));
      fs.writeFileSync(destination, Buffer.from(item.value), { mode: 0o600 });
    }
  }

  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(dbPath, { force: true });
  fs.renameSync(tempPath, dbPath);
  fs.rmSync(`${tempPath}-wal`, { force: true });
  fs.rmSync(`${tempPath}-shm`, { force: true });
  try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  if (dataDir) claimDb.rebaseEvidencePaths(dbPath, dataDir);

  let restoredSettings = {};
  if (entries['settings/settings.json']) {
    try { restoredSettings = JSON.parse(strFromU8(entries['settings/settings.json'])); } catch (_) {}
    if (configWriter) configWriter(restoredSettings);
  }
  return {
    ok: true,
    manifest,
    rollbackPath: fs.existsSync(rollbackPath) ? rollbackPath : '',
    rollbackDataDir: rollbackDataDir && fs.existsSync(rollbackDataDir) ? rollbackDataDir : '',
    restoredSettings,
    restoredDataFiles: dataEntries.length
  };
}

function diagnosticsSettings(config = {}, credentialStatus = {}) {
  return {
    rememberSettings: Boolean(config.rememberSettings),
    historyAutoMobo: Boolean(config.historyAutoMobo),
    historyIncludeNoManifest: Boolean(config.historyIncludeNoManifest),
    developerMode: Boolean(config.developerMode),
    freshTracking: Boolean(config.freshTracking),
    evidenceRetentionDays: Number(config.evidenceRetentionDays || 90),
    webUsernameConfigured: Boolean(config.webUsername),
    estCustomerNumberConfigured: Boolean(config.estCustomerNumber),
    historyCustomerNumberConfigured: Boolean(config.historyCustomerNumber),
    claimAddressConfigured: Boolean(config.claimStreetNumber && config.claimStreetName),
    claimContactConfigured: Boolean(config.claimContactName || config.claimContactEmail || config.claimContactPhone),
    ...credentialStatus
  };
}

function recentFiles(directory, predicate, limit = 5) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && predicate(entry.name))
    .map(entry => ({ name: entry.name, path: path.join(directory, entry.name), mtime: fs.statSync(path.join(directory, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}


function latestStep3RunDirectory(logDir) {
  const root = path.join(logDir || '', 'step3-runs');
  if (!root || !fs.existsSync(root)) return '';
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({ path: path.join(root, entry.name), name: entry.name, mtime: fs.statSync(path.join(root, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.path || '';
}

function step3DiagnosticEntries(logDir, sensitiveValues = []) {
  void sensitiveValues;
  const directory = latestStep3RunDirectory(logDir);
  if (!directory) return {};
  const inventory = [];
  let totalBytes = 0;
  const maxTotalBytes = 25 * 1024 * 1024;
  const allowed = /\.(?:json|jsonl|log|txt)$/i;

  const walk = (current, depth = 0) => {
    if (depth > 8 || inventory.length >= 100) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (inventory.length >= 100) break;
      const source = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (fs.lstatSync(source).isSymbolicLink()) continue;
        walk(source, depth + 1);
        continue;
      }
      if (!entry.isFile() || !allowed.test(entry.name)) continue;
      const stats = fs.lstatSync(source);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      const size = stats.size;
      if (size > 5 * 1024 * 1024 || totalBytes + size > maxTotalBytes) continue;
      inventory.push({ ordinal: inventory.length + 1, extension: path.extname(entry.name).toLowerCase(), bytes: size, modifiedAt: stats.mtime.toISOString() });
      totalBytes += size;
    }
  };

  walk(directory);
  return {
    'step3-diagnostics/inventory.json': strToU8(`${JSON.stringify({
      contentIncluded: false,
      reason: 'Free-form diagnostic text and screenshots are potentially sensitive and are excluded.',
      files: inventory
    }, null, 2)}\n`)
  };
}

function createDiagnosticPackage({ destination, appVersion, config, credentialStatus, logDir, dbPath, dependencyStatus, sensitiveValues = [], components = ['system', 'settings'], supportManifest = {} }) {
  const selected = new Set(components);
  const manifest = {
    ...supportManifest,
    applicationVersion: supportManifest.applicationVersion || appVersion,
    createdAt: new Date().toISOString(),
    node: process.versions.node,
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
    privacy: 'Credentials, tokens, cookies, browser profiles, raw API bodies, screenshots, filenames, free-form operational text, addresses, contact details and full tracking numbers are excluded.'
  };
  const entries = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2) + '\n')
  };
  if (selected.has('system')) {
    entries['system/dependencies.json'] = strToU8(JSON.stringify(dependencyStatus, null, 2) + '\n');
    entries['system/database-integrity.json'] = strToU8(JSON.stringify(claimDb.integrityCheck(dbPath), null, 2) + '\n');
  }
  if (selected.has('settings')) {
    entries['settings/sanitized-settings.json'] = strToU8(JSON.stringify(diagnosticsSettings(config, credentialStatus), null, 2) + '\n');
  }
  if (selected.has('history')) {
    const history = claimDb.listClaimHistory(dbPath, { limit: 100 });
    const reconciliation = claimDb.listReconciliation(dbPath, 100);
    const sanitizedHistory = history.map(item => ({
      id: item.id,
      tracking: maskTracking(item.trackingNumber),
      attemptedAt: item.attemptedAt,
      status: item.status,
      attemptNumber: item.attemptNumber,
      errorCode: item.errorCode,
      messagePresent: Boolean(item.message),
      screenshotPresent: Boolean(item.screenshotPath),
      pageTextPresent: Boolean(item.textPath)
    }));
    const sanitizedReconciliation = reconciliation.map(item => ({
      id: item.id,
      tracking: maskTracking(item.trackingNumber),
      attemptedAt: item.attemptedAt,
      status: item.status,
      errorCode: item.errorCode,
      messagePresent: Boolean(item.message)
    }));
    entries['history/recent-attempts.json'] = strToU8(JSON.stringify(sanitizedHistory, null, 2) + '\n');
    entries['history/reconciliation.json'] = strToU8(JSON.stringify(sanitizedReconciliation, null, 2) + '\n');
    entries['history/dashboard.json'] = strToU8(JSON.stringify(claimDb.dashboard(dbPath), null, 2) + '\n');
  }
  if (selected.has('step3Diagnostics')) Object.assign(entries, step3DiagnosticEntries(logDir, sensitiveValues));
  if (selected.has('logs')) {
    const files = recentFiles(logDir, name => name.endsWith('.log') && !/response|structure/i.test(name), 5)
      .filter(file => {
        const stats = fs.lstatSync(file.path);
        return stats.isFile() && !stats.isSymbolicLink() && stats.size <= 5 * 1024 * 1024;
      })
      .map((file, index) => {
        const stats = fs.lstatSync(file.path);
        return { ordinal: index + 1, bytes: stats.size, modifiedAt: stats.mtime.toISOString() };
      });
    entries['logs/inventory.json'] = strToU8(`${JSON.stringify({
      contentIncluded: false,
      reason: 'Free-form log text is potentially sensitive and is excluded.',
      files
    }, null, 2)}\n`);
  }
  return writeZip(destination, entries);
}

function exportHistoryCsv(dbPath, destination, options = {}) {
  const history = claimDb.listClaimHistory(dbPath, { ...options, limit: 100000 });
  const csv = rowsToCsv(
    ['Tracking Number', 'Reference Number', 'Service Code', 'Attempt Time', 'Status', 'Attempt Number', 'Confirmation Number', 'Error Code', 'Message'],
    history.map(item => ({
      'Tracking Number': item.trackingNumber,
      'Reference Number': item.referenceNumber,
      'Service Code': item.serviceCode,
      'Attempt Time': item.attemptedAt,
      Status: item.status,
      'Attempt Number': item.attemptNumber,
      'Confirmation Number': item.confirmationNumber,
      'Error Code': item.errorCode,
      Message: item.message
    }))
  );
  ensureParent(destination);
  fs.writeFileSync(destination, csv, { mode: 0o600 });
  return destination;
}

module.exports = {
  timestamp,
  maskTracking,
  sanitizeText,
  publicSettings,
  createBackup,
  restoreBackup,
  createDiagnosticPackage,
  exportHistoryCsv,
  latestStep3RunDirectory,
  step3DiagnosticEntries
};
