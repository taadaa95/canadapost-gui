'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const storageModulePath = require.resolve('../lib/app-storage');
const originalLoad = Module._load;

function loadStorage(tempRoot, fakeSafeStorage) {
  delete require.cache[storageModulePath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath(name) {
            assert.strictEqual(name, 'userData');
            return tempRoot;
          }
        },
        safeStorage: fakeSafeStorage
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

function testOsCredentialStorage() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-storage-os-test-'));
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'kwallet6',
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: value => {
      const text = value.toString('utf8');
      if (!text.startsWith('encrypted:')) throw new Error('Invalid encrypted value');
      return text.slice('encrypted:'.length);
    }
  };

  try {
    const storage = loadStorage(tempRoot, fakeSafeStorage);
    storage.ensureDirs();

    storage.writeConfig({ webUsername: 'example', estCustomerNumber: '1234567', guidanceSounds: false, webPassword: 'must-not-persist', arbitrary: 'blocked' });
    const config = storage.readConfig();
    assert.strictEqual(config.webUsername, 'example');
    assert.strictEqual(config.estCustomerNumber, '0001234567', 'stored customer numbers must use the canonical ten-digit form');
    assert.strictEqual(config.guidanceSounds, false, 'the non-sensitive Guidance sounds preference persists without a schema change');
    assert.ok(!Object.prototype.hasOwnProperty.call(config, 'webPassword'));
    assert.ok(!Object.prototype.hasOwnProperty.call(config, 'arbitrary'));

    const passwordResult = storage.savePassword('web-secret', true);
    const expectedBackend = process.platform === 'linux' ? 'kwallet6' : 'os-crypt';
    assert.strictEqual(passwordResult.stored, true);
    assert.strictEqual(passwordResult.updated, true);
    assert.strictEqual(passwordResult.backend, expectedBackend);
    assert.strictEqual(storage.loadPassword(), 'web-secret');
    assert.strictEqual(storage.passwordStored(), true);

    assert.strictEqual(storage.saveApiCredentials(' api-user ', ' api-secret ', { environment: 'development' }).stored, true);
    assert.deepStrictEqual(storage.loadApiCredentials(), { username: 'api-user', password: 'api-secret' });
    assert.strictEqual(storage.apiCredentialsStored(), true);
    assert.strictEqual(storage.apiCredentialEnvironment(), 'development');
    assert.notStrictEqual(storage.loadPassword(), storage.loadApiCredentials().password, 'website password was copied into API credentials');

    const trackingWrite = storage.saveTrackingApiCredentials(' current-client ', ' current-secret ', { environment: 'test' });
    assert.strictEqual(trackingWrite.stored, true);
    assert.strictEqual(trackingWrite.updated, true);
    assert.deepStrictEqual(storage.loadTrackingApiCredentials(), { clientId: 'current-client', clientSecret: 'current-secret' });
    assert.strictEqual(storage.trackingApiCredentialEnvironment(), 'test');
    assert.strictEqual(storage.trackingApiCredentialsStored(), true);
    assert.notStrictEqual(storage.loadTrackingApiCredentials().clientId, storage.loadApiCredentials().username, 'legacy API username was copied into the current client ID');
    assert.notStrictEqual(storage.loadTrackingApiCredentials().clientSecret, storage.loadApiCredentials().password, 'legacy API password was copied into the current client secret');

    const rawCredentialText = fs.readFileSync(storage.CREDENTIALS_PATH, 'utf8');
    assert.ok(!rawCredentialText.includes('web-secret'));
    assert.ok(!rawCredentialText.includes('api-user'));
    assert.ok(!rawCredentialText.includes('api-secret'));
    assert.ok(!rawCredentialText.includes('current-client'));
    assert.ok(!rawCredentialText.includes('current-secret'));
    assert.ok(rawCredentialText.includes('electron-safe-storage-v1'));

    const publicConfig = storage.publicConfig();
    assert.strictEqual(publicConfig.secureCredentialStorage, true);
    assert.strictEqual(publicConfig.credentialStorageMode, 'os-keyring');
    assert.strictEqual(publicConfig.credentialBackend, expectedBackend);

    storage.savePassword('', false);
    assert.strictEqual(storage.passwordStored(), false);
    assert.strictEqual(storage.apiCredentialsStored(), true);
    storage.clearTrackingApiCredentials();
    assert.strictEqual(storage.trackingApiCredentialsStored(), false);
    assert.strictEqual(storage.apiCredentialsStored(), true, 'clearing current credentials must preserve deprecated legacy credentials');
  } finally {
    delete require.cache[storageModulePath];
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function testDeviceLocalCredentialFallback() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-storage-local-test-'));
  const unavailableSafeStorage = {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'unavailable',
    encryptString: () => { throw new Error('OS storage must not be used'); },
    decryptString: () => { throw new Error('OS storage must not be used'); }
  };

  try {
    let storage = loadStorage(tempRoot, unavailableSafeStorage);
    storage.ensureDirs();

    const passwordResult = storage.savePassword('persistent-web-secret', true);
    assert.strictEqual(passwordResult.stored, true);
    assert.strictEqual(passwordResult.backend, 'local-aes-gcm');
    assert.match(passwordResult.warning, /AES-256-GCM device-local encryption/i);
    assert.strictEqual(storage.loadPassword(), 'persistent-web-secret');
    assert.strictEqual(storage.passwordStored(), true);

    const apiResult = storage.saveApiCredentials('persistent-api-user', 'persistent-api-secret', { environment: 'production' });
    assert.strictEqual(apiResult.stored, true);
    assert.strictEqual(apiResult.backend, 'local-aes-gcm');
    assert.deepStrictEqual(storage.loadApiCredentials(), {
      username: 'persistent-api-user',
      password: 'persistent-api-secret'
    });
    assert.strictEqual(storage.apiCredentialEnvironment(), 'production');

    const trackingResult = storage.saveTrackingApiCredentials('persistent-current-client', 'persistent-current-secret', { environment: 'production' });
    assert.strictEqual(trackingResult.stored, true);
    assert.strictEqual(trackingResult.backend, 'local-aes-gcm');
    assert.deepStrictEqual(storage.loadTrackingApiCredentials(), { clientId: 'persistent-current-client', clientSecret: 'persistent-current-secret' });
    assert.strictEqual(storage.trackingApiCredentialEnvironment(), 'production');

    const rawCredentialText = fs.readFileSync(storage.CREDENTIALS_PATH, 'utf8');
    assert.ok(rawCredentialText.includes('local-aes-256-gcm-v1'));
    assert.ok(!rawCredentialText.includes('persistent-web-secret'));
    assert.ok(!rawCredentialText.includes('persistent-api-user'));
    assert.ok(!rawCredentialText.includes('persistent-api-secret'));
    assert.ok(!rawCredentialText.includes('persistent-current-client'));
    assert.ok(!rawCredentialText.includes('persistent-current-secret'));

    const key = fs.readFileSync(storage.CREDENTIAL_KEY_PATH);
    assert.strictEqual(key.length, 32);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(storage.CREDENTIAL_KEY_PATH).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(storage.CREDENTIALS_PATH).mode & 0o777, 0o600);
    }

    // Simulate a full application restart. The password must remain decryptable.
    storage = loadStorage(tempRoot, unavailableSafeStorage);
    assert.strictEqual(storage.loadPassword(), 'persistent-web-secret');
    assert.deepStrictEqual(storage.loadApiCredentials(), {
      username: 'persistent-api-user',
      password: 'persistent-api-secret'
    });
    assert.deepStrictEqual(storage.loadTrackingApiCredentials(), {
      clientId: 'persistent-current-client',
      clientSecret: 'persistent-current-secret'
    });
    const publicConfig = storage.publicConfig();
    assert.strictEqual(publicConfig.passwordStored, true);
    assert.strictEqual(publicConfig.secureCredentialStorage, false);
    assert.strictEqual(publicConfig.credentialStorageMode, 'device-local');
    assert.strictEqual(publicConfig.credentialBackend, 'local-aes-gcm');
    assert.match(publicConfig.credentialStorageWarning, /OS keyring is unavailable/i);

    storage.savePassword('', false);
    assert.strictEqual(storage.passwordStored(), false);
    assert.strictEqual(storage.apiCredentialsStored(), true);
  } finally {
    delete require.cache[storageModulePath];
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  testOsCredentialStorage();
  testDeviceLocalCredentialFallback();
  console.log('Storage tests passed.');
} finally {
  Module._load = originalLoad;
  delete require.cache[storageModulePath];
}
