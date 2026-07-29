const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, clipboard, Menu, session } = require('electron');
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
const claimQueue = require('./lib/claim-queue');
const { buildPreflightReport } = require('./lib/preflight');
const { classifyEligibility, policy: eligibilityPolicy } = require('./lib/policy-engine');
const { createQueueSnapshot } = require('./lib/eligibility-revalidation');
const { isAllowedCanadaPostUrl, portalUrl } = require('./lib/origin-policy');
const { parseDecimalToMinor } = require('./lib/money');
const i18n = require('./lib/i18n');
const runtimeWorkers = require('./lib/runtime-workers');
const { credentialMetadata: trackingCredentialMetadata, normalizeEnvironment: normalizeTrackingEnvironment, normalizeResourceTimeoutMs, TRACKING_API_VERSION, DEFAULT_RESOURCE_TIMEOUT_MS } = require('./lib/tracking-client');
const trackingDiagnosticGate = require('./lib/tracking-diagnostic-gate');
const { TRACKING_PARSER_VERSION } = require('./lib/tracking-json');
const { DEFAULT_DELAY_MS, normalizeDelayMs } = require('./lib/tracking-rate-limiter');
const { restorePreviousTextFiles, validatePromotedTrackingSummary, validateTrackingRunForSubmission } = require('./lib/tracking-run-staging');
const { rowsAsObjects } = require('./lib/csv');

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
const APP_VERSION = require('./package.json').version;
const DEFAULT_TRACKING_REQUEST_INTERVAL_MS = DEFAULT_DELAY_MS;
const BUILTIN_BROWSER_CDP_PORT = String(process.env.CANADAPOST_ELECTRON_CDP_PORT || crypto.randomInt(20000, 48000));
const BUILTIN_BROWSER_CDP_URL = `http://127.0.0.1:${BUILTIN_BROWSER_CDP_PORT}`;
const BUILTIN_BROWSER_TARGET_TOKEN = crypto.randomUUID();
const CANADAPOST_LOGIN_URL = portalUrl('https://www.canadapost-postescanada.ca/lfe-cap/en/login?stepupId=smb_mode1,consumer,commercial_link,smb_link&sourceUrl=https:%2F%2Fwww.canadapost-postescanada.ca%2Fdash%2Fen&targetUrl=https:%2F%2Fwww.canadapost-postescanada.ca%2Fdash%2Fen&authlvl=&language=en', '/login');

function bundledPlaywrightBrowserPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'playwright-core', '.local-browsers')
    : path.join(ROOT, 'node_modules', 'playwright-core', '.local-browsers');
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
let isShuttingDown = false;
let databaseReady = false;
let startupFailureHandled = false;
let activeStep3DiagnosticsDir = '';
let latestStep3DiagnosticsDir = '';
let lastBrowserBoundsDiagnosticAt = 0;
let pendingRestorePath = '';


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
  try {
    if (win && !win.isDestroyed() && builtinBrowserAttached) win.contentView.removeChildView(builtinBrowserView);
  } catch (_) {}
  try {
    if (!builtinBrowserView.webContents.isDestroyed()) builtinBrowserView.webContents.close({ waitForBeforeUnload: false });
  } catch (_) {
    try { builtinBrowserView.webContents.destroy(); } catch (_) {}
  }
  builtinBrowserView = null;
  builtinBrowserAttached = false;
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

function ensureBuiltinBrowserView() {
  if (!win || win.isDestroyed()) throw new Error('Main window is not available.');
  if (builtinBrowserView && !builtinBrowserView.webContents.isDestroyed()) return builtinBrowserView;

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
      emit('event', { stage: 'submit', event: { type: 'log', message: 'Blocked an unexpected download from the built-in browser.' } });
    });
  }

  builtinBrowserView.webContents.on('will-attach-webview', event => {
    event.preventDefault();
    appendStep3ElectronDiagnostic('webview-attachment-blocked');
  });

  const markBuiltinTarget = () => {
    if (!builtinBrowserView || builtinBrowserView.webContents.isDestroyed()) return;
    builtinBrowserView.webContents.executeJavaScript(
      `window.name = ${JSON.stringify(BUILTIN_BROWSER_TARGET_TOKEN)}; true`,
      true
    ).catch(() => {});
  };

  builtinBrowserView.webContents.setWindowOpenHandler(({ url }) => {
    appendStep3ElectronDiagnostic('new-window-request', { url, allowed: isAllowedCanadaPostUrl(url) });
    if (isAllowedCanadaPostUrl(url)) builtinBrowserView.webContents.loadURL(url).catch(() => {});
    else emit('event', { stage: 'submit', event: { type: 'error', message: 'Blocked built-in browser navigation outside Canada Post.' } });
    return { action: 'deny' };
  });
  builtinBrowserView.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedCanadaPostUrl(url)) {
      event.preventDefault();
      appendStep3ElectronDiagnostic('navigation-blocked', { url });
      emit('event', { stage: 'submit', event: { type: 'error', message: 'Blocked built-in browser navigation outside Canada Post.' } });
    }
  });

  builtinBrowserView.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    appendStep3ElectronDiagnostic('did-start-navigation', { url, isInPlace, isMainFrame });
    if (isMainFrame) emitBuiltinBrowserActivity(true, 'Navigating Canada Post…');
  });

  builtinBrowserView.webContents.on('did-start-loading', () => {
    appendStep3ElectronDiagnostic('did-start-loading', { url: builtinBrowserView?.webContents.getURL() });
    emitBuiltinBrowserActivity(true, 'Loading Canada Post…');
  });

  builtinBrowserView.webContents.on('dom-ready', () => {
    appendStep3ElectronDiagnostic('dom-ready', { url: builtinBrowserView?.webContents.getURL() });
    markBuiltinTarget();
    emitBuiltinBrowserActivity(true, 'Rendering Canada Post page…');
  });

  builtinBrowserView.webContents.on('did-stop-loading', () => {
    appendStep3ElectronDiagnostic('did-stop-loading', { url: builtinBrowserView?.webContents.getURL() });
    emitBuiltinBrowserActivity(false, 'Canada Post page ready');
  });

  builtinBrowserView.webContents.on('did-finish-load', () => {
    appendStep3ElectronDiagnostic('did-finish-load', { url: builtinBrowserView?.webContents.getURL() });
    emitBuiltinBrowserActivity(false, 'Canada Post page ready');
  });

  builtinBrowserView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (!isMainFrame || Number(errorCode) === -3) return;
    appendStep3ElectronDiagnostic('did-fail-load', { errorCode, errorDescription, validatedUrl: _validatedUrl, isMainFrame });
    emitBuiltinBrowserActivity(false, `Browser load warning: ${errorDescription}`, 'error');
    emit('event', { stage: 'submit', event: { type: 'log', message: `Built-in browser load warning: ${errorCode} ${errorDescription}` } });
  });

  builtinBrowserView.webContents.on('unresponsive', () => {
    appendStep3ElectronDiagnostic('unresponsive', { url: builtinBrowserView?.webContents.getURL() });
    emitBuiltinBrowserActivity(false, 'Canada Post browser is not responding', 'error');
    emit('event', { stage: 'submit', event: { type: 'error', message: 'The built-in Canada Post browser became unresponsive.' } });
  });

  builtinBrowserView.webContents.on('responsive', () => {
    appendStep3ElectronDiagnostic('responsive', { url: builtinBrowserView?.webContents.getURL() });
    emitBuiltinBrowserActivity(false, 'Canada Post browser recovered');
  });

  builtinBrowserView.webContents.on('render-process-gone', (_event, details = {}) => {
    appendStep3ElectronDiagnostic('render-process-gone', details);
    emitBuiltinBrowserActivity(false, 'Canada Post browser process stopped', 'error');
    emit('event', { stage: 'submit', event: { type: 'error', message: `The built-in Canada Post browser process stopped (${details.reason || 'unknown reason'}). Any active claim will require reconciliation.` } });
  });

  return builtinBrowserView;
}

