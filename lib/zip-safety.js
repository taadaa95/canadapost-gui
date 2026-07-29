'use strict';

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 2000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxUncompressedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 200
});

function safeArchivePath(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) return false;
  return normalized.split('/').every(part => part && part !== '.' && part !== '..');
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('Backup ZIP directory is missing or malformed.');
}

function inspectZipBuffer(input, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const buffer = Buffer.from(input);
  if (buffer.length > limits.maxArchiveBytes) throw new Error('Backup archive exceeds the compressed size limit.');
  if (buffer.length < 22) throw new Error('Backup ZIP is too small.');
  const end = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (entryCount > limits.maxEntries) throw new Error('Backup archive contains too many entries.');
  let offset = centralOffset;
  let totalUncompressed = 0;
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Backup ZIP central directory is invalid.');
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > buffer.length) throw new Error('Backup ZIP entry name is truncated.');
    const name = buffer.subarray(offset + 46, nameEnd).toString('utf8');
    if (!safeArchivePath(name)) throw new Error('Backup archive contains an unsafe entry path.');
    if (uncompressedSize > limits.maxEntryBytes) throw new Error('A backup entry exceeds the per-entry size limit.');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxUncompressedBytes) throw new Error('Backup archive exceeds the uncompressed size limit.');
    if (uncompressedSize > 1024 && uncompressedSize / Math.max(1, compressedSize) > limits.maxCompressionRatio) {
      throw new Error('Backup archive contains an unsafe compression ratio.');
    }
    entries.push({ name, compressedSize, uncompressedSize });
    offset = nameEnd + extraLength + commentLength;
  }
  return { entryCount, compressedBytes: buffer.length, uncompressedBytes: totalUncompressed, entries };
}

module.exports = { DEFAULT_LIMITS, safeArchivePath, inspectZipBuffer };
