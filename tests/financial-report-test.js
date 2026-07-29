'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claimDb = require('../lib/claim-database');
const { parseDecimalToMinor, formatMinor } = require('../lib/money');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-financial-test-'));
try {
  const dbPath = path.join(root, 'app.sqlite');
  assert.strictEqual(parseDecimalToMinor('12.34'), 1234);
  assert.strictEqual(parseDecimalToMinor('12'), 1200);
  assert.throws(() => parseDecimalToMinor('1.001'), /decimal places/);
  assert.match(formatMinor(1234, 'CAD', 'en-CA'), /12\.34/);
  claimDb.recordFinancialEntry(dbPath, { trackingNumber: 'SYNTHETIC-MONEY-1', valueType: 'estimated', amountMinor: 1500, currency: 'CAD', source: 'calculated' });
  claimDb.recordFinancialEntry(dbPath, { trackingNumber: 'SYNTHETIC-MONEY-1', valueType: 'claimed', amountMinor: 1200, currency: 'CAD', source: 'claim' });
  claimDb.recordFinancialEntry(dbPath, { trackingNumber: 'SYNTHETIC-MONEY-1', valueType: 'approved', amountMinor: 1000, currency: 'CAD', source: 'canada_post' });
  claimDb.recordFinancialEntry(dbPath, { trackingNumber: 'SYNTHETIC-MONEY-1', valueType: 'received', amountMinor: 1000, currency: 'CAD', source: 'manual' });
  const report = claimDb.financialReport(dbPath);
  assert.strictEqual(report.totalsMinor.estimated, 1500);
  assert.strictEqual(report.pendingMinor, 200);
  assert.strictEqual(report.recoveryRateBasisPoints, 8333);
  assert.throws(() => claimDb.recordFinancialEntry(dbPath, { trackingNumber: 'X', valueType: 'received', amountMinor: 1.5, source: 'manual' }), /integer minor units/);
  process.stdout.write('Financial reporting tests passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
