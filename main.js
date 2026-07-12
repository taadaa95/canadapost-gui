const { app, BrowserWindow, BrowserView, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const storage = require('./lib/app-storage');

const { ROOT, DATA_DIR, LOG_DIR } = storage;
const STOP_FILE = path.join(DATA_DIR, 'stop-requested.txt');
const DUPLICATE_CLAIM_FIX_VERSION = 'duplicate-claim-fix-v3';
const HISTORY_IMPORT_VERSION = 'shipping-history-import-v6-auto-discover-mobo';
const EST_HISTORY_EXPORT_VERSION = 'est-history-export-v8';
const STEP_TABS_VERSION = 'user-settings-v17';
const APP_VERSION = '0.2.0-hardening';
const DEFAULT_TRACKING_REQUEST_INTERVAL_MS = 3100;
const BUILTIN_BROWSER_CDP_PORT = String(process.env.CANADAPOST_ELECTRON_CDP_PORT || crypto.randomInt(20000, 48000));
const BUILTIN_BROWSER_CDP_URL = `http://127.0.0.1:${BUILTIN_BROWSER_CDP_PORT}`;
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

function ensureDirs() {
  storage.ensureDirs();
  pruneOldFiles(LOG_DIR, 30, name => name.endsWith('.log'));
  pruneOldFiles(DATA_DIR, 90, name => /^claim-(?:error|already-submitted|submitted|captcha)-row-.*\.(?:png|txt)$/i.test(name));
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
    builtinBrowserView = null;
    builtinBrowserAttached = false;
    win = null;
  });
  win.loadFile('index.html');
}

function emit(channel, payload = {}) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function normalizeBounds(bounds = {}) {
  const x = Math.max(0, Math.round(Number(bounds.x) || 0));
  const y = Math.max(0, Math.round(Number(bounds.y) || 0));
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
      partition: 'persist:canadapost-claims-builtin'
    }
  });

  builtinBrowserView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedCanadaPostUrl(url)) builtinBrowserView.webContents.loadURL(url).catch(() => {});
    else emit('event', { stage: 'submit', event: { type: 'error', message: 'Blocked built-in browser navigation outside Canada Post.' } });
    return { action: 'deny' };
  });
  builtinBrowserView.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedCanadaPostUrl(url)) {
      event.preventDefault();
      emit('event', { stage: 'submit', event: { type: 'error', message: 'Blocked built-in browser navigation outside Canada Post.' } });
    }
  });

  builtinBrowserView.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    emit('event', { stage: 'submit', event: { type: 'log', message: `Built-in browser load warning: ${errorCode} ${errorDescription}` } });
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
  view.setAutoResize({ width: false, height: false, horizontal: false, vertical: false });
}

