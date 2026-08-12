#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const SOURCE_REPOSITORY = 'taadaa95/canadapost-gui';
const RELEASE_REPOSITORY = 'taadaa95/canadapost-claim-runner-releases';
const PLATFORM_POLICIES = Object.freeze({
  linux: Object.freeze({ extension: '.AppImage', platformToken: 'linux', architectureToken: 'x86_64' }),
  windows: Object.freeze({ extension: '.exe', platformToken: 'win', architectureToken: 'x64' }),
  macos: Object.freeze({ extension: '.dmg', platformToken: 'mac', architectureToken: 'universal' })
});

function releasePlatform(value = process.env.RELEASE_PLATFORM || process.platform) {
  const requested = String(value || '').trim().toLowerCase();
  const platform = requested === 'win32' ? 'windows' : requested === 'darwin' ? 'macos' : requested;
  if (!Object.hasOwn(PLATFORM_POLICIES, platform)) throw new Error(`Unsupported release metadata platform: ${platform}`);
  return platform;
}

function expectedBinaryName({ version, platform }) {
  const policy = PLATFORM_POLICIES[releasePlatform(platform)];
  const cleanVersion = String(version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(cleanVersion)) throw new Error('A stable semantic application version is required for release metadata.');
  return `Canada.Post.Claim.Runner-${cleanVersion}-${policy.platformToken}-${policy.architectureToken}${policy.extension}`;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function selectPrimaryBinary({ packageDir, version, platform }) {
  const normalizedPlatform = releasePlatform(platform);
  const policy = PLATFORM_POLICIES[normalizedPlatform];
  const expectedFile = expectedBinaryName({ version, platform: normalizedPlatform });
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

function metadataPaths(metadataDir, platform, version) {
  const normalizedPlatform = releasePlatform(platform);
  return {
    checksums: path.join(metadataDir, `SHA256SUMS-${normalizedPlatform}.txt`),
    genericChecksums: path.join(metadataDir, 'SHA256SUMS.txt'),
    publicRelease: path.join(metadataDir, 'releases', `v${version}.json`)
  };
}

function sourceCommit(value = process.env.RELEASE_SOURCE_COMMIT || '') {
  const commit = String(value || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).trim();
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('Release source SHA must be a full 40-character Git commit.');
  return commit.toLowerCase();
}

function buildOrigin(value = '') {
  if (value) return String(value);
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_RUN_ID) return `github-actions:${process.env.GITHUB_RUN_ID}`;
  return 'local-clean-source';
}

function publicReleaseMetadata({ artifact, version, platform, sourceSha, origin }) {
  const normalizedPlatform = releasePlatform(platform);
  return {
    format: 'canadapost-claim-runner-release-metadata',
    metadataVersion: 1,
    version: String(version),
    tag: `v${version}`,
    sourceRepository: SOURCE_REPOSITORY,
    sourceSha: sourceCommit(sourceSha),
    artifacts: { [normalizedPlatform]: artifact },
    manualValidation: { status: 'pending', validatedAt: null, notes: '' },
    buildOrigin: buildOrigin(origin),
    releaseUrl: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`
  };
}

function finalizeArtifacts({ packageDir, metadataDir, version, platform, sourceSha, origin }) {
  const normalizedPlatform = releasePlatform(platform);
  const selected = selectPrimaryBinary({ packageDir, version, platform: normalizedPlatform });
  const files = metadataPaths(metadataDir, normalizedPlatform, version);
  const checksumsText = `${selected.artifact.sha256}  ${selected.artifact.file}\n`;
  const releaseMetadata = publicReleaseMetadata({
    artifact: selected.artifact,
    version,
    platform: normalizedPlatform,
    sourceSha,
    origin
  });
  fs.mkdirSync(path.dirname(files.publicRelease), { recursive: true });
  fs.writeFileSync(files.checksums, checksumsText);
  fs.writeFileSync(files.genericChecksums, checksumsText);
  fs.writeFileSync(files.publicRelease, `${JSON.stringify(releaseMetadata, null, 2)}\n`);
  return { ...selected, checksumsText, releaseMetadata, files };
}

function readRequired(filePath) {
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) throw new Error(`Required release metadata file is missing: ${filePath}`);
  return fs.readFileSync(filePath, 'utf8');
}

function validateReleaseMetadata({ packageDir, metadataDir, version, platform, sourceSha }) {
  const normalizedPlatform = releasePlatform(platform);
  const expectedFile = expectedBinaryName({ version, platform: normalizedPlatform });
  const selected = selectPrimaryBinary({ packageDir, version, platform: normalizedPlatform });
  const files = metadataPaths(metadataDir, normalizedPlatform, version);
  const checksumsText = readRequired(files.checksums);
  if (checksumsText !== readRequired(files.genericChecksums)) throw new Error('Generic SHA256SUMS does not match the platform checksum file.');
  const expectedChecksums = `${selected.artifact.sha256}  ${expectedFile}\n`;
  if (checksumsText !== expectedChecksums) throw new Error('SHA256SUMS must contain exactly one canonical checksum line for the primary binary.');
  let metadata;
  try { metadata = JSON.parse(readRequired(files.publicRelease)); }
  catch (error) { throw new Error(`Stable release metadata is not valid JSON: ${error.message}`); }
  if (metadata.format !== 'canadapost-claim-runner-release-metadata' || metadata.metadataVersion !== 1) throw new Error('Stable release metadata format is invalid.');
  if (metadata.version !== version || metadata.tag !== `v${version}`) throw new Error('Stable release metadata version or tag is invalid.');
  if (metadata.sourceRepository !== SOURCE_REPOSITORY || metadata.sourceSha !== sourceCommit(sourceSha)) throw new Error('Stable release metadata source identity is invalid.');
  if (metadata.releaseUrl !== `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`) throw new Error('Stable release URL is invalid.');
  if (metadata.manualValidation?.status !== 'pending') throw new Error('Stable release metadata must remain pending until Kris completes manual validation.');
  if (JSON.stringify(metadata.artifacts?.[normalizedPlatform]) !== JSON.stringify(selected.artifact)) throw new Error('Stable release metadata artifact does not match the package.');
  if (/(?:beta|channel|signature|manifest)/i.test(JSON.stringify(metadata))) throw new Error('Stable release metadata contains obsolete release-channel or signing fields.');
  return { artifact: selected.artifact, ignoredOutputs: selected.ignoredOutputs, metadata, files };
}

function reportIgnoredOutputs(ignoredOutputs) {
  if (ignoredOutputs.length) process.stdout.write(`Ignored non-public build outputs: ${ignoredOutputs.join(', ')}\n`);
}

function main() {
  const packageDir = path.resolve(process.argv[2] || path.join(root, 'dist', 'packages'));
  const metadataDir = path.resolve(process.argv[3] || path.join(root, 'dist', 'release-metadata'));
  const platform = releasePlatform();
  const version = require('../package.json').version;
  const result = finalizeArtifacts({ packageDir, metadataDir, version, platform });
  reportIgnoredOutputs(result.ignoredOutputs);
  process.stdout.write(`Finalized stable ${platform} package ${result.artifact.file} with SHA-256 metadata.\n`);
}

if (require.main === module) main();

module.exports = {
  SOURCE_REPOSITORY,
  RELEASE_REPOSITORY,
  PLATFORM_POLICIES,
  releasePlatform,
  expectedBinaryName,
  sha256File,
  selectPrimaryBinary,
  metadataPaths,
  sourceCommit,
  buildOrigin,
  publicReleaseMetadata,
  finalizeArtifacts,
  validateReleaseMetadata,
  reportIgnoredOutputs
};
