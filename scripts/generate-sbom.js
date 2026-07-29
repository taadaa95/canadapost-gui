#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const pkg = require('../package.json');
const outputDir = path.resolve(process.argv[2] || path.join(root, 'dist', 'release-metadata'));
fs.mkdirSync(outputDir, { recursive: true });

const components = Object.entries(lock.packages || {}).filter(([name]) => name && name.startsWith('node_modules/')).map(([location, info]) => {
  const name = location.replace(/^.*node_modules\//, '');
  const version = String(info.version || '');
  return {
    type: 'library', name, version,
    purl: `pkg:npm/${name.startsWith('@') ? name.replace('/', '%2F') : name}@${version}`,
    hashes: info.integrity ? [{ alg: 'SHA-512', content: String(info.integrity).replace(/^sha512-/, '') }] : undefined,
    licenses: info.license ? [{ license: { name: info.license } }] : undefined,
    properties: [{ name: 'cdx:npm:development', value: String(Boolean(info.dev)) }]
  };
}).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const serialSeed = crypto.createHash('sha256').update(`${pkg.name}@${pkg.version}:${lock.lockfileVersion}:${components.map(item => `${item.name}@${item.version}`).join('|')}`).digest('hex');
const sbom = {
  bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: `urn:uuid:${serialSeed.slice(0, 8)}-${serialSeed.slice(8, 12)}-4${serialSeed.slice(13, 16)}-a${serialSeed.slice(17, 20)}-${serialSeed.slice(20, 32)}`,
  version: 1, metadata: { timestamp: new Date().toISOString(), component: { type: 'application', name: pkg.name, version: pkg.version } }, components
};
fs.writeFileSync(path.join(outputDir, 'sbom.cyclonedx.json'), `${JSON.stringify(sbom, null, 2)}\n`);
const licences = components.map(item => ({ name: item.name, version: item.version, license: item.licenses?.[0]?.license?.name || 'SEE PACKAGE METADATA' }));
fs.writeFileSync(path.join(outputDir, 'dependency-licenses.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), application: `${pkg.name}@${pkg.version}`, dependencies: licences }, null, 2)}\n`);
process.stdout.write(`Generated SBOM and dependency licence inventory for ${components.length} installed package entries.\n`);
