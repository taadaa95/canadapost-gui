'use strict';

const crypto = require('crypto');
const fs = require('fs');

const MAX_ARTIFACT_BYTES = 1536 * 1024 * 1024;
/** @type {Readonly<Record<string, number>>} */
const PRERELEASE_ORDER = Object.freeze({ dev: 0, alpha: 1, beta: 2, rc: 3 });

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
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] < b.parts[index] ? -1 : 1;
  }
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

/** @param {string} filePath @param {{bytes: number, sha256: string}} expected */
function verifyArtifact(filePath, expected) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size !== Number(expected.bytes)) throw new Error('Update artifact size verification failed.');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const expectedDigest = String(expected.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)
      || !crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expectedDigest, 'hex'))) {
    throw new Error('Update artifact checksum verification failed.');
  }
  return true;
}

/** @param {string} filePath @param {string} expectedSha256 */
function verifyArtifactChecksum(filePath, expectedSha256) {
  return verifyArtifact(filePath, { bytes: fs.statSync(filePath).size, sha256: expectedSha256 });
}

module.exports = {
  MAX_ARTIFACT_BYTES,
  parseVersion,
  compareVersions,
  verifyArtifact,
  verifyArtifactChecksum
};
