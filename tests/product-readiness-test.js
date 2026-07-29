'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { POINTS, faultPoint } = require('../lib/fault-injection');
const { DisabledCrashProvider, createLocalCrashReport } = require('../lib/crash-reporting');
const updateSecurity = require('../lib/update-security');

(async () => {
  for (const point of POINTS) {
    assert.strictEqual(faultPoint(point, { NODE_ENV: 'production', CPCR_FAULT_POINT: point }), false);
    assert.throws(() => faultPoint(point, { NODE_ENV: 'test', CPCR_FAULT_POINT: point }), error => error.code === 'SYNTHETIC_FAULT' && error.faultPoint === point);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-readiness-test-'));
  try {
    const crash = createLocalCrashReport({
      directory: root, appVersion: 'test',
      error: new Error('password=synthetic-secret tracking SYNTHETIC000001 user@example.test'),
      context: { cookie: 'synthetic-cookie', address: '1 Example Street' },
      sensitiveValues: ['synthetic-secret', 'synthetic-cookie', '1 Example Street']
    });
    const crashText = fs.readFileSync(crash.destination, 'utf8');
    assert.ok(!crashText.includes('synthetic-secret'));
    assert.ok(!crashText.includes('synthetic-cookie'));
    assert.ok(!crashText.includes('SYNTHETIC000001'));
    await assert.rejects(() => new DisabledCrashProvider().send(), /disabled/);

    const keys = crypto.generateKeyPairSync('ed25519');
    const artifact = path.join(root, 'artifact.bin');
    fs.writeFileSync(artifact, 'synthetic artifact');
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    const metadata = {
      version: '0.4.0', channel: 'beta', publishedAt: '2026-07-26T00:00:00.000Z',
      artifact: { url: 'https://updates.example.test/app.bin', sha256: checksum }
    };
    metadata.signature = crypto.sign(null, updateSecurity.signedPayload(metadata), keys.privateKey).toString('base64');
    assert.strictEqual(updateSecurity.verifyUpdateMetadata(metadata, { publicKey: keys.publicKey, channel: 'beta', currentVersion: '0.4.0-dev.4' }).ok, true);
    assert.throws(() => updateSecurity.verifyUpdateMetadata(metadata, { channel: 'beta', currentVersion: '0.4.0-dev.4' }), /No trusted update public key/);
    assert.throws(() => updateSecurity.verifyUpdateMetadata(metadata, { publicKey: keys.publicKey, channel: 'stable', currentVersion: '0.4.0-dev.4' }), /cannot install beta/);
    assert.strictEqual(updateSecurity.verifyArtifactChecksum(artifact, checksum), true);
    const downgrade = { ...metadata, version: '0.3.0' };
    downgrade.signature = crypto.sign(null, updateSecurity.signedPayload(downgrade), keys.privateKey).toString('base64');
    assert.throws(() => updateSecurity.verifyUpdateMetadata(downgrade, { publicKey: keys.publicKey, channel: 'beta', currentVersion: '0.4.0' }), /downgrade/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write('Product readiness security tests passed.\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
