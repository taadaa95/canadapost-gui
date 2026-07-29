#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { zipSync, unzipSync } = require('fflate');
const pkg = require('../package.json');
const { assertCleanGit, trackedFiles, auditFileList, sourceManifest, sha256File } = require('../lib/release-safety');
const { scanPaths } = require('../lib/secret-scanner');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'dist', 'safe-release');
assertCleanGit(root);
const files = trackedFiles(root);
const audit = auditFileList(files);
if (!audit.ok) throw new Error(`Release allowlist rejected files: ${[...audit.prohibited, ...audit.unexpected].join(', ')}`);
const findings = scanPaths(root, files);
if (findings.length) throw new Error(`Secret scan rejected ${findings.length} source file finding(s); values were redacted.`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-safe-release-'));
try {
  for (const relative of files) {
    const destination = path.join(stage, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  const manifest = {
    format: 'canadapost-claim-runner-source-package', version: 1, appVersion: pkg.version,
    createdAt: new Date().toISOString(), files: sourceManifest(stage, files)
  };
  fs.writeFileSync(path.join(stage, 'PACKAGE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const packageFiles = [...files, 'PACKAGE-MANIFEST.json'];
  const stagedAudit = auditFileList(files);
  if (!stagedAudit.ok || scanPaths(stage, packageFiles).length) throw new Error('Staged release verification failed.');
  const entries = Object.fromEntries(packageFiles.map(relative => [relative, new Uint8Array(fs.readFileSync(path.join(stage, relative)))]));
  fs.mkdirSync(outputDir, { recursive: true });
  const archivePath = path.join(outputDir, `canadapost-claim-runner-${pkg.version}-source.zip`);
  fs.writeFileSync(archivePath, Buffer.from(zipSync(entries, { level: 9 })));

  const extracted = unzipSync(new Uint8Array(fs.readFileSync(archivePath)));
  const extractedNames = Object.keys(extracted).sort();
  if (JSON.stringify(extractedNames) !== JSON.stringify(packageFiles.sort())) throw new Error('Extracted artifact file list differs from the manifest.');
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-safe-release-verify-'));
  try {
    for (const [relative, bytes] of Object.entries(extracted)) {
      const destination = path.join(extractedDir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(bytes));
    }
    if (scanPaths(extractedDir, extractedNames).length) throw new Error('Extracted artifact secret rescan failed.');
    const extractedManifest = JSON.parse(fs.readFileSync(path.join(extractedDir, 'PACKAGE-MANIFEST.json'), 'utf8'));
    for (const item of extractedManifest.files) {
      if (sha256File(path.join(extractedDir, item.path)) !== item.sha256) throw new Error(`Checksum mismatch for ${item.path}`);
    }
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
  const archiveHash = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  fs.writeFileSync(path.join(outputDir, 'SHA256SUMS.txt'), `${archiveHash}  ${path.basename(archivePath)}\n`);
  process.stdout.write(`${archivePath}\n${archiveHash}\n`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
