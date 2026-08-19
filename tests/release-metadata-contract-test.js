'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  expectedBinaryName,
  finalizeArtifacts,
  metadataPaths,
  sha256File,
  validateReleaseMetadata
} = require('../scripts/finalize-artifacts');

const VERSION = '0.4.3';
const SOURCE_SHA = 'a'.repeat(40);

function primary(platform) {
  return { name: expectedBinaryName({ version: VERSION, platform }), contents: `synthetic-${platform}-artifact` };
}

function fixture(platform, entries, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cpcr-stable-metadata-${platform}-`));
  const packageDir = path.join(root, 'packages');
  const metadataDir = path.join(root, 'metadata');
  fs.mkdirSync(packageDir, { recursive: true });
  try {
    for (const entry of entries) {
      const target = path.join(packageDir, entry.name);
      if (entry.directory) fs.mkdirSync(target, { recursive: true });
      else fs.writeFileSync(target, entry.contents || entry.name);
    }
    callback({ packageDir, metadataDir, platform });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function finalize(context) {
  return finalizeArtifacts({
    ...context,
    version: VERSION,
    sourceSha: SOURCE_SHA,
    origin: 'synthetic-test'
  });
}

function validate(context) {
  return validateReleaseMetadata({
    ...context,
    version: VERSION,
    sourceSha: SOURCE_SHA
  });
}

for (const platform of ['linux', 'windows', 'macos']) {
  fixture(platform, [primary(platform)], context => {
    const finalized = finalize(context);
    const validated = validate(context);
    const files = metadataPaths(context.metadataDir, platform, VERSION);
    const checksums = fs.readFileSync(files.genericChecksums, 'utf8');
    const metadata = JSON.parse(fs.readFileSync(files.publicRelease, 'utf8'));
    assert.strictEqual(finalized.artifact.file, expectedBinaryName({ version: VERSION, platform }));
    assert.strictEqual(finalized.artifact.bytes, fs.statSync(path.join(context.packageDir, finalized.artifact.file)).size);
    assert.strictEqual(finalized.artifact.sha256, sha256File(path.join(context.packageDir, finalized.artifact.file)));
    assert.strictEqual(checksums, `${finalized.artifact.sha256}  ${finalized.artifact.file}\n`);
    assert.deepStrictEqual(validated.artifact, finalized.artifact);
    assert.strictEqual(metadata.version, VERSION);
    assert.strictEqual(metadata.tag, `v${VERSION}`);
    assert.strictEqual(metadata.sourceSha, SOURCE_SHA);
    assert.strictEqual(metadata.manualValidation.status, 'pending');
    assert.strictEqual(metadata.buildOrigin, 'synthetic-test');
    assert.deepStrictEqual(metadata.artifacts[platform], finalized.artifact);
    assert.doesNotMatch(JSON.stringify(metadata), /(?:beta|channel|signature|manifest)/i);
  });
}

fixture('linux', [
  primary('linux'),
  { name: `${primary('linux').name}.blockmap` },
  { name: 'latest-linux.yml' },
  { name: 'linux-unpacked', directory: true }
], context => {
  const result = finalize(context);
  assert(result.ignoredOutputs.includes(`${primary('linux').name}.blockmap`));
  assert(result.ignoredOutputs.includes('latest-linux.yml'));
  assert(result.ignoredOutputs.includes('linux-unpacked/'));
  validate(context);
});

function assertFinalizeFailure(platform, entries, pattern) {
  fixture(platform, entries, context => assert.throws(() => finalize(context), pattern));
}

assertFinalizeFailure('windows', [primary('windows'), { name: `duplicate-${primary('windows').name}` }], /exactly one \.exe primary binary.*found 2/i);
assertFinalizeFailure('linux', [], /found 0/i);
assertFinalizeFailure('linux', [{ name: 'Canada.Post.Claim.Runner-0.4.0-linux-x86_64-beta.AppImage' }], /filename mismatch/i);
assertFinalizeFailure('linux', [{ name: 'Canada.Post.Claim.Runner-0.4.0-beta.1-linux-x86_64.AppImage' }], /filename mismatch/i);
assertFinalizeFailure('windows', [{ name: 'Canada.Post.Claim.Runner-0.4.0-win-arm64.exe' }], /filename mismatch/i);
assertFinalizeFailure('macos', [{ name: 'Canada.Post.Claim.Runner-0.4.3-mac-arm64.dmg' }], /filename mismatch/i);
assert.throws(() => expectedBinaryName({ version: '0.4.3-beta.1', platform: 'linux' }), /stable semantic/i);

fixture('linux', [primary('linux')], context => {
  finalize(context);
  const files = metadataPaths(context.metadataDir, 'linux', VERSION);
  fs.appendFileSync(files.genericChecksums, `${'0'.repeat(64)}  unrelated.AppImage\n`);
  assert.throws(() => validate(context), /does not match/i);
});

fixture('linux', [primary('linux')], context => {
  finalize(context);
  const files = metadataPaths(context.metadataDir, 'linux', VERSION);
  const metadata = JSON.parse(fs.readFileSync(files.publicRelease, 'utf8'));
  metadata.manualValidation.status = 'passed';
  fs.writeFileSync(files.publicRelease, `${JSON.stringify(metadata, null, 2)}\n`);
  assert.throws(() => validate(context), /must remain pending/i);
});

process.stdout.write('Stable release artifact and metadata contracts passed.\n');
require('./sbom-test');
