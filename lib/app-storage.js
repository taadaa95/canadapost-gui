const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const USER_DATA_ROOT = app.getPath('userData');
const DATA_DIR = path.join(USER_DATA_ROOT, 'data');
const LOG_DIR = path.join(USER_DATA_ROOT, 'logs');
const CONFIG_PATH = path.join(USER_DATA_ROOT, 'config.json');
const CREDENTIALS_PATH = path.join(USER_DATA_ROOT, 'credentials.json');
const CREDENTIAL_KEY_PATH = path.join(USER_DATA_ROOT, 'credential-key.bin');

const OS_CREDENTIAL_SCHEME = 'electron-safe-storage-v1';
const LOCAL_CREDENTIAL_SCHEME = 'local-aes-256-gcm-v1';
const LOCAL_CREDENTIAL_BACKEND = 'local-aes-gcm';
const LOCAL_CREDENTIAL_AAD = Buffer.from('canadapost-gui:credential:v1', 'utf8');

const CONFIG_FIELDS = new Set([
  'rememberSettings', 'webUsername', 'estCustomerNumber', 'estFrom', 'estTo',
  'historyCustomerNumber', 'historyFrom', 'historyTo', 'historyAutoMobo',
  'historyMobo', 'historyIncludeNoManifest', 'developerMode', 'freshTracking',
  'claimStreetNumber', 'claimStreetName', 'claimAddressLine2', 'claimCity',
  'claimProvince', 'claimPostalCode', 'claimBusinessName', 'claimContactName',
  'claimContactPhone', 'claimContactEmail', 'updateUrl', 'evidenceRetentionDays',
  'dryRunDefault'
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

function osCredentialBackend() {
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
  const backend = osCredentialBackend();
  return backend !== 'unavailable' && backend !== 'basic_text';
}

function credentialBackend() {
  return strongCredentialStorageAvailable() ? osCredentialBackend() : LOCAL_CREDENTIAL_BACKEND;
}

function credentialStorageWarning() {
  if (strongCredentialStorageAvailable()) return '';
  return 'The OS keyring is unavailable. Credentials are saved with AES-256-GCM device-local encryption protected by your user account file permissions.';
}

function readLocalCredentialKey(createIfMissing = false) {
  ensureDirs();
  try {
    if (fs.existsSync(CREDENTIAL_KEY_PATH)) {
      const key = fs.readFileSync(CREDENTIAL_KEY_PATH);
      ensurePrivateFile(CREDENTIAL_KEY_PATH);
      return key.length === 32 ? key : null;
    }
    if (!createIfMissing) return null;

    const key = crypto.randomBytes(32);
    try {
      fs.writeFileSync(CREDENTIAL_KEY_PATH, key, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = fs.readFileSync(CREDENTIAL_KEY_PATH);
      return existing.length === 32 ? existing : null;
    }
    ensurePrivateFile(CREDENTIAL_KEY_PATH);
    return key;
  } catch (_) {
    return null;
  }
}

function encryptWithOsStorage(value) {
  return {
    scheme: OS_CREDENTIAL_SCHEME,
    value: safeStorage.encryptString(String(value || '')).toString('base64')
  };
}

function decryptWithOsStorage(entry) {
  if (!safeStorage.isEncryptionAvailable()) return '';
  const encoded = typeof entry === 'string' ? entry : String(entry?.value || '');
  if (!encoded) return '';
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch (_) {
    return '';
  }
}

function encryptWithLocalStorage(value) {
  const key = readLocalCredentialKey(true);
  if (!key) throw new Error('Could not create the device-local credential encryption key.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(LOCAL_CREDENTIAL_AAD);
  const ciphertext = Buffer.concat([cipher.update(String(value || ''), 'utf8'), cipher.final()]);
  return {
    scheme: LOCAL_CREDENTIAL_SCHEME,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptWithLocalStorage(entry) {
  const key = readLocalCredentialKey(false);
  if (!key || !entry || typeof entry !== 'object') return '';
  try {
    const iv = Buffer.from(String(entry.iv || ''), 'base64');
    const tag = Buffer.from(String(entry.tag || ''), 'base64');
    const ciphertext = Buffer.from(String(entry.ciphertext || ''), 'base64');
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(LOCAL_CREDENTIAL_AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (_) {
    return '';
  }
}

function encryptCredential(value) {
  if (strongCredentialStorageAvailable()) {
    return { entry: encryptWithOsStorage(value), backend: osCredentialBackend(), warning: '' };
  }
  return {
    entry: encryptWithLocalStorage(value),
    backend: LOCAL_CREDENTIAL_BACKEND,
    warning: credentialStorageWarning()
  };
}

function decryptCredential(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return decryptWithOsStorage(entry); // Legacy v2 record.
  if (entry.scheme === OS_CREDENTIAL_SCHEME) return decryptWithOsStorage(entry);
  if (entry.scheme === LOCAL_CREDENTIAL_SCHEME) return decryptWithLocalStorage(entry);
  return '';
}

function validCredentialEntry(entry) {
  if (typeof entry === 'string') return Boolean(entry);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.scheme === OS_CREDENTIAL_SCHEME) return typeof entry.value === 'string' && Boolean(entry.value);
  if (entry.scheme === LOCAL_CREDENTIAL_SCHEME) {
    return ['iv', 'tag', 'ciphertext'].every(key => typeof entry[key] === 'string' && Boolean(entry[key]));
  }
  return false;
}

function backendForEntry(entry) {
  if (entry?.scheme === LOCAL_CREDENTIAL_SCHEME) return LOCAL_CREDENTIAL_BACKEND;
  if (entry?.scheme === OS_CREDENTIAL_SCHEME || typeof entry === 'string') return osCredentialBackend();
  return credentialBackend();
}

function readCredentialRecord() {
  const record = readJson(CREDENTIALS_PATH, {});
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
  if (!record.webPassword && validCredentialEntry(record.password)) record.webPassword = record.password;
  delete record.password;
  return record;
}

function writeCredentialRecord(record) {
  const clean = { version: 3 };
  for (const key of ['webPassword', 'apiUsername', 'apiPassword']) {
    if (validCredentialEntry(record[key])) clean[key] = record[key];
  }
  if (Object.keys(clean).length === 1) {
    fs.rmSync(CREDENTIALS_PATH, { force: true });
  } else {
    writeJsonAtomic(CREDENTIALS_PATH, clean);
  }
}

function loadPassword() {
  const record = readCredentialRecord();
  return decryptCredential(record.webPassword || record.password || '');
}

function passwordStored() {
  return Boolean(loadPassword());
}

function savePassword(password, remember) {
  ensureDirs();
  const record = readCredentialRecord();
  const cleanPassword = String(password || '');
  if (!remember) {
    delete record.webPassword;
    delete record.password;
    writeCredentialRecord(record);
    return { stored: false, backend: credentialBackend(), warning: '' };
  }
  if (!cleanPassword) {
    return {
      stored: passwordStored(),
      backend: backendForEntry(record.webPassword),
      warning: record.webPassword?.scheme === LOCAL_CREDENTIAL_SCHEME ? credentialStorageWarning() : ''
    };
  }

  try {
    const encrypted = encryptCredential(cleanPassword);
    record.webPassword = encrypted.entry;
    delete record.password;
    writeCredentialRecord(record);
    return { stored: true, backend: encrypted.backend, warning: encrypted.warning };
  } catch (error) {
    return {
      stored: passwordStored(),
      backend: credentialBackend(),
      warning: `Password could not be saved: ${error.message}`
    };
  }
}

function loadApiCredentials() {
  const record = readCredentialRecord();
  return {
    username: decryptCredential(record.apiUsername || ''),
    password: decryptCredential(record.apiPassword || '')
  };
}

function apiCredentialsStored() {
  const credentials = loadApiCredentials();
  return Boolean(credentials.username && credentials.password);
}

function saveApiCredentials(username, password) {
  ensureDirs();
  const cleanUsername = String(username || '').trim();
  const cleanPassword = String(password || '');
  if (!cleanUsername || !cleanPassword) {
    return { stored: apiCredentialsStored(), backend: credentialBackend(), warning: '' };
  }

  try {
    const encryptedUsername = encryptCredential(cleanUsername);
    const encryptedPassword = encryptCredential(cleanPassword);
    const record = readCredentialRecord();
    record.apiUsername = encryptedUsername.entry;
    record.apiPassword = encryptedPassword.entry;
    writeCredentialRecord(record);
    return {
      stored: true,
      backend: encryptedUsername.backend,
      warning: encryptedUsername.warning || encryptedPassword.warning || ''
    };
  } catch (error) {
    return {
      stored: apiCredentialsStored(),
      backend: credentialBackend(),
      warning: `API credentials could not be saved: ${error.message}`
    };
  }
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
    removeIniCredentialLines(legacyUserIni);
    migrated.push('api-credentials');
  }

  ensurePrivateFile(dataUserIni);
  return migrated;
}

function publicConfig() {
  const fallbackActive = !strongCredentialStorageAvailable();
  return {
    ...readConfig(),
    passwordStored: passwordStored(),
    apiCredentialsStored: apiCredentialsStored(),
    credentialBackend: credentialBackend(),
    secureCredentialStorage: strongCredentialStorageAvailable(),
    credentialStorageMode: fallbackActive ? 'device-local' : 'os-keyring',
    credentialStorageWarning: fallbackActive ? credentialStorageWarning() : ''
  };
}

module.exports = {
  ROOT,
  USER_DATA_ROOT,
  DATA_DIR,
  LOG_DIR,
  CONFIG_PATH,
  CREDENTIALS_PATH,
  CREDENTIAL_KEY_PATH,
  LOCAL_CREDENTIAL_BACKEND,
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
  credentialStorageWarning,
  strongCredentialStorageAvailable
};
