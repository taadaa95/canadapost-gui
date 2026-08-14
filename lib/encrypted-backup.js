'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const archiveTools = require('./archive-tools');
const { inspectZipBuffer } = require('./zip-safety');

const MAGIC = Buffer.from('CPCRBACKUP\0', 'ascii');
const VERSION = 1;
const TAG_BYTES = 16;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1, keyLength: 32, maxmem: 128 * 1024 * 1024 });

function passwordBuffer(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new Error('Backup password must be between 12 and 1024 characters.');
  }
  return Buffer.from(password, 'utf8');
}

function deriveKey(password, salt, params = KDF) {
  return crypto.scryptSync(passwordBuffer(password), salt, params.keyLength, {
    N: params.N, r: params.r, p: params.p, maxmem: params.maxmem
  });
}

function encodeEncryptedBuffer(plaintext, password, metadata = {}) {
  const clear = Buffer.from(plaintext);
  if (clear.length > MAX_FILE_BYTES) throw new Error('Backup content exceeds the encrypted backup size limit.');
  inspectZipBuffer(clear);
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const header = {
    format: 'canadapost-claim-runner-encrypted-backup', version: VERSION,
    createdAt: new Date().toISOString(), cipher: 'AES-256-GCM',
    kdf: { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p, keyLength: KDF.keyLength },
    salt: salt.toString('base64'), nonce: nonce.toString('base64'),
    plaintextBytes: clear.length,
    plaintextSha256: crypto.createHash('sha256').update(clear).digest('hex'),
    appVersion: String(metadata.appVersion || '')
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(prefix);
  prefix.writeUInt32BE(headerBytes.length, MAGIC.length);
  const aad = Buffer.concat([prefix, headerBytes]);
  const key = deriveKey(password, salt);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
    return Buffer.concat([aad, ciphertext, cipher.getAuthTag()]);
  } finally {
    key.fill(0);
  }
}

function decodeEncryptedBuffer(input, password) {
  const buffer = Buffer.from(input);
  if (buffer.length > MAX_FILE_BYTES + 65536) throw new Error('Encrypted backup exceeds the size limit.');
  if (buffer.length < MAGIC.length + 4 + TAG_BYTES || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('This is not an encrypted Canada Post Claim Runner backup.');
  }
  const headerLength = buffer.readUInt32BE(MAGIC.length);
  if (headerLength < 64 || headerLength > 32768) throw new Error('Encrypted backup header is invalid.');
  const bodyOffset = MAGIC.length + 4 + headerLength;
  if (bodyOffset + TAG_BYTES > buffer.length) throw new Error('Encrypted backup is truncated.');
  const headerBytes = buffer.subarray(MAGIC.length + 4, bodyOffset);
  let header;
  try { header = JSON.parse(headerBytes.toString('utf8')); } catch (_) { throw new Error('Encrypted backup header is invalid.'); }
  if (header.format !== 'canadapost-claim-runner-encrypted-backup' || header.version !== VERSION || header.cipher !== 'AES-256-GCM') {
    throw new Error('Encrypted backup format or version is not supported.');
  }
  const params = header.kdf || {};
  if (params.name !== 'scrypt' || params.N !== KDF.N || params.r !== KDF.r || params.p !== KDF.p || params.keyLength !== KDF.keyLength) {
    throw new Error('Encrypted backup key-derivation parameters are not supported.');
  }
  const salt = Buffer.from(String(header.salt || ''), 'base64');
  const nonce = Buffer.from(String(header.nonce || ''), 'base64');
  if (salt.length !== 16 || nonce.length !== 12) throw new Error('Encrypted backup cryptographic metadata is invalid.');
  const key = deriveKey(password, salt);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(buffer.subarray(0, bodyOffset));
    decipher.setAuthTag(buffer.subarray(buffer.length - TAG_BYTES));
    let clear;
    try { clear = Buffer.concat([decipher.update(buffer.subarray(bodyOffset, buffer.length - TAG_BYTES)), decipher.final()]); }
    catch (_) { throw new Error('Backup authentication failed. The password may be wrong or the file may be damaged.'); }
    if (clear.length !== Number(header.plaintextBytes) || crypto.createHash('sha256').update(clear).digest('hex') !== header.plaintextSha256) {
      throw new Error('Backup integrity validation failed.');
    }
    inspectZipBuffer(clear);
    return { plaintext: clear, header };
  } finally {
    key.fill(0);
  }
}

function writePrivateAtomic(destination, bytes) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  try { fs.chmodSync(destination, 0o600); } catch (_) {}
}

async function createEncryptedBackup(options) {
  const tempDirectory = path.resolve(options.tempDirectory || os.tmpdir());
  fs.mkdirSync(tempDirectory, { recursive: true, mode: 0o700 });
  const temporary = path.join(tempDirectory, `cpcr-backup-${process.pid}-${Date.now()}.zip`);
  try {
    await archiveTools.createBackup({ ...options, destination: temporary });
    const encrypted = encodeEncryptedBuffer(fs.readFileSync(temporary), options.password, { appVersion: options.appVersion });
    writePrivateAtomic(options.destination, encrypted);
    return options.destination;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function isEncryptedBackup(source) {
  const descriptor = fs.openSync(source, 'r');
  try {
    const first = Buffer.alloc(MAGIC.length);
    return fs.readSync(descriptor, first, 0, first.length, 0) === first.length && first.equals(MAGIC);
  } finally { fs.closeSync(descriptor); }
}

function restoreEncryptedBackup(options) {
  const encrypted = fs.readFileSync(options.source);
  const decoded = decodeEncryptedBuffer(encrypted, options.password);
  const tempDirectory = path.resolve(options.tempDirectory || os.tmpdir());
  fs.mkdirSync(tempDirectory, { recursive: true, mode: 0o700 });
  const temporary = path.join(tempDirectory, `cpcr-restore-${process.pid}-${Date.now()}.zip`);
  try {
    fs.writeFileSync(temporary, decoded.plaintext, { mode: 0o600 });
    const result = archiveTools.restoreBackup({ ...options, source: temporary });
    return { ...result, encrypted: true, encryptionHeader: decoded.header };
  } finally {
    decoded.plaintext.fill(0);
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { MAGIC, VERSION, KDF, encodeEncryptedBuffer, decodeEncryptedBuffer, createEncryptedBackup, restoreEncryptedBackup, isEncryptedBackup };
