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
      error: new Error('password=synthetic-secret tracking SYNTHETIC000001 customer 9000000042 user@example.test'),
      context: { cookie: 'synthetic-cookie', address: '1 Example Street', customerNumber: '9000000042' },
      sensitiveValues: ['synthetic-secret', 'synthetic-cookie', '1 Example Street', '9000000042']
    });
    const crashText = fs.readFileSync(crash.destination, 'utf8');
    assert.ok(!crashText.includes('synthetic-secret'));
    assert.ok(!crashText.includes('synthetic-cookie'));
    assert.ok(!crashText.includes('SYNTHETIC000001'));
    assert.ok(!crashText.includes('9000000042'));
    await assert.rejects(() => new DisabledCrashProvider().send(), /disabled/);

    const artifact = path.join(root, 'artifact.bin');
    fs.writeFileSync(artifact, 'synthetic artifact');
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    assert.strictEqual(updateSecurity.verifyArtifactChecksum(artifact, checksum), true);
    assert(updateSecurity.compareVersions('0.4.0-beta.1', '0.4.0') < 0);
    assert(updateSecurity.compareVersions('0.4.0', '0.4.1') < 0);
    fs.appendFileSync(artifact, '!');
    assert.throws(() => updateSecurity.verifyArtifact(artifact, { bytes: fs.statSync(artifact).size - 1, sha256: checksum }), /size verification/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write('Product readiness security tests passed.\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
