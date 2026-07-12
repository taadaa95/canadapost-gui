const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const USER_DATA_ROOT = app.getPath('userData');
const DATA_DIR = path.join(USER_DATA_ROOT, 'data');
const LOG_DIR = path.join(USER_DATA_ROOT, 'logs');
const CONFIG_PATH = path.join(USER_DATA_ROOT, 'config.json');
const CREDENTIALS_PATH = path.join(USER_DATA_ROOT, 'credentials.json');

const CONFIG_FIELDS = new Set([
  'rememberSettings', 'webUsername', 'estCustomerNumber', 'estFrom', 'estTo',
  'historyCustomerNumber', 'historyFrom', 'historyTo', 'historyAutoMobo',
  'historyMobo', 'historyIncludeNoManifest', 'developerMode', 'freshTracking',
  'claimStreetNumber', 'claimStreetName', 'claimAddressLine2', 'claimCity',
  'claimProvince', 'claimPostalCode', 'claimBusinessName', 'claimContactName',
  'claimContactPhone', 'claimContactEmail', 'updateUrl'
]);

function ensurePrivateFile(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_) {}
}

function ensureDirs() {
  fs.mkdirSync(USER_DATA_ROOT, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  for (const directory of [USER_DATA_ROOT, DATA_DIR, LOG_DIR]) {
    try { fs.chmodSync(directory, 0o700); } catch (_) {}
  }
}

function copyIfMissing(source, destination) {
  if (!fs.existsSync(source) || fs.existsSync(destination)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return true;
}

function copyDirectoryContentsMissing(source, destination) {
  if (!fs.existsSync(source)) return false;
  let copied = false;
  fs.mkdirSync(destination, { recursive: true });
  const walk = (sourceDir, destinationDir) => {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (/^stop-requested\.txt$/i.test(entry.name)) continue;
      const sourcePath = path.join(sourceDir, entry.name);
      const destinationPath = path.join(destinationDir, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: true });
        walk(sourcePath, destinationPath);
      } else if (entry.isFile() && !fs.existsSync(destinationPath)) {
        fs.copyFileSync(sourcePath, destinationPath);
        copied = true;
      }
    }
  };
  walk(source, destination);
  return copied;
}

function readJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDirs();
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  ensurePrivateFile(filePath);
}

function sanitizeConfig(input = {}) {
  const output = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return output;
  for (const [key, value] of Object.entries(input)) {
    if (!CONFIG_FIELDS.has(key)) continue;
    if (typeof value === 'boolean') output[key] = value;
    else if (value === null || value === undefined) output[key] = '';
    else output[key] = String(value).slice(0, 4096);
  }
  return output;
}

function readConfig() {
  return sanitizeConfig(readJson(CONFIG_PATH, {}));
}

function writeConfig(config) {
  writeJsonAtomic(CONFIG_PATH, sanitizeConfig(config));
}

function credentialBackend() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return 'unavailable';
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      return safeStorage.getSelectedStorageBackend();
    }
    return 'os-crypt';
  } catch (_) {
    return 'unavailable';
  }
}

function strongCredentialStorageAvailable() {
  const backend = credentialBackend();
  return backend !== 'unavailable' && backend !== 'basic_text';
}

function encryptCredential(value) {
  if (!strongCredentialStorageAvailable()) return '';
  return safeStorage.encryptString(String(value || '')).toString('base64');
}

function decryptCredential(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(String(value), 'base64'));
  } catch (_) {
    return '';
  }
}

function readCredentialRecord() {
  const record = readJson(CREDENTIALS_PATH, {});
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
  if (!record.webPassword && typeof record.password === 'string' && record.password) {
    record.webPassword = record.password;
  }
  delete record.password;
  return record;
}

function writeCredentialRecord(record) {
  const clean = { version: 2 };
  for (const key of ['webPassword', 'apiUsername', 'apiPassword']) {
    if (typeof record[key] === 'string' && record[key]) clean[key] = record[key];
  }
  if (Object.keys(clean).length === 1) fs.rmSync(CREDENTIALS_PATH, { force: true });
  else writeJsonAtomic(CREDENTIALS_PATH, clean);
}

function passwordStored() {
  const record = readCredentialRecord();
  return Boolean(record.webPassword || record.password);
}

function savePassword(password, remember) {
  ensureDirs();
  const record = readCredentialRecord();
  const cleanPassword = String(password || '');
  if (!remember) {
    delete record.webPassword;
    delete record.password;
    writeCredentialRecord(record);
    return { stored: false, backend: credentialBackend() };
  }
  if (!cleanPassword) {
    return { stored: passwordStored(), backend: credentialBackend() };
  }
  if (!strongCredentialStorageAvailable()) {
    delete record.webPassword;
    delete record.password;
    writeCredentialRecord(record);
    return {
      stored: false,
      backend: credentialBackend(),
      warning: 'Password was not saved because secure OS credential encryption is unavailable.'
    };
  }
  record.webPassword = encryptCredential(cleanPassword);
  delete record.password;
  writeCredentialRecord(record);
  return { stored: true, backend: credentialBackend() };
}

