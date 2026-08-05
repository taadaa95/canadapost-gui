'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('./canonical-json');

const UPDATE_MANIFEST_FORMAT = 'canadapost-claim-runner-update-manifest';
const UPDATE_MANIFEST_VERSION = 1;
const CHANNELS = Object.freeze(['stable', 'beta']);
const PLATFORMS = Object.freeze(['linux', 'windows']);
const ARCHITECTURES = Object.freeze(['x64']);
const MAX_ARTIFACT_BYTES = 1536 * 1024 * 1024;
/** @type {Readonly<Record<string, number>>} */
const PRERELEASE_ORDER = Object.freeze({ dev: 0, alpha: 1, beta: 2, rc: 3 });

/** @typedef {{file?: string, bytes: number, sha256: string}} SignedArtifact */
/** @typedef {{publicKey?: any, expectedVersion?: string, expectedPublishedAt?: string, currentVersion?: string, channel?: 'stable'|'beta', platform?: 'linux'|'windows', architecture?: 'x64'}} ManifestVerificationOptions */

/** @param {unknown} value @returns {{parts: number[], prerelease: string, prereleaseStage: string, prereleaseNumber: number|null}} */
function parseVersion(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)(?:-(dev|alpha|beta|rc)(?:\.(\d+))?)?$/i);
  if (!match) throw new Error('Update version is invalid.');
  return {
    parts: match.slice(1, 4).map(Number),
    prerelease: match[4] ? `${match[4].toLowerCase()}${match[5] === undefined ? '' : `.${match[5]}`}` : '',
    prereleaseStage: String(match[4] || '').toLowerCase(),
    prereleaseNumber: match[5] === undefined ? null : Number(match[5])
  };
}

/** @param {string} left @param {string} right @returns {number} */
function compareVersions(left, right) {
  const a = parseVersion(left); const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) if (a.parts[index] !== b.parts[index]) return a.parts[index] < b.parts[index] ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  if (PRERELEASE_ORDER[a.prereleaseStage] !== PRERELEASE_ORDER[b.prereleaseStage]) {
    return PRERELEASE_ORDER[a.prereleaseStage] < PRERELEASE_ORDER[b.prereleaseStage] ? -1 : 1;
  }
  if (a.prereleaseNumber === b.prereleaseNumber) return 0;
  if (a.prereleaseNumber === null) return -1;
  if (b.prereleaseNumber === null) return 1;
  return a.prereleaseNumber < b.prereleaseNumber ? -1 : 1;
}

/** @param {Record<string, any>} manifest */
function unsignedManifest(manifest) {
  const unsigned = { ...manifest };
  delete unsigned.signature;
  return unsigned;
}

/** @param {Record<string, any>} manifest */
function signedPayload(manifest) {
  return Buffer.from(canonicalize(unsignedManifest(manifest)), 'utf8');
}

/** @param {any} value */
function trustedEd25519Key(value) {
  if (!value) throw new Error('No trusted production update public key is configured; updates are disabled.');
  let key;
  try { key = value?.type === 'public' ? value : crypto.createPublicKey(value); }
  catch (_) { throw new Error('The trusted update public key is malformed; updates are disabled.'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The trusted update public key must be Ed25519.');
  return key;
}

/** @param {unknown} value */
function signatureBytes(value) {
  const signature = String(value || '');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('The update manifest signature is missing or malformed.');
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature) throw new Error('The update manifest signature is missing or malformed.');
  return bytes;
}

/** @param {unknown} value */
function cleanFileName(value) {
  const file = String(value || '');
  if (!file || file.length > 180 || path.basename(file) !== file || /[\\/]/.test(file)
      || file === '.' || file === '..' || /[. ]$/.test(file) || /[\u0000-\u001f]/.test(file)) {
    throw new Error('The update artifact file name is invalid.');
  }
  return file;
}

/** @param {unknown} value */
function isoTimestamp(value) {
  const text = String(value || '');
  const parsed = Date.parse(text);
  if (!text || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) throw new Error('The update publication time is invalid.');
  return text;
}

/** @param {any} manifest @param {ManifestVerificationOptions} [options] */
function validateUnsignedManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('The update manifest is invalid.');
  if (manifest.format !== UPDATE_MANIFEST_FORMAT || manifest.manifestVersion !== UPDATE_MANIFEST_VERSION) throw new Error('The update manifest format or version is invalid.');
  const applicationVersion = String(manifest.applicationVersion || '');
  parseVersion(applicationVersion);
  if (!CHANNELS.includes(manifest.channel)) throw new Error('The update channel is invalid.');
  if (!PLATFORMS.includes(manifest.platform)) throw new Error('The update platform is invalid.');
  if (!ARCHITECTURES.includes(manifest.architecture)) throw new Error('The update architecture is invalid.');
  isoTimestamp(manifest.publishedAt);
  if (manifest.minimumSupportedVersion) parseVersion(manifest.minimumSupportedVersion);
  const artifact = manifest.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error('The update artifact metadata is invalid.');
  cleanFileName(artifact.file);
  const bytes = Number(artifact.bytes);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_ARTIFACT_BYTES) throw new Error('The update artifact size is invalid.');
  if (!/^[a-f0-9]{64}$/i.test(String(artifact.sha256 || ''))) throw new Error('The update artifact checksum is invalid.');
  if (options.expectedVersion && compareVersions(applicationVersion, options.expectedVersion) !== 0) throw new Error('The release tag and update manifest version do not match.');
  if (options.expectedPublishedAt && manifest.publishedAt !== options.expectedPublishedAt) throw new Error('The GitHub release and update manifest publication times do not match.');
  if (options.currentVersion && compareVersions(applicationVersion, options.currentVersion) < 0) throw new Error('Update downgrade is blocked.');
  if (manifest.minimumSupportedVersion && options.currentVersion && compareVersions(options.currentVersion, manifest.minimumSupportedVersion) < 0) throw new Error('This update requires an unsupported upgrade path.');
  if (options.channel === 'stable' && manifest.channel !== 'stable') throw new Error('Stable channel cannot install beta metadata.');
  if (options.channel && options.channel !== manifest.channel) throw new Error('The update manifest channel does not match the selected release channel.');
  if (options.platform && options.platform !== manifest.platform) throw new Error('The update manifest platform does not match this application.');
  if (options.architecture && options.architecture !== manifest.architecture) throw new Error('The update manifest architecture does not match this application.');
  return {
    ...manifest,
    applicationVersion,
    artifact: { ...artifact, file: cleanFileName(artifact.file), bytes, sha256: String(artifact.sha256).toLowerCase() }
  };
}

