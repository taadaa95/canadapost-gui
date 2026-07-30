'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OVERRIDE_ENV = 'CANADA_POST_CLAIM_RUNNER_USER_DATA_DIR';
const CONFIRM_ENV = 'CANADA_POST_CLAIM_RUNNER_ISOLATED_TEST_CONFIRM';
const CONFIRM_VALUE = 'ISOLATED_MIGRATION_TEST';

class IsolatedUserDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IsolatedUserDataError';
    this.code = code;
  }
}

function resolved(value) {
  return path.resolve(String(value || ''));
}

function containsPath(root, candidate) {
  const relative = path.relative(resolved(root), resolved(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeRealpath(value) {
  try { return fs.realpathSync.native(value); } catch (_) { return fs.realpathSync(value); }
}

function canonicalIfExisting(value) {
  const absolute = resolved(value);
  return fs.existsSync(absolute) ? safeRealpath(absolute) : absolute;
}

function samePath(left, right, platform = process.platform) {
  const a = String(left || '');
  const b = String(right || '');
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function containsApplicationBundleSegment(value) {
  return String(value || '')
    .split(/[\\/]+/)
    .some(segment => ['app.asar', 'app.asar.unpacked'].includes(segment.toLowerCase()));
}

function assertNoEscapingSymlinks(root) {
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const info = fs.lstatSync(candidate);
      if (info.isSymbolicLink()) {
        const target = safeRealpath(candidate);
        if (!containsPath(root, target)) {
          throw new IsolatedUserDataError('ISOLATED_PATH_SYMLINK_ESCAPE', 'The isolated profile contains a symbolic link that resolves outside the selected directory.');
        }
        continue;
      }
      if (info.isDirectory()) visit(candidate);
    }
  };
  visit(root);
}

function validateIsolatedOverride(options = {}) {
  const env = options.env || process.env;
  const platform = String(options.platform || process.platform);
  const override = String(env[OVERRIDE_ENV] || '');
  const confirmation = String(env[CONFIRM_ENV] || '');
  const defaultUserData = resolved(options.defaultUserData);
  if (!override && !confirmation) return { active: false, defaultUserData, userDataRoot: defaultUserData };
  if (!override || confirmation !== CONFIRM_VALUE) {
    throw new IsolatedUserDataError('ISOLATED_CONFIRMATION_REQUIRED', `Both ${OVERRIDE_ENV} and the exact isolated migration confirmation are required.`);
  }
  if (!path.isAbsolute(override)) throw new IsolatedUserDataError('ISOLATED_PATH_NOT_ABSOLUTE', 'The isolated application-data directory must be an absolute path.');
  if (!fs.existsSync(override)) throw new IsolatedUserDataError('ISOLATED_PATH_MISSING', 'The isolated application-data directory does not exist.');
  const sourceInfo = fs.lstatSync(override);
  if (sourceInfo.isSymbolicLink()) throw new IsolatedUserDataError('ISOLATED_PATH_SYMLINK', 'The isolated application-data directory itself must not be a symbolic link.');
  if (!sourceInfo.isDirectory()) throw new IsolatedUserDataError('ISOLATED_PATH_NOT_DIRECTORY', 'The isolated application-data path is not a directory.');

  const canonical = safeRealpath(override);
  const canonicalInfo = fs.statSync(canonical);
  const filesystemRoot = canonicalIfExisting(path.parse(canonical).root);
  const homeDirectory = canonicalIfExisting(options.homeDirectory || os.homedir());
  const canonicalDefaultUserData = canonicalIfExisting(defaultUserData);
  const repositoryRoot = safeRealpath(options.repositoryRoot || path.resolve(__dirname, '..'));
  if (samePath(canonical, filesystemRoot, platform)) throw new IsolatedUserDataError('ISOLATED_PATH_FILESYSTEM_ROOT', 'The filesystem root cannot be used as isolated application data.');
  if (samePath(canonical, homeDirectory, platform)) throw new IsolatedUserDataError('ISOLATED_PATH_HOME', 'The home directory cannot be used as isolated application data.');
  const currentUid = typeof options.currentUid === 'number'
    ? options.currentUid
    : (typeof process.getuid === 'function' ? process.getuid() : null);
  if (currentUid !== null && Number.isInteger(canonicalInfo.uid) && canonicalInfo.uid !== currentUid) {
    throw new IsolatedUserDataError('ISOLATED_PATH_WRONG_OWNER', 'The isolated application-data directory is not owned by the current user.');
  }
  // POSIX mode bits do not represent Windows ACLs and appear broadly writable on
  // Windows even when the directory is access-controlled by the current account.
  if (platform !== 'win32' && (canonicalInfo.mode & 0o002) !== 0) {
    throw new IsolatedUserDataError('ISOLATED_PATH_WORLD_WRITABLE', 'The isolated application-data directory must not be world-writable.');
  }

  if (samePath(canonical, canonicalDefaultUserData, platform) || containsPath(canonicalDefaultUserData, canonical)) {
    throw new IsolatedUserDataError('ISOLATED_PATH_DEFAULT_PROFILE', 'The normal application profile and its children cannot be used for an isolated migration test.');
  }
  if (containsPath(canonical, repositoryRoot) || containsPath(repositoryRoot, canonical)) {
    throw new IsolatedUserDataError('ISOLATED_PATH_REPOSITORY', 'The repository and overlapping directories cannot be used as isolated application data.');
  }
  if (containsApplicationBundleSegment(canonical)) {
    throw new IsolatedUserDataError('ISOLATED_PATH_APPLICATION_BUNDLE', 'An ASAR or unpacked application path cannot be used as isolated application data.');
  }

  for (const rawForbidden of options.forbiddenPaths || []) {
    if (!rawForbidden) continue;
    const forbidden = canonicalIfExisting(rawForbidden);
    if (samePath(canonical, forbidden, platform) || containsPath(forbidden, canonical) || containsPath(canonical, forbidden)) {
      throw new IsolatedUserDataError('ISOLATED_PATH_APPLICATION_BUNDLE', 'The AppImage, application mount, executable, and packaged resources cannot be used as isolated application data.');
    }
  }
  assertNoEscapingSymlinks(canonical);
  return { active: true, defaultUserData, userDataRoot: canonical, confirmation: CONFIRM_VALUE };
}

function existingAncestor(candidate) {
  let current = resolved(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function assertContainedPath(root, candidate, label = 'mutable path') {
  const canonicalRoot = safeRealpath(root);
  const absolute = resolved(candidate);
  if (!containsPath(canonicalRoot, absolute)) {
    throw new IsolatedUserDataError('ISOLATED_MUTABLE_PATH_ESCAPE', `${label} is outside the isolated application-data directory.`);
  }
  const ancestor = existingAncestor(absolute);
  const canonicalAncestor = safeRealpath(ancestor);
  if (!containsPath(canonicalRoot, canonicalAncestor)) {
    throw new IsolatedUserDataError('ISOLATED_MUTABLE_PATH_SYMLINK_ESCAPE', `${label} resolves outside the isolated application-data directory.`);
  }
  return absolute;
}

function createUserDataBootstrap() {
  let state = Object.freeze({ initialized: false, active: false, defaultUserData: '', userDataRoot: '' });
  return {
    initialize(app, options = {}) {
      if (state.initialized) return state;
      const defaultUserData = String(app.getPath('userData'));
      const validated = validateIsolatedOverride({
        ...options,
        defaultUserData,
        forbiddenPaths: options.forbiddenPaths || [
          process.env.APPIMAGE,
          process.execPath,
          process.resourcesPath,
          typeof app.getAppPath === 'function' ? app.getAppPath() : ''
        ]
      });
      if (validated.active) {
        const runtimePaths = {
          cache: assertContainedPath(validated.userDataRoot, path.join(validated.userDataRoot, 'cache'), 'cache directory'),
          crashDumps: assertContainedPath(validated.userDataRoot, path.join(validated.userDataRoot, 'crash-dumps'), 'crash dump directory'),
          logs: assertContainedPath(validated.userDataRoot, path.join(validated.userDataRoot, 'logs'), 'application log directory')
        };
        for (const directory of Object.values(runtimePaths)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        app.setPath('userData', validated.userDataRoot);
        app.setPath('sessionData', validated.userDataRoot);
        app.setPath('cache', runtimePaths.cache);
        app.setPath('crashDumps', runtimePaths.crashDumps);
        if (typeof app.setAppLogsPath === 'function') app.setAppLogsPath(runtimePaths.logs);
        state = Object.freeze({ initialized: true, ...validated, runtimePaths: Object.freeze(runtimePaths) });
      } else {
        state = Object.freeze({ initialized: true, ...validated, runtimePaths: Object.freeze({}) });
      }
      return state;
    },
    getState() { return state; },
    assertMutablePath(candidate, label) {
      if (!state.initialized) throw new IsolatedUserDataError('USER_DATA_BOOTSTRAP_LATE', 'Application data was requested before userData bootstrap completed.');
      return state.active ? assertContainedPath(state.userDataRoot, candidate, label) : resolved(candidate);
    },
    assertMutablePaths(entries) {
      return Object.fromEntries(Object.entries(entries).map(([label, candidate]) => [label, this.assertMutablePath(candidate, label)]));
    }
  };
}

const singleton = createUserDataBootstrap();

module.exports = {
  OVERRIDE_ENV,
  CONFIRM_ENV,
  CONFIRM_VALUE,
  IsolatedUserDataError,
  containsPath,
  validateIsolatedOverride,
  assertContainedPath,
  createUserDataBootstrap,
  initialize: singleton.initialize.bind(singleton),
  getState: singleton.getState.bind(singleton),
  assertMutablePath: singleton.assertMutablePath.bind(singleton),
  assertMutablePaths: singleton.assertMutablePaths.bind(singleton)
};
