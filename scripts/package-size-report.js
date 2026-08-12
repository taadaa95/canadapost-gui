#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
const isWindows = platform === 'windows' || platform === 'win32';
const isMacos = platform === 'macos' || platform === 'darwin';
const extension = isWindows ? '.exe' : isMacos ? '.dmg' : '.AppImage';
const budgetKey = isWindows ? 'windows-x64-nsis' : isMacos ? 'mac-universal-dmg' : 'linux-x64-appimage';
const artifacts = fs.readdirSync(packageDirectory, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(extension))
  .map(entry => ({ name: entry.name, bytes: fs.statSync(path.join(packageDirectory, entry.name)).size }));
if (!artifacts.length) throw new Error(`No ${extension} artifact was found for the package-size budget.`);
const budget = Number(allowlist.artifactSizeBudgets[budgetKey]);
const baselineBytes = Number(allowlist.baselineArtifactBytes?.[`${budgetKey}-dev10`] || 0);
for (const artifact of artifacts) {
  process.stdout.write(`Artifact ${artifact.name}: ${artifact.bytes} bytes (budget ${budget} bytes).\n`);
  if (artifact.bytes > budget) throw new Error(`${artifact.name} exceeds the ${budgetKey} package-size budget by ${artifact.bytes - budget} bytes.`);
}

const unpackedName = isWindows ? 'win-unpacked' : isMacos ? 'mac-universal' : 'linux-unpacked';
const unpacked = path.join(packageDirectory, unpackedName);
let contributors = [];
if (fs.existsSync(unpacked)) {
  contributors = fs.readdirSync(unpacked, { withFileTypes: true }).map(entry => {
    const target = path.join(unpacked, entry.name);
    return { name: entry.name, bytes: entry.isDirectory() ? directoryBytes(target) : fs.statSync(target).size };
  }).sort((left, right) => right.bytes - left.bytes).slice(0, 10);
  process.stdout.write('Major unpacked size contributors:\n');
  contributors.forEach(item => process.stdout.write(`  ${item.name}: ${item.bytes} bytes\n`));
}
const commit = String(process.env.RELEASE_SOURCE_COMMIT || process.env.GITHUB_SHA || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout || '').trim();
const report = {
  format: 'canadapost-claim-runner-package-size-report',
  version: 1,
  generatedAt: new Date().toISOString(),
  commit,
  platform: budgetKey,
  budgetBytes: budget,
  baselineBytes: baselineBytes || null,
  artifacts: artifacts.map(artifact => ({
    ...artifact,
    withinBudget: artifact.bytes <= budget,
    reductionFromDev10Bytes: baselineBytes ? baselineBytes - artifact.bytes : null,
    reductionFromDev10Percent: baselineBytes ? Number((((baselineBytes - artifact.bytes) / baselineBytes) * 100).toFixed(2)) : null
  })),
  majorUnpackedContributors: contributors
};
const reportDirectory = path.join(root, 'dist', 'release-metadata');
fs.mkdirSync(reportDirectory, { recursive: true });
const reportPath = path.join(reportDirectory, `package-size-${isWindows ? 'windows' : isMacos ? 'macos' : 'linux'}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Package-size report: ${reportPath}\n`);
