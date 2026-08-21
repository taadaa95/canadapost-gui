'use strict';

const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const renderer = fs.readFileSync('renderer.js', 'utf8');
const database = fs.readFileSync('lib/claim-database.js', 'utf8');
const css = fs.readFileSync('renderer/base.css', 'utf8');

assert(html.includes('id="historyStatusFilter"'), 'History must have one simple status filter');
assert(renderer.includes("listHistory({ limit: 500, offset: 0, latestOnly: true })"), 'History must request current/latest claim states');
assert(database.includes('const latestOnly = options.latestOnly === true;'), 'database must support latest-only History rows');
assert(database.includes('latest_ca.shipment_id = ca.shipment_id AND latest_ca.dry_run = 0'), 'latest-only History must be per shipment and exclude dry runs');
assert(renderer.includes("action: 'retry'"), 'History retry must use the existing explicit retry approval path');
assert(renderer.includes("activateTab('step3')"), 'History retry must route to customer-facing Step 2');
assert(renderer.includes("tr('history.retryStep2', 'Retry in Step 2')"), 'retry action must be simple and explicit');
assert(css.includes('.history-row.history-status-submitted'));
assert(css.includes('.history-row.history-status-attention'));
assert(css.includes('.history-row.history-status-failed'));
assert(!renderer.includes("button.textContent = tr('history.markSubmitted'"), 'old manual reconciliation controls must stay removed');

process.stdout.write('KISS History source-of-truth, filter, retry and color contracts passed.\\n');
