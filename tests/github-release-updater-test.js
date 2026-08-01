'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const updater = require('../lib/github-release-updater');
const security = require('../lib/update-security');

function release(tag, options = {}) {
  return { tag_name: tag, name: tag, draft: false, prerelease: false, published_at: '2026-08-01T12:00:00.000Z', assets: [], ...options };
}

function signedManifest(keys, overrides = {}) {
  return security.signManifest({
    format: security.UPDATE_MANIFEST_FORMAT,
    manifestVersion: security.UPDATE_MANIFEST_VERSION,
    applicationVersion: '0.4.1-beta.1',
    channel: 'beta',
    publishedAt: '2026-08-01T12:00:00.000Z',
    minimumSupportedVersion: '0.4.0-beta.1',
    platform: 'linux',
    architecture: 'x64',
    artifact: {
      file: 'Canada.Post.Claim.Runner-0.4.1-beta.1-linux-x86_64-beta.AppImage',
      bytes: 26,
      sha256: crypto.createHash('sha256').update('synthetic updater artifact').digest('hex')
    },
    ...overrides
  }, keys.privateKey);
}

assert.strictEqual(updater.version('v0.4.1'), '0.4.1');
assert.strictEqual(updater.channelFor('0.4.0-beta.1'), 'beta');
assert.strictEqual(updater.channelFor('0.4.0'), 'stable');
assert.throws(() => updater.version('latest'), /invalid/i);
assert.throws(() => updater.githubUrl('http://github.com/file'), /approved/i);
assert.throws(() => updater.githubUrl('https://example.com/file'), /approved/i);
assert.throws(() => security.validateUnsignedManifest({
  format: security.UPDATE_MANIFEST_FORMAT,
  manifestVersion: security.UPDATE_MANIFEST_VERSION,
  applicationVersion: '0.4.1-beta.1',
  channel: 'beta',
  publishedAt: '2026-08-01T12:00:00.000Z',
  platform: 'linux',
  architecture: 'x64',
  artifact: { file: '..\\outside.AppImage', bytes: 1, sha256: 'a'.repeat(64) }
}), /file name is invalid/i);

const stable = updater.selectRelease([
  release('v0.4.2-beta.1', { prerelease: true }),
  release('v0.4.1'),
  release('v0.4.3', { draft: true })
], '0.4.0', 'stable');
assert.strictEqual(stable.version, '0.4.1');

const beta = updater.selectRelease([
  release('v0.4.2-beta.1', { prerelease: true }),
  release('v0.4.1')
], '0.4.0-beta.1', 'beta');
assert.strictEqual(beta.version, '0.4.2-beta.1');

