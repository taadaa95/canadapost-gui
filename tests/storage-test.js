const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-storage-test-'));
const originalLoad = Module._load;

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

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: name => {
        assert.strictEqual(name, 'userData');
        return tempRoot;
      } },
      safeStorage: fakeSafeStorage
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const storage = require('../lib/app-storage');
  storage.ensureDirs();

  storage.writeConfig({ webUsername: 'example', webPassword: 'must-not-persist', arbitrary: 'blocked' });
  const config = storage.readConfig();
  assert.strictEqual(config.webUsername, 'example');
  assert.ok(!Object.prototype.hasOwnProperty.call(config, 'webPassword'));
  assert.ok(!Object.prototype.hasOwnProperty.call(config, 'arbitrary'));

  assert.strictEqual(storage.savePassword('web-secret', true).stored, true);
  assert.strictEqual(storage.loadPassword(), 'web-secret');
  assert.strictEqual(storage.passwordStored(), true);

  assert.strictEqual(storage.saveApiCredentials('api-user', 'api-secret').stored, true);
  assert.deepStrictEqual(storage.loadApiCredentials(), { username: 'api-user', password: 'api-secret' });
  assert.strictEqual(storage.apiCredentialsStored(), true);

  const rawCredentialText = fs.readFileSync(storage.CREDENTIALS_PATH, 'utf8');
  assert.ok(!rawCredentialText.includes('web-secret'));
  assert.ok(!rawCredentialText.includes('api-user'));
  assert.ok(!rawCredentialText.includes('api-secret'));

  storage.savePassword('', false);
  assert.strictEqual(storage.passwordStored(), false);
  assert.strictEqual(storage.apiCredentialsStored(), true);

  console.log('Storage tests passed.');
} finally {
  Module._load = originalLoad;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
