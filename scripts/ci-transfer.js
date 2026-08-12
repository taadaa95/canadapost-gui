'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHUNK_BYTES = 49_000_000;

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function readExactly(descriptor, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new Error('Unexpected end of CI transfer source file.');
    offset += bytesRead;
  }
}

function writeAll(descriptor, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(descriptor, buffer, offset, buffer.length - offset);
  }
}

function pack(outputDirectory, files) {
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, '.gitattributes'), '* -text\n');
  const manifest = { format: 'canadapost-claim-runner-ci-transfer', version: 1, files: [] };

  for (const file of files) {
    const basename = path.basename(file);
    const source = fs.openSync(file, 'r');
    const entry = { file: basename, bytes: fs.statSync(file).size, sha256: sha256(file), chunks: [] };
    try {
      let index = 0;
      let offset = 0;
      while (offset < entry.bytes) {
        const length = Math.min(CHUNK_BYTES, entry.bytes - offset);
        const chunk = Buffer.allocUnsafe(length);
        readExactly(source, chunk, offset);
        const chunkName = `${basename}.part${String(index).padStart(3, '0')}`;
        const chunkPath = path.join(outputDirectory, chunkName);
        fs.writeFileSync(chunkPath, chunk);
        entry.chunks.push({ file: chunkName, bytes: length, sha256: sha256(chunkPath) });
        offset += length;
        index += 1;
      }
    } finally {
      fs.closeSync(source);
    }
    manifest.files.push(entry);
  }

  fs.writeFileSync(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function restore(inputDirectory, outputDirectory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(inputDirectory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'canadapost-claim-runner-ci-transfer' || manifest.version !== 1) {
    throw new Error('Unsupported CI transfer manifest.');
  }
  fs.mkdirSync(outputDirectory, { recursive: true });

  for (const entry of manifest.files) {
    const destination = path.join(outputDirectory, entry.file);
    const descriptor = fs.openSync(destination, 'w', 0o600);
    try {
      for (const chunk of entry.chunks) {
        const chunkPath = path.join(inputDirectory, chunk.file);
        if (fs.statSync(chunkPath).size !== chunk.bytes || sha256(chunkPath) !== chunk.sha256) {
          throw new Error(`CI transfer chunk verification failed: ${chunk.file}`);
        }
        writeAll(descriptor, fs.readFileSync(chunkPath));
      }
    } finally {
      fs.closeSync(descriptor);
    }
    if (fs.statSync(destination).size !== entry.bytes || sha256(destination) !== entry.sha256) {
      throw new Error(`Restored CI artifact verification failed: ${entry.file}`);
    }
  }
}

const [operation, directory, ...files] = process.argv.slice(2);
if (operation === 'pack' && directory && files.length > 0) {
  pack(directory, files);
} else if (operation === 'restore' && directory && files.length === 1) {
  restore(directory, files[0]);
} else {
  throw new Error('Usage: ci-transfer.js pack <directory> <file...> | restore <directory> <output-directory>');
}