const keys = crypto.generateKeyPairSync('ed25519');
const wrongKeys = crypto.generateKeyPairSync('ed25519');
const manifest = signedManifest(keys);
const verified = updater.validateManifest(manifest, '0.4.1-beta.1', 'beta', {
  publicKey: keys.publicKey,
  currentVersion: '0.4.0-beta.1',
  expectedPublishedAt: manifest.publishedAt,
  platform: 'linux',
  arch: 'x64'
});
assert.strictEqual(updater.selectArtifact(verified, 'linux', 'x64').file.endsWith('.AppImage'), true);
assert.throws(() => updater.selectArtifact(verified, 'linux', 'arm64'), /not supported/i);
assert.throws(() => updater.validateManifest({ ...manifest, signature: '' }, '0.4.1-beta.1', 'beta', { publicKey: keys.publicKey, currentVersion: '0.4.0-beta.1', platform: 'linux', arch: 'x64' }), /missing or malformed/i);
assert.throws(() => updater.validateManifest({ ...manifest, signature: 'not-base64' }, '0.4.1-beta.1', 'beta', { publicKey: keys.publicKey, currentVersion: '0.4.0-beta.1', platform: 'linux', arch: 'x64' }), /missing or malformed/i);
assert.throws(() => updater.validateManifest(manifest, '0.4.1-beta.1', 'beta', { publicKey: wrongKeys.publicKey, currentVersion: '0.4.0-beta.1', platform: 'linux', arch: 'x64' }), /signature verification/i);
assert.throws(() => updater.validateManifest({ ...manifest, publishedAt: '2026-08-01T13:00:00.000Z' }, '0.4.1-beta.1', 'beta', { publicKey: keys.publicKey, currentVersion: '0.4.0-beta.1', platform: 'linux', arch: 'x64' }), /signature verification/i);
assert.throws(() => updater.validateManifest(manifest, '0.4.2-beta.1', 'beta', { publicKey: keys.publicKey, currentVersion: '0.4.0-beta.1', platform: 'linux', arch: 'x64' }), /release tag/i);
assert.throws(() => updater.validateManifest(manifest, '0.4.1-beta.1', 'stable', { publicKey: keys.publicKey, currentVersion: '0.4.0', platform: 'linux', arch: 'x64' }), /Stable channel/i);
assert.throws(() => updater.validateManifest(manifest, '0.4.1-beta.1', 'beta', { publicKey: keys.publicKey, currentVersion: '0.4.0-beta.1', platform: 'windows', arch: 'x64' }), /platform/i);
assert.throws(() => updater.validateManifest(manifest, '0.4.1-beta.1', 'beta', { publicKey: keys.publicKey, currentVersion: '0.4.0-beta.1', platform: 'linux', arch: 'arm64' }), /architecture/i);
const wrongArtifactVersion = signedManifest(keys, { artifact: { ...manifest.artifact, file: 'Canada.Post.Claim.Runner-0.4.9-beta.1-linux-x86_64-beta.AppImage' } });
assert.throws(() => updater.selectArtifact(updater.validateManifest(wrongArtifactVersion, '0.4.1-beta.1', 'beta', { publicKey: keys.publicKey, currentVersion: '0.4.0-beta.1', platform: 'linux', arch: 'x64' }), 'linux', 'x64'), /filename/i);

const downgrade = signedManifest(keys, { applicationVersion: '0.3.9-beta.1', minimumSupportedVersion: '' });
assert.throws(() => updater.validateManifest(downgrade, '0.3.9-beta.1', 'beta', { publicKey: keys.publicKey, currentVersion: '0.4.0-beta.1', platform: 'linux', arch: 'x64' }), /downgrade/i);

const snapshot = updater.progressSnapshot(25, 100, 1000, 2000);
assert.deepStrictEqual({ received: snapshot.received, total: snapshot.total, ratio: snapshot.ratio, bytesPerSecond: snapshot.bytesPerSecond, etaSeconds: snapshot.etaSeconds }, {
  received: 25, total: 100, ratio: 0.25, bytesPerSecond: 25, etaSeconds: 3
});

