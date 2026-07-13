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

    storage.writeConfig({ webUsername: 'example', webPassword: 'must-not-persist', arbitrary: 'blocked' });
    const config = storage.readConfig();
    assert.strictEqual(config.webUsername, 'example');
    assert.ok(!Object.prototype.hasOwnProperty.call(config, 'webPassword'));
    assert.ok(!Object.prototype.hasOwnProperty.call(config, 'arbitrary'));

    const passwordResult = storage.savePassword('web-secret', true);
    assert.strictEqual(passwordResult.stored, true);
    assert.strictEqual(passwordResult.backend, 'kwallet6');
    assert.strictEqual(storage.loadPassword(), 'web-secret');
    assert.strictEqual(storage.passwordStored(), true);

    assert.strictEqual(storage.saveApiCredentials('api-user', 'api-secret').stored, true);
    assert.deepStrictEqual(storage.loadApiCredentials(), { username: 'api-user', password: 'api-secret' });
    assert.strictEqual(storage.apiCredentialsStored(), true);

    const rawCredentialText = fs.readFileSync(storage.CREDENTIALS_PATH, 'utf8');
    assert.ok(!rawCredentialText.includes('web-secret'));
    assert.ok(!rawCredentialText.includes('api-user'));
    assert.ok(!rawCredentialText.includes('api-secret'));
    assert.ok(rawCredentialText.includes('electron-safe-storage-v1'));

    const publicConfig = storage.publicConfig();
    assert.strictEqual(publicConfig.secureCredentialStorage, true);
    assert.strictEqual(publicConfig.credentialStorageMode, 'os-keyring');

    storage.savePassword('', false);
    assert.strictEqual(storage.passwordStored(), false);
    assert.strictEqual(storage.apiCredentialsStored(), true);
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

    const apiResult = storage.saveApiCredentials('persistent-api-user', 'persistent-api-secret');
    assert.strictEqual(apiResult.stored, true);
    assert.strictEqual(apiResult.backend, 'local-aes-gcm');
    assert.deepStrictEqual(storage.loadApiCredentials(), {
      username: 'persistent-api-user',
      password: 'persistent-api-secret'
    });

    const rawCredentialText = fs.readFileSync(storage.CREDENTIALS_PATH, 'utf8');
    assert.ok(rawCredentialText.includes('local-aes-256-gcm-v1'));
    assert.ok(!rawCredentialText.includes('persistent-web-secret'));
    assert.ok(!rawCredentialText.includes('persistent-api-user'));
    assert.ok(!rawCredentialText.includes('persistent-api-secret'));

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