function attachBuiltinBrowserView() {
  const view = ensureBuiltinBrowserView();
  if (!builtinBrowserAttached) {
    win.contentView.addChildView(view);
    builtinBrowserAttached = true;
  }
  return view;
}

function hideBuiltinBrowserView() {
  if (!win || win.isDestroyed() || !builtinBrowserView) return;
  try {
    if (builtinBrowserAttached) win.contentView.removeChildView(builtinBrowserView);
  } catch (_) {}
  builtinBrowserAttached = false;
}

function setBuiltinBrowserBounds(bounds) {
  const view = attachBuiltinBrowserView();
  const normalized = normalizeBounds(bounds);
  view.setBounds(normalized);
  if (Date.now() - lastBrowserBoundsDiagnosticAt >= 1000) {
    lastBrowserBoundsDiagnosticAt = Date.now();
    appendStep3ElectronDiagnostic('browser-view-bounds', normalized);
  }
}

async function showBuiltinBrowser(bounds) {
  const view = attachBuiltinBrowserView();
  setBuiltinBrowserBounds(bounds);
  const currentUrl = view.webContents.getURL();
  appendStep3ElectronDiagnostic('browser-view-show', { currentUrl, bounds });
  if (!currentUrl || currentUrl === 'about:blank' || !isAllowedCanadaPostUrl(currentUrl)) {
    emitBuiltinBrowserActivity(true, 'Opening Canada Post login…');
    await view.webContents.loadURL(CANADAPOST_LOGIN_URL);
  }
  return { ok: true, cdpUrl: BUILTIN_BROWSER_CDP_URL, webContentsId: view.webContents.id, targetToken: BUILTIN_BROWSER_TARGET_TOKEN };
}

