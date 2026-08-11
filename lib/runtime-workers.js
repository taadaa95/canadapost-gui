'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WORKERS = Object.freeze({
  estHistory: 'scripts/import-est-history.js',
  shippingHistory: 'scripts/import-shipping-history.js',
  tracking: 'scripts/get-tracking.js',
  databaseStartup: 'scripts/database-startup-probe.js',
  submitClaims: 'scripts/submit-claims.js'
});

class WorkerLaunchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkerLaunchError';
    this.code = code;
    this.details = details;
  }
}

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path;
}

function samePath(left, right, pathApi) {
  if (!left || !right) return false;
  const normalize = value => {
    const resolved = pathApi.resolve(String(value));
    return pathApi === path.win32 ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function deriveWorkerPaths(workerName, context = {}) {
  const relativeWorker = WORKERS[workerName];
  if (!relativeWorker) {
    throw new WorkerLaunchError('WORKER_UNKNOWN', `Unknown worker: ${String(workerName || '(empty)')}.`);
  }

  const platform = context.platform || process.platform;
  const pathApi = context.pathApi || pathApiFor(platform);
  const isPackaged = Boolean(context.isPackaged);
  const appPath = String(context.appPath || '');
  const resourcesPath = String(context.resourcesPath || '');
  const userDataPath = String(context.userDataPath || '');
  const executable = String(context.executablePath || '');

  if (!appPath) throw new WorkerLaunchError('APP_PATH_INVALID', 'Application path is unavailable.');
  if (!userDataPath) throw new WorkerLaunchError('WORKER_CWD_INVALID', 'Application data path is unavailable.');
  if (isPackaged && !resourcesPath) {
    throw new WorkerLaunchError('PACKAGED_RESOURCE_MISSING', 'Packaged resources path is unavailable.');
  }

  const resourceRoot = isPackaged
    ? pathApi.join(resourcesPath, 'app.asar.unpacked')
    : appPath;
  const cwd = pathApi.join(userDataPath, 'worker-runtime');
  const workerPath = pathApi.join(resourceRoot, ...relativeWorker.split('/'));

  if (isPackaged && /(?:^|[\\/])app\.asar[\\/]?$/i.test(cwd)) {
    throw new WorkerLaunchError('WORKER_CWD_INVALID', 'Packaged worker working directory resolves to app.asar.');
  }
  if (isPackaged && samePath(cwd, context.appImagePath || process.env.APPIMAGE, pathApi)) {
    throw new WorkerLaunchError('WORKER_CWD_INVALID', 'Packaged worker working directory resolves to the AppImage executable.');
  }
  if (isPackaged && !workerPath.toLowerCase().includes('app.asar.unpacked')) {
    throw new WorkerLaunchError('PACKAGED_RESOURCE_MISSING', 'Packaged worker does not resolve outside app.asar.');
  }

  return {
    workerName,
    relativeWorker,
    executable,
    workerPath,
    cwd,
    resourceRoot,
    appPath,
    resourcesPath,
    userDataPath,
    appImagePath: String(context.appImagePath || process.env.APPIMAGE || ''),
    isPackaged,
    platform
  };
}

function statKind(filePath, fsApi) {
  try {
    const stat = fsApi.statSync(filePath);
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if (error && error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function validateWorkerPaths(resolution, options = {}) {
  const fsApi = options.fsApi || fs;
  const createCwd = options.createCwd !== false;

  if (!resolution.executable || statKind(resolution.executable, fsApi) !== 'file') {
    throw new WorkerLaunchError(
      'WORKER_EXECUTABLE_INVALID',
      'Packaged worker executable path is invalid. Repair or reinstall the application.',
      { path: resolution.executable }
    );
  }

  const resourceKind = statKind(resolution.resourceRoot, fsApi);
  if (resolution.isPackaged && resourceKind !== 'directory') {
    throw new WorkerLaunchError(
      'PACKAGED_RESOURCE_MISSING',
      'Packaged worker resources are missing. Repair or reinstall the application.',
      { path: resolution.resourceRoot }
    );
  }

  if (createCwd && statKind(resolution.cwd, fsApi) === 'missing') {
    fsApi.mkdirSync(resolution.cwd, { recursive: true, mode: 0o700 });
  }
  if (statKind(resolution.cwd, fsApi) !== 'directory') {
    throw new WorkerLaunchError(
      'WORKER_CWD_INVALID',
      'Worker working directory is invalid. Check the application data folder permissions.',
      { path: resolution.cwd }
    );
  }
  if (statKind(resolution.workerPath, fsApi) !== 'file') {
    throw new WorkerLaunchError(
      resolution.isPackaged ? 'PACKAGED_RESOURCE_MISSING' : 'WORKER_MISSING',
      resolution.isPackaged
        ? `Packaged resource missing for ${resolution.workerName}. Repair or reinstall the application.`
        : `Worker missing for ${resolution.workerName}. Reinstall dependencies or restore the source file.`,
      { path: resolution.workerPath }
    );
  }
  return resolution;
}

function resolveWorkerLaunch(workerName, context = {}, options = {}) {
  return validateWorkerPaths(deriveWorkerPaths(workerName, context), options);
}

function spawnResolvedWorker(resolution, options = {}, dependencies = {}) {
  const spawnImpl = dependencies.spawnImpl || spawn;
  const childEnv = {
    ...process.env,
    ...options.env,
    APP_ROOT: resolution.resourceRoot,
    ELECTRON_RUN_AS_NODE: '1'
  };
  const useStdinJson = options.stdinJson && typeof options.stdinJson === 'object';
  const state = { status: 'starting', active: true, child: null, error: null };
  let child;

  try {
    child = spawnImpl(resolution.executable, [resolution.workerPath, ...(options.args || [])], {
      cwd: resolution.cwd,
      env: childEnv,
      detached: resolution.platform !== 'win32',
      windowsHide: true,
      stdio: [useStdinJson ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    state.status = 'failed';
    state.active = false;
    state.error = error;
    throw new WorkerLaunchError('WORKER_SPAWN_FAILED', `Worker could not be started: ${error.message}`, {
      workerName: resolution.workerName
    });
  }

  state.child = child;
  const started = new Promise(resolve => {
    child.once('spawn', () => {
      state.status = 'running';
      resolve({ ok: true });
    });
    child.once('error', error => {
      state.status = 'failed';
      state.active = false;
      state.error = error;
      resolve({
        ok: false,
        error: new WorkerLaunchError('WORKER_SPAWN_FAILED', `Worker could not be started: ${error.message}`, {
          workerName: resolution.workerName
        })
      });
    });
  });
  child.once('close', () => {
    state.active = false;
    if (state.status !== 'failed') state.status = 'finished';
  });

  return { child, started, state, resolution, useStdinJson };
}

module.exports = {
  WORKERS,
  WorkerLaunchError,
  deriveWorkerPaths,
  validateWorkerPaths,
  resolveWorkerLaunch,
  spawnResolvedWorker
};
