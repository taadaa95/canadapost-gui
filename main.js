const { app, BrowserWindow, BrowserView, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const storage = require('./lib/app-storage');
const claimDb = require('./lib/claim-database');
const archiveTools = require('./lib/archive-tools');
const { pruneStep3DiagnosticRuns } = require('./lib/step3-diagnostics');

const { ROOT, DATA_DIR, LOG_DIR, USER_DATA_ROOT } = storage;
const DB_PATH = claimDb.databasePathFor(USER_DATA_ROOT);
const STOP_FILE = path.join(DATA_DIR, 'stop-requested.txt');
const DUPLICATE_CLAIM_FIX_VERSION = 'duplicate-claim-fix-v3';
const HISTORY_IMPORT_VERSION = 'shipping-history-import-v6-auto-discover-mobo';
const EST_HISTORY_EXPORT_VERSION = 'est-history-export-v8';
const STEP_TABS_VERSION = 'user-settings-v17';
const APP_VERSION = '0.3.6';
const DEFAULT_TRACKING_REQUEST_INTERVAL_MS = 3100;
const BUILTIN_BROWSER_CDP_PORT = String(process.env.CANADAPOST_ELECTRON_CDP_PORT || crypto.randomInt(20000, 48000));
const BUILTIN_BROWSER_CDP_URL = `http://127.0.0.1:${BUILTIN_BROWSER_CDP_PORT}`;
const BUILTIN_BROWSER_TARGET_TOKEN = crypto.randomUUID();
const CANADAPOST_LOGIN_URL = 'https://www.canadapost-postescanada.ca/lfe-cap/en/login?stepupId=smb_mode1,consumer,commercial_link,smb_link&sourceUrl=https:%2F%2Fwww.canadapost-postescanada.ca%2Fdash%2Fen&targetUrl=https:%2F%2Fwww.canadapost-postescanada.ca%2Fdash%2Fen&authlvl=&language=en';


function isAllowedCanadaPostUrl(value) {
  try {
    const parsed = new URL(String(value));
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host === 'canadapost-postescanada.ca' || host.endsWith('.canadapost-postescanada.ca'));
  } catch (_) {
    return false;
  }
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
let activeStep3DiagnosticsDir = '';
let latestStep3DiagnosticsDir = '';
let lastBrowserBoundsDiagnosticAt = 0;


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
    if (win && !win.isDestroyed() && builtinBrowserAttached) win.removeBrowserView(builtinBrowserView);
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
  const db = claimDb.openDatabase(DB_PATH);
  db.close();
}

function createWindow() {
  ensureDirs();

  // Remove Electron's native menu bar. On Linux/GTK themes the native menu
  // popup can render with a compositor blur/halo over the app; this app does
  // not need File/Edit/View/Window menus, so disabling it gives a cleaner UI.
  Menu.setApplicationMenu(null);

  win = new BrowserWindow({
    width: 1160,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setMenu(null);
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') shell.openExternal(parsed.toString()).catch(() => {});
    } catch (_) {}
    return { action: 'deny' };
  });
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
  // Keep x/y signed so a BrowserView can move partially outside the window
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

  builtinBrowserView = new BrowserView({
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
    win.addBrowserView(view);
    builtinBrowserAttached = true;
  }
  return view;
}

