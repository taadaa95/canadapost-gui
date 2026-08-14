'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { previewClaims, writeSelectedClaimsCsv, readClaimsCsv } = require('../lib/claim-queue');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-claim-queue-'));
const source = path.join(root, 'claims.csv');
const selected = path.join(root, 'selected.csv');
fs.writeFileSync(source, [
  'Tracking PIN,Reference #,Destination Postal Code,Service Code,Expected Delivery Date,Actual Delivery Date',
  '1111111111111111,"Order, One",H0H0H0,DOM.XP,2026-01-01,2026-01-02',
  '2222222222222222,Order Two,H1H1H1,DOM.PC,2026-01-03,2026-01-04'
].join('\n') + '\n');

const preview = previewClaims(source);
assert.strictEqual(preview.count, 2);
assert.strictEqual(preview.items[0].referenceNumber, 'Order, One');

const result = writeSelectedClaimsCsv(source, selected, ['2222222222222222']);
assert.strictEqual(result.count, 1);
const parsed = readClaimsCsv(selected);
assert.strictEqual(parsed.rows.length, 1);
assert.strictEqual(parsed.rows[0]['Tracking PIN'], '2222222222222222');

assert.throws(() => writeSelectedClaimsCsv(source, selected, ['999']), /No selected claims matched/);
fs.rmSync(root, { recursive: true, force: true });
console.log('Claim queue tests passed.');
