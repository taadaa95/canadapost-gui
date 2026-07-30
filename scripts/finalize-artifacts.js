#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageDir = path.resolve(process.argv[2] || path.join(root, 'dist', 'packages'));
const metadataDir = path.join(root, 'dist', 'release-metadata');
const platform = String(process.env.RELEASE_PLATFORM || (process.platform === 'win32' ? 'windows' : process.platform)).trim().toLowerCase();
if (!['windows', 'linux'].includes(platform)) throw new Error(`Unsupported release metadata platform: ${platform}`);
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
  channel: process.env.RELEASE_CHANNEL || 'beta', platform, generatedAt: new Date().toISOString(), artifacts
};
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const sumsText = `${artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n')}\n`;
fs.writeFileSync(path.join(metadataDir, `package-manifest-${platform}.json`), manifestText);
fs.writeFileSync(path.join(metadataDir, `SHA256SUMS-${platform}.txt`), sumsText);
// Preserve the original generic filenames for local release tooling and backwards compatibility.
fs.writeFileSync(path.join(metadataDir, 'package-manifest.json'), manifestText);
fs.writeFileSync(path.join(metadataDir, 'SHA256SUMS.txt'), sumsText);
process.stdout.write(`Finalized ${artifacts.length} ${platform} release artifact(s) with SHA-256 checksums.\n`);