function hideBuiltinBrowserView() {
  if (!win || win.isDestroyed() || !builtinBrowserView) return;
  try {
    if (builtinBrowserAttached) win.removeBrowserView(builtinBrowserView);
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
  view.setAutoResize({ width: false, height: false, horizontal: false, vertical: false });
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
    if (!builtinBrowserAttached) win.addBrowserView(builtinBrowserView);
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

function resolveApiCredentials() {
  const stored = storage.loadApiCredentials();
  if (stored.username && stored.password) return stored;

  for (const filePath of [path.join(DATA_DIR, 'user.ini'), path.join(ROOT, 'user.ini')]) {
    const parsed = parseSimpleIni(filePath);
    const username = String(parsed.username || '').trim();
    const password = String(parsed.password || '');
    if (username && password) return { username, password };
  }
  return { username: '', password: '' };
}

function ensureApiCredentialFiles() {
  const userIniRoot = path.join(ROOT, 'user.ini');
  const userIniData = path.join(DATA_DIR, 'user.ini');
  if (!fs.existsSync(userIniData) && fs.existsSync(userIniRoot)) {
    fs.copyFileSync(userIniRoot, userIniData);
    try { fs.chmodSync(userIniData, 0o600); } catch (_) {}
  }

  const cacertRoot = path.join(ROOT, 'cacert.pem');
  if (!fs.existsSync(cacertRoot)) {
    return { ok: false, error: `Missing bundled CA certificate at ${cacertRoot}.` };
  }
  const credentials = resolveApiCredentials();
  if (!credentials.username || !credentials.password) {
    return {
      ok: false,
      error: `Missing Canada Post Developer API credentials. Copy user.ini into ${DATA_DIR}; on the next launch the secrets will be imported into OS-encrypted storage.`
    };
  }
  return { ok: true, userIniPath: userIniData, cacertRoot, ...credentials };
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
    EST_FILETYPES: pickOptionString(options, config, 'estFileTypes', 'estFileTypes', '2'),
    EST_USERNAME: pickOptionString(options, config, 'webUsername', 'webUsername', ''),
    EST_PASSWORD: Object.prototype.hasOwnProperty.call(options, 'webPassword')
      ? String(options.webPassword ?? '')
      : '',
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
  const cacertRoot = path.join(ROOT, 'cacert.pem');
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

function spawnJsonProcess(command, args, options, stage, logPath, hooks = {}) {
  return new Promise((resolve) => {
    activeStage = stage;
    emit('stage', { stage, status: 'running' });

    const childEnv = { ...process.env, ...options.env };
    const useStdinJson = options.stdinJson && typeof options.stdinJson === 'object';
    const child = spawn(command, args, {
      cwd: ROOT,
      env: childEnv,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [useStdinJson ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });

    activeChild = child;
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
      emit('event', { stage, event });
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
      emit('event', { stage, event: { type: 'error', message: error.message } });
      appendLog(logPath, `[${stage}] ERROR: ${error.message}
`);
      finish({ ok: false, code: -1, error });
    });

    child.once('close', (code, signal) => {
      flushBuffer(stdoutBuffer, 'stdout');
      flushBuffer(stderrBuffer, 'stderr');
      try { hooks.onClose?.({ code, signal, lastEvent, lastEventsByType, eventCounts }); } catch (_) {}
      emit('stage', { stage, status: 'finished', code, signal });
      finish({ ok: code === 0, code, signal });
    });
  });
}


function dependencyStatus() {
  const phpVersion = spawnSync('php', ['-v'], { encoding: 'utf8', timeout: 5000 });
  const phpModules = spawnSync('php', ['-m'], { encoding: 'utf8', timeout: 5000 });
  const moduleText = String(phpModules.stdout || '');
  return {
    phpAvailable: phpVersion.status === 0,
    phpVersion: String(phpVersion.stdout || phpVersion.stderr || '').split(/\r?\n/)[0].slice(0, 200),
    phpSoapAvailable: /(?:^|\n)soap(?:\r?$|\n)/im.test(moduleText),
    cacertAvailable: fs.existsSync(path.join(ROOT, 'cacert.pem')),
    wsdlAvailable: fs.existsSync(path.join(ROOT, 'wsdl', 'track.wsdl')),
    playwrightAvailable: fs.existsSync(path.join(ROOT, 'node_modules', 'playwright')),
    databaseIntegrity: (() => {
      try { return claimDb.integrityCheck(DB_PATH); } catch (error) { return { ok: false, result: error.message }; }
    })()
  };
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
    ...Object.values(storage.loadApiCredentials())
  ].filter(Boolean);
}

function trackingRunCounts(summary = {}) {
  const total = Number(summary.total || 0);
  const failure = Number(summary.errorCount || 0);
  const warning = Number(summary.reviewRequiredCount || 0) + Number(summary.overdueInTransitCount || 0) + Number(summary.noDataCount || 0);
  return { total, success: Math.max(0, total - failure - warning), warning, failure };
}

ipcMain.handle('browser:showBuiltin', async (_event, options = {}) => {
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

ipcMain.handle('config:load', () => {
  ensureDirs();
  const config = storage.publicConfig();
  return {
    ...config,
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
    hasApiCredentials: storage.apiCredentialsStored() || (() => { const api = resolveApiCredentials(); return Boolean(api.username && api.password); })(),
    hasCacert: fs.existsSync(path.join(ROOT, 'cacert.pem')),
    hasWsdl: fs.existsSync(path.join(ROOT, 'wsdl', 'track.wsdl')),
    historyImportVersion: HISTORY_IMPORT_VERSION,
    estHistoryExportVersion: EST_HISTORY_EXPORT_VERSION,
    stepTabsVersion: STEP_TABS_VERSION,
    appVersion: APP_VERSION,
    ...readUserIniPublicFields()
  };
});

ipcMain.handle('config:save', (_event, input = {}) => {
  const existing = readConfig();
  const sanitized = storage.sanitizeConfig(input);
  const next = { ...existing, ...sanitized };
  writeConfig(next);
  const credentialResult = persistPasswordFromOptions(input, next);
  return { ok: true, passwordStored: credentialResult.stored, credentialBackend: credentialResult.backend, warning: credentialResult.warning || '' };
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

ipcMain.handle('history:list', (_event, options = {}) => {
  ensureDirs();
  return { ok: true, items: claimDb.listClaimHistory(DB_PATH, options) };
});

ipcMain.handle('history:export', async (_event, options = {}) => {
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

ipcMain.handle('backup:create', async () => {
  ensureDirs();
  const result = await dialog.showSaveDialog(win, {
    title: 'Create Canada Post Claim Runner backup',
    defaultPath: path.join(app.getPath('documents'), `canadapost-claim-runner-backup-${new Date().toISOString().slice(0, 10)}.zip`),
    filters: [{ name: 'ZIP archives', extensions: ['zip'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    await archiveTools.createBackup({
      dbPath: DB_PATH,
      dataDir: DATA_DIR,
      config: readConfig(),
      destination: result.filePath,
      appVersion: APP_VERSION
    });
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('backup:restore', async () => {
  ensureDirs();
  if (activeChild) return { ok: false, error: 'Stop the active process before restoring a backup.' };
  const result = await dialog.showOpenDialog(win, {
    title: 'Restore Canada Post Claim Runner backup',
    properties: ['openFile'],
    filters: [{ name: 'ZIP archives', extensions: ['zip'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  try {
    const restored = archiveTools.restoreBackup({
      source: result.filePaths[0],
      dbPath: DB_PATH,
      dataDir: DATA_DIR,
      configWriter: restoredSettings => writeConfig({ ...readConfig(), ...storage.sanitizeConfig(restoredSettings) })
    });
    claimDb.markInterruptedAttempts(DB_PATH);
    claimDb.quarantineLegacyDryRunReadyAttempts(DB_PATH);
    return { ...restored, dashboard: claimDb.dashboard(DB_PATH) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('diagnostics:create', async () => {
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
  ensureDirs();
  if (activeChild) return { ok: false, error: 'A process is already active.' };
  try {
    await showBuiltinBrowser(options.bounds || {});
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const config = readConfig();
  const credentials = resolveWebCredentials(options, config);
  const logPath = path.join(LOG_DIR, `site-health-${timestamp()}.log`);
  const runId = claimDb.startRun(DB_PATH, 'site_health', { appVersion: APP_VERSION });
  emit('run', { status: 'started', logPath });
  (async () => {
    try {
      const result = await spawnJsonProcess(process.execPath, [path.join(ROOT, 'scripts', 'site-health-check.js')], {
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_CDP_URL: BUILTIN_BROWSER_CDP_URL,
          ELECTRON_TARGET_TOKEN: BUILTIN_BROWSER_TARGET_TOKEN,
          CANADAPOST_SECRETS_STDIN: '1'
        },
        stdinJson: { username: credentials.username, password: credentials.password }
      }, 'health', logPath, {
        stopOnEvent: event => event?.type === 'health_complete'
      });
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
  if (!estEnv.EST_USERNAME || !estEnv.EST_PASSWORD) {
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

  const importScript = path.join(ROOT, 'scripts', 'import-est-history-cli.php');
  if (!fs.existsSync(importScript)) {
    return { ok: false, error: `Missing ${importScript}.` };
  }

  const logPath = path.join(LOG_DIR, `est-history-import-${timestamp()}.log`);
  emit('run', { status: 'started', logPath });
  appendLog(logPath, `Canada Post EST Desktop history export started ${new Date().toISOString()}\nEST export version: ${EST_HISTORY_EXPORT_VERSION}\n`);

  const envBase = {
    APP_ROOT: ROOT,
    DATA_DIR,
    STOP_FILE,
    TRACKING_CSV: path.join(DATA_DIR, 'tracking.csv'),
    ...estEnv
  };

  (async () => {
    try {
      const importResult = await spawnJsonProcess('php', [importScript], { env: envBase }, 'est-history', logPath);
      if (!importResult.ok) {
        let message = `EST Desktop history export failed with code ${importResult.code}.`;
        if (importResult.code === 2) message = 'EST Desktop export found no history orders. Existing tracking.csv was not replaced.';
        if (importResult.code === 3) message = 'EST Desktop export found order history, but no usable ManifestItems tracking rows were parsed. Check data/est-export raw files.';
        emit('run', { status: 'failed', message, logPath });
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

  fs.rmSync(STOP_FILE, { force: true });

  const apiFiles = ensureApiCredentialFiles();
  if (!apiFiles.ok) return apiFiles;

  const config = readConfig();
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

  const importScript = path.join(ROOT, 'scripts', 'import-shipping-history-cli.php');
  if (!fs.existsSync(importScript)) {
    return { ok: false, error: `Missing ${importScript}.` };
  }

  const logPath = path.join(LOG_DIR, `history-import-${timestamp()}.log`);
  emit('run', { status: 'started', logPath });
  appendLog(logPath, `Canada Post shipping history import started ${new Date().toISOString()}\nHistory import version: ${HISTORY_IMPORT_VERSION}\n`);

  const envBase = {
    APP_ROOT: ROOT,
    DATA_DIR,
    STOP_FILE,
    TRACKING_CSV: path.join(DATA_DIR, 'tracking.csv'),
    CANADAPOST_API_USERNAME: apiFiles.username,
    CANADAPOST_API_PASSWORD: apiFiles.password,
    ...historyEnv
  };

  (async () => {
    try {
      const importResult = await spawnJsonProcess('php', [importScript], { env: envBase }, 'history', logPath);
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

  const apiFiles = ensureApiCredentialFiles();
  if (!apiFiles.ok) return apiFiles;

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

  if (options.fresh) {
    for (const name of ['claims.csv', 'processed_pins.txt', 'claim-run-summary.json', 'tracking-run-summary.json', 'overdue-undelivered.csv', 'eligibility-review.csv', 'stop-requested.txt']) {
      fs.rmSync(path.join(DATA_DIR, name), { force: true });
    }
  }

  const fullRunId = claimDb.startRun(DB_PATH, 'full', { importHistory: Boolean(options.importHistory), dryRun: Boolean(options.dryRun) });
  const envBase = {
    APP_ROOT: ROOT,
    DATA_DIR,
    STOP_FILE,
    CLAIMS_CSV: path.join(DATA_DIR, 'claims.csv'),
    TRACKING_CSV: trackingCsv,
    TRACKING_REQUEST_INTERVAL_MS: String(DEFAULT_TRACKING_REQUEST_INTERVAL_MS),
    CANADAPOST_API_USERNAME: apiFiles.username,
    CANADAPOST_API_PASSWORD: apiFiles.password,
    CANADAPOST_SECRETS_STDIN: '1',
    AFTER_SUBMIT_MS: String(options.afterSubmitMs || 20000),
    BETWEEN_CLAIMS_MS: String(options.betweenClaimsMs || 750),
    MAX_CLAIMS: options.maxClaims ? String(options.maxClaims) : '',
    BROWSER_MODE: options.browserMode === 'builtin' ? 'builtin' : 'external',
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
        const importScript = path.join(ROOT, 'scripts', 'import-shipping-history-cli.php');
        const importResult = await spawnJsonProcess('php', [importScript], { env: envBase }, 'history', logPath);
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
        'php',
        [path.join(ROOT, 'scripts', 'get-tracking-cli.php')],
        { env: envBase },
        'tracking',
        logPath,
        { onEvent: event => claimDb.ingestTrackingEvent(DB_PATH, fullRunId, event) }
      );
      if (!trackingResult.ok) {
        claimDb.finishRun(DB_PATH, fullRunId, 'failed', { failure: 1 }, { stage: 'tracking', code: trackingResult.code });
        emit('run', { status: 'failed', message: `Tracking stage failed with code ${trackingResult.code}.`, logPath });
        return;
      }
      const trackingSummary = trackingResult.lastEventsByType?.tracking_complete || {};
      if (Number(trackingSummary.errorCount || 0) > 0) {
        claimDb.finishRun(DB_PATH, fullRunId, 'complete_with_warnings', trackingRunCounts(trackingSummary), trackingSummary);
        emit('run', {
          status: 'failed',
          message: `Tracking completed with ${trackingSummary.errorCount} lookup error(s). Claim submission was blocked until tracking is rerun successfully.`,
          logPath
        });
        return;
      }

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
        process.execPath,
        [path.join(ROOT, 'scripts', 'submit-claims.js')],
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
          warning: Number(submitSummary.alreadySubmitted || 0),
          failure: Number(submitSummary.failed || 1)
        }, submitSummary);
        emit('run', { status: 'failed', message: `Submit stage failed with code ${submitResult.code}.`, logPath });
        return;
      }

      claimDb.finishRun(DB_PATH, fullRunId, 'complete', {
        total: Number(submitSummary.total || trackingSummary.total || 0),
        success: Number(submitSummary.succeeded || 0),
        warning: Number(submitSummary.alreadySubmitted || 0),
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

  fs.rmSync(STOP_FILE, { force: true });

  const apiFiles = ensureApiCredentialFiles();
  if (!apiFiles.ok) return apiFiles;

  const trackingCsv = path.join(DATA_DIR, 'tracking.csv');
  if (!fs.existsSync(trackingCsv)) {
    return { ok: false, error: `Missing ${trackingCsv}. Run Step 1 or select tracking.csv first.` };
  }

  if (options.fresh) {
    for (const name of ['claims.csv', 'processed_pins.txt', 'claim-run-summary.json', 'tracking-run-summary.json', 'overdue-undelivered.csv', 'eligibility-review.csv', 'stop-requested.txt']) {
      fs.rmSync(path.join(DATA_DIR, name), { force: true });
    }
  }

  const config = readConfig();
  writeConfig({
    ...config,
    freshTracking: !!options.fresh,
    developerMode: false
  });

  const logPath = path.join(LOG_DIR, `tracking-${timestamp()}.log`);
  emit('run', { status: 'started', logPath });
  appendLog(logPath, `Canada Post tracking check started ${new Date().toISOString()}\nStep tabs version: ${STEP_TABS_VERSION}\n`);

  const envBase = {
    APP_ROOT: ROOT,
    DATA_DIR,
    STOP_FILE,
    CLAIMS_CSV: path.join(DATA_DIR, 'claims.csv'),
    TRACKING_CSV: trackingCsv,
    TRACKING_REQUEST_INTERVAL_MS: String(DEFAULT_TRACKING_REQUEST_INTERVAL_MS),
    CANADAPOST_API_USERNAME: apiFiles.username,
    CANADAPOST_API_PASSWORD: apiFiles.password,
    DATABASE_PATH: DB_PATH,
    DEVELOPER_MODE: 'false'
  };
  const trackingRunId = claimDb.startRun(DB_PATH, 'tracking', { fresh: Boolean(options.fresh) });

  (async () => {
    try {
      const trackingScript = path.join(ROOT, 'scripts', 'get-tracking-cli.php');
      if (!fs.existsSync(trackingScript)) {
        claimDb.finishRun(DB_PATH, trackingRunId, 'failed', { failure: 1 }, { error: `Missing ${trackingScript}.` });
        emit('run', { status: 'failed', message: `Missing ${trackingScript}.`, logPath });
        return;
      }

      const trackingResult = await spawnJsonProcess('php', [trackingScript], { env: envBase }, 'tracking', logPath, {
        onEvent: event => claimDb.ingestTrackingEvent(DB_PATH, trackingRunId, event)
      });
      if (!trackingResult.ok) {
        claimDb.finishRun(DB_PATH, trackingRunId, 'failed', { failure: 1 }, { code: trackingResult.code });
        emit('run', { status: 'failed', message: `Tracking stage failed with code ${trackingResult.code}.`, logPath });
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
      const counts = [
        `${Number(summary.eligibleLateCount || 0)} eligible late`,
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
        message: `Tracking check complete: ${counts}.${hasClaims ? ' claims.csv contains eligible delivered-late shipments.' : ' No claims are ready for submission.'}`,
        logPath
      });
    } catch (error) {
      try { claimDb.finishRun(DB_PATH, trackingRunId, 'failed', { failure: 1 }, { error: error.message }); } catch (_) {}
      emit('run', { status: 'failed', message: error.message, logPath });
    }
  })();

  return { ok: true, logPath };
});

ipcMain.handle('submit:run', async (_event, options = {}) => {
  ensureDirs();

  if (activeChild) {
    return { ok: false, error: 'A process is already active.' };
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

  const claimsPath = path.join(DATA_DIR, 'claims.csv');
  if (!fs.existsSync(claimsPath) || fs.readFileSync(claimsPath, 'utf8').trim().split(/\r?\n/).length < 2) {
    return { ok: false, error: `Missing usable ${claimsPath}. Run Step 2 first.` };
  }

  const submitScript = path.join(ROOT, 'scripts', 'submit-claims.js');
  if (!fs.existsSync(submitScript)) {
    return { ok: false, error: `Missing ${submitScript}.` };
  }

  const nextConfig = saveRememberedUserSettings({ ...config, developerMode: false }, options, claimSettingsEnv);
  nextConfig.dryRunDefault = Boolean(options.dryRun);
  writeConfig(nextConfig);
  persistPasswordFromOptions(options, nextConfig);

  const logPath = path.join(LOG_DIR, `submit-${timestamp()}.log`);
  emit('run', { status: 'started', logPath });
  appendLog(logPath, `Canada Post claim submission started ${new Date().toISOString()}\nStep tabs version: ${STEP_TABS_VERSION}\n`);

  const submitRunId = claimDb.startRun(DB_PATH, 'submission', { dryRun: Boolean(options.dryRun) });
  const step3DiagnosticsRunDir = path.join(LOG_DIR, 'step3-runs', `step3-${timestamp()}-run-${submitRunId}`);
  fs.mkdirSync(step3DiagnosticsRunDir, { recursive: true, mode: 0o700 });
  activeStep3DiagnosticsDir = step3DiagnosticsRunDir;
  latestStep3DiagnosticsDir = step3DiagnosticsRunDir;
  appendStep3ElectronDiagnostic('submission-run-started', {
    runId: submitRunId,
    dryRun: Boolean(options.dryRun),
    browserMode: options.browserMode === 'builtin' ? 'builtin' : 'external',
    logPath
  });
  const envBase = {
    APP_ROOT: ROOT,
    DATA_DIR,
    STOP_FILE,
    CLAIMS_CSV: claimsPath,
    CANADAPOST_SECRETS_STDIN: '1',
    AFTER_SUBMIT_MS: String(options.afterSubmitMs || 20000),
    BETWEEN_CLAIMS_MS: String(options.betweenClaimsMs || 750),
    MAX_CLAIMS: options.maxClaims ? String(options.maxClaims) : '',
    BROWSER_MODE: options.browserMode === 'builtin' ? 'builtin' : 'external',
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

  (async () => {
    try {
      const submitResult = await spawnJsonProcess(process.execPath, [submitScript], {
        env: { ...envBase, ELECTRON_RUN_AS_NODE: '1' },
        stdinJson: { username: webUsername, password: webPassword }
      }, 'submit', logPath, {
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
        }
      });
      const summary = submitResult.lastEventsByType?.submit_complete || {};
      const counts = {
        total: Number(summary.total || 0),
        success: Number(summary.succeeded || summary.dryRunReady || 0),
        warning: Number(summary.alreadySubmitted || 0),
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
      try { claimDb.finishRun(DB_PATH, submitRunId, 'failed', { failure: 1 }, { error: error.message }); } catch (_) {}
      emit('run', { status: 'failed', message: error.message, logPath });
    }
  })();

  return { ok: true, logPath, diagnosticsDir: step3DiagnosticsRunDir };
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

app.whenReady().then(() => {
  storage.migrateLegacyData();
  ensureDirs();
  claimDb.importLegacyData(DB_PATH, DATA_DIR);
  claimDb.markInterruptedAttempts(DB_PATH);
  claimDb.quarantineLegacyDryRunReadyAttempts(DB_PATH);
  createWindow();
});

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
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
