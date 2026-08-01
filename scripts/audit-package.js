#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const asar = require('@electron/asar');
const { isProhibited } = require('../lib/release-safety');
const { scanPaths } = require('../lib/secret-scanner');
const { WORKERS } = require('../lib/runtime-workers');
const packageAllowlist = require('../config/package-content-allowlist.json');
const { auditPackagePaths, collectRelativePaths } = require('../lib/package-content-policy');

const target = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'packages', 'linux-unpacked'));
if (!fs.existsSync(target)) throw new Error('Pass an unpacked Electron application directory to audit.');
const resources = path.join(target, 'resources');
const archive = path.join(resources, 'app.asar');
if (!fs.existsSync(archive)) throw new Error('Packaged app.asar is missing.');
const unpackedRoot = path.join(resources, 'app.asar.unpacked');
const prohibitedContent = auditPackagePaths(collectRelativePaths(resources));
if (prohibitedContent.length) {
  throw new Error(`Packaged application contains prohibited production content: ${prohibitedContent.map(item => `${item.path} (${item.reason})`).join(', ')}`);
}
if (!fs.statSync(path.join(unpackedRoot, 'node_modules', 'playwright-core', 'package.json'), { throwIfNoEntry: false })?.isFile()) {
  throw new Error('Packaged playwright-core CDP client is missing.');
}
const missingWorkers = Object.entries(WORKERS)
  .filter(([, relative]) => !fs.statSync(path.join(unpackedRoot, relative), { throwIfNoEntry: false })?.isFile())
  .map(([name]) => name);
if (missingWorkers.length) throw new Error(`Packaged external worker resources are missing: ${missingWorkers.join(', ')}`);
for (const required of [
  'lib/user-data-bootstrap.js',
  'lib/mutable-paths.js',
  'lib/isolated-profile-probe.js',
  'lib/runtime-workers.js',
  'lib/claim-database.js',
  'lib/database-migrations.js',
  'lib/startup-database.js',
  'lib/canadapost-api.js',
  'lib/canadapost-errors.js',
  'lib/canadapost-parsers.js',
  'lib/tracking-contract.js',
  'lib/tracking-oauth.js',
  'lib/tracking-json.js',
  'lib/tracking-diagnostic-gate.js',
  'lib/step3-browser-handshake.js',
  'lib/cdp-page-target.js',
  'lib/browser-visibility.js',
  'lib/tracking-client.js',
  'lib/tracking-normalizer.js',
  'config/policy-rules.json',
  'cacert.pem',
  'wsdl/track.wsdl'
]) {
  if (!fs.statSync(path.join(unpackedRoot, required), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Packaged external worker dependency is missing: ${required}`);
  }
}
const entries = asar.listPackage(archive)
  .map(value => value.replace(/\\/g, '/').replace(/^\/+/, ''))
  .filter(Boolean);
const prohibited = entries.filter(entry => isProhibited(entry) && entry !== 'node_modules' && !entry.startsWith('node_modules/'));
if (prohibited.length) throw new Error(`Packaged application contains prohibited paths: ${prohibited.join(', ')}`);
const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-asar-audit-'));
try {
  asar.extractAll(archive, extracted);
  const findings = scanPaths(extracted);
  if (findings.length) throw new Error(`Packaged application secret scan produced ${findings.length} redacted finding(s).`);
  const unexpectedRoots = fs.readdirSync(extracted).filter(name => !packageAllowlist.allowedRoots.includes(name));
  if (unexpectedRoots.length) throw new Error(`Unexpected packaged application roots: ${unexpectedRoots.join(', ')}`);
  for (const excluded of packageAllowlist.excludedProductionRoots) {
    if (fs.existsSync(path.join(extracted, excluded))) throw new Error(`Development-only production root is present: ${excluded}`);
  }
  const packagedScripts = fs.readdirSync(path.join(extracted, 'scripts')).sort();
  if (JSON.stringify(packagedScripts) !== JSON.stringify([...packageAllowlist.runtimeScripts].sort())) {
    throw new Error(`Packaged scripts differ from the runtime allowlist: ${packagedScripts.join(', ')}`);
  }
} finally {
  fs.rmSync(extracted, { recursive: true, force: true });
}
process.stdout.write(`Packaged content audit passed for ${entries.length} app.asar entries.\n`);
process.stdout.write(`Packaged external worker audit passed for ${Object.keys(WORKERS).length} workers under app.asar.unpacked.\n`);
