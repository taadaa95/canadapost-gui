#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageDirectory = path.resolve(process.argv[2] || path.join(root, 'dist', 'packages'));
const allowlist = require('../config/package-content-allowlist.json');

function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    bytes += entry.isDirectory() ? directoryBytes(target) : fs.statSync(target).size;
  }
  return bytes;
}

const platform = String(process.env.RELEASE_PLATFORM || process.platform).toLowerCase();
const extension = platform === 'windows' || platform === 'win32' ? '.exe' : '.AppImage';
const budgetKey = extension === '.exe' ? 'windows-x64-nsis' : 'linux-x64-appimage';
const artifacts = fs.readdirSync(packageDirectory, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(extension))
  .map(entry => ({ name: entry.name, bytes: fs.statSync(path.join(packageDirectory, entry.name)).size }));
if (!artifacts.length) throw new Error(`No ${extension} artifact was found for the package-size budget.`);
const budget = Number(allowlist.artifactSizeBudgets[budgetKey]);
for (const artifact of artifacts) {
  process.stdout.write(`Artifact ${artifact.name}: ${artifact.bytes} bytes (budget ${budget} bytes).\n`);
  if (artifact.bytes > budget) throw new Error(`${artifact.name} exceeds the ${budgetKey} package-size budget by ${artifact.bytes - budget} bytes.`);
}

const unpackedName = extension === '.exe' ? 'win-unpacked' : 'linux-unpacked';
const unpacked = path.join(packageDirectory, unpackedName);
if (fs.existsSync(unpacked)) {
  const contributors = fs.readdirSync(unpacked, { withFileTypes: true }).map(entry => {
    const target = path.join(unpacked, entry.name);
    return { name: entry.name, bytes: entry.isDirectory() ? directoryBytes(target) : fs.statSync(target).size };
  }).sort((left, right) => right.bytes - left.bytes).slice(0, 10);
  process.stdout.write('Major unpacked size contributors:\n');
  contributors.forEach(item => process.stdout.write(`  ${item.name}: ${item.bytes} bytes\n`));
}
