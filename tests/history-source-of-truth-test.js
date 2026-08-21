'use strict';

const assert = require('assert');
const fs = require('fs');

const renderer = fs.readFileSync('renderer.js', 'utf8');
const database = fs.readFileSync('lib/claim-database.js', 'utf8');

assert(renderer.includes("const history = await window.cpApp.listHistory({ limit: 500, offset: 0, latestOnly: true });"),
  'History must load one authoritative current-record set');
assert(!renderer.includes('const [history, dashboard] = await Promise.all(['),
  'History cards and rows must not come from separate queries');
assert(renderer.includes('updateHistorySummary(historySummaryFromItems(items));'),
  'History summary must be derived from the exact rows rendered');
assert(database.includes("['unknown', 'in_progress', 'retry_approved'].includes(status)"),
  'Needs attention must be a distinct uncertain/ready-to-retry category');
assert(!database.includes("status === 'failed' && Number(row.attempt_number || 0) >= 3"),
  'Failed claims must never be double-counted as Needs attention');
assert(database.includes('COALESCE(CAST(ca.dry_run AS INTEGER), 0) = 0'),
  'Current History must tolerate legacy null dry_run values');
assert(database.includes('JOIN shipments history_shipments ON history_shipments.id = ca.shipment_id'),
  'History summary must count only displayable claim records');

process.stdout.write('History source-of-truth consistency contracts passed.\\n');
