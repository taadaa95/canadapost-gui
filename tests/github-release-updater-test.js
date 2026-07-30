'use strict';

const assert = require('assert');
const crypto = require('crypto');
const updater = require('../lib/github-release-updater');

function release(tag, options = {}) {
  return { tag_name: tag, name: tag, draft: false, prerelease: false, assets: [], ...options };
}

assert.strictEqual(updater.version('v0.4.1'), '0.4.1');
assert.strictEqual(updater.channelFor('0.4.0-dev.4'), 'beta');
assert.strictEqual(updater.channelFor('0.4.0'), 'stable');
assert.throws(() => updater.version('latest'), /invalid/i);
assert.throws(() => updater.githubUrl('http://github.com/file'), /approved/i);
assert.throws(() => updater.githubUrl('https://example.com/file'), /approved/i);

const stable = updater.selectRelease([
  release('v0.4.2-beta.1', { prerelease: true }),
  release('v0.4.1'),
  release('v0.4.3', { draft: true })
], '0.4.0', 'stable');
assert.strictEqual(stable.version, '0.4.1');

const beta = updater.selectRelease([
  release('v0.4.2-beta.1', { prerelease: true }),
  release('v0.4.1')
], '0.4.0-dev.4', 'beta');
assert.strictEqual(beta.version, '0.4.2-beta.1');

const manifest = updater.validateManifest({
  format: 'canadapost-claim-runner-artifact-manifest',
  version: 1,
  applicationVersion: '0.4.1',
  channel: 'stable',
  artifacts: [
    { file: 'Canada Post Claim Runner-0.4.1-linux-x86_64-stable.AppImage', bytes: 123, sha256: 'a'.repeat(64) },
    { file: 'Canada Post Claim Runner-0.4.1-win-x64-stable.exe', bytes: 456, sha256: 'b'.repeat(64) }
  ]
}, '0.4.1', 'stable');
assert.strictEqual(updater.selectArtifact(manifest, 'linux', 'x64').file.endsWith('.AppImage'), true);
assert.strictEqual(updater.selectArtifact(manifest, 'win32', 'x64').file.endsWith('.exe'), true);
assert.throws(() => updater.selectArtifact(manifest, 'linux', 'arm64'), /not supported/i);

(async () => {
  const bytes = Buffer.from('synthetic updater artifact');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const source = {
    owner: 'taadaa95',
    repository: 'canadapost-claim-runner-releases',
    manifestAssets: { windows: 'package-manifest-windows.json', linux: 'package-manifest-linux.json' }
  };
  const file = 'Canada Post Claim Runner-0.4.1-beta.1-linux-x86_64-beta.AppImage';
  const payload = {
    format: 'canadapost-claim-runner-artifact-manifest', version: 1,
    applicationVersion: '0.4.1-beta.1', channel: 'beta',
    artifacts: [{ file, bytes: bytes.length, sha256 }]
  };
  const candidate = release('v0.4.1-beta.1', {
    prerelease: true,
    html_url: 'https://github.com/taadaa95/canadapost-claim-runner-releases/releases/tag/v0.4.1-beta.1',
    assets: [
      { name: 'package-manifest-linux.json', browser_download_url: 'https://github.com/taadaa95/canadapost-claim-runner-releases/releases/download/v0.4.1-beta.1/package-manifest-linux.json' },
      { name: file, size: bytes.length, digest: `sha256:${sha256}`, browser_download_url: 'https://github.com/taadaa95/canadapost-claim-runner-releases/releases/download/v0.4.1-beta.1/update.AppImage' }
    ]
  });
  const fetchImpl = async url => {
    const value = String(url);
    if (value.includes('/releases?')) return new Response(JSON.stringify([candidate]), { status: 200 });
    if (value.includes('package-manifest-linux.json')) return new Response(JSON.stringify(payload), { status: 200 });
    throw new Error(`Unexpected URL: ${value}`);
  };
  const result = await updater.resolveUpdate({ source, currentVersion: '0.4.0-dev.4', channel: 'beta', platform: 'linux', arch: 'x64', fetchImpl });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.version, '0.4.1-beta.1');
  assert.strictEqual(result.artifact.sha256, sha256);
  process.stdout.write('GitHub release updater tests passed.\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
