#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { assertReleaseGitState, validateReleaseIdentity, sha256File } = require('../lib/release-safety');

const root = path.resolve(__dirname, '..');
const platform = String(process.env.RELEASE_PLATFORM || (process.platform === 'win32' ? 'windows' : 'linux')).toLowerCase();
const identity = process.env.RELEASE_MATERIALIZED_FROM_GUARDED_SOURCE === '1'
  ? validateReleaseIdentity({ branch: process.env.RELEASE_SOURCE_BRANCH, commit: process.env.RELEASE_SOURCE_COMMIT }, { expectedBranch: process.env.CPCR_CANONICAL_RELEASE_BRANCH })
  : assertReleaseGitState(root);
const metadataDirectory = path.join(root, 'dist', 'release-metadata');
const candidates = [
  `package-manifest-${platform}.unsigned.json`,
  `SHA256SUMS-${platform}.txt`,
  `package-size-${platform}.json`,
  'sbom.cyclonedx.json',
  'dependency-licenses.json'
];
const materials = candidates.map(name => {
  const filePath = path.join(metadataDirectory, name);
  if (!fs.existsSync(filePath)) throw new Error(`Release provenance input is missing: ${name}`);
  return { name, bytes: fs.statSync(filePath).size, sha256: sha256File(filePath) };
});
const report = {
  format: 'canadapost-claim-runner-release-provenance',
  version: 1,
  generatedAt: new Date().toISOString(),
  applicationVersion: require('../package.json').version,
  channel: process.env.RELEASE_CHANNEL || 'beta',
  platform,
  architecture: 'x64',
  sourceBranch: identity.branch,
  sourceCommit: identity.commit,
  artifactTrust: 'unsigned-beta-build',
  signingRequiredBeforeProductionPublication: true,
  materials
};
const destination = path.join(metadataDirectory, `release-provenance-${platform}.json`);
fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Release provenance recorded for ${identity.commit}: ${destination}\n`);
