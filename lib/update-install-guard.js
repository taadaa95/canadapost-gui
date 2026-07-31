'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function safeVersion(value) {
  const text = String(value || '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(text)) throw new Error('Update marker version is invalid.');
  return text;
}

function markerPath(userDataRoot) {
  return path.join(path.resolve(userDataRoot), 'updates', 'pending-update.json');
}

function sanitizedError(error) {
  return {
    code: String(error?.code || 'UPDATE_INSTALL_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 80),
    operation: String(error?.operation || '').replace(/[^a-z0-9_]/gi, '').slice(0, 80),
    message: String(error?.message || 'Update installation could not continue.')
      .replace(/((?:password|credential|token|cookie|authorization))\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
      .replace(/\b\d{12,22}\b/g, '[TRACKING_REDACTED]')
      .slice(0, 500)
  };
}

function writeMarker(userDataRoot, marker) {
  const destination = markerPath(userDataRoot);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch (_) {}
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, destination);
  try { fs.chmodSync(destination, 0o600); } catch (_) {}
  return destination;
}

function createPendingMarker({ userDataRoot, oldVersion, targetVersion, backupPath, downloadedPath, previousExecutable = '', now = new Date() }) {
  const root = path.resolve(userDataRoot);
  const resolvedBackup = backupPath ? path.resolve(backupPath) : '';
  if (resolvedBackup && !(resolvedBackup === root || resolvedBackup.startsWith(`${root}${path.sep}`))) throw new Error('Pre-update backup must remain inside application data.');
  const marker = {
    format: 'canadapost-claim-runner-pending-update',
    version: 1,
    operationId: crypto.randomUUID(),
    oldVersion: safeVersion(oldVersion),
    targetVersion: safeVersion(targetVersion),
    timestamp: new Date(now).toISOString(),
    backupPath: resolvedBackup,
    downloadedPath: path.resolve(downloadedPath),
    previousExecutable: previousExecutable ? path.resolve(previousExecutable) : '',
    status: 'pending'
  };
  return { marker, path: writeMarker(root, marker) };
}

function readPendingMarker(userDataRoot) {
  const destination = markerPath(userDataRoot);
  if (!fs.existsSync(destination)) return null;
  const parsed = JSON.parse(fs.readFileSync(destination, 'utf8'));
  if (parsed?.format !== 'canadapost-claim-runner-pending-update' || parsed.status !== 'pending') throw new Error('Pending update marker is invalid.');
  safeVersion(parsed.oldVersion);
  safeVersion(parsed.targetVersion);
  return { ...parsed, markerPath: destination };
}

function acknowledgeHealthyStartup(userDataRoot, details = {}) {
  const pending = readPendingMarker(userDataRoot);
  if (!pending) return { acknowledged: false };
  const archiveDirectory = path.join(path.resolve(userDataRoot), 'updates', 'history');
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  const healthy = {
    ...pending,
    markerPath: undefined,
    status: 'healthy',
    healthyAt: new Date(details.now || Date.now()).toISOString(),
    startupIntegrity: String(details.integrity || 'ok').slice(0, 80)
  };
  const destination = path.join(archiveDirectory, `update-${healthy.operationId}-healthy.json`);
  fs.writeFileSync(destination, `${JSON.stringify(healthy, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.rmSync(pending.markerPath, { force: true });
  return { acknowledged: true, archivePath: destination, backupPath: pending.backupPath };
}

function recoveryState(userDataRoot) {
  try {
    const pending = readPendingMarker(userDataRoot);
    if (!pending) return { pending: false };
    return {
      pending: true,
      code: 'UPDATE_RECOVERY_REQUIRED',
      oldVersion: pending.oldVersion,
      targetVersion: pending.targetVersion,
      timestamp: pending.timestamp,
      backupPreserved: Boolean(pending.backupPath && fs.existsSync(pending.backupPath)),
      previousExecutablePreserved: Boolean(pending.previousExecutable && fs.existsSync(pending.previousExecutable)),
      downloadedInstallerPreserved: Boolean(pending.downloadedPath && fs.existsSync(pending.downloadedPath))
    };
  } catch (error) {
    return { pending: true, code: 'UPDATE_MARKER_INVALID', error: sanitizedError(error) };
  }
}

async function prepareInstall({ coordinator, createBackup, createMarker, install }) {
  try {
    coordinator.assertInactive();
  } catch (error) {
    return { ok: false, blocked: true, error: sanitizedError(error) };
  }
  const backupPath = await createBackup();
  try {
    coordinator.assertInactive();
    coordinator.lockForUpdate?.();
  } catch (error) {
    return { ok: false, blocked: true, error: sanitizedError(error), backupPath };
  }
  let marker;
  try {
    marker = await createMarker(backupPath);
    await install({ backupPath, marker });
  } catch (error) {
    if (error?.code === 'PROTECTED_OPERATION_ACTIVE' || error?.code === 'UPDATE_INSTALL_IN_PROGRESS') {
      if (marker?.path) fs.rmSync(marker.path, { force: true });
      return { ok: false, blocked: true, error: sanitizedError(error), backupPath };
    }
    throw error;
  } finally {
    coordinator.unlockForUpdate?.();
  }
  return { ok: true, backupPath, marker };
}

module.exports = {
  markerPath,
  sanitizedError,
  createPendingMarker,
  readPendingMarker,
  acknowledgeHealthyStartup,
  recoveryState,
  prepareInstall
};
