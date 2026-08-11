'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  WORKERS,
  WorkerLaunchError,
  deriveWorkerPaths,
  resolveWorkerLaunch,
  spawnResolvedWorker
} = require('../lib/runtime-workers');

function makeLayout({ packaged = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-worker-layout-'));
  const appPath = packaged ? path.join(root, 'resources', 'app.asar') : path.join(root, 'source');
  const resourcesPath = path.join(root, 'resources');
  const resourceRoot = packaged ? path.join(resourcesPath, 'app.asar.unpacked') : appPath;
  const userDataPath = path.join(root, 'user-data');
  const executablePath = path.join(root, 'electron');
  fs.mkdirSync(resourceRoot, { recursive: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(executablePath, '#!/bin/sh\n', { mode: 0o700 });
  for (const relative of Object.values(WORKERS)) {
    const worker = path.join(resourceRoot, relative);
    fs.mkdirSync(path.dirname(worker), { recursive: true });
    fs.writeFileSync(worker, "process.stdout.write('ok\\n');\n");
  }
  return {
    root,
    context: {
      appPath,
      resourcesPath,
      userDataPath,
      executablePath,
      isPackaged: packaged,
      platform: 'linux',
      appImagePath: path.join(root, 'Canada-Post-Claim-Runner.AppImage')
    }
  };
}

const development = makeLayout();
const devResolution = resolveWorkerLaunch('estHistory', development.context);
assert.strictEqual(devResolution.workerPath, path.join(development.context.appPath, WORKERS.estHistory));
assert.ok(fs.statSync(devResolution.cwd).isDirectory(), 'development cwd must be a real directory');
assert.notStrictEqual(devResolution.cwd, development.context.appPath, 'source root is not used as cwd');

const linuxPackage = makeLayout({ packaged: true });
for (const workerName of Object.keys(WORKERS)) {
  const resolved = resolveWorkerLaunch(workerName, linuxPackage.context);
  assert.ok(resolved.workerPath.startsWith(path.join(linuxPackage.context.resourcesPath, 'app.asar.unpacked')));
  assert.ok(fs.statSync(resolved.cwd).isDirectory(), `${workerName} cwd must be a directory`);
  assert.ok(!resolved.cwd.endsWith('.asar'), `${workerName} cwd must not be app.asar`);
  assert.notStrictEqual(resolved.cwd, linuxPackage.context.appImagePath, `${workerName} cwd must not be the AppImage`);
}

const windows = deriveWorkerPaths('tracking', {
  appPath: 'C:\\Program Files\\Canada Post Claim Runner\\resources\\app.asar',
  resourcesPath: 'C:\\Program Files\\Canada Post Claim Runner\\resources',
  userDataPath: 'C:\\Users\\Synthetic\\AppData\\Roaming\\Canada Post Claim Runner',
  executablePath: 'C:\\Program Files\\Canada Post Claim Runner\\Canada Post Claim Runner.exe',
  isPackaged: true,
  platform: 'win32'
});
assert.strictEqual(windows.workerPath, 'C:\\Program Files\\Canada Post Claim Runner\\resources\\app.asar.unpacked\\scripts\\get-tracking.js');
assert.strictEqual(windows.cwd, 'C:\\Users\\Synthetic\\AppData\\Roaming\\Canada Post Claim Runner\\worker-runtime');
assert.ok(!windows.cwd.toLowerCase().endsWith('.asar'));

assert.throws(() => deriveWorkerPaths('tracking', {
  ...linuxPackage.context,
  userDataPath: path.join(linuxPackage.root, 'bad'),
  appImagePath: path.join(linuxPackage.root, 'bad', 'worker-runtime')
}), error => error instanceof WorkerLaunchError && error.code === 'WORKER_CWD_INVALID');

const cwdFileLayout = makeLayout({ packaged: true });
fs.writeFileSync(path.join(cwdFileLayout.context.userDataPath, 'worker-runtime'), 'not a directory');
assert.throws(() => resolveWorkerLaunch('tracking', cwdFileLayout.context), error => error.code === 'WORKER_CWD_INVALID');

const missingLayout = makeLayout({ packaged: true });
fs.rmSync(path.join(missingLayout.context.resourcesPath, 'app.asar.unpacked', WORKERS.estHistory));
let spawnCalls = 0;
assert.throws(() => {
  const resolution = resolveWorkerLaunch('estHistory', missingLayout.context);
  spawnResolvedWorker(resolution, {}, { spawnImpl: () => { spawnCalls += 1; } });
}, error => error.code === 'PACKAGED_RESOURCE_MISSING');
assert.strictEqual(spawnCalls, 0, 'missing worker must fail before spawn');

class FailedChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    process.nextTick(() => {
      const error = Object.assign(new Error('synthetic spawn failure'), { code: 'ENOENT' });
      this.emit('error', error);
      this.emit('close', -1, null);
    });
  }
}
const failedLaunch = spawnResolvedWorker(devResolution, {}, { spawnImpl: () => new FailedChild() });

(async () => {
  const started = await failedLaunch.started;
  assert.strictEqual(started.ok, false, 'spawn failure must not be reported as started');
  assert.strictEqual(failedLaunch.state.active, false, 'spawn failure must clear active state immediately');
  assert.strictEqual(failedLaunch.state.status, 'failed');
  assert.notStrictEqual(started.error.message, 'No active process.', 'start failure must remain actionable');

  const builder = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  for (const required of ['scripts/import-est-history.js', 'scripts/get-tracking.js', 'scripts/submit-claims.js', 'lib/**/*.js']) {
    assert.ok(builder.includes(`- ${required}`), `electron-builder must unpack ${required}`);
  }
  assert.ok(!builder.includes('site-health-check.js'), 'obsolete site-health worker must not be packaged');
  assert.ok(!Object.hasOwn(WORKERS, 'siteHealth'), 'siteHealth must not be a registered production worker');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!/spawnJsonProcess\(process\.execPath/.test(mainSource), 'workers must use the centralized named launcher');
  assert.ok(!/spawn\([^)]*,[^)]*,\s*\{\s*cwd:\s*ROOT/.test(mainSource), 'ROOT must never be a spawned process cwd');
  assert.ok(mainSource.includes("spawnJsonProcess('estHistory'"));
  assert.ok(mainSource.includes("spawnJsonProcess('tracking'"));

  for (const layout of [development, linuxPackage, cwdFileLayout, missingLayout]) {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
  process.stdout.write('Runtime worker resolution tests passed.\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