function focusBuiltinBrowser() {
  if (!win || win.isDestroyed() || !builtinBrowserView || builtinBrowserView.webContents.isDestroyed()) return false;
  try {
    if (!builtinBrowserAttached) win.contentView.addChildView(builtinBrowserView);
    builtinBrowserAttached = true;
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
    customerNumber: parsed.customerNumber || parsed.customer_number || '',
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

function apiCredentialStatus(selectedEnvironment = 'production') {
  const credentials = resolveApiCredentials(selectedEnvironment);
  return {
    username: { present: Boolean(credentials.username) },
    password: { present: Boolean(credentials.password) },
    selectedEnvironment: normalizeLegacyEnvironment(selectedEnvironment),
    credentialEnvironment: credentials.environment || 'unknown',
    deprecated: true,
    activeForStep2: false
  };
}

function ensureApiCredentialFiles(selectedEnvironment = 'production') {
  const userIniRoot = path.join(ROOT, 'user.ini');
  const userIniData = path.join(DATA_DIR, 'user.ini');
  if (!fs.existsSync(userIniData) && fs.existsSync(userIniRoot)) {
    fs.copyFileSync(userIniRoot, userIniData);
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
  const publicIni = readUserIniPublicFields();
  const customerNumber = pickOptionString(options, config, 'historyCustomerNumber', 'historyCustomerNumber', publicIni.customerNumber);
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
  const publicIni = readUserIniPublicFields();
  const developerMode = Object.prototype.hasOwnProperty.call(options, 'developerMode')
    ? boolFromOption(options.developerMode)
    : boolFromOption(config.developerMode);

  return {
    EST_FROM: pickOptionString(options, config, 'estFrom', 'estFrom', config.historyFrom || ''),
    EST_TO: pickOptionString(options, config, 'estTo', 'estTo', config.historyTo || ''),
    EST_CUSTOMER_NUMBER: pickOptionString(options, config, 'estCustomerNumber', 'estCustomerNumber', publicIni.customerNumber),
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
  const launchOptions = {
    ...options,
    env: { ...options.env, PLAYWRIGHT_BROWSERS_PATH: bundledPlaywrightBrowserPath() }
  };
  const launch = runtimeWorkers.spawnResolvedWorker(resolution, launchOptions);
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

    const handleRawLine = (_source, raw) => {
      appendLog(logPath, raw);
    };

    const handleEvent = event => {
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
    playwrightAvailable: fs.existsSync(path.join(resourceRoot, 'node_modules', 'playwright')),
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
  const latestTracking = claimDb.latestTrackingRun(DB_PATH);
  if (latestTracking && !['complete', 'complete_with_warnings'].includes(latestTracking.status)) {
    return {
      count: 0,
      items: [],
      blocked: true,
      reason: 'INCOMPLETE_TRACKING_RUN',
      message: 'Step 3 is blocked until Step 2 is recomputed and completes successfully.'
    };
  }
  return claimQueue.previewClaims(path.join(DATA_DIR, 'claims.csv'));
}

function diagnosticSensitiveValues(config = {}) {
  return [
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

ipcMain.handle('preflight:run', (_event, rawOptions = {}) => {
  ensureDirs();
  const options = inputValidation.validatePreflightOptions(rawOptions);
  const config = readConfig();
  const submitted = options.submitOptions || {};
  const dependencies = dependencyStatus();
  const preview = currentClaimPreview();
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
    step3WorkersAvailable: workerReady('siteHealth') && workerReady('submitClaims'),
    apiCredentialsAvailable: storage.trackingApiCredentialsStored(),
    apiCredentialMetadata: trackingApiCredentialStatus(trackingEnvironment),
    legacyApiCredentialsAvailable: storage.apiCredentialsStored(),
    trackingDiagnosticGateSatisfied: trackingDiagnosticGateSatisfied(config, trackingEnvironment),
    trackingCsvAvailable: fs.existsSync(path.join(DATA_DIR, 'tracking.csv')),
    webUsernameAvailable: Boolean(String(submitted.webUsername || config.webUsername || '').trim()),
    webPasswordAvailable: Boolean(submitted.webPassword || storage.passwordStored()),
    claimAddressAvailable: Boolean(String(submitted.claimStreetNumber || config.claimStreetNumber || '').trim() && String(submitted.claimStreetName || config.claimStreetName || '').trim()),
    claimCount: preview.count,
    builtinBrowserRequired: true,
    reconciliationCount
  });
  return { ok: true, report, claimPreview: preview };
});

ipcMain.handle('claims:preview', () => {
  ensureDirs();
  try {
    return { ok: true, ...currentClaimPreview() };
  } catch (error) {
    return { ok: false, error: error.message, count: 0, items: [] };
  }
});

ipcMain.handle('tracking:discardIncomplete', (_event, payload = {}) => {
  if (payload.confirmed !== true) return { ok: false, error: 'Confirmation is required.' };
  if (activeChild) return { ok: false, error: 'Stop the active process before discarding an incomplete Step 2 run.' };
  const result = claimDb.discardIncompleteTrackingRun(DB_PATH);
  if (!result.discarded) return { ok: true, ...result, message: 'No incomplete Step 2 run was found.' };
  const fileRestore = restorePreviousTextFiles(path.join(DATA_DIR, 'tracking-runs', `run-${result.runId}`), DATA_DIR);
  return {
    ok: true,
    ...result,
    fileRestore,
    message: `Incomplete Step 2 run discarded. Its history was preserved${fileRestore.restored ? ' and the preceding completed output files were restored' : ''}; Step 3 remains blocked until a new Step 2 run completes.`
  };
});

ipcMain.handle('browser:showBuiltin', async (_event, options = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'The live claim browser is disabled while isolated test data is active.' };
  try {
    return await showBuiltinBrowser(options.bounds || options);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('browser:setBuiltinBounds', (_event, bounds = {}) => {
  try {
    if (!builtinBrowserView || !builtinBrowserAttached) return { ok: true, hidden: true };
    setBuiltinBrowserBounds(bounds);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('browser:hideBuiltin', () => {
  hideBuiltinBrowserView();
  return { ok: true };
});

ipcMain.handle('browser:focusBuiltin', () => {
  return { ok: focusBuiltinBrowser() };
});

ipcMain.handle('browser:sessionStatus', async () => {
  if (USER_DATA_PROFILE.active) return { ok: true, exists: false, cookieCount: 0, disabled: true };
  const browserSession = session.fromPartition('persist:canadapost-claims-builtin');
  const cookies = await browserSession.cookies.get({}).catch(() => []);
  return { ok: true, exists: cookies.length > 0, cookieCount: cookies.length };
});

ipcMain.handle('browser:clearSession', async (_event, payload = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'Browser profile actions are disabled while isolated test data is active.' };
  if (payload.confirmed !== true) return { ok: false, error: 'Confirmation is required.' };
  if (activeChild) return { ok: false, error: 'Stop the active process before clearing browser data.' };
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

ipcMain.handle('config:load', () => {
  ensureDirs();
  const config = storage.publicConfig();
  const apiEnvironment = normalizeLegacyEnvironment(config.apiEnvironment || 'production');
  const trackingApiEnvironment = normalizeTrackingEnvironment(config.trackingApiEnvironment || 'test');
  return {
    ...config,
    apiEnvironment,
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
    hasApiCredentials: (() => { const api = resolveApiCredentials(apiEnvironment); return Boolean(api.username && api.password); })(),
    apiCredentialMetadata: apiCredentialStatus(apiEnvironment),
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
    setupReadiness: (() => {
      const saved = storage.publicConfig();
      let browserAvailable = false;
      try { browserAvailable = fs.existsSync(bundledPlaywrightBrowserPath()); } catch (_) {}
      return {
        dataDirectory: applicationStorageWritable(),
        secureStorage: storage.credentialBackend() !== 'unavailable',
        accountFields: Boolean(saved.webUsername),
        apiFields: storage.trackingApiCredentialsStored() && trackingDiagnosticGateSatisfied(saved, trackingApiEnvironment),
        customerNumber: Boolean(saved.estCustomerNumber || saved.historyCustomerNumber),
        senderInformation: Boolean(saved.claimStreetNumber && saved.claimStreetName && saved.claimPostalCode),
        contactInformation: Boolean(saved.claimContactName && (saved.claimContactEmail || saved.claimContactPhone)),
        browserAvailable,
        databaseHealth: claimDb.integrityCheck(DB_PATH).ok,
        policyAvailable: Boolean(eligibilityPolicy?.dataVersion),
        networkReadiness: 'not_tested',
        credentialsLiveTested: false
      };
    })(),
    ...readUserIniPublicFields()
  };
});

ipcMain.handle('config:save', (_event, input = {}) => {
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
  sanitized.apiEnvironment = normalizeLegacyEnvironment(input.apiEnvironment || existing.apiEnvironment || 'production');
  sanitized.trackingApiEnvironment = normalizeTrackingEnvironment(input.trackingApiEnvironment || existing.trackingApiEnvironment || 'test');
  sanitized.trackingRequestDelayMs = trackingRequestDelayMs;
  sanitized.trackingResourceTimeoutMs = trackingResourceTimeoutMs;
  const trackingEnvironmentChanged = sanitized.trackingApiEnvironment !== normalizeTrackingEnvironment(existing.trackingApiEnvironment || 'test');
  if (activeChild && (trackingClientIdSupplied || trackingEnvironmentChanged)) {
    return { ok: false, error: 'Stop the active process before changing Tracking API credentials or environment.' };
  }
  let next = { ...existing, ...sanitized };
  if (trackingClientIdSupplied || trackingEnvironmentChanged) next = invalidateTrackingDiagnosticGate(next, { newRevision: true });
  writeConfig(next);
  const credentialResult = persistPasswordFromOptions(input, next);
  const apiUsernameSupplied = Boolean(String(input.apiUsername || '').trim());
  const apiPasswordSupplied = Boolean(String(input.apiPassword || '').trim());
  if (apiUsernameSupplied !== apiPasswordSupplied) {
    return { ok: false, error: 'Enter both the Developer Program API username and API password together. The website password is never copied into these fields.' };
  }
  let apiResult = { stored: storage.apiCredentialsStored(), warning: '' };
  if (apiUsernameSupplied && apiPasswordSupplied) {
    apiResult = storage.saveApiCredentials(input.apiUsername, input.apiPassword, { environment: sanitized.apiEnvironment });
  }
  let trackingApiResult = { stored: storage.trackingApiCredentialsStored(), warning: '' };
  if (trackingClientIdSupplied && trackingClientSecretSupplied) {
    trackingApiResult = storage.saveTrackingApiCredentials(input.trackingClientId, input.trackingClientSecret, { environment: sanitized.trackingApiEnvironment });
  }
  return {
    ok: true,
    passwordStored: credentialResult.stored,
    apiCredentialsStored: apiResult.stored,
    apiCredentialMetadata: apiCredentialStatus(sanitized.apiEnvironment),
    trackingApiCredentialsStored: trackingApiResult.stored,
    trackingApiCredentialMetadata: trackingApiCredentialStatus(sanitized.trackingApiEnvironment),
    trackingDiagnosticGateSatisfied: trackingDiagnosticGateSatisfied(next, sanitized.trackingApiEnvironment),
    credentialBackend: credentialResult.backend,
    warning: credentialResult.warning || apiResult.warning || trackingApiResult.warning || ''
  };
});

ipcMain.handle('credentials:clearTrackingApi', (_event, payload = {}) => {
  if (payload.confirmed !== true) return { ok: false, error: 'Confirmation is required.' };
  if (activeChild) return { ok: false, error: 'Stop the active process before clearing Tracking API credentials.' };
  storage.clearTrackingApiCredentials();
  const next = invalidateTrackingDiagnosticGate(readConfig(), { newRevision: true });
  writeConfig(next);
  return { ok: true, trackingApiCredentialsStored: false, trackingDiagnosticGateSatisfied: false };
});

ipcMain.handle('locale:load', (_event, locale) => {
  try { return { ok: true, ...i18n.loadLocale(locale) }; }
  catch (error) { return { ok: false, error: error.message, ...i18n.loadLocale('en-CA') }; }
});

ipcMain.handle('file:selectTrackingCsv', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Select tracking.csv',
    properties: ['openFile'],
    filters: [{ name: 'CSV files', extensions: ['csv'] }]
  });

  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  const source = result.filePaths[0];
  const dest = path.join(DATA_DIR, 'tracking.csv');
  fs.copyFileSync(source, dest);
  return { ok: true, path: dest };
});

ipcMain.handle('folder:openData', async () => {
  await shell.openPath(DATA_DIR);
  return { ok: true };
});

ipcMain.handle('folder:openLogs', async () => {
  await shell.openPath(LOG_DIR);
  return { ok: true };
});

ipcMain.handle('folder:openStep3Diagnostics', async () => {
  const directory = latestStep3DiagnosticsDir || latestStep3RunDirectory();
  if (!directory || !fs.existsSync(directory)) {
    return { ok: false, error: 'No Step 3 diagnostic run exists yet.' };
  }
  latestStep3DiagnosticsDir = directory;
  const error = await shell.openPath(directory);
  return error ? { ok: false, error } : { ok: true, path: directory };
});

ipcMain.handle('updates:open', async () => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'Update actions are disabled while isolated test data is active.' };
  const config = readConfig();
  const updateUrl = String(process.env.CANADAPOST_UPDATE_URL || config.updateUrl || '').trim();
  if (!updateUrl) {
    return {
      ok: false,
      appVersion: APP_VERSION,
      error: 'No update URL is configured yet.',
      message: 'Update button is installed. Set CANADAPOST_UPDATE_URL or the saved updateUrl setting when the web update page is ready.'
    };
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(updateUrl);
  } catch (_) {
    return { ok: false, appVersion: APP_VERSION, error: 'Configured update URL is invalid.' };
  }
  if (parsedUrl.protocol !== 'https:') {
    return { ok: false, appVersion: APP_VERSION, error: 'Update URL must use HTTPS.' };
  }
  await shell.openExternal(parsedUrl.toString());
  return { ok: true, appVersion: APP_VERSION, message: `Opened update page for version ${APP_VERSION}.` };
});

function resolveEvidencePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const resolved = path.resolve(filePath);
  const allowedRoots = [DATA_DIR, LOG_DIR].map(root => path.resolve(root));
  const isAllowed = allowedRoots.some(root => resolved === root || resolved.startsWith(root + path.sep));
  return isAllowed ? resolved : null;
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

ipcMain.handle('evidence:load', (_event, payload = {}) => {
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

  const screenshotPath = resolveEvidencePath(payload.screenshotPath);
  if (screenshotPath && fs.existsSync(screenshotPath)) {
    const data = fs.readFileSync(screenshotPath).toString('base64');
    response.screenshotDataUrl = `data:${mimeFor(screenshotPath)};base64,${data}`;
    response.screenshotName = path.basename(screenshotPath);
    response.screenshotPath = screenshotPath;
  }

  const textPath = resolveEvidencePath(payload.textPath);
  if (textPath && fs.existsSync(textPath)) {
    response.pageText = fs.readFileSync(textPath, 'utf8').slice(0, 20000);
    response.textName = path.basename(textPath);
    response.textPath = textPath;
  }

  if (!response.screenshotDataUrl && !response.pageText) {
    return { ok: false, error: 'No saved evidence file was found for this result.' };
  }

  return response;
});

ipcMain.handle('evidence:open', async (_event, filePath) => {
  const resolved = resolveEvidencePath(filePath);
  if (!resolved || !fs.existsSync(resolved)) return { ok: false, error: 'Evidence file not found.' };
  const errorMessage = await shell.openPath(resolved);
  return errorMessage ? { ok: false, error: errorMessage } : { ok: true };
});



ipcMain.handle('dashboard:get', () => {
  ensureDirs();
  return { ok: true, dashboard: claimDb.dashboard(DB_PATH), integrity: claimDb.integrityCheck(DB_PATH) };
});

ipcMain.handle('financial:get', (_event, options = {}) => {
  try { return { ok: true, report: claimDb.financialReport(DB_PATH, String(options.currency || 'CAD')) }; }
  catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle('financial:record', (_event, payload = {}) => {
  try {
    const id = claimDb.recordFinancialEntry(DB_PATH, {
      trackingNumber: String(payload.trackingNumber || '').trim(),
      valueType: String(payload.valueType || ''),
      amountMinor: parseDecimalToMinor(payload.amount, 2),
      currency: String(payload.currency || 'CAD'),
      source: String(payload.source || 'manual'),
      note: String(payload.note || '')
    });
    return { ok: true, id, report: claimDb.financialReport(DB_PATH, String(payload.currency || 'CAD')) };
  } catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle('history:list', (_event, options = {}) => {
  ensureDirs();
  return { ok: true, items: claimDb.listClaimHistory(DB_PATH, options) };
});

ipcMain.handle('history:export', async (_event, options = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'External exports are disabled while isolated test data is active.' };
  const result = await dialog.showSaveDialog(win, {
    title: 'Export claim history',
    defaultPath: path.join(app.getPath('documents'), `canadapost-claim-history-${new Date().toISOString().slice(0, 10)}.csv`),
    filters: [{ name: 'CSV files', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  archiveTools.exportHistoryCsv(DB_PATH, result.filePath, options);
  return { ok: true, path: result.filePath };
});

ipcMain.handle('reconciliation:list', () => {
  ensureDirs();
  return { ok: true, items: claimDb.listReconciliation(DB_PATH, 1000) };
});

ipcMain.handle('reconciliation:update', (_event, payload = {}) => {
  try {
    const item = claimDb.reconcileAttempt(DB_PATH, payload.attemptId, String(payload.action || ''), String(payload.note || ''), String(payload.confirmationNumber || ''));
    return { ok: true, item, reconciliationCount: claimDb.listReconciliation(DB_PATH, 10000).length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('manualReview:list', (_event, options = {}) => {
  ensureDirs();
  try {
    return { ok: true, items: claimDb.listManualReviews(DB_PATH, {
      status: String(options.status || 'open').slice(0, 32),
      search: String(options.search || '').slice(0, 256),
      limit: Math.max(1, Math.min(1000, Number(options.limit || 250)))
    }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('classification:list', (_event, payload = {}) => {
  try { return { ok: true, items: claimDb.listClassificationQueue(DB_PATH, String(payload.classification || ''), payload) }; }
  catch (error) { return { ok: false, error: error.message, items: [] }; }
});

ipcMain.handle('manualReview:update', (_event, payload = {}) => {
  try {
    const reviewId = Number(payload.reviewId);
    if (!Number.isSafeInteger(reviewId) || reviewId < 1) throw new Error('Invalid manual-review identifier.');
    const action = String(payload.action || '').slice(0, 64);
    const note = String(payload.note || '').slice(0, 4096);
    return { ok: true, item: claimDb.updateManualReview(DB_PATH, reviewId, action, note) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('shipment:listManual', (_event, options = {}) => {
  ensureDirs();
  return { ok: true, items: claimDb.listManualShipments(DB_PATH, options) };
});

ipcMain.handle('shipment:manualAdd', (_event, payload = {}) => {
  try {
    const shipment = claimDb.upsertShipment(DB_PATH, {
      trackingNumber: payload.trackingNumber,
      referenceNumber: payload.referenceNumber,
      serviceCode: payload.serviceCode,
      destinationPostalCode: payload.destinationPostalCode,
      expectedDate: payload.expectedDate,
      deliveryDate: payload.deliveryDate,
      classification: payload.classification || 'MANUAL_ENTRY',
      eligibilityReason: payload.note || 'Manually entered shipment.'
    });
    return { ok: true, shipment };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('backup:create', async (_event, payload = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'Manual backup exports are disabled while isolated test data is active. The verified pre-migration backup remains inside the isolated profile.' };
  ensureDirs();
  const password = typeof payload.password === 'string' ? payload.password : '';
  if (password.length < 12 || password.length > 1024) return { ok: false, error: 'Use a backup password of at least 12 characters.' };
  const result = await dialog.showSaveDialog(win, {
    title: 'Create Canada Post Claim Runner backup',
    defaultPath: path.join(app.getPath('documents'), `canadapost-claim-runner-backup-${new Date().toISOString().slice(0, 10)}.cpcrbackup`),
    filters: [{ name: 'Encrypted Claim Runner backups', extensions: ['cpcrbackup'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
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
  }
});

ipcMain.handle('backup:restore', async (_event, payload = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'Backup restore is disabled while isolated test data is active.' };
  ensureDirs();
  if (activeChild) return { ok: false, error: 'Stop the active process before restoring a backup.' };
  if (!pendingRestorePath) {
    const result = await dialog.showOpenDialog(win, {
      title: 'Restore Canada Post Claim Runner backup',
      properties: ['openFile'],
      filters: [
        { name: 'Claim Runner backups', extensions: ['cpcrbackup', 'zip'] },
        { name: 'Legacy unencrypted ZIP backups', extensions: ['zip'] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    pendingRestorePath = result.filePaths[0];
  }
  try {
    const encrypted = encryptedBackup.isEncryptedBackup(pendingRestorePath);
    if (encrypted && (typeof payload.password !== 'string' || !payload.password)) return { ok: false, passwordRequired: true };
    if (!encrypted) {
      const warning = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['Cancel', 'Restore legacy backup'], defaultId: 0, cancelId: 0,
        title: 'Unencrypted legacy backup',
        message: 'This legacy ZIP is not encrypted or authenticated.',
        detail: 'Only restore it if you trust its source. A rollback copy will be retained.'
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
  }
});

ipcMain.handle('diagnostics:create', async () => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'External diagnostic exports are disabled while isolated test data is active.' };
  ensureDirs();
  const result = await dialog.showSaveDialog(win, {
    title: 'Create sanitized diagnostic report',
    defaultPath: path.join(app.getPath('documents'), `canadapost-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`),
    filters: [{ name: 'ZIP archives', extensions: ['zip'] }]
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
      sensitiveValues: diagnosticSensitiveValues(config)
    });
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('siteHealth:run', async (_event, options = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'Step 3 browser and site-health actions are disabled while isolated test data is active.' };
  ensureDirs();
  if (activeChild) return { ok: false, error: 'A process is already active.' };
  const workerPreflight = preflightWorkerLaunch('siteHealth');
  if (!workerPreflight.ok) return workerPreflight;
  try {
    await showBuiltinBrowser(options.bounds || {});
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const config = readConfig();
  const credentials = resolveWebCredentials(options, config);
  const logPath = path.join(LOG_DIR, `site-health-${timestamp()}.log`);
  const runId = claimDb.startRun(DB_PATH, 'site_health', { appVersion: APP_VERSION });
  const healthProcess = spawnJsonProcess('siteHealth', {
    resolution: workerPreflight.resolution,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_CDP_URL: BUILTIN_BROWSER_CDP_URL,
      ELECTRON_TARGET_TOKEN: BUILTIN_BROWSER_TARGET_TOKEN,
      CANADAPOST_SECRETS_STDIN: '1'
    },
    stdinJson: { username: credentials.username, password: credentials.password }
  }, 'health', logPath, {
    onSpawn: () => emit('run', { status: 'started', logPath }),
    stopOnEvent: event => event?.type === 'health_complete'
  });
  const started = await healthProcess.started;
  if (!started.ok) {
    const failed = await healthProcess;
    claimDb.finishRun(DB_PATH, runId, 'failed', { total: 1, failure: 1 }, { error: failed.error?.message || 'Worker spawn failed.' });
    return { ok: false, error: failed.error?.message || 'Site-health worker could not be started.' };
  }
  (async () => {
    try {
      const result = await healthProcess;
      const health = result.lastEventsByType?.health_complete || result.lastEvent || {};
      claimDb.finishRun(DB_PATH, runId, health.ok ? 'complete' : 'failed', {
        total: 1, success: health.ok ? 1 : 0, warning: health.status === 'warning' ? 1 : 0, failure: health.ok ? 0 : 1
      }, health);
      emit('run', {
        status: health.ok ? (health.status === 'warning' ? 'complete_with_warnings' : 'complete') : 'failed',
        message: health.message || (health.ok ? 'Workflow health check passed.' : 'Workflow health check failed.'),
        logPath
      });
    } catch (error) {
      claimDb.finishRun(DB_PATH, runId, 'failed', { total: 1, failure: 1 }, { error: error.message });
      emit('run', { status: 'failed', message: error.message, logPath });
    }
  })();
  return { ok: true, logPath };
});

ipcMain.handle('est:importHistory', async (_event, options = {}) => {
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
    return { ok: false, error: 'Missing Canada Post customer number. Add customerNumber=... to user.ini or enter it in the app.' };
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
        emit('run', { status: 'complete', message: 'Completed — no EST orders found for the selected date range.', logPath });
        return;
      }
      if (completed.outcome === 'IMPORTED_INCOMPLETE') {
        emit('run', { status: 'complete', message: `EST Desktop history export completed with ${Number(completed.excluded || 0)} incomplete row(s) excluded. tracking.csv contains only quality-gated rows.`, logPath });
        return;
      }
      emit('run', { status: 'complete', message: 'EST Desktop history export complete. tracking.csv was generated.', logPath });
    } catch (error) {
      emit('run', { status: 'failed', message: error.message, logPath });
    }
  })();

  return { ok: true, logPath };
});

ipcMain.handle('history:import', async (_event, options = {}) => {
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
    return { ok: false, error: 'Missing Canada Post customer number. Add customerNumber=... to user.ini or enter it in the app.' };
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
      emit('run', { status: 'complete', message: 'Shipping history import complete. tracking.csv was generated.', logPath });
    } catch (error) {
      emit('run', { status: 'failed', message: error.message, logPath });
    }
  })();

  return { ok: true, logPath };
});

ipcMain.handle('run:start', async (_event, options = {}) => {
  ensureDirs();

  if (activeChild) {
    return { ok: false, error: 'A run is already active.' };
  }
  const requiredWorkers = options.importHistory ? ['shippingHistory', 'tracking'] : ['tracking'];
  const workerResolutions = {};
  for (const workerName of requiredWorkers) {
    const preflight = preflightWorkerLaunch(workerName);
    if (!preflight.ok) return preflight;
    workerResolutions[workerName] = preflight.resolution;
  }

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

  const trackingApiEnvironment = normalizeTrackingEnvironment(config.trackingApiEnvironment || 'test');
  const trackingApiFiles = ensureTrackingApiCredentials(trackingApiEnvironment);
  if (!trackingApiFiles.ok) return trackingApiFiles;
  if (!trackingDiagnosticGateSatisfied(config, trackingApiEnvironment)) {
    return { ok: false, error: `Step 2 is blocked until “Test API connection with one shipment” succeeds for credential revision, ${trackingApiEnvironment}, and Tracking API ${TRACKING_API_VERSION}.` };
  }
  const legacyApiFiles = options.importHistory
    ? ensureApiCredentialFiles(normalizeLegacyEnvironment(config.apiEnvironment || 'production'))
    : null;
  if (legacyApiFiles && !legacyApiFiles.ok) return legacyApiFiles;

  const trackingCsv = path.join(DATA_DIR, 'tracking.csv');
  if (!options.importHistory && !fs.existsSync(trackingCsv)) {
    return { ok: false, error: `Missing ${trackingCsv}. Select, copy, or import tracking.csv first.` };
  }

  const historyEnv = buildHistoryEnv(options, config);
  if (options.importHistory) {
    if (!historyEnv.HISTORY_FROM || !historyEnv.HISTORY_TO) {
      return { ok: false, error: 'Missing shipping history date range.' };
    }
    if (!historyEnv.HISTORY_CUSTOMER_NUMBER) {
      return { ok: false, error: 'Missing Canada Post customer number. Add customerNumber=... to user.ini or enter it in the app.' };
    }
  }

  const logPath = path.join(LOG_DIR, `run-${timestamp()}.log`);
  emit('run', { status: 'started', logPath });
  appendLog(logPath, `Canada Post GUI run started ${new Date().toISOString()}\nDuplicate-claim detector active: ${DUPLICATE_CLAIM_FIX_VERSION}\nHistory import version: ${HISTORY_IMPORT_VERSION}\n`);

  const nextConfig = saveRememberedUserSettings({ ...config }, options, claimSettingsEnv);
  if (options.importHistory) {
    nextConfig.historyFrom = historyEnv.HISTORY_FROM;
    nextConfig.historyTo = historyEnv.HISTORY_TO;
    nextConfig.historyCustomerNumber = historyEnv.HISTORY_CUSTOMER_NUMBER;
    nextConfig.historyAutoMobo = boolFromOption(historyEnv.HISTORY_AUTO_MOBO);
    nextConfig.historyMobo = historyEnv.HISTORY_MOBO;
    nextConfig.historyIncludeNoManifest = options.historyIncludeNoManifest ? true : false;
  }
  nextConfig.developerMode = boolFromOption(historyEnv.DEVELOPER_MODE);
  nextConfig.dryRunDefault = Boolean(options.dryRun);
  writeConfig(nextConfig);
  persistPasswordFromOptions(options, nextConfig);

  const fullRunId = claimDb.startRun(DB_PATH, 'full', { importHistory: Boolean(options.importHistory), dryRun: Boolean(options.dryRun) });
  const envBase = {
    DATA_DIR,
    STOP_FILE,
    CLAIMS_CSV: path.join(DATA_DIR, 'claims.csv'),
    TRACKING_CSV: trackingCsv,
    TRACKING_REQUEST_INTERVAL_MS: String(normalizeDelayMs(Number(config.trackingRequestDelayMs) >= DEFAULT_TRACKING_REQUEST_INTERVAL_MS ? config.trackingRequestDelayMs : DEFAULT_TRACKING_REQUEST_INTERVAL_MS)),
    TRACKING_RESOURCE_TIMEOUT_MS: String(normalizeResourceTimeoutMs(config.trackingResourceTimeoutMs, DEFAULT_RESOURCE_TIMEOUT_MS)),
    CANADAPOST_SECRETS_STDIN: '1',
    CANADAPOST_API_ENVIRONMENT: trackingApiEnvironment,
    AFTER_SUBMIT_MS: String(options.afterSubmitMs || 20000),
    BETWEEN_CLAIMS_MS: String(options.betweenClaimsMs || 750),
    MAX_CLAIMS: options.canaryMode ? '1' : (options.maxClaims ? String(options.maxClaims) : ''),
    BROWSER_MODE: 'builtin',
    CANARY_MODE: options.canaryMode ? 'true' : 'false',
    ELECTRON_CDP_URL: BUILTIN_BROWSER_CDP_URL,
    ELECTRON_TARGET_TOKEN: BUILTIN_BROWSER_TARGET_TOKEN,
    DATABASE_PATH: DB_PATH,
    RUN_ID: String(fullRunId),
    DRY_RUN: options.dryRun ? 'true' : 'false',
    ...claimSettingsEnv,
    ...historyEnv
  };

  (async () => {
    try {
      if (options.importHistory) {
        const importResult = await spawnJsonProcess('shippingHistory', {
          resolution: workerResolutions.shippingHistory,
          env: { ...envBase, ELECTRON_RUN_AS_NODE: '1' }, stdinJson: { username: legacyApiFiles.username, password: legacyApiFiles.password, environment: legacyApiFiles.environment, usernameSource: legacyApiFiles.usernameSource, passwordSource: legacyApiFiles.passwordSource }
        }, 'history', logPath);
        if (!importResult.ok) {
          const message = importResult.code === 2
            ? 'Shipping history import found no shipments. Full run stopped so old tracking.csv is not reused.'
            : `Shipping history import failed with code ${importResult.code}.`;
          claimDb.finishRun(DB_PATH, fullRunId, 'failed', { failure: 1 }, { stage: 'history', code: importResult.code });
          emit('run', { status: 'failed', message, logPath });
          return;
        }
      }

      if (!fs.existsSync(trackingCsv)) {
        claimDb.finishRun(DB_PATH, fullRunId, 'failed', { failure: 1 }, { stage: 'tracking', error: 'tracking.csv missing' });
        emit('run', { status: 'failed', message: `Missing ${trackingCsv} after history import.`, logPath });
        return;
      }

      const trackingResult = await spawnJsonProcess(
        'tracking',
        { resolution: workerResolutions.tracking, env: { ...envBase, ELECTRON_RUN_AS_NODE: '1' }, stdinJson: { clientId: trackingApiFiles.clientId, clientSecret: trackingApiFiles.clientSecret, environment: trackingApiFiles.environment } },
        'tracking',
        logPath
      );
      if (!trackingResult.ok) {
        const circuit = trackingResult.lastEventsByType?.tracking_circuit_open;
        const semantic = trackingResult.lastEventsByType?.tracking_semantic_circuit_open;
        const aborted = trackingResult.lastEventsByType?.tracking_aborted;
        const blocked = Boolean(circuit || semantic || aborted?.queuePreserved);
        const message = aborted?.message || circuit?.message || semantic?.message || `Tracking stage failed with code ${trackingResult.code}.`;
        claimDb.finishRun(DB_PATH, fullRunId, blocked ? 'blocked' : 'failed', { failure: Number(aborted?.errorCount || circuit?.errors || 1) }, { stage: 'tracking', code: trackingResult.code, circuit, semantic, aborted });
        emit('run', { status: blocked ? 'blocked' : 'failed', message, logPath });
        return;
      }
      const trackingSummary = trackingResult.lastEventsByType?.tracking_complete || {};
      const promotionProof = validatePromotedTrackingSummary(trackingSummary);
      if (!promotionProof.ok) {
        claimDb.finishRun(DB_PATH, fullRunId, 'blocked', { failure: 1 }, { stage: 'tracking', reason: promotionProof.reason });
        emit('run', { status: 'blocked', message: `${promotionProof.reason} Step 3 remains blocked until Step 2 is recomputed from the beginning.`, logPath });
        return;
      }
      if (Number(trackingSummary.errorCount || 0) > 0) {
        claimDb.finishRun(DB_PATH, fullRunId, 'complete_with_warnings', trackingRunCounts(trackingSummary), trackingSummary);
        emit('run', {
          status: 'failed',
          message: `Tracking completed with ${trackingSummary.errorCount} lookup error(s). Claim submission was blocked until tracking is rerun successfully.`,
          logPath
        });
        return;
      }
      if (options.fresh) {
        for (const name of ['processed_pins.txt', 'claim-run-summary.json', 'stop-requested.txt']) fs.rmSync(path.join(DATA_DIR, name), { force: true });
      }
      claimDb.finishRun(DB_PATH, fullRunId, 'complete', trackingRunCounts(trackingSummary), { tracking: trackingSummary, submissionDeferredForReview: true });
      emit('run', {
        status: 'complete',
        message: 'Import and tracking complete. Review the newly classified queue and create a fresh queue snapshot before starting Step 3.',
        logPath
      });
      return;

      if (fs.existsSync(STOP_FILE)) {
        claimDb.finishRun(DB_PATH, fullRunId, 'stopped', trackingRunCounts(trackingSummary), trackingSummary);
        emit('run', { status: 'stopped', message: 'Stopped after tracking stage.', logPath });
        return;
      }

      const claimsPath = path.join(DATA_DIR, 'claims.csv');
      if (!fs.existsSync(claimsPath) || fs.readFileSync(claimsPath, 'utf8').trim().split(/\r?\n/).length < 2) {
        claimDb.finishRun(DB_PATH, fullRunId, 'complete', trackingRunCounts(trackingSummary), trackingSummary);
        emit('run', { status: 'complete', message: 'Tracking complete. No late claims found.', logPath });
        return;
      }

      const submitResult = await spawnJsonProcess(
        'submitClaims',
        {
          env: { ...envBase, ELECTRON_RUN_AS_NODE: '1' },
          stdinJson: { username: webUsername, password: webPassword }
        },
        'submit',
        logPath,
        { onClose: () => claimDb.markInterruptedAttempts(DB_PATH) }
      );
      const submitSummary = submitResult.lastEventsByType?.submit_complete || {};
      if (!submitResult.ok) {
        claimDb.finishRun(DB_PATH, fullRunId, 'failed', {
          total: Number(submitSummary.total || 0),
          success: Number(submitSummary.succeeded || 0),
          warning: Number(submitSummary.alreadySubmitted || 0) + Number(submitSummary.rejected || 0),
          failure: Number(submitSummary.failed || 1)
        }, submitSummary);
        emit('run', { status: 'failed', message: `Submit stage failed with code ${submitResult.code}.`, logPath });
        return;
      }

      claimDb.finishRun(DB_PATH, fullRunId, 'complete', {
        total: Number(submitSummary.total || trackingSummary.total || 0),
        success: Number(submitSummary.succeeded || 0),
        warning: Number(submitSummary.alreadySubmitted || 0) + Number(submitSummary.rejected || 0),
        failure: Number(submitSummary.failed || 0)
      }, { tracking: trackingSummary, submission: submitSummary, dryRun: Boolean(options.dryRun) });
      emit('run', { status: 'complete', message: options.dryRun ? 'Full dry run complete. No claims were submitted.' : 'Full run complete.', logPath });
    } catch (error) {
      try { claimDb.finishRun(DB_PATH, fullRunId, 'failed', { failure: 1 }, { error: error.message }); } catch (_) {}
      emit('run', { status: 'failed', message: error.message, logPath });
    }
  })();

  return { ok: true, logPath };
});


ipcMain.handle('tracking:run', async (_event, options = {}) => {
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
    TRACKING_DIAGNOSTIC_ROW: diagnosticMode ? String(Math.max(1, Number(options.diagnosticRow || 1))) : '',
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
          emit('run', { status: 'failed', message: 'One-request Tracking API diagnostic did not complete successfully. State was not modified.', logPath });
          return;
        }
        const latest = readConfig();
        writeConfig(trackingDiagnosticGate.markSucceeded(latest, trackingApiEnvironment, { apiVersion: TRACKING_API_VERSION, parserVersion: TRACKING_PARSER_VERSION }));
        const diagnostic = trackingResult.lastEventsByType?.tracking_diagnostic || {};
        emit('run', { status: 'diagnostic_complete', message: structureExport ? `Sanitized response structure exported. Claim and queue state were not modified.` : 'One-request semantic API diagnostic complete. Claim and queue state were not modified.', structureReportPath: diagnostic.structureReportPath || '', logPath });
        return;
      }

      if (fs.existsSync(STOP_FILE)) {
        claimDb.finishRun(DB_PATH, trackingRunId, 'stopped', {}, trackingResult.lastEvent || {});
        emit('run', { status: 'stopped', message: 'Stopped during tracking stage.', logPath });
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
        message: `Tracking check complete: ${counts}.${hasClaims ? ' claims.csv contains late-delivery candidates for Canada Post to decide.' : ' No claims are ready for submission.'}`,
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

ipcMain.handle('submit:run', async (_event, rawOptions = {}) => {
  if (USER_DATA_PROFILE.active) return { ok: false, error: 'Live claim submission is disabled while isolated test data is active.' };
  ensureDirs();
  const options = inputValidation.validateSubmitOptions(rawOptions);

  if (activeChild) {
    return { ok: false, error: 'A process is already active.' };
  }
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

  const claimsPath = path.join(DATA_DIR, 'claims.csv');
  if (!fs.existsSync(claimsPath) || fs.readFileSync(claimsPath, 'utf8').trim().split(/\r?\n/).length < 2) {
    return { ok: false, error: `Missing usable ${claimsPath}. Run Step 2 first.` };
  }

  const queuePreview = claimQueue.previewClaims(claimsPath);
  const selectedTrackingNumbers = options.selectedTrackingNumbers.length
    ? options.selectedTrackingNumbers
    : queuePreview.items.map(item => item.trackingNumber);
  if (!selectedTrackingNumbers.length) {
    return { ok: false, error: 'No eligible claims are selected. Refresh the Step 3 review queue and select at least one claim.' };
  }
  if (options.expectedClaimCount && options.expectedClaimCount !== selectedTrackingNumbers.length) {
    return { ok: false, error: 'The Step 3 claim selection changed before the run started. Refresh the review queue and confirm the selection again.' };
  }
  if (!options.dryRun && !options.liveSubmissionConfirmed) {
    return { ok: false, error: 'Live submission was not explicitly confirmed. Review the selected claims and confirm the live run.' };
  }

  const nextConfig = saveRememberedUserSettings({ ...config, developerMode: false }, options, claimSettingsEnv);
  nextConfig.dryRunDefault = Boolean(options.dryRun);
  writeConfig(nextConfig);
  persistPasswordFromOptions(options, nextConfig);

  const logPath = path.join(LOG_DIR, `submit-${timestamp()}.log`);

  const submitRunId = claimDb.startRun(DB_PATH, 'submission', {
    dryRun: Boolean(options.dryRun),
    selectedClaimCount: selectedTrackingNumbers.length,
    canaryMode: Boolean(options.canaryMode)
  });
  const selectedClaimsPath = path.join(DATA_DIR, `claims-selected-run-${submitRunId}.csv`);
  const queueSnapshotPath = path.join(DATA_DIR, `queue-snapshot-run-${submitRunId}.json`);
  let selectedClaims;
  let queueSnapshotId = null;
  try {
    selectedClaims = claimQueue.writeSelectedClaimsCsv(claimsPath, selectedClaimsPath, selectedTrackingNumbers);
    if (selectedClaims.count !== selectedTrackingNumbers.length) {
      throw new Error('One or more selected claims no longer match claims.csv. Refresh the Step 3 queue before running.');
    }
    const selectedRows = claimQueue.readClaimsCsv(selectedClaimsPath).rows;
    const policyInputs = selectedRows.map(row => claimQueue.claimInputFromRow(row, { ...config, ...options }));
    const classifiedAt = new Date().toISOString();
    const blocked = [];
    for (const input of policyInputs) {
      const classification = classifyEligibility(input, { asOf: classifiedAt, classificationTimestamp: classifiedAt });
      claimDb.recordClassification(DB_PATH, input.trackingNumber, classification, input);
      if (classification.classification !== 'LATE_CANDIDATE') {
        blocked.push(`${input.trackingNumber}: ${classification.explanation}`);
      }
    }
    if (blocked.length) {
      throw new Error(`Pre-submission late-candidate revalidation blocked ${blocked.length} claim(s). Refresh tracking evidence and review the review-required queue. ${blocked[0]}`);
    }
    const queueSnapshot = createQueueSnapshot(policyInputs, { createdAt: classifiedAt, asOf: classifiedAt, policyDataVersion: eligibilityPolicy.dataVersion });
    queueSnapshotId = claimDb.saveQueueSnapshot(DB_PATH, queueSnapshot);
    fs.writeFileSync(queueSnapshotPath, `${JSON.stringify(queueSnapshot, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    fs.rmSync(selectedClaimsPath, { force: true });
    fs.rmSync(queueSnapshotPath, { force: true });
    claimDb.finishRun(DB_PATH, submitRunId, 'failed', { failure: 1 }, { error: error.message, stage: 'claim-selection' });
    return { ok: false, error: error.message };
  }
  const step3DiagnosticsRunDir = path.join(LOG_DIR, 'step3-runs', `step3-${timestamp()}-run-${submitRunId}`);
  fs.mkdirSync(step3DiagnosticsRunDir, { recursive: true, mode: 0o700 });
  activeStep3DiagnosticsDir = step3DiagnosticsRunDir;
  latestStep3DiagnosticsDir = step3DiagnosticsRunDir;
  const envBase = {
    DATA_DIR,
    STOP_FILE,
    CLAIMS_CSV: selectedClaimsPath,
    QUEUE_SNAPSHOT_PATH: queueSnapshotPath,
    QUEUE_SNAPSHOT_ID: String(queueSnapshotId || ''),
    CANADAPOST_SECRETS_STDIN: '1',
    AFTER_SUBMIT_MS: String(options.afterSubmitMs || 20000),
    BETWEEN_CLAIMS_MS: String(options.betweenClaimsMs || 750),
    MAX_CLAIMS: options.canaryMode ? '1' : (options.maxClaims ? String(options.maxClaims) : ''),
    BROWSER_MODE: 'builtin',
    CANARY_MODE: options.canaryMode ? 'true' : 'false',
    ELECTRON_CDP_URL: BUILTIN_BROWSER_CDP_URL,
    ELECTRON_TARGET_TOKEN: BUILTIN_BROWSER_TARGET_TOKEN,
    DATABASE_PATH: DB_PATH,
    RUN_ID: String(submitRunId),
    DRY_RUN: options.dryRun ? 'true' : 'false',
    APP_VERSION,
    LOG_DIR,
    STEP3_DIAGNOSTICS_ENABLED: 'true',
    STEP3_DIAGNOSTICS_RUN_DIR: step3DiagnosticsRunDir,
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
      appendLog(logPath, `Canada Post claim submission started ${new Date().toISOString()}\nStep tabs version: ${STEP_TABS_VERSION}\nSelected claims: ${selectedClaims.count}\nCanary mode: ${options.canaryMode ? 'yes' : 'no'}\nDry run: ${options.dryRun ? 'yes' : 'no'}\n`);
      appendStep3ElectronDiagnostic('submission-run-started', {
        runId: submitRunId,
        dryRun: Boolean(options.dryRun),
        browserMode: 'builtin',
        selectedClaimCount: selectedClaims.count,
        canaryMode: Boolean(options.canaryMode),
        logPath
      });
    },
    onEvent: event => {
      if (event?.type === 'diagnostics_started') {
        latestStep3DiagnosticsDir = String(event.directory || step3DiagnosticsRunDir);
        emit('event', { stage: 'submit', event: { type: 'log', message: `Detailed Step 3 diagnostics: ${latestStep3DiagnosticsDir}` } });
      }
    },
    onClose: ({ code, signal, eventCounts }) => {
      claimDb.markInterruptedAttempts(DB_PATH);
      appendStep3ElectronDiagnostic('submission-worker-closed', { code, signal, eventCounts });
      activeStep3DiagnosticsDir = '';
      fs.rmSync(selectedClaimsPath, { force: true });
      fs.rmSync(queueSnapshotPath, { force: true });
    }
  });
  const started = await submitProcess.started;
  if (!started.ok) {
    const failed = await submitProcess;
    activeStep3DiagnosticsDir = '';
    fs.rmSync(selectedClaimsPath, { force: true });
    fs.rmSync(queueSnapshotPath, { force: true });
    claimDb.finishRun(DB_PATH, submitRunId, 'failed', { failure: 1 }, { error: failed.error?.message || 'Worker spawn failed.' });
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
        emit('run', { status: 'failed', message: `Submit stage failed with code ${submitResult.code}.`, logPath });
        return;
      }

      emit('run', { status: 'complete', message: options.dryRun ? 'Dry run complete. No claims were submitted.' : 'Claim submission complete.', logPath });
    } catch (error) {
      appendStep3ElectronDiagnostic('submission-run-error', { message: error.message, stack: error.stack });
      activeStep3DiagnosticsDir = '';
      fs.rmSync(selectedClaimsPath, { force: true });
      fs.rmSync(queueSnapshotPath, { force: true });
      try { claimDb.finishRun(DB_PATH, submitRunId, 'failed', { failure: 1 }, { error: error.message }); } catch (_) {}
      emit('run', { status: 'failed', message: error.message, logPath });
    }
  })();

  return { ok: true, logPath, diagnosticsDir: step3DiagnosticsRunDir, selectedClaimCount: selectedClaims.count, canaryMode: Boolean(options.canaryMode) };
});

ipcMain.handle('run:requestStop', () => {
  ensureDirs();
  fs.writeFileSync(STOP_FILE, new Date().toISOString() + '\n');
  emit('event', { stage: activeStage, event: { type: 'stop_requested', message: 'Stop requested. The runner will stop after the current item.' } });
  return { ok: true };
});

ipcMain.handle('run:forceStop', () => {
  ensureDirs();
  fs.writeFileSync(STOP_FILE, new Date().toISOString() + '\n', { mode: 0o600 });
  if (activeChild) {
    const child = activeChild;
    sendStopSignalToChild(child, { force: false });
    const timer = setTimeout(() => sendStopSignalToChild(child, { force: true }), 1500);
    if (typeof timer.unref === 'function') timer.unref();
    emit('event', { stage: activeStage, event: { type: 'force_stop', message: 'Force stop sent to the current process and its browser descendants.' } });
    return { ok: true };
  }
  return { ok: false, error: 'No active process.' };
});

async function startApplication() {
  validateMutablePathManifest(userDataBootstrap, USER_DATA_ROOT);
  fs.mkdirSync(BACKUP_RESTORE_TEMP_DIR, { recursive: true, mode: 0o700 });
  storage.migrateLegacyData();
  ensureDirs();
  await claimDb.initializeDatabase(DB_PATH, { backupDirectory: DATABASE_BACKUP_DIR });
  databaseReady = true;
  claimDb.importLegacyData(DB_PATH, DATA_DIR);
  claimDb.markInterruptedAttempts(DB_PATH);
  claimDb.quarantineLegacyDryRunReadyAttempts(DB_PATH);
  createWindow();
}

async function handleStartupFailure(error) {
  if (startupFailureHandled) return;
  startupFailureHandled = true;
  databaseReady = false;
  let diagnosticPath = '';
  const diagnostic = startupDatabase.buildDiagnostic(error);
  try { diagnosticPath = startupDatabase.writeDiagnostic(LOG_DIR, diagnostic); } catch (_) {}
  const safeText = startupDatabase.diagnosticText(diagnostic);
  const details = [
    'The workflow window was not opened because the local database could not be prepared safely.',
    `Backup: ${diagnostic.backupLocation || 'Unavailable; the source database was left unchanged.'}`,
    `Diagnostic: ${diagnosticPath || 'Could not write the local diagnostic file.'}`,
    '',
    'No database contents or credentials are included in this diagnostic.'
  ].join('\n');
  try {
    const choice = await dialog.showMessageBox({
      type: 'error',
      title: 'Database recovery required',
      message: 'Canada Post Claim Runner could not start safely.',
      detail: details,
      buttons: ['Open data folder', 'Copy diagnostic', 'Exit'],
      defaultId: 2,
      cancelId: 2,
      noLink: true
    });
    if (choice.response === 0) await shell.openPath(USER_DATA_ROOT);
    if (choice.response === 1) clipboard.writeText(`${safeText}\nDiagnostic file: ${diagnosticPath || 'unavailable'}`);
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

app.on('before-quit', () => {
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
