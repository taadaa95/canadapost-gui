'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const updater = require('../lib/github-release-updater');
const security = require('../lib/update-security');

const SOURCE = Object.freeze({
  provider: 'github-releases',
  owner: 'taadaa95',
  repository: 'canadapost-claim-runner-releases'
});

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function release(tag, bytes, options = {}) {
  const releaseVersion = String(tag).replace(/^v/, '');
  const linuxFile = `Canada.Post.Claim.Runner-${releaseVersion}-linux-x86_64.AppImage`;
  const windowsFile = `Canada.Post.Claim.Runner-${releaseVersion}-win-x64.exe`;
  const macFile = `Canada.Post.Claim.Runner-${releaseVersion}-mac-universal.dmg`;
  return {
    tag_name: tag,
    name: `Canada Post Claim Runner ${releaseVersion}`,
    draft: false,
    prerelease: false,
    body: 'A concise synthetic release note.',
    html_url: `https://github.com/${SOURCE.owner}/${SOURCE.repository}/releases/tag/${tag}`,
    assets: [linuxFile, windowsFile, macFile].map(file => ({
      name: file,
      size: bytes.length,
      digest: `sha256:${digest(bytes)}`,
      browser_download_url: `https://github.com/${SOURCE.owner}/${SOURCE.repository}/releases/download/${tag}/${file}`
    })),
    ...options
  };
}

function fakeAppImageFileSystem({ current, downloaded, currentBytes, downloadedBytes, fail = () => false, alterHash = null }) {
  const files = new Map([
    [current, Buffer.from(currentBytes)],
    [downloaded, Buffer.from(downloadedBytes)]
  ]);
  const calls = [];
  const counts = new Map();
  const record = (operation, target, destination = '') => {
    calls.push({ operation, target, destination });
    if (fail(operation, target, destination)) throw Object.assign(new Error(`synthetic ${operation} failure`), { code: 'SYNTHETIC_FAILURE' });
  };
  const fileSystem = {
    existsSync(target) { return files.has(target); },
    accessSync(target) { record('access', target); },
    rmSync(target) { record('remove', target); files.delete(target); },
    copyFileSync(source, destination) {
      record('copy', source, destination);
      if (!files.has(source)) throw new Error(`Missing synthetic source ${source}`);
      if (files.has(destination)) throw new Error(`Synthetic exclusive destination exists ${destination}`);
      files.set(destination, Buffer.from(files.get(source)));
    },
    chmodSync(target) { record('chmod', target); },
    openSync(target) { record('open', target); return target; },
    fsyncSync(target) { record('fsync', target); },
    closeSync(target) { record('close', target); },
    renameSync(source, destination) {
      record('rename', source, destination);
      if (!files.has(source)) throw new Error(`Missing synthetic rename source ${source}`);
      files.set(destination, files.get(source));
      files.delete(source);
    }
  };
  const hashFile = async target => {
    record('hash', target);
    const count = Number(counts.get(target) || 0) + 1;
    counts.set(target, count);
    if (!files.has(target)) return '';
    if (alterHash) {
      const replacement = alterHash(target, count, files);
      if (replacement) return replacement;
    }
    return digest(files.get(target));
  };
  return { fileSystem, hashFile, files, calls, counts };
}

assert.strictEqual(require('../package.json').version, '0.4.3');
const updaterUiText = [
  fs.readFileSync(path.join(__dirname, '..', 'lib', 'github-release-updater.js'), 'utf8'),
  fs.readFileSync(path.join(__dirname, '..', 'locales', 'en-CA.json'), 'utf8'),
  fs.readFileSync(path.join(__dirname, '..', 'locales', 'fr-CA.json'), 'utf8')
].join('\n');
assert.doesNotMatch(updaterUiText, /unsigned beta|beta channel|release channel|signing key|trustedPublicKeyEd25519/i);
assert.strictEqual(updater.version('v0.4.1'), '0.4.1');
assert.strictEqual(updater.channelFor, undefined, 'release-channel selection must not be exported');
assert.strictEqual(updater.apiUrl(SOURCE), 'https://api.github.com/repos/taadaa95/canadapost-claim-runner-releases/releases/latest');
assert.strictEqual(updater.expectedArtifactName('0.4.1', 'linux', 'x64'), 'Canada.Post.Claim.Runner-0.4.1-linux-x86_64.AppImage');
assert.strictEqual(updater.expectedArtifactName('0.4.1', 'win32', 'x64'), 'Canada.Post.Claim.Runner-0.4.1-win-x64.exe');
assert.strictEqual(updater.expectedArtifactName('0.4.1', 'darwin', 'x64'), 'Canada.Post.Claim.Runner-0.4.1-mac-universal.dmg');
assert.strictEqual(updater.expectedArtifactName('0.4.1', 'darwin', 'arm64'), 'Canada.Post.Claim.Runner-0.4.1-mac-universal.dmg');
assert.throws(() => updater.expectedArtifactName('0.4.1', 'linux', 'arm64'), /not supported/i);
assert.throws(() => updater.expectedArtifactName('0.4.1', 'darwin', 'ia32'), /not supported/i);
assert.throws(() => updater.apiUrl({ ...SOURCE, provider: 'custom-manifest' }), /provider/i);
assert.throws(() => updater.version('latest'), /invalid/i);
assert.throws(() => updater.githubUrl('http://github.com/file'), /approved/i);
assert.throws(() => updater.githubUrl('https://example.com/file'), /approved/i);

