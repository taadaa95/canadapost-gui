'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rollingShipmentHistoryRange, shipmentHistoryRangeForRun } = require('../lib/shipment-history-range');
const { splitDateRange, dateSpanDays } = require('../lib/est-order-ranges');

assert.deepStrictEqual({ ...rollingShipmentHistoryRange(new Date('2026-08-13T16:00:00Z')) }, {
  from: '2026-07-10', to: '2026-08-13', inclusiveDays: 35
});
assert.deepStrictEqual({ ...rollingShipmentHistoryRange(new Date('2026-01-02T16:00:00Z')) }, {
  from: '2025-11-29', to: '2026-01-02', inclusiveDays: 35
});
assert.deepStrictEqual({ ...rollingShipmentHistoryRange(new Date('2024-03-01T16:00:00Z')) }, {
  from: '2024-01-27', to: '2024-03-01', inclusiveDays: 35
});
assert.strictEqual(dateSpanDays('2026-07-10', '2026-08-13'), 35);
assert.deepStrictEqual(splitDateRange('2026-07-10', '2026-08-13'), [
  { from: '2026-07-10', to: '2026-08-08' },
  { from: '2026-08-09', to: '2026-08-13' }
]);

const production = shipmentHistoryRangeForRun({
  now: new Date('2026-08-13T16:00:00Z'),
  testMode: false,
  override: { from: '2000-01-01', to: '2000-01-02' }
});
assert.strictEqual(production.from, '2026-07-10', 'production must ignore renderer-supplied dates');
const synthetic = shipmentHistoryRangeForRun({
  now: new Date('2026-08-13T16:00:00Z'),
  testMode: true,
  override: { from: '2026-05-01', to: '2026-05-03' }
});
assert.deepStrictEqual({ ...synthetic }, { from: '2026-05-01', to: '2026-05-03', inclusiveDays: null, testOverride: true });

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
assert.doesNotMatch(html, /id="(?:estFrom|estTo|historyFrom|historyTo)"/, 'Step 1 must expose no date controls');
const optionsSource = /function buildEstHistoryOptions\(\)[\s\S]*?\n\}/.exec(renderer)?.[0] || '';
assert.doesNotMatch(optionsSource, /estFrom|estTo|historyFrom|historyTo/, 'the production renderer must not submit a date range');

const first = rollingShipmentHistoryRange(new Date('2026-08-13T16:00:00Z'));
const second = rollingShipmentHistoryRange(new Date('2026-08-14T16:00:00Z'));
assert.notDeepStrictEqual(first, second, 'the range must be calculated at run time rather than startup');

process.stdout.write('Rolling 35-day Shipment History range and Step 1 UI contracts passed.\n');
