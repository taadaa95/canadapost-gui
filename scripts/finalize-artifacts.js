#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const PLATFORM_POLICIES = Object.freeze({
  linux: Object.freeze({ extension: '.AppImage', platformToken: 'linux', architectureToken: 'x86_64' }),
  windows: Object.freeze({ extension: '.exe', platformToken: 'win', architectureToken: 'x64' })
});

function releasePlatform(value = process.env.RELEASE_PLATFORM || (process.platform === 'win32' ? 'windows' : process.platform)) {
  const platform = String(value || '').trim().toLowerCase();
  if (!Object.hasOwn(PLATFORM_POLICIES, platform)) throw new Error(`Unsupported release metadata platform: ${platform}`);
  return platform;
}

function releaseChannel(value = process.env.RELEASE_CHANNEL || 'beta') {
  const channel = String(value || '').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(channel)) throw new Error(`Invalid release channel: ${channel || '(empty)'}`);
  return channel;
}

function expectedBinaryName({ version, platform, channel }) {
  const policy = PLATFORM_POLICIES[releasePlatform(platform)];
  const cleanVersion = String(version || '').trim();
  if (!cleanVersion) throw new Error('Application version is required for release metadata.');
  return `Canada.Post.Claim.Runner-${cleanVersion}-${policy.platformToken}-${policy.architectureToken}-${releaseChannel(channel)}${policy.extension}`;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function selectPrimaryBinary({ packageDir, version, platform, channel }) {
  const normalizedPlatform = releasePlatform(platform);
  const policy = PLATFORM_POLICIES[normalizedPlatform];
  const expectedFile = expectedBinaryName({ version, platform: normalizedPlatform, channel });
  const entries = fs.readdirSync(packageDir, { withFileTypes: true });
  const primaryCandidates = entries
    .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === policy.extension.toLowerCase())
    .map(entry => entry.name)
    .sort();
  if (primaryCandidates.length !== 1) {
    throw new Error(`Expected exactly one ${policy.extension} primary binary for ${normalizedPlatform}; found ${primaryCandidates.length}: ${primaryCandidates.join(', ') || '(none)'}`);
  }
  if (primaryCandidates[0] !== expectedFile) {
    throw new Error(`Primary binary filename mismatch for ${normalizedPlatform}: expected ${expectedFile}, found ${primaryCandidates[0]}`);
  }
  const ignoredOutputs = entries
    .filter(entry => entry.name !== expectedFile)
    .map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .sort();
  const filePath = path.join(packageDir, expectedFile);
  return {
    artifact: { file: expectedFile, bytes: fs.statSync(filePath).size, sha256: sha256File(filePath) },
    ignoredOutputs
  };
}

function metadataPaths(metadataDir, platform) {
  const normalizedPlatform = releasePlatform(platform);
  return {
    manifest: path.join(metadataDir, `package-manifest-${normalizedPlatform}.json`),
    checksums: path.join(metadataDir, `SHA256SUMS-${normalizedPlatform}.txt`),
    genericManifest: path.join(metadataDir, 'package-manifest.json'),
    genericChecksums: path.join(metadataDir, 'SHA256SUMS.txt')
  };
}

function canonicalMetadata({ artifact, version, platform, channel, generatedAt = new Date().toISOString() }) {
  const normalizedPlatform = releasePlatform(platform);
  const manifest = {
    format: 'canadapost-claim-runner-artifact-manifest',
    version: 1,
    applicationVersion: String(version),
    channel: releaseChannel(channel),
    platform: normalizedPlatform,
    generatedAt,
    artifacts: [artifact]
  };
  return {
    manifest,
    manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
    checksumsText: `${artifact.sha256}  ${artifact.file}\n`
  };
}

function finalizeArtifacts({ packageDir, metadataDir, version, platform, channel, generatedAt }) {
  const normalizedPlatform = releasePlatform(platform);
  const selected = selectPrimaryBinary({ packageDir, version, platform: normalizedPlatform, channel });
  const metadata = canonicalMetadata({ artifact: selected.artifact, version, platform: normalizedPlatform, channel, generatedAt });
  const files = metadataPaths(metadataDir, normalizedPlatform);
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(files.manifest, metadata.manifestText);
  fs.writeFileSync(files.checksums, metadata.checksumsText);
  // Preserve generic filenames for local release tooling and backwards compatibility.
  fs.writeFileSync(files.genericManifest, metadata.manifestText);
  fs.writeFileSync(files.genericChecksums, metadata.checksumsText);
  return { ...selected, ...metadata, files };
}

