'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { canonicalize } = require('./canonical-json');

/** @typedef {{url: string, sha256: string}} UpdateArtifact */
/** @typedef {{version: string, channel: 'stable'|'beta', publishedAt?: string, minimumVersion?: string, artifact: UpdateArtifact, signature?: string}} UpdateMetadata */
/** @typedef {{publicKey?: import('crypto').KeyLike, channel?: 'stable'|'beta', currentVersion: string}} UpdateOptions */

/** @param {unknown} value @returns {{parts: number[], prerelease: string}} */
function parseVersion(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error('Update version is invalid.');
  return { parts: match.slice(1, 4).map(Number), prerelease: match[4] || '' };
}

/** @param {string} left @param {string} right @returns {number} */
function compareVersions(left, right) {
  const a = parseVersion(left); const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) if (a.parts[index] !== b.parts[index]) return a.parts[index] < b.parts[index] ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

/** @param {UpdateMetadata} metadata @returns {Buffer} */
function signedPayload(metadata) {
  const unsigned = { ...metadata };
  delete unsigned.signature;
  return Buffer.from(canonicalize(unsigned), 'utf8');
}

/** @param {UpdateMetadata} metadata @param {UpdateOptions} options */
function verifyUpdateMetadata(metadata, options) {
  if (!options.publicKey) throw new Error('No trusted update public key is configured; updates are disabled.');
  if (!metadata || typeof metadata !== 'object' || !metadata.signature) throw new Error('Signed update metadata is required.');
  if (!['stable', 'beta'].includes(metadata.channel)) throw new Error('Update channel is invalid.');
  if (options.channel === 'stable' && metadata.channel !== 'stable') throw new Error('Stable channel cannot install beta metadata.');
  if (compareVersions(metadata.version, options.currentVersion) < 0) throw new Error('Update downgrade is blocked.');
  if (metadata.minimumVersion && compareVersions(options.currentVersion, metadata.minimumVersion) < 0) throw new Error('This update requires an unsupported upgrade path.');
  const artifactUrl = new URL(String(metadata.artifact?.url || ''));
  if (artifactUrl.protocol !== 'https:') throw new Error('Update artifact URL must use HTTPS.');
  if (!/^[a-f0-9]{64}$/i.test(String(metadata.artifact?.sha256 || ''))) throw new Error('Update artifact checksum is invalid.');
  const valid = crypto.verify(null, signedPayload(metadata), options.publicKey, Buffer.from(metadata.signature, 'base64'));
  if (!valid) throw new Error('Update metadata signature verification failed.');
  return { ok: true, version: metadata.version, channel: metadata.channel, sha256: metadata.artifact.sha256.toLowerCase() };
}

/** @param {string} filePath @param {string} expectedSha256 @returns {true} */
function verifyArtifactChecksum(filePath, expectedSha256) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(String(expectedSha256), 'hex'))) throw new Error('Update artifact checksum verification failed.');
  return true;
}

module.exports = { parseVersion, compareVersions, signedPayload, verifyUpdateMetadata, verifyArtifactChecksum };
