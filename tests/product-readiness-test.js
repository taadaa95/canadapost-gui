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
    const metadata = updateSecurity.signManifest({
      format: updateSecurity.UPDATE_MANIFEST_FORMAT,
      manifestVersion: updateSecurity.UPDATE_MANIFEST_VERSION,
      applicationVersion: '0.4.1-beta.1', channel: 'beta', publishedAt: '2026-07-26T00:00:00.000Z',
      platform: 'linux', architecture: 'x64',
      artifact: { file: 'synthetic.AppImage', bytes: fs.statSync(artifact).size, sha256: checksum }
    }, keys.privateKey);
    const verifyOptions = { publicKey: keys.publicKey, channel: 'beta', currentVersion: '0.4.0-beta.1', platform: 'linux', architecture: 'x64' };
    assert.strictEqual(updateSecurity.verifyUpdateMetadata(metadata, verifyOptions).ok, true);
    assert.throws(() => updateSecurity.verifyUpdateMetadata(metadata, { ...verifyOptions, publicKey: '' }), /No trusted production update public key/);
    assert.throws(() => updateSecurity.verifyUpdateMetadata(metadata, { ...verifyOptions, channel: 'stable' }), /cannot install beta/);
    assert.strictEqual(updateSecurity.verifyArtifactChecksum(artifact, checksum), true);
    const downgrade = updateSecurity.signManifest({ ...updateSecurity.unsignedManifest(metadata), applicationVersion: '0.3.0' }, keys.privateKey);
    assert.throws(() => updateSecurity.verifyUpdateMetadata(downgrade, { ...verifyOptions, currentVersion: '0.4.0' }), /downgrade/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write('Product readiness security tests passed.\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
