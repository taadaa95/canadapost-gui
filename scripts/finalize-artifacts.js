#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageDir = path.resolve(process.argv[2] || path.join(root, 'dist', 'packages'));
const metadataDir = path.join(root, 'dist', 'release-metadata');
fs.mkdirSync(metadataDir, { recursive: true });
const artifacts = fs.readdirSync(packageDir, { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(?:AppImage|exe|blockmap|yml)$/i.test(entry.name) && entry.name !== 'builder-debug.yml')
  .map(entry => {
    const filePath = path.join(packageDir, entry.name);
    const bytes = fs.statSync(filePath).size;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    return { file: entry.name, bytes, sha256 };
  }).sort((left, right) => left.file.localeCompare(right.file));
if (!artifacts.length) throw new Error('No release artifacts were found to finalize.');
const manifest = {
  format: 'canadapost-claim-runner-artifact-manifest', version: 1,
  applicationVersion: require('../package.json').version,
  channel: process.env.RELEASE_CHANNEL || 'beta', generatedAt: new Date().toISOString(), artifacts
};
fs.writeFileSync(path.join(metadataDir, 'package-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(metadataDir, 'SHA256SUMS.txt'), `${artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n')}\n`);
process.stdout.write(`Finalized ${artifacts.length} release artifact(s) with SHA-256 checksums.\n`);
