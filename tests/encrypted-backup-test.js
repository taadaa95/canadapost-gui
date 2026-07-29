'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');
const claimDb = require('../lib/claim-database');
const encryptedBackup = require('../lib/encrypted-backup');
const { inspectZipBuffer } = require('../lib/zip-safety');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-encrypted-test-'));
  const backupPassphrase = ['correct', 'horse', 'synthetic', 'backup', '2026'].join('-');
  try {
    const sourceDb = path.join(root, 'source', 'app.sqlite');
    const sourceData = path.join(root, 'source-data');
    fs.mkdirSync(sourceData, { recursive: true });
    fs.writeFileSync(path.join(sourceData, 'tracking.csv'), 'Tracking PIN\nSYNTHETIC000001\n');
    claimDb.upsertShipment(sourceDb, { trackingNumber: 'SYNTHETIC000001', classification: 'AUTO_ELIGIBLE' });

    const destination = path.join(root, 'backup.cpcrbackup');
    await encryptedBackup.createEncryptedBackup({ dbPath: sourceDb, dataDir: sourceData, config: { dryRunDefault: true }, destination, appVersion: 'test', password: backupPassphrase });
    assert.ok(encryptedBackup.isEncryptedBackup(destination));
    assert.ok(!fs.readFileSync(destination).includes(Buffer.from('SQLite format 3')));

    assert.throws(() => encryptedBackup.decodeEncryptedBuffer(fs.readFileSync(destination), 'wrong password for this backup'), /authentication failed/i);
    const tampered = Buffer.from(fs.readFileSync(destination));
    tampered[tampered.length - 24] ^= 1;
    assert.throws(() => encryptedBackup.decodeEncryptedBuffer(tampered, backupPassphrase), /authentication failed/i);

    const restoreDb = path.join(root, 'restore', 'app.sqlite');
    const restored = encryptedBackup.restoreEncryptedBackup({ source: destination, password: backupPassphrase, dbPath: restoreDb, dataDir: path.join(root, 'restored-data'), configWriter: () => {} });
    assert.strictEqual(restored.encrypted, true);
    assert.strictEqual(claimDb.integrityCheck(restoreDb).ok, true);
    assert.strictEqual(claimDb.dashboard(restoreDb).shipments, 1);

    const traversal = Buffer.from(zipSync({ '../escape.txt': strToU8('blocked') }));
    assert.throws(() => inspectZipBuffer(traversal), /unsafe entry path/i);
    const highRatio = Buffer.from(zipSync({ 'data/large.txt': new Uint8Array(2 * 1024 * 1024) }, { level: 9 }));
    assert.throws(() => inspectZipBuffer(highRatio), /compression ratio/i);
    assert.throws(() => encryptedBackup.encodeEncryptedBuffer(Buffer.from('not a zip'), backupPassphrase), /zip/i);
    process.stdout.write('Encrypted backup security tests passed.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