function loadPassword() {
  const record = readCredentialRecord();
  return decryptCredential(record.webPassword || record.password || '');
}

function apiCredentialsStored() {
  const record = readCredentialRecord();
  return Boolean(record.apiUsername && record.apiPassword);
}

function saveApiCredentials(username, password) {
  ensureDirs();
  const cleanUsername = String(username || '').trim();
  const cleanPassword = String(password || '');
  if (!cleanUsername || !cleanPassword) {
    return { stored: apiCredentialsStored(), backend: credentialBackend() };
  }
  if (!strongCredentialStorageAvailable()) {
    return {
      stored: false,
      backend: credentialBackend(),
      warning: 'API credentials remain in user.ini because secure OS credential encryption is unavailable.'
    };
  }
  const record = readCredentialRecord();
  record.apiUsername = encryptCredential(cleanUsername);
  record.apiPassword = encryptCredential(cleanPassword);
  writeCredentialRecord(record);
  return { stored: true, backend: credentialBackend() };
}

function loadApiCredentials() {
  const record = readCredentialRecord();
  return {
    username: decryptCredential(record.apiUsername || ''),
    password: decryptCredential(record.apiPassword || '')
  };
}

function parseIniCredentials(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { username: '', password: '' };
  let username = '';
  let password = '';
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim().toLowerCase();
    const value = line.slice(equals + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key === 'username') username = value;
    if (key === 'password') password = value;
  }
  return { username, password };
}

function removeIniCredentialLines(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split(/\r?\n/).filter(rawLine => {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#') || !line.includes('=')) return true;
    const key = line.slice(0, line.indexOf('=')).trim().toLowerCase();
    return key !== 'username' && key !== 'password';
  });
  const output = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  if (output === source) return false;
  try {
    fs.writeFileSync(filePath, output, { mode: 0o600 });
    ensurePrivateFile(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

function migrateLegacyData() {
  ensureDirs();
  const migrated = [];
  const legacyData = path.join(ROOT, 'data');
  const legacyLogs = path.join(ROOT, 'logs');
  const legacyConfig = path.join(ROOT, 'config.local.json');
  const legacyUserIni = path.join(ROOT, 'user.ini');

  if (copyDirectoryContentsMissing(legacyData, DATA_DIR)) migrated.push('data');
  if (copyDirectoryContentsMissing(legacyLogs, LOG_DIR)) migrated.push('logs');
  if (copyIfMissing(legacyConfig, CONFIG_PATH)) migrated.push('config');
  if (copyIfMissing(legacyUserIni, path.join(DATA_DIR, 'user.ini'))) migrated.push('user.ini');

  const rawConfig = readJson(CONFIG_PATH, {});
  const legacyPassword = typeof rawConfig.webPassword === 'string' ? rawConfig.webPassword : '';
  const cleaned = sanitizeConfig(rawConfig);
  delete cleaned.webPassword;
  if (legacyPassword) savePassword(legacyPassword, cleaned.rememberSettings !== false);
  writeConfig(cleaned);

  const dataUserIni = path.join(DATA_DIR, 'user.ini');
  const sourceCredentials = parseIniCredentials(dataUserIni);
  const apiResult = saveApiCredentials(sourceCredentials.username, sourceCredentials.password);
  if (apiResult.stored) {
    removeIniCredentialLines(dataUserIni);
    // Remove the legacy plaintext copy as well when the application directory
    // is writable. Failure is harmless; config diagnostics will still flag it.
    removeIniCredentialLines(legacyUserIni);
    migrated.push('api-credentials');
  }

  ensurePrivateFile(dataUserIni);
  return migrated;
}

function publicConfig() {
  return {
    ...readConfig(),
    passwordStored: passwordStored(),
    apiCredentialsStored: apiCredentialsStored(),
    credentialBackend: credentialBackend(),
    secureCredentialStorage: strongCredentialStorageAvailable()
  };
}

module.exports = {
  ROOT,
  USER_DATA_ROOT,
  DATA_DIR,
  LOG_DIR,
  CONFIG_PATH,
  CREDENTIALS_PATH,
  ensureDirs,
  migrateLegacyData,
  readConfig,
  writeConfig,
  sanitizeConfig,
  publicConfig,
  savePassword,
  loadPassword,
  passwordStored,
  saveApiCredentials,
  loadApiCredentials,
  apiCredentialsStored,
  credentialBackend,
  strongCredentialStorageAvailable
};
