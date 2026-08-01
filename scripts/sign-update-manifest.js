#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const updateSecurity = require('../lib/update-security');
const source = require('../config/update-source.json');

const root = path.resolve(__dirname, '..');

function outsideRepository(filePath) {
  const relative = path.relative(root, filePath);
  return relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function main() {
  const inputPath = path.resolve(process.argv[2] || '');
  const outputPath = path.resolve(process.argv[3] || '');
  const privateKeyPath = path.resolve(process.env.CPCR_UPDATE_PRIVATE_KEY_FILE || '');
  if (!fs.statSync(inputPath, { throwIfNoEntry: false })?.isFile()) throw new Error('An unsigned manifest candidate path is required.');
  if (!outputPath || path.extname(outputPath) !== '.json' || outputPath === inputPath) throw new Error('A distinct signed-manifest JSON output path is required.');
  if (!fs.statSync(privateKeyPath, { throwIfNoEntry: false })?.isFile() || !outsideRepository(privateKeyPath)) {
    throw new Error('CPCR_UPDATE_PRIVATE_KEY_FILE must identify an external offline key file outside the repository.');
  }
  if (fs.existsSync(outputPath)) throw new Error('The signed-manifest output already exists; refusing to overwrite it.');
  const trusted = updateSecurity.trustedEd25519Key(source.trustedPublicKeyEd25519);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath));
  const derivedPublic = crypto.createPublicKey(privateKey);
  if (derivedPublic.export({ type: 'spki', format: 'der' }).compare(trusted.export({ type: 'spki', format: 'der' })) !== 0) {
    throw new Error('The offline private key does not match the public key embedded in this reviewed commit.');
  }
  const unsigned = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const signed = updateSecurity.signManifest(unsigned, privateKey);
  updateSecurity.verifySignedManifest(signed, {
    publicKey: trusted,
    expectedVersion: unsigned.applicationVersion,
    channel: unsigned.channel,
    platform: unsigned.platform,
    architecture: unsigned.architecture
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(signed, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`Created verified signed update manifest ${outputPath}.\n`);
}

if (require.main === module) main();

module.exports = { outsideRepository };
