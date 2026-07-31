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

const target = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'packages', 'linux-unpacked'));
if (!fs.existsSync(target)) throw new Error('Pass an unpacked Electron application directory to audit.');
const resources = path.join(target, 'resources');
const archive = path.join(resources, 'app.asar');
if (!fs.existsSync(archive)) throw new Error('Packaged app.asar is missing.');
const browserRoot = path.join(resources, 'app.asar.unpacked', 'node_modules', 'playwright-core', '.local-browsers');
if (!fs.existsSync(browserRoot)) throw new Error('Packaged Playwright browser runtime is missing.');
function containsBrowserExecutable(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).some(entry => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory() ? containsBrowserExecutable(candidate) : /^(?:chrome|chrome-headless-shell)(?:\.exe)?$/i.test(entry.name);
  });
}
if (!containsBrowserExecutable(browserRoot)) throw new Error('Packaged Playwright browser executable is missing.');
const unpackedRoot = path.join(resources, 'app.asar.unpacked');
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