/** @param {any} manifest @param {ManifestVerificationOptions} [options] */
function verifySignedManifest(manifest, options = {}) {
  const publicKey = trustedEd25519Key(options.publicKey);
  const validated = validateUnsignedManifest(manifest, options);
  const signature = signatureBytes(manifest.signature);
  if (!crypto.verify(null, signedPayload(manifest), publicKey, signature)) throw new Error('Update manifest signature verification failed.');
  return validated;
}

/** @param {Record<string, any>} manifest @param {any} privateKey */
function signManifest(manifest, privateKey) {
  const validated = validateUnsignedManifest(unsignedManifest(manifest));
  const key = privateKey?.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The update private key must be Ed25519.');
  return { ...validated, signature: crypto.sign(null, signedPayload(validated), key).toString('base64') };
}

/** @param {string} filePath @param {SignedArtifact} expected */
function verifyArtifact(filePath, expected) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size !== Number(expected.bytes)) throw new Error('Update artifact size verification failed.');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const expectedDigest = String(expected.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || !crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expectedDigest, 'hex'))) {
    throw new Error('Update artifact checksum verification failed.');
  }
  return true;
}

/** @param {any} metadata @param {ManifestVerificationOptions & {currentVersion: string}} options */
function verifyUpdateMetadata(metadata, options) {
  const manifest = {
    format: UPDATE_MANIFEST_FORMAT,
    manifestVersion: UPDATE_MANIFEST_VERSION,
    applicationVersion: metadata.applicationVersion || metadata.version,
    channel: metadata.channel,
    publishedAt: metadata.publishedAt,
    ...((metadata.minimumSupportedVersion || metadata.minimumVersion) ? { minimumSupportedVersion: metadata.minimumSupportedVersion || metadata.minimumVersion } : {}),
    platform: metadata.platform,
    architecture: metadata.architecture,
    artifact: metadata.artifact,
    signature: metadata.signature
  };
  const verified = verifySignedManifest(manifest, {
    ...options,
    architecture: options.architecture,
    currentVersion: options.currentVersion
  });
  return { ok: true, version: verified.applicationVersion, channel: verified.channel, sha256: verified.artifact.sha256 };
}

/** @param {string} filePath @param {string} expectedSha256 */
function verifyArtifactChecksum(filePath, expectedSha256) {
  return verifyArtifact(filePath, { bytes: fs.statSync(filePath).size, sha256: expectedSha256 });
}

module.exports = {
  UPDATE_MANIFEST_FORMAT,
  UPDATE_MANIFEST_VERSION,
  MAX_ARTIFACT_BYTES,
  parseVersion,
  compareVersions,
  unsignedManifest,
  signedPayload,
  trustedEd25519Key,
  validateUnsignedManifest,
  verifySignedManifest,
  signManifest,
  verifyArtifact,
  verifyUpdateMetadata,
  verifyArtifactChecksum
};
