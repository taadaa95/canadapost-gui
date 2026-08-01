#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const updateSecurity = require('../lib/update-security');
const source = require('../config/update-source.json');

function main() {
  const manifestPath = path.resolve(process.argv[2] || '');
  const artifactPath = path.resolve(process.argv[3] || '');
  if (!fs.statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) throw new Error('A signed update manifest is required.');
  if (!fs.statSync(artifactPath, { throwIfNoEntry: false })?.isFile()) throw new Error('The signed manifest artifact is required.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const verified = updateSecurity.verifySignedManifest(manifest, {
    publicKey: source.trustedPublicKeyEd25519,
    expectedVersion: require('../package.json').version,
    channel: process.env.RELEASE_CHANNEL || 'beta',
    platform: process.env.RELEASE_PLATFORM || (process.platform === 'win32' ? 'windows' : process.platform),
    architecture: process.env.RELEASE_ARCH || 'x64'
  });
  if (path.basename(artifactPath) !== verified.artifact.file) throw new Error('The supplied artifact name does not match the signed manifest.');
  updateSecurity.verifyArtifact(artifactPath, verified.artifact);
  process.stdout.write(`Signed update manifest and artifact verification passed for ${verified.applicationVersion}.\n`);
}

if (require.main === module) main();
