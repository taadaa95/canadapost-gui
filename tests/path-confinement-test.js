'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inside, resolveOwnedRegularFile } = require('../lib/path-confinement');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-path-confinement-'));
const owned = path.join(fixture, 'owned');
const outside = path.join(fixture, 'outside.txt');
fs.mkdirSync(path.join(owned, 'nested'), { recursive: true });
fs.writeFileSync(outside, 'outside secret');
fs.writeFileSync(path.join(owned, 'nested', 'evidence.txt'), 'synthetic evidence');

try {
  const accepted = resolveOwnedRegularFile(path.join(owned, 'nested', 'evidence.txt'), [owned]);
  assert(accepted);
  assert.strictEqual(accepted.size, Buffer.byteLength('synthetic evidence'));
  assert.strictEqual(resolveOwnedRegularFile(path.join(owned, '..', 'outside.txt'), [owned]), null);
  assert.strictEqual(resolveOwnedRegularFile(owned, [owned]), null, 'directories must not be opened as evidence');

  fs.symlinkSync(outside, path.join(owned, 'linked-file'));
  assert.strictEqual(resolveOwnedRegularFile(path.join(owned, 'linked-file'), [owned]), null, 'file symlinks must not escape an owned root');
  fs.symlinkSync(path.dirname(outside), path.join(owned, 'linked-dir'), 'dir');
  assert.strictEqual(resolveOwnedRegularFile(path.join(owned, 'linked-dir', path.basename(outside)), [owned]), null, 'directory symlinks must not escape an owned root');

  assert.strictEqual(inside('C:\\App\\data', 'C:\\App\\data\\safe.txt', path.win32), true);
  assert.strictEqual(inside('C:\\App\\data', 'C:\\App\\data-escape\\secret.txt', path.win32), false);
  assert.strictEqual(inside('C:\\App\\data', 'C:\\App\\data\\..\\secret.txt', path.win32), false);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

process.stdout.write('Owned-file path confinement tests passed.\n');
