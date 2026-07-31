'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OperationCoordinator, PROTECTED_OPERATIONS } = require('../lib/operation-coordinator');
const guard = require('../lib/update-install-guard');
const updater = require('../lib/github-release-updater');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-update-guard-'));
  try {
    const coordinator = new OperationCoordinator();
    for (const operation of PROTECTED_OPERATIONS) {
      const token = coordinator.begin(operation);
      assert.throws(() => coordinator.assertInactive(), error => error.code === 'PROTECTED_OPERATION_ACTIVE' && error.operation === operation);
      coordinator.end(token);
    }

    let installed = false;
    const inactive = await guard.prepareInstall({
      coordinator,
      createBackup: async () => path.join(root, 'backup.sqlite'),
      createMarker: async backupPath => ({ path: path.join(root, 'pending.json'), backupPath }),
      install: async () => { installed = true; }
    });
    assert.strictEqual(inactive.ok, true);
    assert.strictEqual(installed, true);

    const activeToken = coordinator.begin('step3_live_run');
    const active = await guard.prepareInstall({ coordinator, createBackup: async () => { throw new Error('must not run'); }, createMarker: async () => ({}), install: async () => {} });
    assert.strictEqual(active.blocked, true);
    assert.strictEqual(active.error.operation, 'step3_live_run');
    coordinator.end(activeToken);

    const lastMoment = await guard.prepareInstall({
      coordinator,
      createBackup: async () => {
        coordinator.begin('backup_restore');
        return path.join(root, 'backup-last.sqlite');
      },
      createMarker: async () => { throw new Error('marker must not be created while operation became active'); },
      install: async () => {}
    });
    assert.strictEqual(lastMoment.blocked, true);
    assert.strictEqual(lastMoment.error.operation, 'backup_restore');
    coordinator.resetForTests();

    await assert.rejects(() => guard.prepareInstall({
      coordinator,
      createBackup: async () => { throw Object.assign(new Error('synthetic verified backup failure'), { code: 'BACKUP_FAILED' }); },
      createMarker: async () => ({}),
      install: async () => {}
    }), /backup failure/i);

    const backup = path.join(root, 'database-backups', 'pre-update.sqlite');
    const download = path.join(root, 'updates', '0.4.0-dev.8', 'installer.exe');
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.mkdirSync(path.dirname(download), { recursive: true });
    fs.writeFileSync(backup, 'synthetic backup');
    fs.writeFileSync(download, 'verified installer');
    const pending = guard.createPendingMarker({
      userDataRoot: root,
      oldVersion: '0.4.0-dev.7',
      targetVersion: '0.4.0-dev.8',
      backupPath: backup,
      downloadedPath: download,
      previousExecutable: path.join(root, 'runner.AppImage.previous'),
      now: new Date('2026-07-30T12:00:00.000Z')
    });
    const markerText = fs.readFileSync(pending.path, 'utf8');
    for (const forbidden of ['credential', 'cookie', 'browser-profile', 'device-key']) assert.ok(!markerText.toLowerCase().includes(forbidden));
    const recovery = guard.recoveryState(root);
    assert.strictEqual(recovery.pending, true);
    assert.strictEqual(recovery.backupPreserved, true);
    assert.strictEqual(recovery.downloadedInstallerPreserved, true);
    const healthy = guard.acknowledgeHealthyStartup(root, { integrity: 'ok', now: new Date('2026-07-30T12:10:00.000Z') });
    assert.strictEqual(healthy.acknowledged, true);
    assert.strictEqual(fs.existsSync(pending.path), false);
    assert.strictEqual(fs.existsSync(backup), true, 'health acknowledgement must preserve the pre-update backup');
    assert.strictEqual(fs.existsSync(download), true, 'Windows installer must remain available');

    const redacted = guard.sanitizedError(new Error('password=secret token=abc tracking 1234567890123456'));
    assert.ok(!JSON.stringify(redacted).includes('secret'));
    assert.ok(!JSON.stringify(redacted).includes('1234567890123456'));

    const abandoned = path.join(root, 'updates', 'old', 'package.AppImage.partial-123');
    const oldPackage = path.join(root, 'updates', 'old', 'old.AppImage');
    fs.mkdirSync(path.dirname(abandoned), { recursive: true });
    fs.writeFileSync(abandoned, 'partial');
    fs.writeFileSync(oldPackage, 'old');
    updater.cleanupUpdateStorage(root, { keepRecent: 0, protectedPaths: [download] });
    assert.strictEqual(fs.existsSync(abandoned), false);
    assert.strictEqual(fs.existsSync(oldPackage), false);
    assert.strictEqual(fs.existsSync(download), true);

    process.stdout.write('Operation coordinator and update install/recovery guard tests passed.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
