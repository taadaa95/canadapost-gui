'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const updater = require('../lib/github-release-updater');
const claimDb = require('../lib/claim-database');
const { mutablePathManifest } = require('../lib/mutable-paths');
const { deriveWorkerPaths, spawnResolvedWorker } = require('../lib/runtime-workers');
const { resolvePackagedLayout } = require('../scripts/packaged-layout');
const { expectedBinaryName } = require('../scripts/finalize-artifacts');

class SyntheticChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    process.nextTick(() => this.emit('spawn'));
  }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-macos-platform-'));
  try {
    const appBundle = path.join(root, 'Canada Post Claim Runner.app');
    fs.mkdirSync(appBundle, { recursive: true });
    const layout = resolvePackagedLayout(appBundle, 'darwin');
    assert.strictEqual(layout.executablePath, path.join(appBundle, 'Contents', 'MacOS', 'Canada Post Claim Runner'));
    assert.strictEqual(layout.resourcesPath, path.join(appBundle, 'Contents', 'Resources'));
    assert.strictEqual(layout.appPath, path.join(appBundle, 'Contents', 'Resources', 'app.asar'));

    const userData = path.join(root, 'Library', 'Application Support', 'Canada Post Claim Runner');
    const paths = mutablePathManifest(userData);
    assert.strictEqual(claimDb.databasePathFor(userData), path.join(userData, 'database', 'app.sqlite'));
    assert.strictEqual(paths.databaseBackups, path.join(userData, 'database-backups'));
    assert.strictEqual(paths.browserPartition, path.join(userData, 'Partitions', 'canadapost-claims-builtin'));
    assert.strictEqual(paths.workerRuntime, path.join(userData, 'worker-runtime'));
    assert.strictEqual(paths.updateStorage, path.join(userData, 'updates'));
    assert.strictEqual(paths.backupRestoreTemporary, path.join(userData, 'tmp', 'backup-restore'));

    const resolution = deriveWorkerPaths('tracking', {
      ...layout,
      userDataPath: userData,
      isPackaged: true,
      platform: 'darwin',
      pathApi: path
    });
    let spawnCall;
    const launch = spawnResolvedWorker(resolution, {}, {
      spawnImpl: (command, args, options) => {
        spawnCall = { command, args, options };
        return new SyntheticChild();
      }
    });
    assert.strictEqual((await launch.started).ok, true);
    assert.strictEqual(spawnCall.command, layout.executablePath);
    assert.strictEqual(spawnCall.args[0], path.join(layout.resourcesPath, 'app.asar.unpacked', 'scripts', 'get-tracking.js'));
    assert.strictEqual(spawnCall.options.cwd, paths.workerRuntime);
    assert.strictEqual(spawnCall.options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.strictEqual(spawnCall.options.env.APP_ROOT, path.join(layout.resourcesPath, 'app.asar.unpacked'));
    assert.strictEqual(spawnCall.options.detached, true);

    assert.strictEqual(updater.expectedArtifactName('0.4.1', 'darwin', 'x64'), 'Canada.Post.Claim.Runner-0.4.1-mac-universal.dmg');
    assert.strictEqual(updater.expectedArtifactName('0.4.1', 'darwin', 'arm64'), 'Canada.Post.Claim.Runner-0.4.1-mac-universal.dmg');
    assert.strictEqual(expectedBinaryName({ version: '0.4.1', platform: 'macos' }), 'Canada.Post.Claim.Runner-0.4.1-mac-universal.dmg');

    const builder = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
    assert.match(builder, /mac:[\s\S]*target: dmg[\s\S]*arch: \[universal\]/);
    assert.match(builder, /hardenedRuntime: true/);
    assert.match(builder, /notarize: true/);
    assert.match(builder, /mergeASARs: true/);
    process.stdout.write('macOS universal packaging, paths, worker runtime and updater contracts passed.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
