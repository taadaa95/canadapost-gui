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

const VERSION = '0.4.0-dev.9';
const CHANNEL = 'beta';
const GENERATED_AT = '2026-07-31T12:00:00.000Z';

function fixture(platform, entries, callback) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cpcr-release-metadata-${platform}-`));
  const packageDir = path.join(fixtureRoot, 'packages');
  const metadataDir = path.join(fixtureRoot, 'release-metadata');
  fs.mkdirSync(packageDir, { recursive: true });
  for (const entry of entries) {
    const target = path.join(packageDir, entry.name);
    if (entry.directory) fs.mkdirSync(target, { recursive: true });
    else fs.writeFileSync(target, entry.contents || `synthetic-${entry.name}`);
  }
  try {
    return callback({ packageDir, metadataDir, platform });
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function primary(platform, contents = `synthetic-${platform}-binary`) {
  return { name: expectedBinaryName({ version: VERSION, platform, channel: CHANNEL }), contents };
}

function finalize(context) {
  return finalizeArtifacts({
    ...context,
    version: VERSION,
    channel: CHANNEL,
    generatedAt: GENERATED_AT
  });
}

function validate(context) {
  return validateReleaseMetadata({ ...context, version: VERSION, channel: CHANNEL });
}

function metadataText(metadataDir, platform) {
  const files = metadataPaths(metadataDir, platform);
  return Object.values(files).map(file => fs.readFileSync(file, 'utf8')).join('\n');
}

function assertSingleBinaryContract(platform) {
  fixture(platform, [primary(platform)], context => {
    const finalized = finalize(context);
    const validated = validate(context);
    const files = metadataPaths(context.metadataDir, platform);
    const manifest = JSON.parse(fs.readFileSync(files.unsignedManifest, 'utf8'));
    const checksums = fs.readFileSync(files.checksums, 'utf8');
    assert.deepStrictEqual(manifest.artifact, finalized.artifact);
    assert.strictEqual(manifest.platform, platform);
    assert.strictEqual(manifest.architecture, 'x64');
    assert.strictEqual(manifest.publishedAt, GENERATED_AT);
    assert.deepStrictEqual(validated.artifact, finalized.artifact);
    assert.strictEqual(manifest.artifact.bytes, fs.statSync(path.join(context.packageDir, finalized.artifact.file)).size);
    assert.strictEqual(manifest.artifact.sha256, sha256File(path.join(context.packageDir, finalized.artifact.file)));
    assert.strictEqual(checksums.trimEnd().split(/\r?\n/).length, 1);
    assert.strictEqual(checksums, `${finalized.artifact.sha256}  ${finalized.artifact.file}\n`);
    assert.strictEqual(fs.readFileSync(files.unsignedManifest, 'utf8'), fs.readFileSync(files.genericUnsignedManifest, 'utf8'));
    assert.strictEqual(fs.readFileSync(files.checksums, 'utf8'), fs.readFileSync(files.genericChecksums, 'utf8'));
  });
}

// Windows and Linux each produce exactly one primary binary in all public metadata.
assertSingleBinaryContract('windows');
assertSingleBinaryContract('linux');

// Non-public differential and provider outputs are explicitly reported but never enter metadata.
fixture('windows', [
  primary('windows'),
  { name: `${primary('windows').name}.blockmap` },
  { name: 'latest.yml' },
  { name: 'beta.yml' },
  { name: 'builder-debug.yml' },
  { name: 'win-unpacked', directory: true }
], context => {
  const result = finalize(context);
  assert(result.ignoredOutputs.includes(`${primary('windows').name}.blockmap`));
  assert(result.ignoredOutputs.includes('latest.yml'));
  assert(result.ignoredOutputs.includes('beta.yml'));
  assert(result.ignoredOutputs.includes('win-unpacked/'));
  validate(context);
  assert.doesNotMatch(metadataText(context.metadataDir, 'windows'), /\.blockmap|\.ya?ml/i);
});

function assertFinalizeFailure(platform, entries, pattern) {
  fixture(platform, entries, context => assert.throws(() => finalize(context), pattern));
}

assertFinalizeFailure('windows', [primary('windows'), { name: `duplicate-${primary('windows').name}` }], /exactly one \.exe primary binary.*found 2/i);
assertFinalizeFailure('linux', [primary('linux'), { name: `duplicate-${primary('linux').name}` }], /exactly one \.AppImage primary binary.*found 2/i);
assertFinalizeFailure('windows', [{ name: 'builder-debug.yml' }], /found 0/i);
assertFinalizeFailure('linux', [], /found 0/i);
assertFinalizeFailure('windows', [{ name: 'Canada.Post.Claim.Runner-0.4.0-dev.8-win-x64-beta.exe' }], /filename mismatch/i);
assertFinalizeFailure('windows', [{ name: 'Canada.Post.Claim.Runner-0.4.0-dev.9-linux-x64-beta.exe' }], /filename mismatch/i);
assertFinalizeFailure('windows', [{ name: 'Canada.Post.Claim.Runner-0.4.0-dev.9-win-arm64-beta.exe' }], /filename mismatch/i);
assertFinalizeFailure('windows', [{ name: 'Canada.Post.Claim.Runner-0.4.0-dev.9-win-x64-stable.exe' }], /filename mismatch/i);

// Validation fails closed when generated metadata is later inconsistent or unsupported.
fixture('windows', [primary('windows')], context => {
  finalize(context);
  const files = metadataPaths(context.metadataDir, 'windows');
  const manifest = JSON.parse(fs.readFileSync(files.unsignedManifest, 'utf8'));
  manifest.artifact.file = `${manifest.artifact.file}.blockmap`;
  const corrupted = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(files.unsignedManifest, corrupted);
  fs.writeFileSync(files.genericUnsignedManifest, corrupted);
  assert.throws(() => validate(context), /prohibited blockmap/i);
});

fixture('windows', [primary('windows')], context => {
  finalize(context);
  const files = metadataPaths(context.metadataDir, 'windows');
  const manifest = JSON.parse(fs.readFileSync(files.unsignedManifest, 'utf8'));
  manifest.artifact.file = 'unsupported.zip';
  const corrupted = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(files.unsignedManifest, corrupted);
  fs.writeFileSync(files.genericUnsignedManifest, corrupted);
  assert.throws(() => validate(context), /extension must be exactly \.exe/i);
});

fixture('linux', [primary('linux')], context => {
  finalize(context);
  const files = metadataPaths(context.metadataDir, 'linux');
  fs.appendFileSync(files.checksums, `0`.repeat(64) + '  unrelated.AppImage\n');
  fs.writeFileSync(files.genericChecksums, fs.readFileSync(files.checksums));
  assert.throws(() => validate(context), /exactly one canonical checksum line/i);
});

process.stdout.write('Release metadata platform and publication-readiness contracts passed.\n');
require('./sbom-test');
