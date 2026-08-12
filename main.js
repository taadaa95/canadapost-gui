const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, clipboard, Menu, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const storage = require('./lib/app-storage');
const userDataBootstrap = require('./lib/user-data-bootstrap');
const { validateMutablePathManifest } = require('./lib/mutable-paths');
const claimDb = require('./lib/claim-database');
const startupDatabase = require('./lib/startup-database');
const archiveTools = require('./lib/archive-tools');
const encryptedBackup = require('./lib/encrypted-backup');
const { pruneStep3DiagnosticRuns } = require('./lib/step3-diagnostics');
const inputValidation = require('./lib/input-validation');
const step3QueueService = require('./lib/step3-queue-service');
const privacyDeletion = require('./lib/privacy-deletion');
const updateInstallGuard = require('./lib/update-install-guard');
const githubReleaseUpdater = require('./lib/github-release-updater');
const { coordinator: operationCoordinator } = require('./lib/operation-coordinator');
const { buildPreflightReport } = require('./lib/preflight');
const { policy: eligibilityPolicy } = require('./lib/policy-engine');
const { isAllowedCanadaPostUrl, portalUrl } = require('./lib/origin-policy');
const i18n = require('./lib/i18n');
const runtimeWorkers = require('./lib/runtime-workers');
const { credentialMetadata: trackingCredentialMetadata, normalizeEnvironment: normalizeTrackingEnvironment, normalizeResourceTimeoutMs, TRACKING_API_VERSION, DEFAULT_RESOURCE_TIMEOUT_MS } = require('./lib/tracking-client');
const trackingDiagnosticGate = require('./lib/tracking-diagnostic-gate');
const { TRACKING_PARSER_VERSION } = require('./lib/tracking-json');
const { DEFAULT_DELAY_MS, normalizeDelayMs } = require('./lib/tracking-rate-limiter');
const { restorePreviousTextFiles, validatePromotedTrackingSummary, validateTrackingRunForSubmission } = require('./lib/tracking-run-staging');
const { rowsAsObjects } = require('./lib/csv');
const trackingDiagnosticSelection = require('./lib/tracking-diagnostic-selection');
const { publishBrowserTarget, targetIdentityHash } = require('./lib/step3-browser-handshake');
const { calculateBrowserDisplay, boundsIntersectContent } = require('./lib/browser-visibility');
const { createFocusedRegistrar } = require('./main/ipc');
const { validateWorkerEvent } = require('./lib/ipc-contracts');
const supportBundle = require('./lib/support-bundle');
const { resolveOwnedRegularFile } = require('./lib/path-confinement');
const registerIpcHandler = createFocusedRegistrar(ipcMain);

const { ROOT, DATA_DIR, LOG_DIR, USER_DATA_ROOT } = storage;
const USER_DATA_PROFILE = userDataBootstrap.getState();
if (!USER_DATA_PROFILE.initialized) throw new Error('userData bootstrap must complete before main.js is loaded.');
const DB_PATH = claimDb.databasePathFor(USER_DATA_ROOT);
const DATABASE_BACKUP_DIR = path.join(USER_DATA_ROOT, 'database-backups');
const BACKUP_RESTORE_TEMP_DIR = path.join(USER_DATA_ROOT, 'tmp', 'backup-restore');
const STOP_FILE = path.join(DATA_DIR, 'stop-requested.txt');
const DUPLICATE_CLAIM_FIX_VERSION = 'duplicate-claim-fix-v3';
const HISTORY_IMPORT_VERSION = 'shipping-history-import-v6-auto-discover-mobo';
const EST_HISTORY_EXPORT_VERSION = 'est-history-export-v10-parser-v5-live-blocks';
const STEP_TABS_VERSION = 'user-settings-v17';
const APP_VERSION = app.getVersion();
const DEFAULT_TRACKING_REQUEST_INTERVAL_MS = DEFAULT_DELAY_MS;
const BUILTIN_BROWSER_CDP_PORT = String(process.env.CANADAPOST_ELECTRON_CDP_PORT || crypto.randomInt(20000, 48000));
const BUILTIN_BROWSER_CDP_URL = `http://127.0.0.1:${BUILTIN_BROWSER_CDP_PORT}`;
const BUILTIN_BROWSER_MARKER_URL = 'about:blank#canadapost-claim-runner-step3-target';
const CANADAPOST_LOGIN_URL = portalUrl('https://www.canadapost-postescanada.ca/lfe-cap/en/login?stepupId=smb_mode1,consumer,commercial_link,smb_link&sourceUrl=https:%2F%2Fwww.canadapost-postescanada.ca%2Fdash%2Fen&targetUrl=https:%2F%2Fwww.canadapost-postescanada.ca%2Fdash%2Fen&authlvl=&language=en', '/login');

function setupReadiness(saved, trackingApiEnvironment) {
  const browserAvailable = typeof WebContentsView === 'function'
    && fs.existsSync(path.join(workerResourceRoot(), 'node_modules', 'playwright-core'));
  return {
    dataDirectory: applicationStorageWritable(),
    secureStorage: storage.credentialBackend() !== 'unavailable',
    accountFields: Boolean(saved.webUsername),
    apiCredentials: storage.trackingApiCredentialsStored(),
    apiDiagnostic: trackingDiagnosticGateSatisfied(saved, trackingApiEnvironment),
    customerNumber: Boolean(saved.estCustomerNumber),
    senderInformation: Boolean(saved.claimStreetNumber && saved.claimStreetName && saved.claimPostalCode),
    contactInformation: Boolean(saved.claimContactName && (saved.claimContactEmail || saved.claimContactPhone)),
    browserAvailable,
    databaseHealth: claimDb.integrityCheck(DB_PATH).ok,
    policyAvailable: Boolean(eligibilityPolicy?.dataVersion),
    safetyAcknowledged: saved.setupSafetyAcknowledged === true,
    networkReadiness: 'not_tested',
    credentialsLiveTested: false
  };
}

function setupCompletionAllowed(readiness) {
  return [
    'dataDirectory', 'secureStorage', 'accountFields', 'apiCredentials', 'apiDiagnostic',
    'customerNumber', 'senderInformation', 'contactInformation', 'browserAvailable',
    'databaseHealth', 'policyAvailable', 'safetyAcknowledged'
  ].every(key => readiness[key] === true);
}

function workerRuntimeContext() {
  return {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: USER_DATA_ROOT,
    executablePath: process.execPath,
    appImagePath: process.env.APPIMAGE || '',
    isPackaged: app.isPackaged,
    platform: process.platform
  };
}

function resolveWorkerLaunch(workerName) {
  const resolution = runtimeWorkers.resolveWorkerLaunch(workerName, workerRuntimeContext());
  if (USER_DATA_PROFILE.active) userDataBootstrap.assertMutablePath(resolution.cwd, `${workerName} worker runtime directory`);
  return resolution;
}

function preflightWorkerLaunch(workerName) {
  try {
    return { ok: true, resolution: resolveWorkerLaunch(workerName) };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code || 'WORKER_PREFLIGHT_FAILED' };
  }
}

function workerResourceRoot() {
  return runtimeWorkers.deriveWorkerPaths('tracking', workerRuntimeContext()).resourceRoot;
}


function pruneOldFiles(directory, maxAgeDays, matcher = () => true) {
  if (!fs.existsSync(directory)) return;
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !matcher(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.rmSync(filePath, { force: true });
    } catch (_) {}
  }
}

// The integrated browser still requires CDP for the existing Playwright workflow.
// Use a randomized loopback-only port and never expose wildcard origins.
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port', BUILTIN_BROWSER_CDP_PORT);

let win;
let builtinBrowserView = null;
let builtinBrowserAttached = false;
let activeChild = null;
let activeStage = 'idle';
let builtinBrowserSessionHardened = false;
let builtinBrowserGeneration = 0;
let builtinBrowserTargetNonce = '';
let builtinBrowserTargetPublication = null;
let builtinBrowserDisplayState = Object.freeze({ visible: false, attached: false, reason: 'not-created', appliedBounds: { x: 0, y: 0, width: 0, height: 0 } });
const pendingBrowserVisibilityRequests = new Map();
let activeBrowserVisibilityFile = '';
let isShuttingDown = false;
let databaseReady = false;
let startupFailureHandled = false;
let activeStep3DiagnosticsDir = '';
let latestStep3DiagnosticsDir = '';
let lastBrowserBoundsDiagnosticAt = 0;
let pendingRestorePath = '';
let updateRecovery = Object.freeze({ pending: false });


function sanitizeDiagnosticUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  } catch (_) {
    return String(value || '').split(/[?#]/, 1)[0].slice(0, 500);
  }
}

function appendStep3ElectronDiagnostic(type, details = {}) {
  const directory = activeStep3DiagnosticsDir || latestStep3DiagnosticsDir;
  if (!directory) return;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const cleanDetails = {};
    for (const [key, value] of Object.entries(details || {})) {
      if (/url|uri|href/i.test(key)) cleanDetails[key] = sanitizeDiagnosticUrl(value);
      else if (/password|cookie|token|authorization|credential/i.test(key)) cleanDetails[key] = value ? '[REDACTED]' : '';
      else cleanDetails[key] = typeof value === 'string' ? value.slice(0, 2000) : value;
    }
    const event = {
      at: new Date().toISOString(),
      source: 'electron-main',
      type: String(type || 'event'),
      stage: activeStage,
      details: cleanDetails
    };
    const filePath = path.join(directory, 'electron-browser.jsonl');
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
  } catch (_) {}
}