(async () => {
  const artifactBytes = Buffer.from('synthetic updater artifact');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-updater-trust-'));
  try {
    const isolatedHandlers = new Map();
    updater.registerGithubReleaseUpdater({
      app: { isPackaged: true },
      registerIpcHandler: (channel, handler) => isolatedHandlers.set(channel, handler),
      dialog: {},
      BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
      shell: {},
      isolated: true
    });
    const isolatedResult = await isolatedHandlers.get('updates:open')();
    assert.strictEqual(isolatedResult.ok, false);
    assert.match(isolatedResult.error, /disabled while isolated test data is active/i);

    const artifactPath = path.join(root, manifest.artifact.file);
    fs.writeFileSync(artifactPath, artifactBytes);
    assert.strictEqual(security.verifyArtifact(artifactPath, manifest.artifact), true);
    fs.appendFileSync(artifactPath, '!');
    assert.throws(() => security.verifyArtifact(artifactPath, manifest.artifact), /size verification/i);
    fs.writeFileSync(artifactPath, Buffer.alloc(manifest.artifact.bytes, 1));
    assert.throws(() => security.verifyArtifact(artifactPath, manifest.artifact), /checksum verification/i);

    const source = {
      owner: 'taadaa95',
      repository: 'canadapost-claim-runner-releases',
      manifestAssets: { windows: 'package-manifest-windows.json', linux: 'package-manifest-linux.json' }
    };
    const candidate = release('v0.4.1-beta.1', {
      prerelease: true,
      html_url: 'https://github.com/taadaa95/canadapost-claim-runner-releases/releases/tag/v0.4.1-beta.1',
      assets: [
        { name: 'package-manifest-linux.json', browser_download_url: 'https://github.com/taadaa95/canadapost-claim-runner-releases/releases/download/v0.4.1-beta.1/package-manifest-linux.json' },
        { name: manifest.artifact.file, size: manifest.artifact.bytes, digest: `sha256:${manifest.artifact.sha256}`, browser_download_url: `https://github.com/taadaa95/canadapost-claim-runner-releases/releases/download/v0.4.1-beta.1/${manifest.artifact.file}` }
      ]
    });
    const fetchImpl = async url => {
      const value = String(url);
      if (value.includes('/releases?')) return new Response(JSON.stringify([candidate]), { status: 200 });
      if (value.includes('package-manifest-linux.json')) return new Response(JSON.stringify(manifest), { status: 200 });
      throw new Error(`Unexpected URL: ${value}`);
    };
    const result = await updater.resolveUpdate({ source, publicKey: keys.publicKey, currentVersion: '0.4.0-beta.1', channel: 'beta', platform: 'linux', arch: 'x64', fetchImpl });
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.version, '0.4.1-beta.1');
    assert.strictEqual(result.artifact.sha256, manifest.artifact.sha256);

    const redirectCalls = [];
    await assert.rejects(() => updater.resolveUpdate({
      source,
      publicKey: keys.publicKey,
      currentVersion: '0.4.0-beta.1',
      channel: 'beta',
      platform: 'linux',
      arch: 'x64',
      fetchImpl: async (url, options) => {
        redirectCalls.push({ url: String(url), redirect: options.redirect });
        return new Response('', { status: 302, headers: { location: 'https://attacker.invalid/update.json' } });
      }
    }), error => error.code === 'UPDATE_URL_BLOCKED');
    assert.deepStrictEqual(redirectCalls, [{ url: updater.apiUrl(source), redirect: 'manual' }], 'a disallowed redirect must be rejected before it is followed');

    const currentAppImage = path.join(root, 'Canada.Post.Claim.Runner-current.AppImage');
    const downloadedAppImage = path.join(root, manifest.artifact.file);
    fs.writeFileSync(currentAppImage, 'old verified application');
    fs.writeFileSync(downloadedAppImage, artifactBytes);
    await updater.replaceAppImage(downloadedAppImage, manifest.artifact.sha256, { APPIMAGE: currentAppImage });
    assert.strictEqual(fs.readFileSync(currentAppImage, 'utf8'), artifactBytes.toString('utf8'));
    assert.strictEqual(fs.readFileSync(`${currentAppImage}.previous`, 'utf8'), 'old verified application');

    fs.writeFileSync(downloadedAppImage, Buffer.alloc(manifest.artifact.bytes, 1));
    let quitCalled = false;
    await assert.rejects(() => updater.installUpdate({
      app: { quit: () => { quitCalled = true; } },
      shell: {},
      downloadedPath: downloadedAppImage,
      update: { artifact: manifest.artifact },
      platform: 'win32'
    }), /checksum verification/i);
    assert.strictEqual(quitCalled, false, 'an installer modified after download verification must never be executed');

    await assert.rejects(() => updater.resolveUpdate({ source, currentVersion: '0.4.0-beta.1', channel: 'beta', platform: 'linux', arch: 'x64', fetchImpl }), /No trusted production update public key/i);
    await assert.rejects(() => updater.resolveUpdate({ source, publicKey: keys.publicKey, currentVersion: '0.4.0-beta.1', channel: 'beta', platform: 'linux', arch: 'x64', fetchImpl: async url => {
      const value = String(url);
      if (value.includes('/releases?')) return new Response(JSON.stringify([{ ...candidate, assets: candidate.assets.map(item => item.name === manifest.artifact.file ? { ...item, size: item.size + 1 } : item) }]), { status: 200 });
      return new Response(JSON.stringify(manifest), { status: 200 });
    } }), /asset size/i);
    process.stdout.write('Signed GitHub release updater trust-chain tests passed.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