assert(security.compareVersions('0.4.0-beta.1', '0.4.0') < 0);
assert(security.compareVersions('0.4.0-dev.10', '0.4.0') < 0);
assert(security.compareVersions('0.4.0', '0.4.1') < 0);
assert(security.compareVersions('0.4.0-rc.1', '0.4.0') < 0);

const artifactBytes = Buffer.from('synthetic updater artifact');
const stableRelease = release('v0.4.1', artifactBytes);
const candidate = updater.validateLatestRelease(stableRelease, '0.4.0', 'linux', 'x64');
assert.strictEqual(candidate.available, true);
assert.strictEqual(candidate.version, '0.4.1');
assert.strictEqual(candidate.artifact.file, 'Canada.Post.Claim.Runner-0.4.1-linux-x86_64.AppImage');
assert.strictEqual(candidate.artifact.bytes, artifactBytes.length);
assert.strictEqual(candidate.artifact.sha256, digest(artifactBytes));
const macCandidate = updater.validateLatestRelease(stableRelease, '0.4.0', 'darwin', 'arm64');
assert.strictEqual(macCandidate.artifact.file, 'Canada.Post.Claim.Runner-0.4.1-mac-universal.dmg');
assert.strictEqual(updater.validateLatestRelease(stableRelease, '0.4.1', 'linux', 'x64').available, false);
assert.strictEqual(updater.validateLatestRelease(stableRelease, '0.4.3', 'linux', 'x64').available, false);
assert.throws(() => updater.validateLatestRelease({ ...stableRelease, draft: true }, '0.4.0', 'linux', 'x64'), /normal stable release/i);
assert.throws(() => updater.validateLatestRelease({ ...stableRelease, prerelease: true }, '0.4.0-beta.1', 'linux', 'x64'), /normal stable release/i);
assert.throws(() => updater.validateLatestRelease(release('v0.4.3-rc.1', artifactBytes), '0.4.1', 'linux', 'x64'), /stable semantic version/i);
assert.throws(() => updater.validateLatestRelease({ ...stableRelease, assets: [] }, '0.4.0', 'linux', 'x64'), /missing Canada\.Post/i);
assert.throws(() => updater.validateLatestRelease({
  ...stableRelease,
  assets: stableRelease.assets.map(item => ({ ...item, name: `${item.name}-beta` }))
}, '0.4.0', 'linux', 'x64'), /missing Canada\.Post/i);
for (const badDigest of [undefined, '', 'sha256:1234', `sha512:${'a'.repeat(64)}`]) {
  assert.throws(() => updater.validateLatestRelease({
    ...stableRelease,
    assets: stableRelease.assets.map(item => ({ ...item, digest: badDigest }))
  }, '0.4.0', 'linux', 'x64'), /SHA-256 digest/i);
}
assert.throws(() => updater.validateLatestRelease({
  ...stableRelease,
  assets: stableRelease.assets.map(item => ({ ...item, size: 0 }))
}, '0.4.0', 'linux', 'x64'), /size is invalid/i);
assert.throws(() => updater.validateLatestRelease({
  ...stableRelease,
  assets: stableRelease.assets.map(item => ({ ...item, browser_download_url: 'https://attacker.invalid/update.AppImage' }))
}, '0.4.0', 'linux', 'x64'), /approved GitHub hosts/i);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-updater-stable-'));
  try {
    const calls = [];
    const resolved = await updater.resolveUpdate({
      source: SOURCE,
      currentVersion: '0.4.0-beta.1',
      platform: 'linux',
      arch: 'x64',
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), redirect: options.redirect });
        return new Response(JSON.stringify(release('v0.4.0', artifactBytes)), { status: 200 });
      }
    });
    assert.strictEqual(resolved.available, true, 'the new updater must move an old development runtime to stable 0.4.0');
    assert.strictEqual(resolved.version, '0.4.0');
    assert.deepStrictEqual(calls, [{ url: updater.apiUrl(SOURCE), redirect: 'manual' }]);

    await assert.rejects(() => updater.resolveUpdate({
      source: SOURCE,
      currentVersion: '0.4.0',
      platform: 'linux',
      arch: 'x64',
      fetchImpl: async (url, options) => {
        assert.strictEqual(options.redirect, 'manual');
        return new Response('', { status: 302, headers: { location: 'https://attacker.invalid/update.json' } });
      }
    }), error => error.code === 'UPDATE_URL_BLOCKED');

    const downloadRoot = path.join(root, 'profile');
    const downloaded = await updater.downloadUpdate(candidate, {
      app: { getPath: () => downloadRoot },
      userAgent: 'synthetic-test',
      fetchImpl: async () => new Response(artifactBytes, {
        status: 200,
        headers: { 'content-length': String(artifactBytes.length) }
      })
    });
    assert.strictEqual(fs.readFileSync(downloaded, 'utf8'), artifactBytes.toString('utf8'));
    assert.strictEqual(security.verifyArtifact(downloaded, candidate.artifact), true);

    await assert.rejects(() => updater.downloadUpdate({ ...candidate, version: '0.4.3', artifact: {
      ...candidate.artifact,
      file: 'Canada.Post.Claim.Runner-0.4.3-linux-x86_64.AppImage'
    } }, {
      app: { getPath: () => downloadRoot },
      userAgent: 'synthetic-test',
      fetchImpl: async () => new Response(artifactBytes, { status: 200, headers: { 'content-length': String(artifactBytes.length + 1) } })
    }), error => error.code === 'UPDATE_DOWNLOAD_SIZE_MISMATCH');

    await assert.rejects(() => updater.downloadUpdate({ ...candidate, version: '0.4.3', artifact: {
      ...candidate.artifact,
      file: 'Canada.Post.Claim.Runner-0.4.3-linux-x86_64.AppImage',
      sha256: '0'.repeat(64)
    } }, {
      app: { getPath: () => downloadRoot },
      userAgent: 'synthetic-test',
      fetchImpl: async () => new Response(artifactBytes, { status: 200, headers: { 'content-length': String(artifactBytes.length) } })
    }), error => error.code === 'UPDATE_DOWNLOAD_HASH_MISMATCH');

    const artifactPath = path.join(root, candidate.artifact.file);
    fs.writeFileSync(artifactPath, artifactBytes);
    fs.appendFileSync(artifactPath, '!');
    assert.throws(() => security.verifyArtifact(artifactPath, candidate.artifact), /size verification/i);
    fs.writeFileSync(artifactPath, Buffer.alloc(candidate.artifact.bytes, 1));
    assert.throws(() => security.verifyArtifact(artifactPath, candidate.artifact), /checksum verification/i);

    const handlers = new Map();
    const dialogs = [];
    updater.registerGithubReleaseUpdater({
      app: { isPackaged: true, getVersion: () => '0.4.0' },
      registerIpcHandler: (channel, handler) => handlers.set(channel, handler),
      dialog: { showMessageBox: async options => { dialogs.push(options); return { response: 1 }; } },
      BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
      shell: {},
      source: SOURCE
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(stableRelease), { status: 200 });
    try {
      const result = await handlers.get('updates:open')();
      assert.strictEqual(result.deferred, true);
      assert.strictEqual(dialogs.length, 1, 'idle update flow must use one normal confirmation');
      assert.match(dialogs[0].message, /Current version: 0\.4\.0\nNew version: 0\.4\.1/);
      assert.deepStrictEqual(dialogs[0].buttons, ['Download / Install Update', 'Cancel']);
    } finally {
      globalThis.fetch = oldFetch;
    }

    const currentAppImage = path.join(root, 'Canada.Post.Claim.Runner-current.AppImage');
    const downloadedAppImage = path.join(root, candidate.artifact.file);
    const oldAppImage = Buffer.from('old verified application');
    const stagedPath = path.join(path.dirname(currentAppImage), `.${path.basename(currentAppImage)}.new-${process.pid}`);
    const backupStagedPath = `${currentAppImage}.previous.new-${process.pid}`;
    const fake = fakeAppImageFileSystem({
      current: currentAppImage,
      downloaded: downloadedAppImage,
      currentBytes: oldAppImage,
      downloadedBytes: artifactBytes
    });
    await updater.replaceAppImage(downloadedAppImage, candidate.artifact.sha256, { APPIMAGE: currentAppImage }, {
      platform: 'linux', fileSystem: fake.fileSystem, fileHash: fake.hashFile
    });
    assert.deepStrictEqual(fake.files.get(currentAppImage), artifactBytes);
    assert.deepStrictEqual(fake.files.get(`${currentAppImage}.previous`), oldAppImage);
    assert.strictEqual(fake.counts.get(stagedPath), 2);
    assert.strictEqual(fake.counts.get(backupStagedPath), 1);
    assert(fake.calls.some(call => call.operation === 'fsync' && call.target === stagedPath));
    assert.strictEqual(fake.calls.filter(call => call.operation === 'fsync' && call.target === path.dirname(currentAppImage)).length, 2);

    const changedBeforeRename = fakeAppImageFileSystem({
      current: currentAppImage,
      downloaded: downloadedAppImage,
      currentBytes: oldAppImage,
      downloadedBytes: artifactBytes,
      alterHash: (target, count) => target === stagedPath && count === 2 ? '0'.repeat(64) : ''
    });
    await assert.rejects(() => updater.replaceAppImage(downloadedAppImage, candidate.artifact.sha256, { APPIMAGE: currentAppImage }, {
      platform: 'linux', fileSystem: changedBeforeRename.fileSystem, fileHash: changedBeforeRename.hashFile
    }), error => error.code === 'UPDATE_STAGED_HASH_MISMATCH');
    assert.deepStrictEqual(changedBeforeRename.files.get(currentAppImage), oldAppImage);

    fs.writeFileSync(downloadedAppImage, artifactBytes);
    let quitCalled = false;
    const launches = [];
    await assert.rejects(() => updater.installUpdate({
      app: { quit: () => { quitCalled = true; } },
      shell: {},
      downloadedPath: downloadedAppImage,
      update: { ...candidate, version: '0.4.0' },
      currentVersion: '0.4.0',
      platform: 'win32'
    }), error => error.code === 'UPDATE_DOWNGRADE_BLOCKED');
    assert.strictEqual(quitCalled, false);

    await updater.installUpdate({
      app: { quit: () => { quitCalled = true; } },
      shell: {},
      downloadedPath: downloadedAppImage,
      update: candidate,
      currentVersion: '0.4.0',
      platform: 'win32',
      launchDetached: (command, args) => launches.push({ command, args })
    });
    assert.strictEqual(launches.length, 1);
    assert.strictEqual(launches[0].command, 'powershell.exe');
    assert.strictEqual(quitCalled, true);

    const downloadedDmg = path.join(root, macCandidate.artifact.file);
    fs.writeFileSync(downloadedDmg, artifactBytes);
    const opened = [];
    let macBeforeExit = 0;
    quitCalled = false;
    const keptOpen = await updater.installUpdate({
      app: { quit: () => { quitCalled = true; } },
      shell: { openPath: async file => { opened.push(file); return ''; } },
      downloadedPath: downloadedDmg,
      update: macCandidate,
      currentVersion: '0.4.0',
      platform: 'darwin',
      beforeExit: () => { macBeforeExit += 1; },
      confirmMacInstall: async () => false
    });
    assert.deepStrictEqual(keptOpen, { manualInstall: true, opened: true, quitRequested: false });
    assert.deepStrictEqual(opened, [downloadedDmg]);
    assert.strictEqual(macBeforeExit, 0);
    assert.strictEqual(quitCalled, false);

    const quitForInstall = await updater.installUpdate({
      app: { quit: () => { quitCalled = true; } },
      shell: { openPath: async () => '' },
      downloadedPath: downloadedDmg,
      update: macCandidate,
      currentVersion: '0.4.0',
      platform: 'darwin',
      beforeExit: () => { macBeforeExit += 1; },
      confirmMacInstall: async () => true
    });
    assert.strictEqual(quitForInstall.quitRequested, true);
    assert.strictEqual(macBeforeExit, 1);
    assert.strictEqual(quitCalled, true);

    await assert.rejects(() => updater.installUpdate({
      app: { quit: () => {} },
      shell: { openPath: async () => 'synthetic mount failure' },
      downloadedPath: downloadedDmg,
      update: macCandidate,
      currentVersion: '0.4.0',
      platform: 'darwin'
    }), error => error.code === 'UPDATE_DMG_OPEN_FAILED');

    process.stdout.write('Stable GitHub Latest updater trust and install tests passed.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