function latestStep3RunDirectory() {
  const root = path.join(LOG_DIR, 'step3-runs');
  if (!fs.existsSync(root)) return '';
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({ path: path.join(root, entry.name), mtime: fs.statSync(path.join(root, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0]?.path || '';
}

function sendStopSignalToChild(child, { force = false } = {}) {
  if (!child || child.exitCode !== null || child.signalCode) return false;
  appendStep3ElectronDiagnostic('child-stop-signal', { pid: child.pid, force });
  try {
    if (process.platform === 'win32') {
      const args = ['/pid', String(child.pid), '/T'];
      if (force) args.push('/F');
      spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).unref();
    } else {
      // Child processes are launched in their own process group so Playwright
      // descendants cannot survive a force stop or app shutdown.
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    }
    return true;
  } catch (_) {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
      return true;
    } catch (_) {
      return false;
    }
  }
}

function stopActiveChildForShutdown() {
  if (!activeChild) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STOP_FILE, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch (_) {}
  const child = activeChild;
  sendStopSignalToChild(child, { force: false });
  const timer = setTimeout(() => sendStopSignalToChild(child, { force: true }), 2500);
  if (typeof timer.unref === 'function') timer.unref();
}

function destroyBuiltinBrowserView() {
  if (!builtinBrowserView) return;
  const identityHash = builtinBrowserTargetPublication?.webContentsIdentityHash
    || targetIdentityHash(`${builtinBrowserView.webContents?.id || ''}:${builtinBrowserTargetNonce}`);
  appendStep3ElectronDiagnostic('browser-target-destroyed', { webContentsIdentityHash: identityHash, generation: builtinBrowserGeneration });
  try {
    if (win && !win.isDestroyed() && childViewIndex(builtinBrowserView) >= 0) win.contentView.removeChildView(builtinBrowserView);
  } catch (_) {}
  try {
    if (!builtinBrowserView.webContents.isDestroyed()) builtinBrowserView.webContents.close({ waitForBeforeUnload: false });
  } catch (_) {
    try { builtinBrowserView.webContents.destroy(); } catch (_) {}
  }
  builtinBrowserView = null;
  builtinBrowserAttached = false;
  builtinBrowserTargetNonce = '';
  builtinBrowserTargetPublication = null;
  builtinBrowserDisplayState = Object.freeze({ visible: false, attached: false, reason: 'destroyed', appliedBounds: { x: 0, y: 0, width: 0, height: 0 } });
  emitBrowserDisplayState(browserDisplaySnapshot());
}


function ensureDirs() {
  storage.ensureDirs();
  const config = storage.readConfig();
  const retentionDays = Math.max(7, Math.min(3650, Number(config.evidenceRetentionDays || 90)));
  pruneOldFiles(LOG_DIR, 30, name => name.endsWith('.log'));
  pruneStep3DiagnosticRuns(path.join(LOG_DIR, 'step3-runs'), { maxAgeDays: 30, maxRuns: 20 });
  pruneOldFiles(DATA_DIR, retentionDays, name => /^claim-(?:error|already-submitted|submitted|captcha|dry-run)-row-.*\.(?:png|txt)$/i.test(name));
}

function createWindow() {
  if (!databaseReady) throw new Error('The workflow window cannot open before the database is ready.');
  ensureDirs();

  // Remove Electron's native menu bar. On Linux/GTK themes the native menu
  // popup can render with a compositor blur/halo over the app; this app does
  // not need File/Edit/View/Window menus, so disabling it gives a cleaner UI.
  Menu.setApplicationMenu(null);

  win = new BrowserWindow({
    title: USER_DATA_PROFILE.active
      ? 'Canada Post Claim Runner [ISOLATED TEST DATA]'
      : 'Canada Post Claim Runner',
    width: 1160,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  win.setMenu(null);
  win.setMenuBarVisibility(false);
  // The renderer is never allowed to open an arbitrary URL. Purpose-specific
  // main-process handlers own any external navigation and validate its target.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  const requestDisplayRefresh = reason => {
    if (!builtinBrowserView) return;
    requestBuiltinBrowserVisibility({ reason, requireVisible: false }).catch(() => {});
  };
  win.on('resize', () => requestDisplayRefresh('window-resize'));
  win.on('maximize', () => requestDisplayRefresh('window-maximize'));
  win.on('unmaximize', () => requestDisplayRefresh('window-unmaximize'));
  win.on('move', () => requestDisplayRefresh('window-move'));
  win.on('close', event => {
    const operation = operationCoordinator.blockingOperation();
    if (!operation) return;
    event.preventDefault();
    const bundle = i18n.loadLocale(readConfig().locale || 'en-CA');
    dialog.showMessageBox(win, {
      type: 'warning',
      title: i18n.translate(bundle, 'update.blocked.title', 'Close blocked'),
      message: i18n.interpolate(i18n.translate(bundle, 'update.exitBlocked.message', 'The application cannot close while {operation} is active.'), { operation }),
      buttons: [i18n.translate(bundle, 'action.continue', 'Continue')],
      noLink: true
    }).catch(() => {});
  });
  win.on('closed', () => {
    stopActiveChildForShutdown();
    destroyBuiltinBrowserView();
    win = null;
  });
  win.loadFile('index.html');
}

function emit(channel, payload = {}) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function emitBuiltinBrowserActivity(active, text, kind = '') {
  emit('browser:activity', { active: Boolean(active), text: String(text || ''), kind: String(kind || '') });
}

function normalizeBounds(bounds = {}) {
  // Keep x/y signed so a WebContentsView can move partially outside the window
  // while its DOM slot is being scrolled. Electron clips the off-screen portion.
  const x = Math.round(Number(bounds.x) || 0);
  const y = Math.round(Number(bounds.y) || 0);
  const width = Math.max(0, Math.round(Number(bounds.width) || 0));
  const height = Math.max(0, Math.round(Number(bounds.height) || 0));
  return { x, y, width, height };
}

function browserContentBounds() {
  if (!win || win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
  const bounds = win.getContentBounds();
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function childViewIndex(view = builtinBrowserView) {
  const children = win?.contentView?.children;
  return Array.isArray(children) && view ? children.indexOf(view) : -1;
}

function browserDisplaySnapshot(overrides = {}) {
  const bounds = builtinBrowserView && !builtinBrowserView.webContents.isDestroyed()
    ? normalizeBounds(builtinBrowserView.getBounds())
    : { x: 0, y: 0, width: 0, height: 0 };
  return {
    ok: true,
    created: Boolean(builtinBrowserView),
    destroyed: Boolean(builtinBrowserView?.webContents?.isDestroyed()),
    attached: builtinBrowserAttached,
    visible: Boolean(builtinBrowserDisplayState.visible),
    reason: builtinBrowserDisplayState.reason || 'unknown',
    bounds,
    childViewIndex: childViewIndex(),
    targetAttached: Boolean(builtinBrowserTargetPublication),
    webContentsIdentityHash: builtinBrowserTargetPublication?.webContentsIdentityHash || '',
    targetIdHash: builtinBrowserTargetPublication?.targetIdHash || '',
    currentUrl: builtinBrowserView?.webContents && !builtinBrowserView.webContents.isDestroyed()
      ? builtinBrowserView.webContents.getURL()
      : '',
    ...overrides
  };
}

function emitBrowserDisplayState(state = browserDisplaySnapshot()) {
  emit('browser:display-state', state);
  return state;
}

function browserVisibilityWatchdog() {
  const contentBounds = browserContentBounds();
  const snapshot = browserDisplaySnapshot();
  const positiveBounds = snapshot.bounds.width > 0 && snapshot.bounds.height > 0;
  const intersectsContent = positiveBounds && boundsIntersectContent(snapshot.bounds, contentBounds, 1);
  const ready = Boolean(snapshot.created && !snapshot.destroyed && snapshot.attached && snapshot.visible && positiveBounds && intersectsContent);
  const result = { ...snapshot, ready, positiveBounds, intersectsContent, contentBounds };
  if (!ready) {
    appendStep3ElectronDiagnostic('browser-visibility-watchdog-failed', {
      reason: snapshot.reason,
      attached: snapshot.attached,
      visible: snapshot.visible,
      positiveBounds,
      intersectsContent,
      appliedBounds: snapshot.bounds,
      contentBounds,
      targetAttached: snapshot.targetAttached,
      currentUrl: snapshot.currentUrl
    });
  }
  return result;
}

function writeBrowserVisibilityAcknowledgement(requestId, result) {
  if (!activeBrowserVisibilityFile || !requestId) return;
  const payload = {
    version: 1,
    requestId: String(requestId),
    visible: Boolean(result?.ready),
    errorCode: result?.ready ? '' : 'BROWSER_VISIBILITY_REQUIRED',
    reason: String(result?.reason || ''),
    webContentsIdentityHash: String(result?.webContentsIdentityHash || ''),
    updatedAt: new Date().toISOString()
  };
  const temporary = `${activeBrowserVisibilityFile}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, activeBrowserVisibilityFile);
    try { fs.chmodSync(activeBrowserVisibilityFile, 0o600); } catch (_) {}
  } catch (_) {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function isBuiltinMarkerUrl(value) {
  return String(value || '').startsWith('about:blank');
}

function isAllowedBuiltinBrowserUrl(value) {
  return isBuiltinMarkerUrl(value) || isAllowedCanadaPostUrl(value);
}

function isLoadedCanadaPostUrl(value) {
  return !isBuiltinMarkerUrl(value) && isAllowedCanadaPostUrl(value);
}

async function markBuiltinBrowserTarget(view = builtinBrowserView) {
  if (!view) throw Object.assign(new Error('The Step 3 browser view was not created.'), { code: 'BROWSER_VIEW_NOT_CREATED' });
  if (view.webContents.isDestroyed()) throw Object.assign(new Error('The Step 3 browser webContents was destroyed.'), { code: 'BROWSER_WEBCONTENTS_DESTROYED' });
  await view.webContents.executeJavaScript(`window.name = ${JSON.stringify(builtinBrowserTargetNonce)}; window.name`, true);
  const marker = await view.webContents.executeJavaScript('window.name', true);
  if (marker !== builtinBrowserTargetNonce) throw Object.assign(new Error('The Step 3 target marker could not be published.'), { code: 'TARGET_NOT_PUBLISHED' });
}

async function styleBuiltinBrowserMarker(view = builtinBrowserView) {
  if (!view || view.webContents.isDestroyed() || !isBuiltinMarkerUrl(view.webContents.getURL())) return;
  await view.webContents.executeJavaScript(`(() => {
    document.documentElement.style.background = '#07101f';
    if (document.body) {
      document.body.replaceChildren();
      document.body.style.margin = '0';
      document.body.style.background = '#07101f';
    }
  })()`, true);
}

function ensureBuiltinBrowserView() {
  if (!win || win.isDestroyed()) throw new Error('Main window is not available.');
  if (builtinBrowserView && !builtinBrowserView.webContents.isDestroyed()) return builtinBrowserView;

  appendStep3ElectronDiagnostic('browser-view-creation-requested', { debuggingPort: Number(BUILTIN_BROWSER_CDP_PORT) });
  builtinBrowserGeneration += 1;
  builtinBrowserTargetNonce = crypto.randomUUID();
  builtinBrowserTargetPublication = null;
  builtinBrowserView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      partition: 'persist:canadapost-claims-builtin'
    }
  });
  const createdWebContentsId = builtinBrowserView.webContents.id;
  const createdIdentityHash = targetIdentityHash(`${createdWebContentsId}:${builtinBrowserTargetNonce}`);
  appendStep3ElectronDiagnostic('browser-view-created', {
    generation: builtinBrowserGeneration,
    webContentsId: createdWebContentsId,
    webContentsIdentityHash: createdIdentityHash,
    partition: 'persist:canadapost-claims-builtin'
  });

  const browserSession = builtinBrowserView.webContents.session;
  if (!builtinBrowserSessionHardened) {
    builtinBrowserSessionHardened = true;
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    if (typeof browserSession.setPermissionCheckHandler === 'function') {
      browserSession.setPermissionCheckHandler(() => false);
    }
    browserSession.on('will-download', (event, _item, webContents) => {
      if (!builtinBrowserView || webContents?.id !== builtinBrowserView.webContents.id) return;
      event.preventDefault();
      appendStep3ElectronDiagnostic('download-blocked', { webContentsId: webContents?.id });
      emit('event', { stage: 'submit', event: { type: 'log', messageKey: 'event.browser.downloadBlocked', message: 'Blocked an unexpected download from the built-in browser.' } });
    });
  }

  builtinBrowserView.webContents.on('will-attach-webview', event => {
    event.preventDefault();
    appendStep3ElectronDiagnostic('webview-attachment-blocked');
  });

  builtinBrowserView.webContents.setWindowOpenHandler(({ url }) => {
    appendStep3ElectronDiagnostic('new-window-request', { url, allowed: isAllowedCanadaPostUrl(url) });
    if (isAllowedCanadaPostUrl(url)) builtinBrowserView.webContents.loadURL(url).catch(() => {});
    else emit('event', { stage: 'submit', event: { type: 'error', messageKey: 'event.browser.navigationBlocked', message: 'Blocked built-in browser navigation outside Canada Post.' } });
    return { action: 'deny' };
  });
  builtinBrowserView.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedBuiltinBrowserUrl(url)) {
      event.preventDefault();
      appendStep3ElectronDiagnostic('navigation-blocked', { url });
      emit('event', { stage: 'submit', event: { type: 'error', messageKey: 'event.browser.navigationBlocked', message: 'Blocked built-in browser navigation outside Canada Post.' } });
    }
  });

  builtinBrowserView.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    appendStep3ElectronDiagnostic('did-start-navigation', { url, isInPlace, isMainFrame });
    if (isMainFrame && isLoadedCanadaPostUrl(url)) {
      emitBuiltinBrowserActivity(true, 'Opening Canada Post…');
      requestBuiltinBrowserVisibility({ reason: 'navigation-start', requireVisible: false }).catch(() => {});
    }
  });

  builtinBrowserView.webContents.on('did-start-loading', () => {
    const url = builtinBrowserView?.webContents.getURL();
    appendStep3ElectronDiagnostic('did-start-loading', { url });
    if (isLoadedCanadaPostUrl(url)) emitBuiltinBrowserActivity(true, 'Opening Canada Post…');
  });

  builtinBrowserView.webContents.on('dom-ready', () => {
    const url = builtinBrowserView?.webContents.getURL();
    appendStep3ElectronDiagnostic('dom-ready', { url });
    markBuiltinBrowserTarget().catch(error => appendStep3ElectronDiagnostic('browser-target-marker-failed', { code: error.code || 'TARGET_NOT_PUBLISHED' }));
    if (isLoadedCanadaPostUrl(url)) {
      emitBuiltinBrowserActivity(true, 'Rendering Canada Post page…');
      requestBuiltinBrowserVisibility({ reason: 'navigation-dom-ready', requireVisible: false }).catch(() => {});
    }
  });

  builtinBrowserView.webContents.on('did-stop-loading', () => {
    const url = builtinBrowserView?.webContents.getURL();
    appendStep3ElectronDiagnostic('did-stop-loading', { url });
    if (isLoadedCanadaPostUrl(url)) emitBuiltinBrowserActivity(false, 'Canada Post loaded');
  });

  builtinBrowserView.webContents.on('did-finish-load', () => {
    const url = builtinBrowserView?.webContents.getURL();
    appendStep3ElectronDiagnostic('did-finish-load', { url });
    if (isLoadedCanadaPostUrl(url)) {
      emitBuiltinBrowserActivity(false, 'Canada Post loaded');
      requestBuiltinBrowserVisibility({ reason: 'navigation-ready', requireVisible: false }).catch(() => {});
    }
  });

  builtinBrowserView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (!isMainFrame || Number(errorCode) === -3) return;
    appendStep3ElectronDiagnostic('did-fail-load', { errorCode, errorDescription, validatedUrl: _validatedUrl, isMainFrame });
    emitBuiltinBrowserActivity(false, `Browser load warning: ${errorDescription}`, 'error');
    emit('event', { stage: 'submit', event: { type: 'log', messageKey: 'event.browser.loadWarning', messageValues: { code: errorCode, description: errorDescription }, message: `Built-in browser load warning: ${errorCode} ${errorDescription}` } });
  });

  builtinBrowserView.webContents.on('unresponsive', () => {
    appendStep3ElectronDiagnostic('unresponsive', { url: builtinBrowserView?.webContents.getURL() });
    emitBuiltinBrowserActivity(false, 'Canada Post browser is not responding', 'error');
    emit('event', { stage: 'submit', event: { type: 'error', messageKey: 'event.browser.unresponsive', message: 'The built-in Canada Post browser became unresponsive.' } });
  });

  builtinBrowserView.webContents.on('responsive', () => {
    appendStep3ElectronDiagnostic('responsive', { url: builtinBrowserView?.webContents.getURL() });
    emitBuiltinBrowserActivity(false, 'Canada Post browser recovered');
  });

  builtinBrowserView.webContents.on('render-process-gone', (_event, details = {}) => {
    appendStep3ElectronDiagnostic('render-process-gone', details);
    emitBuiltinBrowserActivity(false, 'Canada Post browser process stopped', 'error');
    emit('event', { stage: 'submit', event: { type: 'error', messageKey: 'event.browser.processStopped', messageValues: { reason: details.reason || 'unknown' }, message: `The built-in Canada Post browser process stopped (${details.reason || 'unknown reason'}). Any active claim will require reconciliation.` } });
  });

  builtinBrowserView.webContents.once('destroyed', () => {
    appendStep3ElectronDiagnostic('browser-target-closed', {
      generation: builtinBrowserGeneration,
      webContentsIdentityHash: createdIdentityHash,
      activeWorker: Boolean(activeChild)
    });
    builtinBrowserTargetPublication = null;
    if (activeChild && activeStage === 'submit') sendStopSignalToChild(activeChild, { force: false });
  });

  return builtinBrowserView;
}

async function prepareBuiltinBrowserForWorker(options = {}) {
  appendStep3ElectronDiagnostic('worker-browser-handshake-started', {
    reason: String(options.reason || 'submission'),
    debuggingPort: Number(BUILTIN_BROWSER_CDP_PORT)
  });
  const view = ensureBuiltinBrowserView();
  if (view.webContents.isDestroyed()) throw Object.assign(new Error('The Step 3 browser webContents was destroyed before readiness.'), { code: 'BROWSER_WEBCONTENTS_DESTROYED' });
  const currentUrl = view.webContents.getURL();
  if (!currentUrl || !isAllowedBuiltinBrowserUrl(currentUrl)) {
    await view.webContents.loadURL(BUILTIN_BROWSER_MARKER_URL);
  }
  await markBuiltinBrowserTarget(view);
  await styleBuiltinBrowserMarker(view);
  let publication = await publishBrowserTarget({
    view,
    endpoint: BUILTIN_BROWSER_CDP_URL,
    nonce: builtinBrowserTargetNonce
  });
  if (builtinBrowserTargetPublication
      && builtinBrowserTargetPublication.webContentsId === publication.webContentsId
      && builtinBrowserTargetPublication.targetId !== publication.targetId) {
    builtinBrowserTargetNonce = crypto.randomUUID();
    await markBuiltinBrowserTarget(view);
    publication = await publishBrowserTarget({ view, endpoint: BUILTIN_BROWSER_CDP_URL, nonce: builtinBrowserTargetNonce });
  }
  builtinBrowserTargetPublication = publication;
  appendStep3ElectronDiagnostic('browser-target-identity-published', {
    generation: builtinBrowserGeneration,
    webContentsIdentityHash: publication.webContentsIdentityHash,
    targetIdHash: publication.targetIdHash,
    debuggingPort: Number(BUILTIN_BROWSER_CDP_PORT),
    endpointAttempts: publication.endpointAttempts
  });
  appendStep3ElectronDiagnostic('worker-browser-handshake-completed', {
    webContentsIdentityHash: publication.webContentsIdentityHash,
    targetIdHash: publication.targetIdHash
  });
  return publication;
}

function attachBuiltinBrowserView(reason = 'show') {
  const view = ensureBuiltinBrowserView();
  const children = win.contentView.children;
  const currentIndex = childViewIndex(view);
  builtinBrowserAttached = currentIndex >= 0;
  const needsRaise = builtinBrowserAttached && Array.isArray(children) && currentIndex !== children.length - 1;
  if (needsRaise) {
    // Remove/add raises the native child above the main renderer without
    // touching its webContents or deterministic CDP identity.
    try { win.contentView.removeChildView(view); } catch (_) {}
    builtinBrowserAttached = false;
  }
  if (!builtinBrowserAttached) {
    win.contentView.addChildView(view);
    builtinBrowserAttached = true;
    appendStep3ElectronDiagnostic('browser-child-view-attached', {
      reason,
      childViewIndex: childViewIndex(view),
      childViewCount: Array.isArray(win.contentView.children) ? win.contentView.children.length : null
    });
  }
  if (typeof view.setVisible === 'function') view.setVisible(true);
  return view;
}

function hideBuiltinBrowserView(reason = 'hidden') {
  if (!win || win.isDestroyed() || !builtinBrowserView) return;
  if (typeof builtinBrowserView.setVisible === 'function') builtinBrowserView.setVisible(false);
  const previousIndex = childViewIndex();
  try {
    if (previousIndex >= 0) win.contentView.removeChildView(builtinBrowserView);
  } catch (_) {}
  builtinBrowserAttached = false;
  builtinBrowserDisplayState = Object.freeze({
    ...builtinBrowserDisplayState,
    visible: false,
    attached: false,
    reason,
    appliedBounds: { x: 0, y: 0, width: 0, height: 0 }
  });
  appendStep3ElectronDiagnostic('browser-child-view-detached', {
    reason,
    previousChildViewIndex: previousIndex,
    targetAttached: Boolean(builtinBrowserTargetPublication)
  });
  emitBrowserDisplayState(browserDisplaySnapshot());
}

function setBuiltinBrowserBounds(bounds, reason = 'bounds-sync') {
  const view = attachBuiltinBrowserView(reason);
  const normalized = normalizeBounds(bounds);
  if (normalized.width < 1 || normalized.height < 1) {
    const error = new Error('The built-in browser cannot use empty native bounds.');
    error.code = 'BROWSER_VISIBILITY_REQUIRED';
    throw error;
  }
  view.setBounds(normalized);
  if (typeof view.setVisible === 'function') view.setVisible(true);
  builtinBrowserDisplayState = Object.freeze({
    ...builtinBrowserDisplayState,
    visible: true,
    attached: true,
    reason,
    appliedBounds: normalized
  });
  if (Date.now() - lastBrowserBoundsDiagnosticAt >= 1000) {
    lastBrowserBoundsDiagnosticAt = Date.now();
    appendStep3ElectronDiagnostic('browser-view-bounds', {
      ...normalized,
      reason,
      childViewIndex: childViewIndex(view),
      contentBounds: browserContentBounds(),
      targetAttached: Boolean(builtinBrowserTargetPublication),
      currentUrl: view.webContents.getURL()
    });
  }
  return browserDisplaySnapshot();
}

function applyBuiltinBrowserVisibility(payload = {}) {
  const contentBounds = browserContentBounds();
  const calculated = calculateBrowserDisplay(payload, contentBounds);
  appendStep3ElectronDiagnostic('browser-visibility-measurement', {
    requestId: String(payload.requestId || ''),
    reason: String(payload.reason || 'renderer-sync'),
    step3Active: Boolean(payload.step3Active),
    placeholderVisible: Boolean(payload.placeholderVisible),
    rawDomRect: calculated.rawDomRect,
    rendererViewport: calculated.rendererViewport,
    contentBounds,
    visibleIntersection: calculated.visibleIntersection,
    displayable: calculated.displayable,
    targetAttached: Boolean(builtinBrowserTargetPublication),
    currentUrl: builtinBrowserView?.webContents?.getURL?.() || ''
  });
  if (!calculated.displayable) {
    hideBuiltinBrowserView(calculated.reason);
    const state = browserDisplaySnapshot({
      displayable: false,
      reason: calculated.reason,
      rawDomRect: calculated.rawDomRect,
      visibleIntersection: calculated.visibleIntersection
    });
    builtinBrowserDisplayState = Object.freeze({ ...builtinBrowserDisplayState, ...state });
    return emitBrowserDisplayState(state);
  }
  if (!builtinBrowserView || builtinBrowserView.webContents.isDestroyed()) {
    builtinBrowserDisplayState = Object.freeze({
      visible: false,
      attached: false,
      reason: 'browser-preparing',
      appliedBounds: calculated.appliedBounds
    });
    return emitBrowserDisplayState(browserDisplaySnapshot({
      displayable: false,
      reason: 'browser-preparing',
      rawDomRect: calculated.rawDomRect,
      visibleIntersection: calculated.visibleIntersection
    }));
  }
  setBuiltinBrowserBounds(calculated.appliedBounds, String(payload.reason || 'renderer-sync'));
  const state = browserDisplaySnapshot({
    displayable: true,
    reason: 'visible',
    rawDomRect: calculated.rawDomRect,
    visibleIntersection: calculated.visibleIntersection
  });
  builtinBrowserDisplayState = Object.freeze({ ...builtinBrowserDisplayState, ...state });
  appendStep3ElectronDiagnostic('browser-view-visible', {
    reason: String(payload.reason || 'renderer-sync'),
    appliedBounds: state.bounds,
    childViewIndex: state.childViewIndex,
    targetAttached: state.targetAttached,
    currentUrl: state.currentUrl
  });
  return emitBrowserDisplayState(state);
}

function requestBuiltinBrowserVisibility(options = {}) {
  if (!win || win.isDestroyed()) return Promise.reject(Object.assign(new Error('The application window is unavailable for browser visibility synchronization.'), { code: 'BROWSER_DISPLAY_UNAVAILABLE' }));
  const requestId = crypto.randomUUID();
  const timeoutMs = Math.max(500, Number(options.timeoutMs || 5000));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBrowserVisibilityRequests.delete(requestId);
      const error = new Error('The Step 3 browser slot did not report display bounds in time.');
      error.code = 'BROWSER_VISIBILITY_SYNC_TIMEOUT';
      appendStep3ElectronDiagnostic('browser-visibility-watchdog-failed', { requestId, reason: error.code });
      reject(error);
    }, timeoutMs);
    pendingBrowserVisibilityRequests.set(requestId, { resolve, reject, timer, requireVisible: Boolean(options.requireVisible) });
    appendStep3ElectronDiagnostic('browser-visibility-sync-requested', {
      requestId,
      reason: String(options.reason || 'main-request'),
      requireVisible: Boolean(options.requireVisible),
      scrollIntoView: Boolean(options.scrollIntoView)
    });
    emit('browser:visibility-request', {
      requestId,
      reason: String(options.reason || 'main-request'),
      requireVisible: Boolean(options.requireVisible),
      scrollIntoView: Boolean(options.scrollIntoView)
    });
  });
}

async function handleManualBrowserVisibilityRequest(event = {}) {
  const requestId = String(event.requestId || '');
  appendStep3ElectronDiagnostic('manual-verification-detected', {
    requestId,
    kind: String(event.kind || 'verification'),
    targetAttached: Boolean(builtinBrowserTargetPublication),
    currentUrl: builtinBrowserView?.webContents?.getURL?.() || ''
  });
  try {
    await requestBuiltinBrowserVisibility({
      reason: 'manual-verification-required',
      requireVisible: true,
      scrollIntoView: true,
      timeoutMs: 6000
    });
    const watchdog = browserVisibilityWatchdog();
    if (!watchdog.ready) {
      const error = new Error('Manual verification was detected, but the built-in browser could not be displayed safely.');
      error.code = 'BROWSER_VISIBILITY_REQUIRED';
      throw error;
    }
    writeBrowserVisibilityAcknowledgement(requestId, watchdog);
    appendStep3ElectronDiagnostic('verification-browser-display-ready', {
      requestId,
      appliedBounds: watchdog.bounds,
      childViewIndex: watchdog.childViewIndex,
      placeholderVisible: false,
      webContentsIdentityHash: watchdog.webContentsIdentityHash,
      currentUrl: watchdog.currentUrl
    });
    emitBuiltinBrowserActivity(false, 'Manual verification required');
  } catch (error) {
    const failed = { ...browserVisibilityWatchdog(), ready: false, reason: error.code || 'BROWSER_VISIBILITY_REQUIRED' };
    writeBrowserVisibilityAcknowledgement(requestId, failed);
    appendStep3ElectronDiagnostic('verification-browser-display-failed', {
      requestId,
      code: error.code || 'BROWSER_VISIBILITY_REQUIRED',
      message: error.message
    });
    emit('event', { stage: 'submit', event: {
      type: 'manual_verification_display_failed',
      code: error.code || 'BROWSER_VISIBILITY_REQUIRED',
      messageKey: 'event.browser.manualDisplayFailed',
      message: 'Manual verification was detected, but the built-in browser could not be displayed. Step 3 stopped safely.'
    } });
    const child = activeChild;
    if (child && activeStage === 'submit') {
      const timer = setTimeout(() => {
        if (activeChild === child && activeStage === 'submit') sendStopSignalToChild(child, { force: false });
      }, 3000);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }
}

async function showBuiltinBrowser(bounds) {
  const view = ensureBuiltinBrowserView();
  setBuiltinBrowserBounds(bounds, 'browser-show');
  const currentUrl = view.webContents.getURL();
  appendStep3ElectronDiagnostic('browser-view-show', { currentUrl, bounds });
  if (!currentUrl || currentUrl === 'about:blank' || !isAllowedCanadaPostUrl(currentUrl)) {
    emitBuiltinBrowserActivity(true, 'Opening Canada Post login…');
    await view.webContents.loadURL(CANADAPOST_LOGIN_URL);
  }
  await markBuiltinBrowserTarget(view);
  const publication = builtinBrowserTargetPublication || await prepareBuiltinBrowserForWorker({ reason: 'browser-show' });
  return {
    ok: true,
    cdpUrl: publication.endpoint,
    webContentsId: view.webContents.id,
    webContentsIdentityHash: publication.webContentsIdentityHash,
    targetIdHash: publication.targetIdHash
  };
}

function focusBuiltinBrowser() {
  if (!win || win.isDestroyed() || !builtinBrowserView || builtinBrowserView.webContents.isDestroyed()) return false;
  try {
    attachBuiltinBrowserView('browser-focus');
    win.focus();
    builtinBrowserView.webContents.focus();
    return true;
  } catch (_) {
    return false;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readConfig() {
  return storage.readConfig();
}

function writeConfig(config) {
  storage.writeConfig(config);
}


function resolveWebCredentials(options = {}, config = {}) {
  const optionUsername = Object.prototype.hasOwnProperty.call(options, 'webUsername')
    ? String(options.webUsername || '').trim()
    : '';
  const username = optionUsername || String(config.webUsername || '').trim();
  const optionPassword = Object.prototype.hasOwnProperty.call(options, 'webPassword')
    ? String(options.webPassword || '')
    : '';
  const password = optionPassword || storage.loadPassword();
  return { username, password };
}

function persistPasswordFromOptions(options = {}, config = {}) {
  const rememberSettings = Object.prototype.hasOwnProperty.call(options, 'rememberSettings')
    ? boolFromOption(options.rememberSettings)
    : boolFromOption(config.rememberSettings);
  const password = Object.prototype.hasOwnProperty.call(options, 'webPassword')
    ? String(options.webPassword || '')
    : '';
  return storage.savePassword(password, rememberSettings);
}

function parseSimpleIni(filePath) {
  const result = {};
  if (!filePath || !fs.existsSync(filePath)) return result;

  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    result[key] = value;
  }

  return result;
}

function readUserIniPublicFields() {
  const userIniRoot = path.join(ROOT, 'user.ini');
  const userIniData = path.join(DATA_DIR, 'user.ini');
  const parsed = fs.existsSync(userIniData)
    ? parseSimpleIni(userIniData)
    : parseSimpleIni(userIniRoot);

  return {
    mobo: parsed.mobo || parsed.mailedOnBehalfOf || parsed.mailed_on_behalf_of || ''
  };
}

function normalizeLegacyEnvironment(value = 'production') {
  const environment = String(value || 'production').trim().toLowerCase();
  if (!['production', 'development'].includes(environment)) throw new Error('Legacy API environment must be production or development.');
  return environment;
}

function resolveApiCredentials(selectedEnvironment = 'production') {
  normalizeLegacyEnvironment(selectedEnvironment);
  const stored = storage.loadApiCredentials();
  if (stored.username && stored.password) return {
    ...stored,
    environment: storage.apiCredentialEnvironment() || '',
    usernameSource: 'encrypted Developer Program API username',
    passwordSource: 'encrypted Developer Program API password'
  };

  for (const filePath of [path.join(DATA_DIR, 'user.ini'), path.join(ROOT, 'user.ini')]) {
    const parsed = parseSimpleIni(filePath);
    const usernameKey = Object.prototype.hasOwnProperty.call(parsed, 'apiUsername') ? 'apiUsername' : 'username';
    const passwordKey = Object.prototype.hasOwnProperty.call(parsed, 'apiPassword') ? 'apiPassword' : 'password';
    const username = String(parsed[usernameKey] || '').trim();
    const password = String(parsed[passwordKey] || '').trim();
    if (username && password) return {
      username,
      password,
      environment: ['production', 'development'].includes(String(parsed.apiEnvironment || '').toLowerCase()) ? String(parsed.apiEnvironment).toLowerCase() : '',
      usernameSource: `Developer Program ${usernameKey} setting`,
      passwordSource: `Developer Program ${passwordKey} setting`
    };
  }
  return {
    username: '', password: '', environment: '',
    usernameSource: 'Developer Program API username',
    passwordSource: 'Developer Program API password'
  };
}

function ensureApiCredentialFiles(selectedEnvironment = 'production') {
  const userIniRoot = path.join(ROOT, 'user.ini');
  const userIniData = path.join(DATA_DIR, 'user.ini');
  if (!fs.existsSync(userIniData) && fs.existsSync(userIniRoot)) {
    fs.copyFileSync(userIniRoot, userIniData);
    storage.removeLegacyCustomerNumberLines(userIniData);
    try { fs.chmodSync(userIniData, 0o600); } catch (_) {}
  }

  const cacertRoot = path.join(workerResourceRoot(), 'cacert.pem');
  if (!fs.existsSync(cacertRoot)) {
    return { ok: false, error: `Missing bundled CA certificate at ${cacertRoot}.` };
  }
  const credentials = resolveApiCredentials(selectedEnvironment);
  if (!credentials.username || !credentials.password) {
    return {
      ok: false,
      error: `Missing Canada Post Developer API credentials. Copy user.ini into ${DATA_DIR}; on the next launch the secrets will be imported into OS-encrypted storage.`
    };
  }
  if (credentials.environment && credentials.environment !== normalizeLegacyEnvironment(selectedEnvironment)) {
    return {
      ok: false,
      error: `The selected legacy API credentials appear to belong to the ${credentials.environment} environment while the ${normalizeLegacyEnvironment(selectedEnvironment)} endpoint is selected.`
    };
  }
  return { ok: true, userIniPath: userIniData, cacertRoot, ...credentials };
}

function resolveTrackingApiCredentials(selectedEnvironment = 'test') {
  const environment = normalizeTrackingEnvironment(selectedEnvironment);
  const stored = storage.loadTrackingApiCredentials();
  return {
    ...stored,
    environment: storage.trackingApiCredentialEnvironment() || '',
    selectedEnvironment: environment
  };
}

function trackingApiCredentialStatus(selectedEnvironment = 'test') {
  return trackingCredentialMetadata(resolveTrackingApiCredentials(selectedEnvironment), selectedEnvironment);
}

function ensureTrackingApiCredentials(selectedEnvironment = 'test') {
  const environment = normalizeTrackingEnvironment(selectedEnvironment);
  const credentials = resolveTrackingApiCredentials(environment);
  if (!credentials.clientId || !credentials.clientSecret) {
    return { ok: false, error: 'Missing Tracking API 2.0 client ID or client secret. Create a Developer Portal app with Tracking product access and save its API Key and API Secret.' };
  }
  if (credentials.environment && credentials.environment !== environment) {
    return { ok: false, error: `The saved Tracking API credentials are for ${credentials.environment}, but the ${environment} gateway is selected.` };
  }
  return { ok: true, ...credentials };
}

function trackingDiagnosticGateSatisfied(config = {}, environment = 'test') {
  return trackingDiagnosticGate.isSatisfied(config, environment, TRACKING_API_VERSION, TRACKING_PARSER_VERSION);
}

function invalidateTrackingDiagnosticGate(config = {}, { newRevision = false } = {}) {
  return trackingDiagnosticGate.invalidate(config, { newRevision });
}

function boolFromOption(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function pickOptionString(options, config, optionKey, configKey, fallback = '') {
  // Critical for MOBO auto-discovery: an explicitly blank UI field must stay blank.
  // Do not use || here because "" would incorrectly fall through to user.ini/config.
  if (Object.prototype.hasOwnProperty.call(options, optionKey)) {
    return String(options[optionKey] ?? '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(config, configKey)) {
    return String(config[configKey] ?? '').trim();
  }
  return String(fallback ?? '').trim();
}

function buildHistoryEnv(options = {}, config = {}) {
  const customerNumber = pickOptionString(options, config, 'estCustomerNumber', 'estCustomerNumber', '');
  const autoMobo = Object.prototype.hasOwnProperty.call(options, 'historyAutoMobo')
    ? boolFromOption(options.historyAutoMobo)
    : (Object.prototype.hasOwnProperty.call(config, 'historyAutoMobo') ? boolFromOption(config.historyAutoMobo) : true);
  // In auto mode, force blank MOBO so the PHP importer must run customer-info discovery.
  const mobo = autoMobo ? '' : pickOptionString(options, config, 'historyMobo', 'historyMobo', '');
  const developerMode = Object.prototype.hasOwnProperty.call(options, 'developerMode')
    ? boolFromOption(options.developerMode)
    : boolFromOption(config.developerMode);

  return {
    HISTORY_FROM: pickOptionString(options, config, 'historyFrom', 'historyFrom', ''),
    HISTORY_TO: pickOptionString(options, config, 'historyTo', 'historyTo', ''),
    HISTORY_CUSTOMER_NUMBER: customerNumber,
    HISTORY_AUTO_MOBO: autoMobo ? 'true' : 'false',
    HISTORY_MOBO: mobo,
    HISTORY_INCLUDE_NO_MANIFEST: options.historyIncludeNoManifest ? 'true' : 'false',
    CANADAPOST_REST_HOST: 'soa-gw.canadapost.ca',
    DEVELOPER_MODE: developerMode ? 'true' : 'false'
  };
}


function buildEstHistoryEnv(options = {}, config = {}) {
  const developerMode = Object.prototype.hasOwnProperty.call(options, 'developerMode')
    ? boolFromOption(options.developerMode)
    : boolFromOption(config.developerMode);

  return {
    EST_FROM: pickOptionString(options, config, 'estFrom', 'estFrom', config.historyFrom || ''),
    EST_TO: pickOptionString(options, config, 'estTo', 'estTo', config.historyTo || ''),
    EST_CUSTOMER_NUMBER: pickOptionString(options, config, 'estCustomerNumber', 'estCustomerNumber', ''),
    EST_WORKGROUP: pickOptionString(options, config, 'estWorkgroup', 'estWorkgroup', ''),
    EST_MOBO: pickOptionString(options, config, 'estMobo', 'estMobo', '-2'),
    EST_CATEGORY_GROUP: pickOptionString(options, config, 'estCategoryGroup', 'estCategoryGroup', 'SHP').toUpperCase(),
    EST_FILETYPES: pickOptionString(options, config, 'estFileTypes', 'estFileTypes', '1,2'),
    DEVELOPER_MODE: developerMode ? 'true' : 'false'
  };
}


function buildClaimSettingsEnv(options = {}, config = {}) {
  const get = (optionKey, configKey = optionKey, fallback = '') => pickOptionString(options, config, optionKey, configKey, fallback);
  return {
    CLAIM_STREET_NUMBER: get('claimStreetNumber'),
    CLAIM_STREET_NAME: get('claimStreetName'),
    CLAIM_ADDRESS_LINE2: get('claimAddressLine2'),
    CLAIM_CITY: get('claimCity'),
    CLAIM_PROVINCE: get('claimProvince'),
    CLAIM_POSTAL_CODE: get('claimPostalCode'),
    CLAIM_CONTACT_NAME: get('claimContactName'),
    CLAIM_CONTACT_PHONE: get('claimContactPhone'),
    CLAIM_CONTACT_EMAIL: get('claimContactEmail'),
    CLAIM_BUSINESS_NAME: get('claimBusinessName')
  };
}

function saveRememberedUserSettings(config, options = {}, env = {}) {
  const rememberSettings = Object.prototype.hasOwnProperty.call(options, 'rememberSettings')
    ? boolFromOption(options.rememberSettings)
    : boolFromOption(config.rememberSettings);

  return {
    ...config,
    rememberSettings,
    webUsername: options.webUsername !== undefined ? String(options.webUsername || '').trim() : (config.webUsername || ''),
    estCustomerNumber: options.estCustomerNumber !== undefined ? String(options.estCustomerNumber || '').trim() : (config.estCustomerNumber || ''),
    claimStreetNumber: env.CLAIM_STREET_NUMBER ?? config.claimStreetNumber ?? '',
    claimStreetName: env.CLAIM_STREET_NAME ?? config.claimStreetName ?? '',
    claimAddressLine2: env.CLAIM_ADDRESS_LINE2 ?? config.claimAddressLine2 ?? '',
    claimCity: env.CLAIM_CITY ?? config.claimCity ?? '',
    claimProvince: env.CLAIM_PROVINCE ?? config.claimProvince ?? '',
    claimPostalCode: env.CLAIM_POSTAL_CODE ?? config.claimPostalCode ?? '',
    claimContactName: env.CLAIM_CONTACT_NAME ?? config.claimContactName ?? '',
    claimContactPhone: env.CLAIM_CONTACT_PHONE ?? config.claimContactPhone ?? '',
    claimContactEmail: env.CLAIM_CONTACT_EMAIL ?? config.claimContactEmail ?? '',
    claimBusinessName: env.CLAIM_BUSINESS_NAME ?? config.claimBusinessName ?? ''
  };
}

function validateClaimSettings(env = {}) {
  if (!String(env.CLAIM_STREET_NUMBER || '').trim()) {
    return { ok: false, error: 'Missing claim sender street number. Add it in the User Settings tab.' };
  }
  if (!String(env.CLAIM_STREET_NAME || '').trim()) {
    return { ok: false, error: 'Missing claim sender street name/dropdown option. Add it in the User Settings tab.' };
  }
  return { ok: true };
}

function ensureCacertIfAvailable() {
  const cacertRoot = path.join(workerResourceRoot(), 'cacert.pem');
  return { ok: fs.existsSync(cacertRoot), cacertRoot: fs.existsSync(cacertRoot) ? cacertRoot : '' };
}

function appendLog(logPath, text) {
  fs.appendFileSync(logPath, text, { mode: 0o600 });
  try { fs.chmodSync(logPath, 0o600); } catch (_) {}
}

function parseJsonLines(bufferState, chunk, onEvent, onRaw) {
  bufferState.text += chunk.toString();
  const lines = bufferState.text.split(/\r?\n/);
  bufferState.text = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    onRaw(line + '\n');
    try {
      const event = JSON.parse(line);
      onEvent(event);
    } catch {
      onEvent({ type: 'log', message: line });
    }
  }
}

const TRACKING_TERMINAL_EVENT_TYPES = new Set(['pin_late', 'pin_on_time', 'pin_overdue', 'pin_overdue_in_transit', 'pin_review_required', 'pin_no_data', 'pin_error']);
let rendererTrackingRowsCache = { mtimeMs: -1, rows: [] };

function eventForRenderer(stage, event) {
  if (stage !== 'tracking' || !TRACKING_TERMINAL_EVENT_TYPES.has(String(event?.type || ''))) return event;
  const rowIndex = Number(event.row || 0) - 1;
  if (rowIndex < 0) return event;
  try {
    const trackingPath = path.join(DATA_DIR, 'tracking.csv');
    const stat = fs.statSync(trackingPath);
    if (rendererTrackingRowsCache.mtimeMs !== stat.mtimeMs) {
      const sourceRows = rowsAsObjects(fs.readFileSync(trackingPath, 'utf8'));
      const seen = new Set();
      const rows = sourceRows.filter(row => {
        const pin = String(row['Tracking PIN'] || row['Tracking Number'] || row.PIN || row.Tracking || '').replace(/\s+/g, '').toUpperCase();
        if (!pin || seen.has(pin)) return false;
        seen.add(pin);
        return true;
      });
      rendererTrackingRowsCache = { mtimeMs: stat.mtimeMs, rows };
    }
    const row = rendererTrackingRowsCache.rows[rowIndex] || {};
    const fullTrackingNumber = String(row['Tracking PIN'] || row['Tracking Number'] || row.PIN || row.Tracking || '').replace(/\s+/g, '').toUpperCase();
    return fullTrackingNumber ? { ...event, displayTrackingNumber: fullTrackingNumber, rendererOnlyFullTrackingNumber: true } : event;
  } catch (_) {
    return event;
  }
}

function spawnJsonProcess(workerName, options, stage, logPath, hooks = {}) {
  const resolution = options.resolution || resolveWorkerLaunch(workerName);
  const launchOptions = { ...options, env: { ...options.env } };
  const protectedOperation = stage === 'tracking'
    ? (options.env?.TRACKING_STRUCTURE_EXPORT === '1' ? 'step2_structure_export' : (options.env?.TRACKING_DIAGNOSTIC_MODE === '1' ? 'step2_diagnostic' : 'step2_bulk_run'))
    : (stage === 'submit' ? (options.env?.DRY_RUN === 'true' ? 'step3_dry_run' : 'step3_live_run')
      : (stage === 'history' || stage === 'est-history' ? 'step1_import' : 'authoritative_data_mutation'));
  const operationToken = operationCoordinator.begin(protectedOperation, { code: stage });
  let launch;
  try {
    launch = runtimeWorkers.spawnResolvedWorker(resolution, launchOptions);
  } catch (error) {
    operationCoordinator.end(operationToken);
    throw error;
  }
  const completion = new Promise((resolve) => {
    const { child, useStdinJson } = launch;
    activeChild = child;
    activeStage = `${stage}:starting`;
    const stdoutBuffer = { text: '' };
    const stderrBuffer = { text: '' };
    let lastEvent = null;
    const lastEventsByType = {};
    const eventCounts = {};
    let settled = false;
    const customerNumbers = [options.env?.EST_CUSTOMER_NUMBER, options.env?.HISTORY_CUSTOMER_NUMBER];

    const handleRawLine = (_source, raw) => {
      appendLog(logPath, storage.redactCustomerNumbers(raw, customerNumbers));
    };

    const handleEvent = rawEvent => {
      let event;
      try {
        event = validateWorkerEvent(rawEvent, stage);
      } catch (error) {
        event = { type: 'worker_protocol_error', code: error.code || 'WORKER_EVENT_INVALID', message: error.message };
      }
      lastEvent = event;
      const type = String(event?.type || 'unknown');
      lastEventsByType[type] = event;
      eventCounts[type] = (eventCounts[type] || 0) + 1;
      try { hooks.onEvent?.(event); } catch (error) {
        appendLog(logPath, `[database-hook] ${error.message}
`);
      }
      emit('event', { stage, event: eventForRenderer(stage, event) });
      try {
        if (hooks.stopOnEvent?.(event)) {
          const stopTimer = setTimeout(() => {
            if (activeChild === child && child.exitCode === null) sendStopSignalToChild(child, { force: false });
          }, 150);
          if (typeof stopTimer.unref === 'function') stopTimer.unref();
        }
      } catch (error) {
        appendLog(logPath, `[process-hook] ${error.message}
`);
      }
    };

    const flushBuffer = (bufferState, source) => {
      const tail = bufferState.text;
      bufferState.text = '';
      if (!tail.trim()) return;
      handleRawLine(source, `${tail}
`);
      try { handleEvent(JSON.parse(tail)); }
      catch (_) { handleEvent({ type: 'log', message: tail }); }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      activeStage = 'idle';
      operationCoordinator.end(operationToken);
      resolve({ ...result, lastEvent, lastEventsByType, eventCounts });
    };

    launch.started.then(result => {
      if (!result.ok) return;
      activeStage = stage;
      emit('stage', { stage, status: 'running' });
      try { hooks.onSpawn?.({ child, resolution }); } catch (error) {
        appendLog(logPath, `[process-hook] ${error.message}\n`);
      }
    });

    child.stdout.on('data', chunk => {
      parseJsonLines(stdoutBuffer, chunk, handleEvent, raw => handleRawLine('stdout', raw));
    });

    child.stderr.on('data', chunk => {
      parseJsonLines(stderrBuffer, chunk, handleEvent, raw => handleRawLine('stderr', raw));
    });

    if (useStdinJson && child.stdin) {
      const payload = JSON.stringify(options.stdinJson);
      child.stdin.on('error', error => appendLog(logPath, `[${stage}] stdin warning: ${error.message}
`));
      child.stdin.end(payload);
    }

    child.once('error', error => {
      const actionable = error instanceof runtimeWorkers.WorkerLaunchError
        ? error
        : new runtimeWorkers.WorkerLaunchError('WORKER_SPAWN_FAILED', `Worker could not be started: ${error.message}`);
      emit('event', { stage, event: { type: 'error', message: actionable.message } });
      appendLog(logPath, `[${stage}] ERROR: ${actionable.message}\n`);
      finish({ ok: false, code: -1, error: actionable });
    });

    child.once('close', (code, signal) => {
      flushBuffer(stdoutBuffer, 'stdout');
      flushBuffer(stderrBuffer, 'stderr');
      try { hooks.onClose?.({ code, signal, lastEvent, lastEventsByType, eventCounts }); } catch (_) {}
      emit('stage', { stage, status: 'finished', code, signal });
      finish({ ok: code === 0, code, signal });
    });
  });
  completion.started = launch.started;
  completion.resolution = resolution;
  return completion;
}


function dependencyStatus() {
  const resourceRoot = workerResourceRoot();
  return {
    nodeRuntimeAvailable: Boolean(process.execPath && process.versions.node),
    nodeVersion: process.versions.node,
    cacertAvailable: fs.existsSync(path.join(resourceRoot, 'cacert.pem')),
    wsdlAvailable: fs.existsSync(path.join(resourceRoot, 'wsdl', 'track.wsdl')),
    playwrightCoreAvailable: fs.existsSync(path.join(resourceRoot, 'node_modules', 'playwright-core')),
    databaseIntegrity: (() => {
      try { return claimDb.integrityCheck(DB_PATH); } catch (error) { return { ok: false, result: error.message }; }
    })()
  };
}

function applicationStorageWritable() {
  const probe = path.join(USER_DATA_ROOT, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(USER_DATA_ROOT, { recursive: true, mode: 0o700 });
    fs.writeFileSync(probe, 'ok', { mode: 0o600, flag: 'wx' });
    fs.rmSync(probe, { force: true });
    return true;
  } catch (_) {
    try { fs.rmSync(probe, { force: true }); } catch (_) {}
    return false;
  }
}

function currentClaimPreview() {
  return step3QueueService.previewCandidates(DB_PATH, { now: new Date() });
}

function trackingDiagnosticRows() {
  const trackingPath = path.join(DATA_DIR, 'tracking.csv');
  if (!fs.existsSync(trackingPath)) return { rows: [], trackingPath };
  return { rows: rowsAsObjects(fs.readFileSync(trackingPath, 'utf8')), trackingPath };
}

function validateDiagnosticRow(value) {
  const { rows } = trackingDiagnosticRows();
  return trackingDiagnosticSelection.validateRow(rows, value);
}

function localizedText(key, values = {}, fallback = '') {
  const bundle = i18n.loadLocale(readConfig().locale || 'en-CA');
  return i18n.interpolate(i18n.translate(bundle, key, fallback), values);
}

function localizedOperation(operation) {
  const code = String(operation || 'unknown');
  return localizedText(`operation.${code}`, {}, code);
}

function localizedStep3Error(error) {
  const code = String(error?.code || 'STEP3_SNAPSHOT_FAILED');
  const keys = {
    STEP2_RUN_MISSING: 'step3.error.step2Missing',
    STEP2_RUN_NOT_AUTHORITATIVE: 'step3.error.step2NotAuthoritative',
    STEP3_SELECTION_EMPTY: 'step3.zeroSelectionRecovery',
    STEP3_EVIDENCE_CHANGED: 'step3.error.evidenceChanged',
    STEP3_TERMINAL_OUTCOME: 'step3.error.terminalOutcome',
    STEP3_UNRESOLVED_ATTEMPT: 'step3.error.unresolvedAttempt'
  };
  return localizedText(keys[code] || 'step3.error.snapshotFailed', {}, code);
}

function diagnosticSensitiveValues(config = {}) {
  return [
    config.estCustomerNumber,
    config.historyCustomerNumber,
    config.webUsername,
    config.claimStreetNumber,
    config.claimStreetName,
    config.claimAddressLine2,
    config.claimCity,
    config.claimPostalCode,
    config.claimBusinessName,
    config.claimContactName,
    config.claimContactPhone,
    config.claimContactEmail,
    storage.loadPassword(),
    ...Object.values(storage.loadApiCredentials()),
    ...Object.values(storage.loadTrackingApiCredentials())
  ].filter(Boolean);
}

function trackingRunCounts(summary = {}) {
  const total = Number(summary.checked || summary.attempted || summary.total || 0);
  const failure = Number(summary.errorCount || 0);
  const success = Number(summary.eligibleLateCount || 0) + Number(summary.onTimeCount || 0);
  const warning = Number(summary.notDeliveredCount || 0) + Number(summary.deliveredReviewCount || 0);
  return { total, success, warning, failure };
}

function runPreflight(rawOptions = {}) {
  ensureDirs();
  const options = inputValidation.validatePreflightOptions(rawOptions);
  const config = readConfig();
  const submitted = options.submitOptions || {};
  const dependencies = dependencyStatus();
  let preview;
  try {
    preview = currentClaimPreview();
  } catch (error) {
    preview = { count: 0, items: [], blocked: true, reason: error.code || 'STEP3_QUEUE_UNAVAILABLE' };
  }
  const reconciliationCount = claimDb.listReconciliation(DB_PATH, 10000).length;
  const workerReady = name => preflightWorkerLaunch(name).ok;
  const trackingEnvironment = normalizeTrackingEnvironment(config.trackingApiEnvironment || 'test');
  const report = buildPreflightReport({
    scope: options.scope,
    storageWritable: applicationStorageWritable(),
    databaseIntegrity: dependencies.databaseIntegrity,
    nodeRuntimeAvailable: dependencies.nodeRuntimeAvailable,
    nodeVersion: dependencies.nodeVersion,
    step1WorkersAvailable: workerReady('estHistory') && workerReady('shippingHistory'),
    step2WorkerAvailable: workerReady('tracking'),
    step3WorkersAvailable: workerReady('submitClaims'),
    apiCredentialsAvailable: storage.trackingApiCredentialsStored(),
    apiCredentialMetadata: trackingApiCredentialStatus(trackingEnvironment),
    trackingDiagnosticGateSatisfied: trackingDiagnosticGateSatisfied(config, trackingEnvironment),
    trackingCsvAvailable: fs.existsSync(path.join(DATA_DIR, 'tracking.csv')),
    webUsernameAvailable: Boolean(String(submitted.webUsername || config.webUsername || '').trim()),
    webPasswordAvailable: Boolean(submitted.webPassword || storage.passwordStored()),
    claimAddressAvailable: Boolean(String(submitted.claimStreetNumber || config.claimStreetNumber || '').trim() && String(submitted.claimStreetName || config.claimStreetName || '').trim()),
    claimCount: Number(preview.executableCount ?? preview.count ?? 0),
    builtinBrowserAvailable: typeof WebContentsView === 'function' && workerReady('submitClaims'),
    reconciliationCount
  });
  return { ok: true, report, claimPreview: preview };
}

function blockedStep3Preflight(result) {
  const report = result?.report || { checks: [], blockingCount: 1, warningCount: 0 };
  return {
    ok: false,
    code: 'STEP3_PREFLIGHT_BLOCKED',
    error: 'Step 3 preflight found blocking issues.',
    preflight: {
      blockingCount: Number(report.blockingCount || 0),
      warningCount: Number(report.warningCount || 0),
      failedChecks: (report.checks || []).filter(item => !item.ok && item.severity === 'blocking').map(item => ({
        id: String(item.id || ''),
        label: String(item.label || ''),
        action: String(item.action || '')
      }))
    }
  };
}

registerIpcHandler('preflight:run', (_event, rawOptions = {}) => {
  try {
    return runPreflight(rawOptions);
  } catch (error) {
    return { ok: false, error: error.message, code: error.code || 'PREFLIGHT_OPTIONS_INVALID' };
  }
});

registerIpcHandler('claims:preview', () => {
  ensureDirs();
  try {
    return { ok: true, ...currentClaimPreview() };
  } catch (error) {
    return { ok: false, error: localizedStep3Error(error), code: error.code || 'STEP3_QUEUE_UNAVAILABLE', count: 0, items: [] };
  }
});

registerIpcHandler('tracking:diagnosticDefaultRow', () => {
  try {
    const { rows } = trackingDiagnosticRows();
    const row = trackingDiagnosticSelection.firstUsableRow(rows);
    if (row === null) return { ok: false, error: 'No usable tracking row is available.', code: 'TRACKING_DIAGNOSTIC_ROW_MISSING' };
    return { ok: true, row, rowCount: rows.length };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code || 'TRACKING_DIAGNOSTIC_ROW_READ_FAILED' };
  }
});

registerIpcHandler('tracking:discardIncomplete', async (_event, payload = {}) => {
  if (payload.confirmed !== true) return { ok: false, error: 'Confirmation is required.' };
  if (activeChild) return { ok: false, error: 'Stop the active process before discarding an incomplete Step 2 run.' };
  return operationCoordinator.run('authoritative_data_mutation', async () => {
    const result = claimDb.discardIncompleteTrackingRun(DB_PATH);
    if (!result.discarded) return { ok: true, ...result, messageKey: 'step2.noIncomplete', message: 'No incomplete Step 2 run was found.' };
    const fileRestore = restorePreviousTextFiles(path.join(DATA_DIR, 'tracking-runs', `run-${result.runId}`), DATA_DIR);
    return {
      ok: true,
      ...result,
      fileRestore,
      messageKey: fileRestore.restored ? 'step2.discardedRestored' : 'step2.discarded',
      message: `Incomplete Step 2 run discarded. Its history was preserved${fileRestore.restored ? ' and the preceding completed output files were restored' : ''}; Step 3 remains blocked until a new Step 2 run completes.`
    };
  });
});

registerIpcHandler('browser:showBuiltin', async (_event, options = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'The live claim browser is disabled while isolated test data is active.' };
  try {
    return await showBuiltinBrowser(options.bounds || options);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

registerIpcHandler('browser:prepareBuiltin', async () => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'The live claim browser is disabled while isolated test data is active.', code: 'BROWSER_DISABLED' };
  try {
    const publication = await prepareBuiltinBrowserForWorker({ reason: 'renderer-preflight' });
    return {
      ok: true,
      endpoint: publication.endpoint,
      webContentsIdentityHash: publication.webContentsIdentityHash,
      targetIdHash: publication.targetIdHash
    };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code || 'BROWSER_HANDSHAKE_FAILED' };
  }
});

registerIpcHandler('browser:targetState', () => ({
  ...browserDisplaySnapshot(),
  generation: builtinBrowserGeneration,
  debuggingPort: Number(BUILTIN_BROWSER_CDP_PORT)
}));

registerIpcHandler('browser:syncVisibility', (event, payload = {}) => {
  if (!win || event.sender !== win.webContents) return { ok: false, error: 'Browser visibility synchronization came from an unexpected renderer.', code: 'BROWSER_VISIBILITY_SOURCE_REJECTED' };
  try {
    const result = applyBuiltinBrowserVisibility(payload);
    const pending = pendingBrowserVisibilityRequests.get(String(payload.requestId || ''));
    if (pending) {
      clearTimeout(pending.timer);
      pendingBrowserVisibilityRequests.delete(String(payload.requestId || ''));
      if (pending.requireVisible && !result.visible) {
        const error = new Error('The Step 3 browser slot is not displayable inside the application viewport.');
        error.code = 'BROWSER_VISIBILITY_REQUIRED';
        pending.reject(error);
      } else pending.resolve(result);
    }
    return result;
  } catch (error) {
    const pending = pendingBrowserVisibilityRequests.get(String(payload.requestId || ''));
    if (pending) {
      clearTimeout(pending.timer);
      pendingBrowserVisibilityRequests.delete(String(payload.requestId || ''));
      pending.reject(error);
    }
    return { ok: false, error: error.message, code: error.code || 'BROWSER_DISPLAY_ERROR' };
  }
});

registerIpcHandler('browser:setBuiltinBounds', (_event, bounds = {}) => {
  try {
    if (!builtinBrowserView) return { ok: true, hidden: true, reason: 'browser-preparing' };
    const state = setBuiltinBrowserBounds(bounds, 'legacy-bounds-sync');
    return { ...state, ok: true };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code || 'BROWSER_DISPLAY_ERROR' };
  }
});

registerIpcHandler('browser:hideBuiltin', () => {
  hideBuiltinBrowserView('renderer-hide-request');
  return { ok: true };
});

registerIpcHandler('browser:focusBuiltin', () => {
  return { ok: focusBuiltinBrowser() };
});

registerIpcHandler('browser:clearSession', async (_event, payload = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'Browser profile actions are disabled while isolated test data is active.' };
  if (payload.confirmed !== true) return { ok: false, error: 'Confirmation is required.' };
  if (activeChild) return { ok: false, error: 'Stop the active process before clearing browser data.' };
  return operationCoordinator.run('authoritative_data_mutation', async () => {
    hideBuiltinBrowserView();
    destroyBuiltinBrowserView();
    const browserSession = session.fromPartition('persist:canadapost-claims-builtin');
    await browserSession.clearStorageData({ storages: ['cookies', 'localstorage', 'cachestorage', 'indexdb', 'serviceworkers'] });
    await browserSession.clearCache();
    claimDb.recordAuditEvent(DB_PATH, payload.resetProfile ? 'browser_profile_reset' : 'browser_session_cleared', {
      claimHistoryPreserved: true,
      cookiesAndStorageCleared: true
    });
    return { ok: true, claimHistoryPreserved: true };
  });
});

registerIpcHandler('config:load', () => {
  ensureDirs();
  const config = storage.publicConfig();
  const publicConfig = { ...config };
  delete publicConfig.apiEnvironment;
  delete publicConfig.apiCredentialsStored;
  delete publicConfig.apiCredentialEnvironment;
  const trackingApiEnvironment = normalizeTrackingEnvironment(config.trackingApiEnvironment || 'test');
  return {
    ...publicConfig,
    trackingApiEnvironment,
    duplicateClaimFixVersion: DUPLICATE_CLAIM_FIX_VERSION,
    root: ROOT,
    dataDir: DATA_DIR,
    logDir: LOG_DIR,
    databasePath: DB_PATH,
    databaseIntegrity: claimDb.integrityCheck(DB_PATH),
    dashboard: claimDb.dashboard(DB_PATH),
    reconciliationCount: claimDb.listReconciliation(DB_PATH, 10000).length,
    hasTrackingCsv: fs.existsSync(path.join(DATA_DIR, 'tracking.csv')),
    hasClaimsCsv: fs.existsSync(path.join(DATA_DIR, 'claims.csv')),
    hasUserIni: fs.existsSync(path.join(DATA_DIR, 'user.ini')) || fs.existsSync(path.join(ROOT, 'user.ini')),
    hasTrackingApiCredentials: storage.trackingApiCredentialsStored(),
    trackingApiCredentialMetadata: trackingApiCredentialStatus(trackingApiEnvironment),
    trackingDiagnosticGateSatisfied: trackingDiagnosticGateSatisfied(config, trackingApiEnvironment),
    trackingApiVersion: TRACKING_API_VERSION,
    trackingParserVersion: TRACKING_PARSER_VERSION,
    trackingRequestDelayMs: (() => { try { return normalizeDelayMs(config.trackingRequestDelayMs); } catch (_) { return DEFAULT_TRACKING_REQUEST_INTERVAL_MS; } })(),
    trackingResourceTimeoutMs: normalizeResourceTimeoutMs(config.trackingResourceTimeoutMs, DEFAULT_RESOURCE_TIMEOUT_MS),
    hasCacert: fs.existsSync(path.join(workerResourceRoot(), 'cacert.pem')),
    hasWsdl: fs.existsSync(path.join(workerResourceRoot(), 'wsdl', 'track.wsdl')),
    historyImportVersion: HISTORY_IMPORT_VERSION,
    estHistoryExportVersion: EST_HISTORY_EXPORT_VERSION,
    stepTabsVersion: STEP_TABS_VERSION,
    appVersion: APP_VERSION,
    signedBuild: false,
    isolatedTestMode: USER_DATA_PROFILE.active,
    isolatedUserDataPath: USER_DATA_PROFILE.active ? USER_DATA_PROFILE.userDataRoot : '',
    liveSubmissionEnabled: !USER_DATA_PROFILE.active,
    updateActionsEnabled: !USER_DATA_PROFILE.active,
    updateRecovery,
    setupReadiness: setupReadiness(storage.publicConfig(), trackingApiEnvironment),
    ...readUserIniPublicFields()
  };
});

registerIpcHandler('config:save', (_event, input = {}) => {
  const existing = readConfig();
  let trackingRequestDelayMs;
  let trackingResourceTimeoutMs;
  try { trackingRequestDelayMs = normalizeDelayMs(input.trackingRequestDelayMs ?? (Number(existing.trackingRequestDelayMs) >= DEFAULT_TRACKING_REQUEST_INTERVAL_MS ? existing.trackingRequestDelayMs : DEFAULT_TRACKING_REQUEST_INTERVAL_MS)); }
  catch (error) { return { ok: false, error: error.message }; }
  try { trackingResourceTimeoutMs = normalizeResourceTimeoutMs(input.trackingResourceTimeoutMs ?? existing.trackingResourceTimeoutMs, DEFAULT_RESOURCE_TIMEOUT_MS); }
  catch (error) { return { ok: false, error: error.message }; }
  const trackingClientIdSupplied = Boolean(String(input.trackingClientId || '').trim());
  const trackingClientSecretSupplied = Boolean(String(input.trackingClientSecret || '').trim());
  if (trackingClientIdSupplied !== trackingClientSecretSupplied) {
    return { ok: false, error: 'Enter both the Tracking API client ID and client secret together. Legacy and website credentials are never copied into these fields.' };
  }
  const sanitized = storage.sanitizeConfig(input);
  delete sanitized.apiEnvironment;
  sanitized.trackingApiEnvironment = normalizeTrackingEnvironment(input.trackingApiEnvironment || existing.trackingApiEnvironment || 'test');
  sanitized.trackingRequestDelayMs = trackingRequestDelayMs;
  sanitized.trackingResourceTimeoutMs = trackingResourceTimeoutMs;
  const trackingEnvironmentChanged = sanitized.trackingApiEnvironment !== normalizeTrackingEnvironment(existing.trackingApiEnvironment || 'test');
  if (activeChild && (trackingClientIdSupplied || trackingEnvironmentChanged)) {
    return { ok: false, error: 'Stop the active process before changing Tracking API credentials or environment.' };
  }
  let next = { ...existing, ...sanitized };
  if (trackingClientIdSupplied || trackingEnvironmentChanged) next = invalidateTrackingDiagnosticGate(next, { newRevision: true });
  if (sanitized.setupCompleted === true && existing.setupCompleted !== true
    && !setupCompletionAllowed(setupReadiness(next, sanitized.trackingApiEnvironment))) {
    return { ok: false, error: 'Setup cannot be completed until every required readiness check and the safety acknowledgement are satisfied.' };
  }
  writeConfig(next);
  const credentialResult = persistPasswordFromOptions(input, next);
  let trackingApiResult = { stored: storage.trackingApiCredentialsStored(), warning: '' };
  if (trackingClientIdSupplied && trackingClientSecretSupplied) {
    trackingApiResult = storage.saveTrackingApiCredentials(input.trackingClientId, input.trackingClientSecret, { environment: sanitized.trackingApiEnvironment });
  }
  return {
    ok: true,
    passwordStored: credentialResult.stored,
    trackingApiCredentialsStored: trackingApiResult.stored,
    trackingApiCredentialMetadata: trackingApiCredentialStatus(sanitized.trackingApiEnvironment),
    trackingDiagnosticGateSatisfied: trackingDiagnosticGateSatisfied(next, sanitized.trackingApiEnvironment),
    credentialBackend: credentialResult.backend,
    warning: credentialResult.warning || trackingApiResult.warning || ''
  };
});

registerIpcHandler('credentials:clearTrackingApi', (_event, payload = {}) => {
  if (payload.confirmed !== true) return { ok: false, error: 'Confirmation is required.' };
  if (activeChild) return { ok: false, error: 'Stop the active process before clearing Tracking API credentials.' };
  storage.clearTrackingApiCredentials();
  const next = invalidateTrackingDiagnosticGate(readConfig(), { newRevision: true });
  writeConfig(next);
  return { ok: true, trackingApiCredentialsStored: false, trackingDiagnosticGateSatisfied: false };
});

registerIpcHandler('locale:load', (_event, locale) => {
  try { return { ok: true, ...i18n.loadLocale(locale) }; }
  catch (error) { return { ok: false, error: error.message, ...i18n.loadLocale('en-CA') }; }
});

registerIpcHandler('file:selectTrackingCsv', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: localizedText('dialog.selectTrackingCsv.title', {}, 'Select tracking.csv'),
    properties: ['openFile'],
    filters: [{ name: localizedText('dialog.csvFiles', {}, 'CSV files'), extensions: ['csv'] }]
  });

  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  const source = result.filePaths[0];
  const dest = path.join(DATA_DIR, 'tracking.csv');
  fs.copyFileSync(source, dest);
  return { ok: true, path: dest };
});

registerIpcHandler('folder:openData', async () => {
  await shell.openPath(DATA_DIR);
  return { ok: true };
});

registerIpcHandler('folder:openLogs', async () => {
  await shell.openPath(LOG_DIR);
  return { ok: true };
});

registerIpcHandler('folder:openStep3Diagnostics', async () => {
  const directory = latestStep3DiagnosticsDir || latestStep3RunDirectory();
  if (!directory || !fs.existsSync(directory)) {
    return { ok: false, error: 'No Step 3 diagnostic run exists yet.' };
  }
  latestStep3DiagnosticsDir = directory;
  const error = await shell.openPath(directory);
  return error ? { ok: false, error } : { ok: true, path: directory };
});

function resolveEvidencePath(filePath) {
  return resolveOwnedRegularFile(filePath, [DATA_DIR, LOG_DIR]);
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

registerIpcHandler('evidence:load', (_event, payload = {}) => {
  ensureDirs();

  const response = {
    ok: true,
    screenshotDataUrl: '',
    screenshotName: '',
    screenshotPath: '',
    pageText: '',
    textName: '',
    textPath: ''
  };

  const screenshot = resolveEvidencePath(payload.screenshotPath);
  if (screenshot && screenshot.size <= 25 * 1024 * 1024) {
    const data = fs.readFileSync(screenshot.path).toString('base64');
    response.screenshotDataUrl = `data:${mimeFor(screenshot.path)};base64,${data}`;
    response.screenshotName = path.basename(screenshot.path);
    response.screenshotPath = screenshot.path;
  }

  const text = resolveEvidencePath(payload.textPath);
  if (text && text.size <= 1024 * 1024) {
    response.pageText = fs.readFileSync(text.path, 'utf8').slice(0, 20000);
    response.textName = path.basename(text.path);
    response.textPath = text.path;
  }

  if (!response.screenshotDataUrl && !response.pageText) {
    return { ok: false, error: 'No saved evidence file was found for this result.' };
  }

  return response;
});

registerIpcHandler('evidence:open', async (_event, filePath) => {
  const resolved = resolveEvidencePath(filePath);
  if (!resolved) return { ok: false, error: 'Evidence file not found.' };
  const errorMessage = await shell.openPath(resolved.path);
  return errorMessage ? { ok: false, error: errorMessage } : { ok: true };
});



registerIpcHandler('dashboard:get', () => {
  ensureDirs();
  return { ok: true, dashboard: claimDb.dashboard(DB_PATH), integrity: claimDb.integrityCheck(DB_PATH) };
});

registerIpcHandler('history:list', (_event, options = {}) => {
  ensureDirs();
  return { ok: true, items: claimDb.listClaimHistory(DB_PATH, options) };
});

registerIpcHandler('history:export', async () => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'External exports are disabled while isolated test data is active.' };
  const result = await dialog.showSaveDialog(win, {
    title: localizedText('dialog.exportHistory.title', {}, 'Export claim history'),
    defaultPath: path.join(app.getPath('documents'), `canadapost-claim-history-${new Date().toISOString().slice(0, 10)}.csv`),
    filters: [{ name: localizedText('dialog.csvFiles', {}, 'CSV files'), extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  archiveTools.exportHistoryCsv(DB_PATH, result.filePath);
  return { ok: true, path: result.filePath };
});

registerIpcHandler('reconciliation:update', async (_event, payload = {}) => {
  try {
    return await operationCoordinator.run('authoritative_data_mutation', async () => {
      const item = claimDb.reconcileAttempt(DB_PATH, payload.attemptId, String(payload.action || ''), String(payload.note || ''), String(payload.confirmationNumber || ''));
      return { ok: true, item, reconciliationCount: claimDb.listReconciliation(DB_PATH, 10000).length };
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

registerIpcHandler('backup:create', async (_event, payload = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'Manual backup exports are disabled while isolated test data is active. The verified pre-migration backup remains inside the isolated profile.' };
  ensureDirs();
  const password = typeof payload.password === 'string' ? payload.password : '';
  if (password.length < 12 || password.length > 1024) return { ok: false, error: 'Use a backup password of at least 12 characters.' };
  const result = await dialog.showSaveDialog(win, {
    title: localizedText('dialog.createBackup.title', {}, 'Create Canada Post Claim Runner backup'),
    defaultPath: path.join(app.getPath('documents'), `canadapost-claim-runner-backup-${new Date().toISOString().slice(0, 10)}.cpcrbackup`),
    filters: [{ name: localizedText('dialog.encryptedBackups', {}, 'Encrypted Claim Runner backups'), extensions: ['cpcrbackup'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  const operationToken = operationCoordinator.begin('backup_creation');
  try {
    await encryptedBackup.createEncryptedBackup({
      dbPath: DB_PATH,
      dataDir: DATA_DIR,
      config: readConfig(),
      destination: result.filePath,
      appVersion: APP_VERSION,
      tempDirectory: BACKUP_RESTORE_TEMP_DIR,
      password
    });
    claimDb.recordAuditEvent(DB_PATH, 'backup_created', { encrypted: true, formatVersion: encryptedBackup.VERSION });
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    operationCoordinator.end(operationToken);
  }
});

registerIpcHandler('backup:restore', async (_event, payload = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'Backup restore is disabled while isolated test data is active.' };
  ensureDirs();
  if (activeChild) return { ok: false, error: 'Stop the active process before restoring a backup.' };
  if (!pendingRestorePath) {
    const result = await dialog.showOpenDialog(win, {
      title: localizedText('dialog.restoreBackup.title', {}, 'Restore Canada Post Claim Runner backup'),
      properties: ['openFile'],
      filters: [
        { name: localizedText('dialog.claimRunnerBackups', {}, 'Claim Runner backups'), extensions: ['cpcrbackup', 'zip'] },
        { name: localizedText('dialog.legacyBackups', {}, 'Legacy unencrypted ZIP backups'), extensions: ['zip'] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    pendingRestorePath = result.filePaths[0];
  }
  let operationToken = '';
  try {
    const encrypted = encryptedBackup.isEncryptedBackup(pendingRestorePath);
    if (encrypted && (typeof payload.password !== 'string' || !payload.password)) return { ok: false, passwordRequired: true };
    if (!encrypted) {
      const warning = await dialog.showMessageBox(win, {
        type: 'warning', buttons: [localizedText('action.cancel', {}, 'Cancel'), localizedText('dialog.legacy.restore', {}, 'Restore legacy backup')], defaultId: 0, cancelId: 0,
        title: localizedText('dialog.legacy.title', {}, 'Unencrypted legacy backup'),
        message: localizedText('dialog.legacy.message', {}, 'This legacy ZIP is not encrypted or authenticated.'),
        detail: localizedText('dialog.legacy.detail', {}, 'Only restore it if you trust its source. A rollback copy will be retained.')
      });
      if (warning.response !== 1) { pendingRestorePath = ''; return { ok: false, canceled: true }; }
    }
    const restoreOptions = {
      source: pendingRestorePath,
      dbPath: DB_PATH,
      dataDir: DATA_DIR,
      tempDirectory: BACKUP_RESTORE_TEMP_DIR,
      configWriter: restoredSettings => writeConfig({ ...readConfig(), ...storage.sanitizeConfig(restoredSettings) })
    };
    operationToken = operationCoordinator.begin('backup_restore');
    const restored = encrypted
      ? encryptedBackup.restoreEncryptedBackup({ ...restoreOptions, password: payload.password })
      : archiveTools.restoreBackup(restoreOptions);
    claimDb.markInterruptedAttempts(DB_PATH);
    claimDb.quarantineLegacyDryRunReadyAttempts(DB_PATH);
    claimDb.recordAuditEvent(DB_PATH, 'backup_restored', { encrypted, legacyWarningShown: !encrypted });
    pendingRestorePath = '';
    return { ...restored, encrypted, legacy: !encrypted, dashboard: claimDb.dashboard(DB_PATH) };
  } catch (error) {
    if (!/password may be wrong/i.test(error.message)) pendingRestorePath = '';
    return { ok: false, error: error.message };
  } finally {
    if (operationToken) operationCoordinator.end(operationToken);
  }
});

function validatedPrivacyScope(payload = {}) {
  return {
    allRecords: payload.allRecords === true,
    trackingNumbers: Array.isArray(payload.trackingNumbers)
      ? payload.trackingNumbers.slice(0, 10000).map(value => String(value || '').slice(0, 128))
      : [],
    dateFrom: String(payload.dateFrom || '').slice(0, 10),
    dateTo: String(payload.dateTo || '').slice(0, 10)
  };
}

registerIpcHandler('privacy:preview', (_event, payload = {}) => {
  try {
    return { ok: true, ...privacyDeletion.previewData(DB_PATH, validatedPrivacyScope(payload)) };
  } catch (_error) {
    return { ok: false, error: localizedText('privacy.previewFailed', {}, 'PRIVACY_PREVIEW_INVALID'), code: 'PRIVACY_PREVIEW_INVALID' };
  }
});

registerIpcHandler('privacy:delete', (_event, payload = {}) => {
  try {
    operationCoordinator.assertInactive();
  } catch (error) {
    return {
      ok: false,
      error: localizedText('privacy.operationActive', { operation: localizedOperation(error.operation) }, 'PRIVACY_OPERATION_ACTIVE'),
      code: error.code,
      operation: error.operation
    };
  }
  const operationToken = operationCoordinator.begin('privacy_deletion');
  try {
    return privacyDeletion.deleteData({
      dbPath: DB_PATH,
      scope: validatedPrivacyScope(payload),
      locale: i18n.normalizeLocale(payload.locale),
      confirmed: payload.confirmed === true,
      typedPhrase: String(payload.typedPhrase || '').slice(0, 128),
      secondConfirmed: payload.secondConfirmed === true,
      applicationVersion: APP_VERSION,
      operationId: crypto.randomUUID(),
      ownedRoots: [DATA_DIR, LOG_DIR],
      transactionRoot: path.join(USER_DATA_ROOT, 'tmp', 'privacy-deletion'),
      receiptDirectory: path.join(USER_DATA_ROOT, 'privacy-receipts')
    });
  } catch (_error) {
    return { ok: false, error: localizedText('privacy.deleteFailed', {}, 'PRIVACY_DELETION_FAILED'), code: 'PRIVACY_DELETION_FAILED' };
  } finally {
    operationCoordinator.end(operationToken);
  }
});

function supportBundlePreview(payload = {}) {
  return supportBundle.preview({
    components: payload.components,
    supportReferenceId: payload.supportReferenceId,
    applicationVersion: APP_VERSION,
    databaseSchemaVersion: claimDb.SCHEMA_VERSION,
    trackingParserVersion: TRACKING_PARSER_VERSION
  });
}

registerIpcHandler('diagnostics:preview', (_event, payload = {}) => ({ ok: true, preview: supportBundlePreview(payload) }));

registerIpcHandler('diagnostics:create', async (_event, payload = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'External diagnostic exports are disabled while isolated test data is active.' };
  if (payload.acknowledged !== true) return { ok: false, error: 'Review and acknowledge the support bundle warning before creating an archive.', code: 'SUPPORT_BUNDLE_ACK_REQUIRED' };
  const preview = supportBundlePreview(payload);
  if (!/^CPCR-\d{8}-[A-F0-9]{10}$/.test(preview.supportReferenceId)) return { ok: false, error: 'The support reference ID is invalid.', code: 'SUPPORT_REFERENCE_INVALID' };
  ensureDirs();
  const result = await dialog.showSaveDialog(win, {
    title: localizedText('dialog.support.title', {}, 'Create sanitized support bundle'),
    defaultPath: path.join(app.getPath('documents'), `canadapost-support-${preview.supportReferenceId}.zip`),
    filters: [{ name: localizedText('dialog.zipArchives', {}, 'ZIP archives'), extensions: ['zip'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    const config = readConfig();
    archiveTools.createDiagnosticPackage({
      destination: result.filePath,
      appVersion: APP_VERSION,
      config,
      credentialStatus: {
        passwordStored: storage.passwordStored(),
        apiCredentialsStored: storage.apiCredentialsStored(),
        credentialBackend: storage.credentialBackend(),
        secureCredentialStorage: storage.strongCredentialStorageAvailable()
      },
      logDir: LOG_DIR,
      dbPath: DB_PATH,
      dependencyStatus: dependencyStatus(),
      sensitiveValues: diagnosticSensitiveValues(config),
      components: preview.selectedComponents,
      supportManifest: preview
    });
    return { ok: true, path: result.filePath, supportReferenceId: preview.supportReferenceId };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

registerIpcHandler('est:importHistory', async (_event, options = {}) => {
  ensureDirs();

  if (activeChild) {
    return { ok: false, error: 'A process is already active.' };
  }
  const workerPreflight = preflightWorkerLaunch('estHistory');
  if (!workerPreflight.ok) return workerPreflight;

  fs.rmSync(STOP_FILE, { force: true });
  ensureCacertIfAvailable();

  const config = readConfig();
  const credentials = resolveWebCredentials(options, config);
  const credentialOptions = { ...options, webUsername: credentials.username, webPassword: credentials.password };
  const estEnv = buildEstHistoryEnv(credentialOptions, config);

  if (!estEnv.EST_FROM || !estEnv.EST_TO) {
    return { ok: false, error: 'Missing EST history date range.' };
  }
  if (!estEnv.EST_CUSTOMER_NUMBER) {
    return { ok: false, error: 'Missing Canada Post customer number. Enter it in User Settings.' };
  }
  if (!credentials.username || !credentials.password) {
    return { ok: false, error: 'Missing Canada Post web username/password. The EST Desktop export endpoints use the web/EST login, not the developer API key.' };
  }

  const claimEnvForSave = buildClaimSettingsEnv(options, config);
  const nextConfig = saveRememberedUserSettings({
    ...config,
    estFrom: estEnv.EST_FROM,
    estTo: estEnv.EST_TO,
    estCustomerNumber: estEnv.EST_CUSTOMER_NUMBER,
    estWorkgroup: estEnv.EST_WORKGROUP,
    estMobo: estEnv.EST_MOBO,
    estCategoryGroup: estEnv.EST_CATEGORY_GROUP,
    estFileTypes: estEnv.EST_FILETYPES,
    developerMode: boolFromOption(estEnv.DEVELOPER_MODE)
  }, options, claimEnvForSave);
  writeConfig(nextConfig);
  persistPasswordFromOptions(options, nextConfig);

  const logPath = path.join(LOG_DIR, `est-history-import-${timestamp()}.log`);

  const envBase = {
    DATA_DIR,
    STOP_FILE,
    TRACKING_CSV: path.join(DATA_DIR, 'tracking.csv'),
    CANADAPOST_SECRETS_STDIN: '1',
    ...estEnv
  };

  const importProcess = spawnJsonProcess('estHistory', {
    resolution: workerPreflight.resolution,
    env: { ...envBase, ELECTRON_RUN_AS_NODE: '1' },
    stdinJson: { username: credentials.username, password: credentials.password }
  }, 'est-history', logPath, {
    onSpawn: () => {
      emit('run', { status: 'started', logPath });
      appendLog(logPath, `Canada Post EST Desktop history export started ${new Date().toISOString()}\nEST export version: ${EST_HISTORY_EXPORT_VERSION}\n`);
    }
  });
  const started = await importProcess.started;
  if (!started.ok) {
    const failed = await importProcess;
    return { ok: false, error: failed.error?.message || 'EST Desktop history worker could not be started.' };
  }

  (async () => {
    try {
      const importResult = await importProcess;
      if (!importResult.ok) {
        const workerError = importResult.lastEventsByType?.error;
        const message = workerError?.message || `EST Desktop history export failed with code ${importResult.code}.`;
        emit('run', { status: 'failed', message, logPath });
        return;
      }
      const completed = importResult.lastEventsByType?.est_complete || {};
      if (completed.outcome === 'EMPTY') {
        emit('run', { status: 'complete', messageKey: 'event.est.empty', message: 'Completed — no EST orders found for the selected date range.', logPath });
        return;
      }
      if (completed.outcome === 'IMPORTED_INCOMPLETE') {
        emit('run', { status: 'complete', messageKey: 'event.est.completedExcluded', messageValues: { count: Number(completed.excluded || 0) }, message: `EST Desktop history export completed with ${Number(completed.excluded || 0)} incomplete row(s) excluded. tracking.csv contains only quality-gated rows.`, logPath });
        return;
      }
      emit('run', { status: 'complete', messageKey: 'event.est.generated', message: 'EST Desktop history export complete. tracking.csv was generated.', logPath });
    } catch (error) {
      emit('run', { status: 'failed', message: error.message, logPath });
    }
  })();

  return { ok: true, logPath };
});

registerIpcHandler('history:import', async (_event, options = {}) => {
  ensureDirs();

  if (activeChild) {
    return { ok: false, error: 'A process is already active.' };
  }
  const workerPreflight = preflightWorkerLaunch('shippingHistory');
  if (!workerPreflight.ok) return workerPreflight;

  fs.rmSync(STOP_FILE, { force: true });

  const config = readConfig();
  const apiEnvironment = normalizeLegacyEnvironment(config.apiEnvironment || 'production');
  const apiFiles = ensureApiCredentialFiles(apiEnvironment);
  if (!apiFiles.ok) return apiFiles;
  const historyEnv = buildHistoryEnv(options, config);

  if (!historyEnv.HISTORY_FROM || !historyEnv.HISTORY_TO) {
    return { ok: false, error: 'Missing shipping history date range.' };
  }
  if (!historyEnv.HISTORY_CUSTOMER_NUMBER) {
    return { ok: false, error: 'Missing Canada Post customer number. Enter it in User Settings.' };
  }

  writeConfig({
    ...config,
    historyFrom: historyEnv.HISTORY_FROM,
    historyTo: historyEnv.HISTORY_TO,
    historyCustomerNumber: historyEnv.HISTORY_CUSTOMER_NUMBER,
    historyAutoMobo: boolFromOption(historyEnv.HISTORY_AUTO_MOBO),
    historyMobo: historyEnv.HISTORY_MOBO,
    historyIncludeNoManifest: options.historyIncludeNoManifest ? true : false,
    developerMode: boolFromOption(historyEnv.DEVELOPER_MODE)
  });

  const logPath = path.join(LOG_DIR, `history-import-${timestamp()}.log`);

  const envBase = {
    DATA_DIR,
    STOP_FILE,
    TRACKING_CSV: path.join(DATA_DIR, 'tracking.csv'),
    CANADAPOST_SECRETS_STDIN: '1',
    ...historyEnv
  };

  const importProcess = spawnJsonProcess('shippingHistory', {
    resolution: workerPreflight.resolution,
    env: { ...envBase, ELECTRON_RUN_AS_NODE: '1' },
    stdinJson: { username: apiFiles.username, password: apiFiles.password, environment: apiFiles.environment, usernameSource: apiFiles.usernameSource, passwordSource: apiFiles.passwordSource }
  }, 'history', logPath, {
    onSpawn: () => {
      emit('run', { status: 'started', logPath });
      appendLog(logPath, `Canada Post shipping history import started ${new Date().toISOString()}\nHistory import version: ${HISTORY_IMPORT_VERSION}\n`);
    }
  });
  const started = await importProcess.started;
  if (!started.ok) {
    const failed = await importProcess;
    return { ok: false, error: failed.error?.message || 'Shipping history worker could not be started.' };
  }

  (async () => {
    try {
      const importResult = await importProcess;
      if (!importResult.ok) {
        const message = importResult.code === 2
          ? 'Shipping history import found no shipments. Existing tracking.csv was not replaced.'
          : `Shipping history import failed with code ${importResult.code}.`;
        emit('run', { status: 'failed', message, logPath });
        return;
      }
      emit('run', { status: 'complete', messageKey: 'event.history.generated', message: 'Shipping history import complete. tracking.csv was generated.', logPath });
    } catch (error) {
      emit('run', { status: 'failed', message: error.message, logPath });
    }
  })();

  return { ok: true, logPath };
});



registerIpcHandler('tracking:run', async (_event, options = {}) => {
  ensureDirs();

  if (activeChild) {
    return { ok: false, error: 'A process is already active.' };
  }
  const workerPreflight = preflightWorkerLaunch('tracking');
  if (!workerPreflight.ok) return workerPreflight;

  fs.rmSync(STOP_FILE, { force: true });

  const config = readConfig();
  const trackingApiEnvironment = normalizeTrackingEnvironment(options.trackingApiEnvironment || config.trackingApiEnvironment || 'test');
  const trackingApiFiles = ensureTrackingApiCredentials(trackingApiEnvironment);
  if (!trackingApiFiles.ok) return trackingApiFiles;

  const trackingCsv = path.join(DATA_DIR, 'tracking.csv');
  if (!fs.existsSync(trackingCsv)) {
    return { ok: false, error: `Missing ${trackingCsv}. Run Step 1 or select tracking.csv first.` };
  }

  const diagnosticMode = options.diagnosticMode === true;
  const structureExport = diagnosticMode && options.structureExport === true;
  if (diagnosticMode && options.diagnosticConfirmed !== true) {
    return { ok: false, error: 'One-request diagnostic requires deliberate confirmation.' };
  }
  let diagnosticRow = null;
  if (diagnosticMode) {
    try { diagnosticRow = validateDiagnosticRow(options.diagnosticRow).row; }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
  }
  if (!diagnosticMode && !trackingDiagnosticGateSatisfied(config, trackingApiEnvironment)) {
    return { ok: false, error: `Step 2 is blocked until “Test API connection with one shipment” succeeds for credential revision, ${trackingApiEnvironment}, and Tracking API ${TRACKING_API_VERSION}.` };
  }
  writeConfig({
    ...config,
    freshTracking: !!options.fresh,
    trackingApiEnvironment,
    developerMode: false
  });

  const logPath = path.join(LOG_DIR, `tracking-${timestamp()}.log`);

  const envBase = {
    DATA_DIR,
    STOP_FILE,
    CLAIMS_CSV: path.join(DATA_DIR, 'claims.csv'),
    TRACKING_CSV: trackingCsv,
    TRACKING_REQUEST_INTERVAL_MS: String(DEFAULT_TRACKING_REQUEST_INTERVAL_MS),
    TRACKING_RESOURCE_TIMEOUT_MS: String(normalizeResourceTimeoutMs(config.trackingResourceTimeoutMs, DEFAULT_RESOURCE_TIMEOUT_MS)),
    CANADAPOST_SECRETS_STDIN: '1',
    CANADAPOST_API_ENVIRONMENT: trackingApiEnvironment,
    TRACKING_DIAGNOSTIC_MODE: diagnosticMode ? '1' : '0',
    TRACKING_DIAGNOSTIC_CONFIRM: diagnosticMode ? 'ONE_REQUEST_NO_STATE_CHANGE' : '',
    TRACKING_DIAGNOSTIC_ROW: diagnosticMode ? String(diagnosticRow) : '',
    TRACKING_STRUCTURE_EXPORT: structureExport ? '1' : '0',
    TRACKING_STRUCTURE_REPORT: structureExport ? path.join(LOG_DIR, `tracking-response-structure-${timestamp()}.json`) : '',
    DATABASE_PATH: DB_PATH,
    DEVELOPER_MODE: 'false'
  };
  envBase.TRACKING_REQUEST_INTERVAL_MS = String(normalizeDelayMs(Number(config.trackingRequestDelayMs) >= DEFAULT_TRACKING_REQUEST_INTERVAL_MS ? config.trackingRequestDelayMs : DEFAULT_TRACKING_REQUEST_INTERVAL_MS));
  const trackingRunId = diagnosticMode ? null : claimDb.startRun(DB_PATH, 'tracking', { fresh: Boolean(options.fresh), apiEnvironment: trackingApiEnvironment });
  if (trackingRunId) envBase.TRACKING_RUN_ID = String(trackingRunId);

  const trackingProcess = spawnJsonProcess('tracking', {
    resolution: workerPreflight.resolution,
    env: { ...envBase, ELECTRON_RUN_AS_NODE: '1', ...buildClaimSettingsEnv(options, config) },
    stdinJson: {
      clientId: trackingApiFiles.clientId,
      clientSecret: trackingApiFiles.clientSecret,
      environment: trackingApiFiles.environment
    }
  }, 'tracking', logPath, {
    onSpawn: () => {
      emit('run', { status: 'started', logPath });
      appendLog(logPath, `Canada Post ${diagnosticMode ? 'one-request diagnostic' : 'tracking check'} started ${new Date().toISOString()}\nStep tabs version: ${STEP_TABS_VERSION}\nTracking API version: ${TRACKING_API_VERSION}\nAPI environment: ${trackingApiEnvironment}\n`);
    }
  });
  const started = await trackingProcess.started;
  if (!started.ok) {
    const failed = await trackingProcess;
    if (trackingRunId) claimDb.finishRun(DB_PATH, trackingRunId, 'failed', { failure: 1 }, { error: failed.error?.message || 'Worker spawn failed.' });
    return { ok: false, error: failed.error?.message || 'Tracking worker could not be started.' };
  }

  (async () => {
    try {
      const trackingResult = await trackingProcess;
      if (!trackingResult.ok) {
        const circuit = trackingResult.lastEventsByType?.tracking_circuit_open;
        const semantic = trackingResult.lastEventsByType?.tracking_semantic_circuit_open;
        const aborted = trackingResult.lastEventsByType?.tracking_aborted;
        const message = aborted?.message || circuit?.message || semantic?.message || `Tracking stage failed with code ${trackingResult.code}.`;
        const blocked = Boolean(circuit || semantic || aborted?.queuePreserved);
        if (trackingRunId) claimDb.finishRun(DB_PATH, trackingRunId, blocked ? 'blocked' : 'failed', { failure: Number(aborted?.errorCount || circuit?.errors || 1) }, { code: trackingResult.code, circuit, semantic, aborted });
        emit('run', { status: blocked ? 'blocked' : 'failed', message, logPath });
        return;
      }

      if (diagnosticMode) {
        const completed = trackingResult.lastEventsByType?.tracking_diagnostic_complete || {};
        if (completed.status !== 'DIAGNOSTIC_COMPLETE' || Number(completed.checked || 0) !== 1) {
          emit('run', { status: 'failed', messageKey: 'event.tracking.diagnosticFailed', message: 'One-request Tracking API diagnostic did not complete successfully. State was not modified.', logPath });
          return;
        }
        const latest = readConfig();
        writeConfig(trackingDiagnosticGate.markSucceeded(latest, trackingApiEnvironment, { apiVersion: TRACKING_API_VERSION, parserVersion: TRACKING_PARSER_VERSION }));
        const diagnostic = trackingResult.lastEventsByType?.tracking_diagnostic || {};
        emit('run', { status: 'diagnostic_complete', messageKey: structureExport ? 'event.tracking.structureExported' : 'event.tracking.diagnosticComplete', message: structureExport ? 'Sanitized response structure exported. Claim and queue state were not modified.' : 'One-request semantic API diagnostic complete. Claim and queue state were not modified.', structureReportPath: diagnostic.structureReportPath || '', logPath });
        return;
      }

      if (fs.existsSync(STOP_FILE)) {
        claimDb.finishRun(DB_PATH, trackingRunId, 'stopped', {}, trackingResult.lastEvent || {});
        emit('run', { status: 'stopped', messageKey: 'event.tracking.stopped', message: 'Stopped during tracking stage.', logPath });
        return;
      }

      const claimsPath = path.join(DATA_DIR, 'claims.csv');
      const hasClaims = fs.existsSync(claimsPath) && fs.readFileSync(claimsPath, 'utf8').trim().split(/\r?\n/).length >= 2;
      const summary = trackingResult.lastEventsByType?.tracking_complete || {};
      const promotionProof = validatePromotedTrackingSummary(summary);
      if (!promotionProof.ok) {
        claimDb.finishRun(DB_PATH, trackingRunId, 'blocked', { failure: 1 }, { reason: promotionProof.reason });
        emit('run', { status: 'blocked', message: `${promotionProof.reason} Step 3 remains blocked until Step 2 is recomputed from the beginning.`, logPath });
        return;
      }
      if (options.fresh) {
        for (const name of ['processed_pins.txt', 'claim-run-summary.json', 'stop-requested.txt']) fs.rmSync(path.join(DATA_DIR, name), { force: true });
      }
      const counts = [
        `${Number(summary.checked || 0)} shipments`,
        `${Number(summary.cachedOnTimeCount || 0)} cached on-time`,
        `${Number(summary.trackingApiRequestCount || 0)} Tracking API requests`,
        `${Number(summary.eligibleLateCount || 0)} late candidates`,
        `${Number(summary.overdueInTransitCount || 0)} overdue/in transit`,
        `${Number(summary.reviewRequiredCount || 0)} review required`,
        `${Number(summary.errorCount || 0)} errors`
      ].join(', ');
      claimDb.finishRun(
        DB_PATH,
        trackingRunId,
        Number(summary.errorCount || 0) > 0 ? 'complete_with_warnings' : 'complete',
        trackingRunCounts(summary),
        summary
      );
      emit('run', {
        status: Number(summary.errorCount || 0) > 0 ? 'complete_with_warnings' : 'complete',
        message: `${localizedText('step2.runComplete', { counts }, 'STEP2_RUN_COMPLETE')} ${localizedText(hasClaims ? 'step2.runCompleteCandidates' : 'step2.runCompleteNoCandidates')}`,
        logPath
      });
    } catch (error) {
      if (trackingRunId) {
        try { claimDb.finishRun(DB_PATH, trackingRunId, 'failed', { failure: 1 }, { error: error.message }); } catch (_) {}
      }
      emit('run', { status: 'failed', message: error.message, logPath });
    }
  })();

  return { ok: true, logPath };
});

registerIpcHandler('submit:run', async (_event, rawOptions = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'Live claim submission is disabled while isolated test data is active.' };
  ensureDirs();
  hideBuiltinBrowserView('submission-validation');
  let options;
  try { options = inputValidation.validateSubmitOptions(rawOptions); }
  catch (error) { return { ok: false, error: error.message, code: error.code || 'SUBMIT_OPTIONS_INVALID' }; }

  if (activeChild) {
    return { ok: false, error: 'A process is already active.' };
  }
  const initialPreflight = runPreflight({ scope: 'step3', submitOptions: options });
  if (!initialPreflight.report.ready) return blockedStep3Preflight(initialPreflight);
  const authoritativeTracking = claimDb.latestTrackingRun(DB_PATH);
  const trackingRunGate = validateTrackingRunForSubmission(authoritativeTracking);
  if (!trackingRunGate.ok) {
    return { ok: false, error: `Step 3 is blocked because ${trackingRunGate.reason} Recompute Step 2 successfully from the beginning.` };
  }
  const workerPreflight = preflightWorkerLaunch('submitClaims');
  if (!workerPreflight.ok) return workerPreflight;

  fs.rmSync(STOP_FILE, { force: true });

  const config = readConfig();
  const credentials = resolveWebCredentials(options, config);
  const webUsername = credentials.username;
  const webPassword = credentials.password;

  if (!webUsername || !webPassword) {
    return { ok: false, error: 'Missing Canada Post web login username/password.' };
  }

  const claimSettingsEnv = buildClaimSettingsEnv(options, config);
  const claimSettingsValid = validateClaimSettings(claimSettingsEnv);
  if (!claimSettingsValid.ok) return claimSettingsValid;

  const requestedClassificationRecords = options.selectedClassificationRecords;
  if (!requestedClassificationRecords.length) {
    return { ok: false, error: 'No late-delivery candidates are selected. Refresh the Step 3 candidate queue and select at least one candidate.', code: 'STEP3_SELECTION_EMPTY' };
  }
  if (options.expectedClaimCount !== requestedClassificationRecords.length) {
    return { ok: false, error: 'The Step 3 candidate selection changed before the run started. Refresh the candidate queue and confirm the selection again.', code: 'STEP3_SELECTION_COUNT_CHANGED' };
  }
  let selectedClassificationRecords;
  try { selectedClassificationRecords = step3QueueService.selectionForRun(requestedClassificationRecords); }
  catch (error) { return { ok: false, error: localizedStep3Error(error), code: error.code || 'STEP3_SELECTION_INVALID' }; }

  const nextConfig = saveRememberedUserSettings({ ...config, developerMode: false }, options, claimSettingsEnv);
  delete nextConfig.dryRunDefault;
  writeConfig(nextConfig);
  persistPasswordFromOptions(options, nextConfig);

  const logPath = path.join(LOG_DIR, `submit-${timestamp()}.log`);

  let submissionOperationToken;
  try {
    submissionOperationToken = operationCoordinator.begin('step3_live_run');
  } catch (error) {
    return { ok: false, error: error.message, code: error.code || 'PROTECTED_OPERATION_BLOCKED' };
  }
  const submitRunId = claimDb.startRun(DB_PATH, 'submission', {
    dryRun: false,
    selectedClaimCount: selectedClassificationRecords.length,
    requestedSelectedClaimCount: requestedClassificationRecords.length
  });
  const privateSnapshotDirectory = path.join(DATA_DIR, 'private-step3-snapshots', `run-${submitRunId}`);
  fs.mkdirSync(privateSnapshotDirectory, { recursive: true, mode: 0o700 });
  const selectedClaimsPath = path.join(privateSnapshotDirectory, 'worker-claims.csv');
  const queueSnapshotPath = path.join(privateSnapshotDirectory, 'queue-snapshot.json');
  const finalPreflight = runPreflight({ scope: 'step3', submitOptions: options });
  if (!finalPreflight.report.ready) {
    fs.rmSync(privateSnapshotDirectory, { recursive: true, force: true });
    claimDb.finishRun(DB_PATH, submitRunId, 'blocked', { failure: 1 }, { stage: 'last-moment-preflight' });
    operationCoordinator.end(submissionOperationToken);
    return blockedStep3Preflight(finalPreflight);
  }
  let selectedClaims;
  let queueSnapshotId = null;
  try {
    selectedClaims = step3QueueService.createRunSnapshot(
      DB_PATH,
      selectedClassificationRecords,
      { csvPath: selectedClaimsPath, snapshotPath: queueSnapshotPath },
      { allowedDirectory: privateSnapshotDirectory, now: new Date() }
    );
    queueSnapshotId = selectedClaims.snapshotId;
  } catch (error) {
    fs.rmSync(privateSnapshotDirectory, { recursive: true, force: true });
    claimDb.finishRun(DB_PATH, submitRunId, 'failed', { failure: 1 }, { error: error.message, stage: 'claim-selection' });
    operationCoordinator.end(submissionOperationToken);
    hideBuiltinBrowserView('submission-selection-blocked');
    return {
      ok: false,
      error: localizedStep3Error(error),
      code: error.code || 'STEP3_SNAPSHOT_FAILED',
      recordId: error.recordId || null,
      attemptId: error.attemptId || null,
      executionState: error.executionState || ''
    };
  }
  const step3DiagnosticsRunDir = path.join(LOG_DIR, 'step3-runs', `step3-${timestamp()}-run-${submitRunId}`);
  fs.mkdirSync(step3DiagnosticsRunDir, { recursive: true, mode: 0o700 });
  activeStep3DiagnosticsDir = step3DiagnosticsRunDir;
  latestStep3DiagnosticsDir = step3DiagnosticsRunDir;
  activeBrowserVisibilityFile = path.join(step3DiagnosticsRunDir, 'browser-visibility.json');
  let browserHandshake;
  try {
    browserHandshake = await prepareBuiltinBrowserForWorker({ reason: 'submission' });
    await requestBuiltinBrowserVisibility({
      reason: 'main-handshake-complete',
      requireVisible: true,
      scrollIntoView: true,
      timeoutMs: 6000
    });
    const displayReady = browserVisibilityWatchdog();
    if (!displayReady.ready) {
      const error = new Error('The Step 3 browser target is ready, but its native view cannot be displayed inside the browser slot.');
      error.code = 'BROWSER_VISIBILITY_REQUIRED';
      throw error;
    }
    appendStep3ElectronDiagnostic('worker-browser-display-ready', {
      webContentsIdentityHash: displayReady.webContentsIdentityHash,
      appliedBounds: displayReady.bounds,
      childViewIndex: displayReady.childViewIndex,
      currentUrl: displayReady.currentUrl
    });
  } catch (error) {
    appendStep3ElectronDiagnostic('worker-browser-handshake-failed', {
      code: error.code || 'BROWSER_HANDSHAKE_FAILED',
      message: error.message
    });
    activeStep3DiagnosticsDir = '';
    activeBrowserVisibilityFile = '';
    hideBuiltinBrowserView('browser-handshake-failed');
    fs.rmSync(privateSnapshotDirectory, { recursive: true, force: true });
    claimDb.finishRun(DB_PATH, submitRunId, 'failed', { failure: 1 }, {
      stage: 'browser-handshake',
      errorCode: error.code || 'BROWSER_HANDSHAKE_FAILED',
      error: error.message
    });
    operationCoordinator.end(submissionOperationToken);
    return { ok: false, error: error.message, code: error.code || 'BROWSER_HANDSHAKE_FAILED' };
  }
  const envBase = {
    DATA_DIR,
    STOP_FILE,
    CLAIMS_CSV: selectedClaimsPath,
    QUEUE_SNAPSHOT_PATH: queueSnapshotPath,
    QUEUE_SNAPSHOT_ID: String(queueSnapshotId || ''),
    CANADAPOST_SECRETS_STDIN: '1',
    AFTER_SUBMIT_MS: String(options.afterSubmitMs || 20000),
    BETWEEN_CLAIMS_MS: String(options.betweenClaimsMs || 750),
    MAX_CLAIMS: '',
    BROWSER_MODE: 'builtin',
    ELECTRON_CDP_URL: browserHandshake.endpoint,
    ELECTRON_TARGET_ID: browserHandshake.targetId,
    ELECTRON_TARGET_NONCE: browserHandshake.targetNonce,
    ELECTRON_TARGET_WEB_CONTENTS_HASH: browserHandshake.webContentsIdentityHash,
    DATABASE_PATH: DB_PATH,
    RUN_ID: String(submitRunId),
    DRY_RUN: 'false',
    APP_VERSION,
    LOG_DIR,
    STEP3_DIAGNOSTICS_ENABLED: 'true',
    STEP3_DIAGNOSTICS_RUN_DIR: step3DiagnosticsRunDir,
    BROWSER_VISIBILITY_ACK_FILE: activeBrowserVisibilityFile,
    ...claimSettingsEnv,
    DEVELOPER_MODE: 'false'
  };

  const submitProcess = spawnJsonProcess('submitClaims', {
    resolution: workerPreflight.resolution,
    env: { ...envBase, ELECTRON_RUN_AS_NODE: '1' },
    stdinJson: { username: webUsername, password: webPassword }
  }, 'submit', logPath, {
    onSpawn: () => {
      emit('run', { status: 'started', logPath });
      appendLog(logPath, `Canada Post claim submission started ${new Date().toISOString()}\nStep tabs version: ${STEP_TABS_VERSION}\nSelected claims: ${selectedClaims.count}\n`);
      appendStep3ElectronDiagnostic('submission-run-started', {
        runId: submitRunId,
        dryRun: false,
        browserMode: 'builtin',
        selectedClaimCount: selectedClaims.count,
        logPath
      });
    },
    onEvent: event => {
      if (event?.type === 'diagnostics_started') {
        latestStep3DiagnosticsDir = String(event.directory || step3DiagnosticsRunDir);
        emit('event', { stage: 'submit', event: { type: 'log', messageKey: 'event.submit.diagnosticsPath', messageValues: { path: latestStep3DiagnosticsDir }, message: `Detailed Step 3 diagnostics: ${latestStep3DiagnosticsDir}` } });
      }
      if (event?.type === 'manual_verification_required') {
        handleManualBrowserVisibilityRequest(event).catch(error => {
          appendStep3ElectronDiagnostic('verification-browser-display-failed', { code: error.code || 'BROWSER_VISIBILITY_REQUIRED', message: error.message });
          if (activeChild && activeStage === 'submit') sendStopSignalToChild(activeChild, { force: false });
        });
      }
    },
    onClose: ({ code, signal, eventCounts }) => {
      claimDb.markInterruptedAttempts(DB_PATH);
      appendStep3ElectronDiagnostic('submission-worker-closed', { code, signal, eventCounts });
      activeStep3DiagnosticsDir = '';
      activeBrowserVisibilityFile = '';
      hideBuiltinBrowserView('submission-worker-closed');
      fs.rmSync(privateSnapshotDirectory, { recursive: true, force: true });
    }
  });
  const started = await submitProcess.started;
  if (!started.ok) {
    const failed = await submitProcess;
    activeStep3DiagnosticsDir = '';
    activeBrowserVisibilityFile = '';
    hideBuiltinBrowserView('submission-worker-start-failed');
    fs.rmSync(privateSnapshotDirectory, { recursive: true, force: true });
    claimDb.finishRun(DB_PATH, submitRunId, 'failed', { failure: 1 }, { error: failed.error?.message || 'Worker spawn failed.' });
    operationCoordinator.end(submissionOperationToken);
    return { ok: false, error: failed.error?.message || 'Submission worker could not be started.' };
  }

  (async () => {
    try {
      const submitResult = await submitProcess;
      const summary = submitResult.lastEventsByType?.submit_complete || {};
      const counts = {
        total: Number(summary.total || 0),
        success: Number(summary.succeeded || summary.dryRunReady || 0),
        warning: Number(summary.alreadySubmitted || 0) + Number(summary.rejected || 0),
        failure: Number(summary.failed || (submitResult.ok ? 0 : 1))
      };
      claimDb.finishRun(DB_PATH, submitRunId, submitResult.ok ? 'complete' : 'failed', counts, summary);
      if (!submitResult.ok) {
        emit('run', { status: 'failed', messageKey: 'event.submit.stageFailed', messageValues: { code: submitResult.code }, message: `Submit stage failed with code ${submitResult.code}.`, logPath });
        return;
      }

      emit('run', { status: 'complete', messageKey: 'event.submit.claimComplete', message: 'Claim submission complete.', logPath });
    } catch (error) {
      appendStep3ElectronDiagnostic('submission-run-error', { message: error.message, stack: error.stack });
      activeStep3DiagnosticsDir = '';
      activeBrowserVisibilityFile = '';
      hideBuiltinBrowserView('submission-run-error');
      fs.rmSync(privateSnapshotDirectory, { recursive: true, force: true });
      try { claimDb.finishRun(DB_PATH, submitRunId, 'failed', { failure: 1 }, { error: error.message }); } catch (_) {}
      emit('run', { status: 'failed', message: error.message, logPath });
    } finally {
      operationCoordinator.end(submissionOperationToken);
    }
  })();

  return { ok: true, logPath, diagnosticsDir: step3DiagnosticsRunDir, selectedClaimCount: selectedClaims.count };
});

registerIpcHandler('run:requestStop', () => {
  ensureDirs();
  fs.writeFileSync(STOP_FILE, new Date().toISOString() + '\n');
  emit('event', { stage: activeStage, event: { type: 'stop_requested', messageKey: 'event.stopRequested', message: 'Stop requested. The runner will stop after the current item.' } });
  return { ok: true };
});

registerIpcHandler('run:forceStop', () => {
  ensureDirs();
  fs.writeFileSync(STOP_FILE, new Date().toISOString() + '\n', { mode: 0o600 });
  if (activeChild) {
    const child = activeChild;
    sendStopSignalToChild(child, { force: false });
    const timer = setTimeout(() => sendStopSignalToChild(child, { force: true }), 1500);
    if (typeof timer.unref === 'function') timer.unref();
    emit('event', { stage: activeStage, event: { type: 'force_stop', messageKey: 'event.forceStopSent', message: 'Force stop sent to the current process and its browser descendants.' } });
    return { ok: true };
  }
  return { ok: false, error: 'No active process.' };
});

async function startApplication() {
  validateMutablePathManifest(userDataBootstrap, USER_DATA_ROOT);
  fs.mkdirSync(BACKUP_RESTORE_TEMP_DIR, { recursive: true, mode: 0o700 });
  storage.migrateLegacyData();
  ensureDirs();
  updateRecovery = Object.freeze(updateInstallGuard.recoveryState(USER_DATA_ROOT));
  const migrationToken = operationCoordinator.begin('database_migration');
  try {
    await claimDb.initializeDatabase(DB_PATH, { backupDirectory: DATABASE_BACKUP_DIR });
  } finally {
    operationCoordinator.end(migrationToken);
  }
  const recoveryToken = operationCoordinator.begin('database_recovery');
  try {
    privacyDeletion.recoverInterruptedTransactions({
      dbPath: DB_PATH,
      transactionRoot: path.join(USER_DATA_ROOT, 'tmp', 'privacy-deletion'),
      ownedRoots: [DATA_DIR, LOG_DIR]
    });
  } finally {
    operationCoordinator.end(recoveryToken);
  }
  databaseReady = true;
  claimDb.importLegacyData(DB_PATH, DATA_DIR);
  claimDb.markInterruptedAttempts(DB_PATH);
  claimDb.quarantineLegacyDryRunReadyAttempts(DB_PATH);
  const databaseHealth = claimDb.integrityCheck(DB_PATH);
  const pendingUpdate = updateInstallGuard.readPendingMarker(USER_DATA_ROOT);
  if (pendingUpdate && pendingUpdate.targetVersion === APP_VERSION && databaseHealth.ok) {
    updateInstallGuard.acknowledgeHealthyStartup(USER_DATA_ROOT, { integrity: databaseHealth.result });
    updateRecovery = Object.freeze({ pending: false, acknowledged: true });
    githubReleaseUpdater.cleanupUpdateStorage(USER_DATA_ROOT, {
      keepRecent: 2,
      protectedPaths: [pendingUpdate.downloadedPath]
    });
  }
  createWindow();
  screen.on('display-metrics-changed', () => {
    if (!builtinBrowserView) return;
    requestBuiltinBrowserVisibility({ reason: 'display-metrics-changed', requireVisible: false }).catch(() => {});
  });
}

async function handleStartupFailure(error) {
  if (startupFailureHandled) return;
  startupFailureHandled = true;
  databaseReady = false;
  let diagnosticPath = '';
  const diagnostic = startupDatabase.buildDiagnostic(error);
  updateRecovery = Object.freeze(updateInstallGuard.recoveryState(USER_DATA_ROOT));
  try { diagnosticPath = startupDatabase.writeDiagnostic(LOG_DIR, diagnostic); } catch (_) {}
  const safeText = startupDatabase.diagnosticText(diagnostic);
  const details = [
    localizedText('dialog.databaseRecovery.detailIntro', {}, 'The workflow window was not opened because the local database could not be prepared safely.'),
    localizedText('dialog.databaseRecovery.backup', { path: diagnostic.backupLocation || localizedText('dialog.databaseRecovery.backupUnavailable', {}, 'Unavailable; the source database was left unchanged.') }, 'Backup: {path}'),
    localizedText('dialog.databaseRecovery.diagnostic', { path: diagnosticPath || localizedText('dialog.databaseRecovery.diagnosticUnavailable', {}, 'Could not write the local diagnostic file.') }, 'Diagnostic: {path}'),
    '',
    localizedText('dialog.databaseRecovery.privacy', {}, 'No database contents or credentials are included in this diagnostic.')
  ].join('\n');
  const recoveryDetails = updateRecovery.pending
    ? `\n\n${localizedText('dialog.databaseRecovery.updatePreserved', {
      backup: localizedText(updateRecovery.backupPreserved ? 'common.yes' : 'common.no'),
      executable: localizedText(updateRecovery.previousExecutablePreserved ? 'common.yes' : 'common.no')
    }, 'A pending update was preserved. Pre-update backup available: {backup}. Previous executable available: {executable}.')}`
    : '';
  try {
    const choice = await dialog.showMessageBox({
      type: 'error',
      title: localizedText('dialog.databaseRecovery.title', {}, 'Database recovery required'),
      message: localizedText('dialog.databaseRecovery.message', {}, 'Canada Post Claim Runner could not start safely.'),
      detail: `${details}${recoveryDetails}`,
      buttons: [localizedText('dialog.databaseRecovery.openData', {}, 'Open data folder'), localizedText('dialog.databaseRecovery.copyDiagnostic', {}, 'Copy diagnostic'), localizedText('dialog.databaseRecovery.exit', {}, 'Exit')],
      defaultId: 2,
      cancelId: 2,
      noLink: true
    });
    if (choice.response === 0) await shell.openPath(USER_DATA_ROOT);
    if (choice.response === 1) clipboard.writeText(`${safeText}\n${localizedText('dialog.databaseRecovery.diagnosticFile', { path: diagnosticPath || localizedText('common.unavailable', {}, 'unavailable') }, 'Diagnostic file: {path}')}`);
  } catch (_) {
    // Startup recovery is best effort; always terminate instead of remaining hidden.
  } finally {
    app.exit(1);
  }
}

app.whenReady()
  .then(startApplication)
  .catch(error => handleStartupFailure(error))
  .catch(() => app.exit(1));

app.on('before-quit', event => {
  try {
    operationCoordinator.assertInactive();
  } catch (error) {
    event.preventDefault();
    if (!isShuttingDown) {
      const focused = BrowserWindow.getFocusedWindow();
      const bundle = i18n.loadLocale(readConfig().locale || 'en-CA');
      const operation = i18n.translate(bundle, `operation.${error.operation}`, error.operation);
      const message = i18n.interpolate(i18n.translate(bundle, 'update.exitBlocked.message', 'UPDATE_EXIT_BLOCKED'), { operation });
      dialog.showMessageBox(focused || undefined, { type: 'warning', title: i18n.translate(bundle, 'update.blocked.title', 'Close blocked'), message, buttons: [i18n.translate(bundle, 'action.continue', 'Continue')] }).catch(() => {});
    }
    return;
  }
  if (isShuttingDown) return;
  isShuttingDown = true;
  stopActiveChildForShutdown();
  destroyBuiltinBrowserView();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (databaseReady && BrowserWindow.getAllWindows().length === 0) createWindow();
});

module.exports = { registerIpcHandler };
