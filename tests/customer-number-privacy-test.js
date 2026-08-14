'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const storageModulePath = require.resolve('../lib/app-storage');
const originalLoad = Module._load;

const syntheticOld = '9000000001';
const syntheticHistory = '9000000002';
const syntheticGeneric = '9000000003';
const syntheticCurrent = '9000000099';

function loadIsolatedStorage(userDataRoot) {
  delete require.cache[storageModulePath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getPath: () => userDataRoot },
        safeStorage: {
          isEncryptionAvailable: () => false,
          getSelectedStorageBackend: () => 'unavailable',
          encryptString: () => { throw new Error('not available'); },
          decryptString: () => { throw new Error('not available'); }
        }
      };
    }
    if (request === './user-data-bootstrap') {
      return {
        getState: () => ({ initialized: true, active: true, userDataRoot }),
        assertMutablePaths: () => {}
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../lib/app-storage');
  } finally {
    Module._load = originalLoad;
  }
}

const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-customer-privacy-'));
try {
  let storage = loadIsolatedStorage(userDataRoot);

  storage.migrateLegacyData();
  let config = storage.readConfig();
  assert.strictEqual(config.customerNumberPrivacyResetV1, true, 'a clean profile must record the reset marker');
  assert.strictEqual(config.estCustomerNumber || '', '', 'a clean profile must start without a customer number');

  fs.writeFileSync(storage.CONFIG_PATH, `${JSON.stringify({
    estCustomerNumber: syntheticOld,
    historyCustomerNumber: syntheticHistory,
    customerNumber: syntheticGeneric,
    webUsername: 'synthetic-user',
    claimCity: 'Ottawa',
    rememberSettings: true
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(storage.DATA_DIR, 'user.ini'), [
    `customerNumber=${syntheticOld}`,
    `customer_number=${syntheticGeneric}`,
    'mobo=9000000077',
    'apiEnvironment=production'
  ].join('\n') + '\n');

  storage.migrateLegacyData();
  config = storage.readConfig();
  assert.strictEqual(config.estCustomerNumber || '', '');
  assert.strictEqual(config.historyCustomerNumber || '', '');
  assert.strictEqual(Object.hasOwn(JSON.parse(fs.readFileSync(storage.CONFIG_PATH, 'utf8')), 'customerNumber'), false);
  assert.strictEqual(config.customerNumberPrivacyResetV1, true);
  assert.strictEqual(config.webUsername, 'synthetic-user');
  assert.strictEqual(config.claimCity, 'Ottawa');
  assert.strictEqual(config.rememberSettings, true);
  const migratedIni = fs.readFileSync(path.join(storage.DATA_DIR, 'user.ini'), 'utf8');
  assert.doesNotMatch(migratedIni, /^(?:customerNumber|customer_number)\s*=/mi);
  assert.match(migratedIni, /^mobo=9000000077$/m, 'unrelated INI settings must remain unchanged');

  storage.writeConfig({ ...config, estCustomerNumber: syntheticCurrent });
  storage.migrateLegacyData();
  assert.strictEqual(storage.readConfig().estCustomerNumber, syntheticCurrent, 'the marker must prevent repeated clearing');

  storage = loadIsolatedStorage(userDataRoot);
  storage.migrateLegacyData();
  assert.strictEqual(storage.readConfig().estCustomerNumber, syntheticCurrent, 'a number entered after reset must persist across restart');

  const redacted = storage.redactCustomerNumbers(
    `customer=${syntheticCurrent} endpoint=/${syntheticCurrent}/workgroup`,
    [syntheticCurrent]
  );
  assert.ok(!redacted.includes(syntheticCurrent), 'persistent log redaction must remove the full customer number');
  assert.match(redacted, /\[REDACTED_CUSTOMER_NUMBER\]/);

  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.doesNotMatch(renderer, /cfg\.estCustomerNumber\s*\|\|\s*cfg\.(?:historyCustomerNumber|customerNumber)/, 'renderer must not use legacy customer-number fallbacks');
  assert.match(renderer, /const customerNumber = getFieldValue\('estCustomerNumber'\)/, 'hidden Step 1 state must come from the visible current field');
  assert.match(main, /EST_CUSTOMER_NUMBER:\s*pickOptionString\(options, config, 'estCustomerNumber', 'estCustomerNumber', ''\)/, 'Step 1 must receive only the explicitly entered or saved current number');
  assert.doesNotMatch(main, /publicIni\.customerNumber|parsed\.customerNumber|parsed\.customer_number/, 'legacy INI customer numbers must not be runtime sources');

  const english = require('../locales/en-CA.json');
  const french = require('../locales/fr-CA.json');
  assert.strictEqual(english['settings.est.title'], 'Canada Post Customer Number');
  assert.strictEqual(english['settings.est.customerNumber'], 'Customer Number');
  assert.strictEqual(french['settings.est.title'], 'Numéro de client de Postes Canada');
  assert.strictEqual(french['settings.est.customerNumber'], 'Numéro de client');

  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<label for="estCustomerNumber" data-i18n="settings\.est\.customerNumber"><\/label>/);
  assert.match(html, /id="estCustomerNumber"[^>]*data-i18n-aria-label="settings\.est\.customerNumber"/);

  process.stdout.write('Customer-number one-time privacy reset and UI source tests passed.\n');
} finally {
  Module._load = originalLoad;
  delete require.cache[storageModulePath];
  fs.rmSync(userDataRoot, { recursive: true, force: true });
}