async function showBuiltinBrowser(bounds) {
  const view = attachBuiltinBrowserView();
  setBuiltinBrowserBounds(bounds);
  const currentUrl = view.webContents.getURL();
  if (!currentUrl || currentUrl === 'about:blank') {
    await view.webContents.loadURL(CANADAPOST_LOGIN_URL);
  }
  return { ok: true, cdpUrl: BUILTIN_BROWSER_CDP_URL, webContentsId: view.webContents.id };
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

function spawnJsonProcess(command, args, options, stage, logPath) {
  return new Promise((resolve) => {
    activeStage = stage;
    emit('stage', { stage, status: 'running' });

    const childEnv = { ...process.env, ...options.env };
    const child = spawn(command, args, {
      cwd: ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    activeChild = child;
    const stdoutBuffer = { text: '' };
    const stderrBuffer = { text: '' };
    let lastEvent = null;
    const eventCounts = {};

    const handleRawLine = (_source, raw) => {
      // Always save the exact JSON-lines stream to disk. Developer mode receives
      // formatted raw API events through `debug_raw` events from the child process.
      appendLog(logPath, raw);
    };

    const handleEvent = event => {
      lastEvent = event;
      const type = String(event?.type || 'unknown');
      eventCounts[type] = (eventCounts[type] || 0) + 1;
      emit('event', { stage, event });
    };

    child.stdout.on('data', (chunk) => {
      parseJsonLines(stdoutBuffer, chunk, handleEvent, (raw) => handleRawLine('stdout', raw));
    });

    child.stderr.on('data', (chunk) => {
      parseJsonLines(stderrBuffer, chunk, handleEvent, (raw) => handleRawLine('stderr', raw));
    });

    child.on('error', (error) => {
      emit('event', { stage, event: { type: 'error', message: error.message } });
      appendLog(logPath, `[${stage}] ERROR: ${error.message}\n`);
      activeChild = null;
      activeStage = 'idle';
      resolve({ ok: false, code: -1, error, lastEvent, eventCounts });
    });

    child.on('close', (code, signal) => {
      activeChild = null;
      activeStage = 'idle';
      emit('stage', { stage, status: 'finished', code, signal });
      resolve({ ok: code === 0, code, signal, lastEvent, eventCounts });
    });
  });
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
  writeConfig(nextConfig);
  persistPasswordFromOptions(options, nextConfig);

  if (options.fresh) {
    for (const name of ['claims.csv', 'processed_pins.txt', 'claim-run-summary.json', 'tracking-run-summary.json', 'overdue-undelivered.csv', 'eligibility-review.csv', 'stop-requested.txt']) {
      fs.rmSync(path.join(DATA_DIR, name), { force: true });
    }
    for (const file of fs.readdirSync(DATA_DIR)) {
      if (/^claim-(?:error|already-submitted|submitted)-row-.*\.(?:png|txt)$/.test(file)) fs.rmSync(path.join(DATA_DIR, file), { force: true });
    }
  }

  const envBase = {
    APP_ROOT: ROOT,
    DATA_DIR,
    STOP_FILE,
    CLAIMS_CSV: path.join(DATA_DIR, 'claims.csv'),
    TRACKING_CSV: trackingCsv,
    TRACKING_REQUEST_INTERVAL_MS: String(DEFAULT_TRACKING_REQUEST_INTERVAL_MS),
    CANADAPOST_API_USERNAME: apiFiles.username,
    CANADAPOST_API_PASSWORD: apiFiles.password,
    CANADAPOST_USERNAME: webUsername,
    CANADAPOST_PASSWORD: webPassword,
    AFTER_SUBMIT_MS: String(options.afterSubmitMs || 20000),
    BETWEEN_CLAIMS_MS: String(options.betweenClaimsMs || 2000),
    MAX_CLAIMS: options.maxClaims ? String(options.maxClaims) : '',
    BROWSER_MODE: options.browserMode === 'builtin' ? 'builtin' : 'external',
    ELECTRON_CDP_URL: BUILTIN_BROWSER_CDP_URL,
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
          emit('run', { status: 'failed', message, logPath });
          return;
        }
      }

      if (!fs.existsSync(trackingCsv)) {
        emit('run', { status: 'failed', message: `Missing ${trackingCsv} after history import.`, logPath });
        return;
      }

      const trackingResult = await spawnJsonProcess('php', [path.join(ROOT, 'scripts', 'get-tracking-cli.php')], { env: envBase }, 'tracking', logPath);
      if (!trackingResult.ok) {
        emit('run', { status: 'failed', message: `Tracking stage failed with code ${trackingResult.code}.`, logPath });
        return;
      }
      const trackingSummary = trackingResult.lastEvent?.type === 'tracking_complete' ? trackingResult.lastEvent : null;
      if (Number(trackingSummary?.errorCount || 0) > 0) {
        emit('run', {
          status: 'failed',
          message: `Tracking completed with ${trackingSummary.errorCount} lookup error(s). Claim submission was blocked until tracking is rerun successfully.`,
          logPath
        });
        return;
      }

      if (fs.existsSync(STOP_FILE)) {
        emit('run', { status: 'stopped', message: 'Stopped after tracking stage.', logPath });
        return;
      }

      const claimsPath = path.join(DATA_DIR, 'claims.csv');
      if (!fs.existsSync(claimsPath) || fs.readFileSync(claimsPath, 'utf8').trim().split(/\r?\n/).length < 2) {
        emit('run', { status: 'complete', message: 'Tracking complete. No late claims found.', logPath });
        return;
      }

      const submitResult = await spawnJsonProcess(process.execPath, [path.join(ROOT, 'scripts', 'submit-claims.js')], { env: { ...envBase, ELECTRON_RUN_AS_NODE: '1' } }, 'submit', logPath);
      if (!submitResult.ok) {
        emit('run', { status: 'failed', message: `Submit stage failed with code ${submitResult.code}.`, logPath });
        return;
      }

      emit('run', { status: 'complete', message: 'Full run complete.', logPath });
    } catch (error) {
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
    DEVELOPER_MODE: 'false'
  };

  (async () => {
    try {
      const trackingScript = path.join(ROOT, 'scripts', 'get-tracking-cli.php');
      if (!fs.existsSync(trackingScript)) {
        emit('run', { status: 'failed', message: `Missing ${trackingScript}.`, logPath });
        return;
      }

      const trackingResult = await spawnJsonProcess('php', [trackingScript], { env: envBase }, 'tracking', logPath);
      if (!trackingResult.ok) {
        emit('run', { status: 'failed', message: `Tracking stage failed with code ${trackingResult.code}.`, logPath });
        return;
      }

      if (fs.existsSync(STOP_FILE)) {
        emit('run', { status: 'stopped', message: 'Stopped during tracking stage.', logPath });
        return;
      }

      const claimsPath = path.join(DATA_DIR, 'claims.csv');
      const hasClaims = fs.existsSync(claimsPath) && fs.readFileSync(claimsPath, 'utf8').trim().split(/\r?\n/).length >= 2;
      const summary = trackingResult.lastEvent?.type === 'tracking_complete' ? trackingResult.lastEvent : {};
      const counts = [
        `${Number(summary.eligibleLateCount || 0)} eligible late`,
        `${Number(summary.overdueInTransitCount || 0)} overdue/in transit`,
        `${Number(summary.reviewRequiredCount || 0)} review required`,
        `${Number(summary.errorCount || 0)} errors`
      ].join(', ');
      emit('run', {
        status: Number(summary.errorCount || 0) > 0 ? 'complete_with_warnings' : 'complete',
        message: `Tracking check complete: ${counts}.${hasClaims ? ' claims.csv contains eligible delivered-late shipments.' : ' No claims are ready for submission.'}`,
        logPath
      });
    } catch (error) {
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
  writeConfig(nextConfig);
  persistPasswordFromOptions(options, nextConfig);

  const logPath = path.join(LOG_DIR, `submit-${timestamp()}.log`);
  emit('run', { status: 'started', logPath });
  appendLog(logPath, `Canada Post claim submission started ${new Date().toISOString()}\nStep tabs version: ${STEP_TABS_VERSION}\n`);

  const envBase = {
    APP_ROOT: ROOT,
    DATA_DIR,
    STOP_FILE,
    CLAIMS_CSV: claimsPath,
    CANADAPOST_USERNAME: webUsername,
    CANADAPOST_PASSWORD: webPassword,
    AFTER_SUBMIT_MS: String(options.afterSubmitMs || 20000),
    BETWEEN_CLAIMS_MS: String(options.betweenClaimsMs || 2000),
    MAX_CLAIMS: options.maxClaims ? String(options.maxClaims) : '',
    BROWSER_MODE: options.browserMode === 'builtin' ? 'builtin' : 'external',
    ELECTRON_CDP_URL: BUILTIN_BROWSER_CDP_URL,
    ...claimSettingsEnv,
    DEVELOPER_MODE: 'false'
  };

  (async () => {
    try {
      const submitResult = await spawnJsonProcess(process.execPath, [submitScript], { env: { ...envBase, ELECTRON_RUN_AS_NODE: '1' } }, 'submit', logPath);
      if (!submitResult.ok) {
        emit('run', { status: 'failed', message: `Submit stage failed with code ${submitResult.code}.`, logPath });
        return;
      }

      emit('run', { status: 'complete', message: 'Claim submission complete.', logPath });
    } catch (error) {
      emit('run', { status: 'failed', message: error.message, logPath });
    }
  })();

  return { ok: true, logPath };
});

ipcMain.handle('run:requestStop', () => {
  ensureDirs();
  fs.writeFileSync(STOP_FILE, new Date().toISOString() + '\n');
  emit('event', { stage: activeStage, event: { type: 'stop_requested', message: 'Stop requested. The runner will stop after the current item.' } });
  return { ok: true };
});

ipcMain.handle('run:forceStop', () => {
  ensureDirs();
  fs.writeFileSync(STOP_FILE, new Date().toISOString() + '\n');
  if (activeChild) {
    activeChild.kill('SIGTERM');
    emit('event', { stage: activeStage, event: { type: 'force_stop', message: 'Force stop sent to current process.' } });
    return { ok: true };
  }
  return { ok: false, error: 'No active process.' };
});

app.whenReady().then(() => {
  storage.migrateLegacyData();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
