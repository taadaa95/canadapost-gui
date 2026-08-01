'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');
const claimDb = require('../lib/claim-database');
const archiveTools = require('../lib/archive-tools');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-archive-test-'));
  try {
    const sourceData = path.join(root, 'source-data');
    const sourceDb = path.join(root, 'source-db', 'app.sqlite');
    fs.mkdirSync(sourceData, { recursive: true });
    const screenshot = path.join(sourceData, 'claim-submitted-row-2-test.png');
    const pageText = path.join(sourceData, 'claim-submitted-row-2-test.txt');
    fs.writeFileSync(screenshot, Buffer.from([137, 80, 78, 71]));
    fs.writeFileSync(pageText, 'Confirmation for 1234567890123456\n');
    fs.writeFileSync(path.join(sourceData, 'tracking.csv'), 'Tracking PIN\n1234567890123456\n');
    fs.writeFileSync(path.join(sourceData, 'user.ini'), 'username=DO-NOT-BACK-UP\npassword=DO-NOT-BACK-UP\n');

    const attemptId = claimDb.beginClaimAttempt(sourceDb, { trackingNumber: '1234567890123456' });
    claimDb.completeClaimAttempt(sourceDb, attemptId, {
      status: 'submitted', confirmationNumber: 'CONF-1', screenshotPath: screenshot, textPath: pageText,
      message: 'Recipient Jane Example lives at 77 Private Avenue.'
    });

    const backupPath = path.join(root, 'backup.zip');
    await archiveTools.createBackup({
      dbPath: sourceDb,
      dataDir: sourceData,
      config: { webUsername: 'user@example.com', claimStreetNumber: '123', dryRunDefault: true },
      destination: backupPath,
      appVersion: '0.3.2'
    });
    const entries = unzipSync(new Uint8Array(fs.readFileSync(backupPath)));
    assert.ok(entries['database/app.sqlite']);
    assert.ok(entries['data/claim-submitted-row-2-test.png']);
    assert.ok(entries['data/claim-submitted-row-2-test.txt']);
    assert.ok(entries['data/tracking.csv']);
    assert.ok(!entries['data/user.ini']);
    const allNames = Object.keys(entries).join('\n');
    assert.ok(!/browser-profile|credentials\.json/i.test(allNames));

    const restoreData = path.join(root, 'restore-data');
    const restoreDb = path.join(root, 'restore-db', 'app.sqlite');
    let restoredConfig = null;
    const restored = archiveTools.restoreBackup({
      source: backupPath,
      dbPath: restoreDb,
      dataDir: restoreData,
      configWriter: value => { restoredConfig = value; }
    });
    assert.strictEqual(restored.ok, true);
    assert.ok(restored.restoredDataFiles >= 3);
    assert.strictEqual(restoredConfig.dryRunDefault, true);
    assert.ok(fs.existsSync(path.join(restoreData, path.basename(screenshot))));
    const restoredHistory = claimDb.listClaimHistory(restoreDb, { limit: 10 });
    assert.strictEqual(restoredHistory.length, 1);
    assert.strictEqual(restoredHistory[0].screenshotPath, path.join(restoreData, path.basename(screenshot)));
    assert.strictEqual(claimDb.integrityCheck(restoreDb).ok, true);

    const logDir = path.join(root, 'logs');
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(logDir, 'latest.log'), 'password=supersecret user@example.com H0H 0H0 1234567890123456\n');
    fs.writeFileSync(path.join(logDir, 'Jane Example 77 Private Avenue.log'), 'arbitrary private address text\n');
    const outsideLog = path.join(root, 'outside-private.log');
    fs.writeFileSync(outsideLog, 'outside symlink secret');
    fs.symlinkSync(outsideLog, path.join(logDir, 'linked.log'));
    const oversizedLog = path.join(logDir, 'oversized.log');
    fs.writeFileSync(oversizedLog, 'oversized private prefix');
    fs.truncateSync(oversizedLog, 6 * 1024 * 1024);
    const step3Run = path.join(logDir, 'step3-runs', 'step3-test-run');
    fs.mkdirSync(path.join(step3Run, 'page-states'), { recursive: true });
    fs.writeFileSync(path.join(step3Run, 'timeline.jsonl'), '{"message":"supersecret user@example.com 1234567890123456"}\n');
    fs.writeFileSync(path.join(step3Run, 'summary.json'), '{"outcome":"complete"}\n');
    fs.writeFileSync(path.join(step3Run, 'page-states', '001-test.json'), '{"visibleText":"H0H 0H0 1234567890123456"}\n');
    for (let index = 0; index < 120; index += 1) fs.writeFileSync(path.join(step3Run, 'page-states', `${index + 2}-bounded.txt`), 'bounded metadata source');
    fs.writeFileSync(path.join(step3Run, 'private-screenshot.png'), Buffer.from([137, 80, 78, 71]));
    const diagnostics = path.join(root, 'diagnostics.zip');
    archiveTools.createDiagnosticPackage({
      destination: diagnostics,
      appVersion: '0.3.2',
      config: { webUsername: 'user@example.com' },
      credentialStatus: { passwordStored: true },
      logDir,
      dbPath: sourceDb,
      dependencyStatus: { phpAvailable: true },
      sensitiveValues: ['supersecret', 'user@example.com'],
      components: ['system', 'settings', 'history', 'logs', 'step3Diagnostics'],
      supportManifest: { format: 'canadapost-claim-runner-support-bundle', version: 1, supportReferenceId: 'CPCR-TEST' }
    });
    const diagnosticEntries = unzipSync(new Uint8Array(fs.readFileSync(diagnostics)));
    assert.ok(diagnosticEntries['logs/inventory.json']);
    assert.ok(diagnosticEntries['step3-diagnostics/inventory.json']);
    assert.ok(!diagnosticEntries['step3-diagnostics/private-screenshot.png']);
    const diagnosticText = Object.values(diagnosticEntries).map(value => strFromU8(value)).join('\n');
    const diagnosticInventory = JSON.parse(strFromU8(diagnosticEntries['step3-diagnostics/inventory.json']));
    assert(diagnosticInventory.files.length <= 100, 'malicious diagnostic trees must produce a bounded inventory');
    for (const secret of ['supersecret', 'user@example.com', '1234567890123456', 'Jane Example', '77 Private Avenue', 'outside symlink secret', 'oversized private prefix']) {
      assert.ok(!diagnosticText.includes(secret), `support bundle leaked free-form value: ${secret}`);
    }
    const recentAttempts = JSON.parse(strFromU8(diagnosticEntries['history/recent-attempts.json']));
    assert.strictEqual(recentAttempts[0].messagePresent, true);
    assert.strictEqual(Object.hasOwn(recentAttempts[0], 'message'), false, 'free-form history text must not enter support bundles');

    const defaultBundle = path.join(root, 'support-default.zip');
    archiveTools.createDiagnosticPackage({
      destination: defaultBundle,
      appVersion: '0.4.0-beta.1', config: {}, credentialStatus: {}, logDir,
      dbPath: sourceDb, dependencyStatus: {}, sensitiveValues: ['supersecret'],
      supportManifest: { format: 'canadapost-claim-runner-support-bundle', version: 1 }
    });
    const defaultEntries = unzipSync(new Uint8Array(fs.readFileSync(defaultBundle)));
    assert.ok(defaultEntries['system/database-integrity.json']);
    assert.ok(defaultEntries['settings/sanitized-settings.json']);
    assert.ok(!defaultEntries['logs/inventory.json'], 'logs must require explicit opt in');
    assert.ok(!defaultEntries['history/recent-attempts.json'], 'history must require explicit opt in');
    assert.ok(!Object.keys(defaultEntries).some(name => /screenshot|\.png$/i.test(name)), 'screenshots must never enter support bundles');

    const exportPath = path.join(root, 'history.csv');
    archiveTools.exportHistoryCsv(sourceDb, exportPath, {});
    assert.ok(fs.readFileSync(exportPath, 'utf8').includes('CONF-1'));

    console.log('Archive tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
