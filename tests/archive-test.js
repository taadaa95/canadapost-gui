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
      status: 'submitted', confirmationNumber: 'CONF-1', screenshotPath: screenshot, textPath: pageText
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
    const step3Run = path.join(logDir, 'step3-runs', 'step3-test-run');
    fs.mkdirSync(path.join(step3Run, 'page-states'), { recursive: true });
    fs.writeFileSync(path.join(step3Run, 'timeline.jsonl'), '{"message":"supersecret user@example.com 1234567890123456"}\n');
    fs.writeFileSync(path.join(step3Run, 'summary.json'), '{"outcome":"complete"}\n');
    fs.writeFileSync(path.join(step3Run, 'page-states', '001-test.json'), '{"visibleText":"H0H 0H0 1234567890123456"}\n');
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
      sensitiveValues: ['supersecret', 'user@example.com']
    });
    const diagnosticEntries = unzipSync(new Uint8Array(fs.readFileSync(diagnostics)));
    const log = strFromU8(diagnosticEntries['logs/latest.log']);
    assert.ok(!log.includes('supersecret'));
    assert.ok(!log.includes('user@example.com'));
    assert.ok(!log.includes('1234567890123456'));
    assert.ok(log.includes('[REDACTED]'));
    assert.ok(diagnosticEntries['step3-diagnostics/timeline.jsonl']);
    assert.ok(diagnosticEntries['step3-diagnostics/summary.json']);
    assert.ok(diagnosticEntries['step3-diagnostics/page-states/001-test.json']);
    assert.ok(!diagnosticEntries['step3-diagnostics/private-screenshot.png']);
    const step3Timeline = strFromU8(diagnosticEntries['step3-diagnostics/timeline.jsonl']);
    assert.ok(!step3Timeline.includes('supersecret'));
    assert.ok(!step3Timeline.includes('user@example.com'));
    assert.ok(!step3Timeline.includes('1234567890123456'));

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