function readRequired(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`Required release metadata file is missing: ${filePath}`);
  return fs.readFileSync(filePath, 'utf8');
}

function validateReleaseMetadata({ packageDir, metadataDir, version, platform, channel }) {
  const normalizedPlatform = releasePlatform(platform);
  const policy = PLATFORM_POLICIES[normalizedPlatform];
  const expectedFile = expectedBinaryName({ version, platform: normalizedPlatform, channel });
  const selected = selectPrimaryBinary({ packageDir, version, platform: normalizedPlatform, channel });
  const files = metadataPaths(metadataDir, normalizedPlatform);
  const manifestText = readRequired(files.manifest);
  const checksumsText = readRequired(files.checksums);
  const genericManifestText = readRequired(files.genericManifest);
  const genericChecksumsText = readRequired(files.genericChecksums);
  const publicMetadataText = [manifestText, checksumsText, genericManifestText, genericChecksumsText].join('\n');
  if (/\.blockmap|\.ya?ml/i.test(publicMetadataText)) throw new Error('Public release metadata contains a prohibited blockmap or YAML reference.');
  if (manifestText !== genericManifestText || checksumsText !== genericChecksumsText) {
    throw new Error('Generic release metadata does not exactly match the platform-specific metadata.');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`Release manifest is not valid JSON: ${error.message}`);
  }
  if (manifest.format !== 'canadapost-claim-runner-artifact-manifest' || manifest.version !== 1) throw new Error('Release manifest format or version is invalid.');
  if (manifest.applicationVersion !== String(version)) throw new Error(`Release manifest applicationVersion must be ${version}.`);
  if (manifest.channel !== releaseChannel(channel)) throw new Error(`Release manifest channel must be ${releaseChannel(channel)}.`);
  if (manifest.platform !== normalizedPlatform) throw new Error(`Release manifest platform must be ${normalizedPlatform}.`);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 1) throw new Error('Release manifest must contain exactly one artifact.');
  const artifact = manifest.artifacts[0];
  if (path.extname(String(artifact.file || '')) !== policy.extension) throw new Error(`Release manifest artifact extension must be exactly ${policy.extension}.`);
  if (artifact.file !== expectedFile) throw new Error(`Release manifest artifact filename must be ${expectedFile}.`);
  if (artifact.bytes !== selected.artifact.bytes) throw new Error('Release manifest byte size does not match the primary binary.');
  if (artifact.sha256 !== selected.artifact.sha256) throw new Error('Release manifest SHA-256 does not match the primary binary.');
  const expectedChecksums = `${selected.artifact.sha256}  ${expectedFile}\n`;
  if (checksumsText !== expectedChecksums) throw new Error('SHA256SUMS must contain exactly one canonical checksum line for the primary binary.');
  return { artifact: selected.artifact, ignoredOutputs: selected.ignoredOutputs, manifest, files };
}

function reportIgnoredOutputs(ignoredOutputs) {
  if (ignoredOutputs.length) process.stdout.write(`Ignored non-public build outputs: ${ignoredOutputs.join(', ')}\n`);
}

function main() {
  const packageDir = path.resolve(process.argv[2] || path.join(root, 'dist', 'packages'));
  const metadataDir = path.resolve(process.argv[3] || path.join(root, 'dist', 'release-metadata'));
  const platform = releasePlatform();
  const version = require('../package.json').version;
  const channel = releaseChannel();
  const result = finalizeArtifacts({ packageDir, metadataDir, version, platform, channel });
  reportIgnoredOutputs(result.ignoredOutputs);
  process.stdout.write(`Finalized exactly one ${platform} public release binary with SHA-256 metadata.\n`);
}

if (require.main === module) main();

module.exports = {
  PLATFORM_POLICIES,
  releasePlatform,
  releaseChannel,
  expectedBinaryName,
  sha256File,
  selectPrimaryBinary,
  metadataPaths,
  canonicalMetadata,
  finalizeArtifacts,
  validateReleaseMetadata,
  reportIgnoredOutputs
};
