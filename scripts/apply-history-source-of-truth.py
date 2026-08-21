from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'missing expected block in {path}: {old[:180]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# History categories must be mutually exclusive. Failed is not Needs attention.
replace_once('lib/claim-database.js', """  const needsAttention = !Boolean(row.dry_run)
    && Boolean(row.is_latest_live)
    && (['unknown', 'in_progress'].includes(status)
      || (status === 'failed' && Number(row.attempt_number || 0) >= 3));
""", """  const needsAttention = !Boolean(row.dry_run)
    && Boolean(row.is_latest_live)
    && ['unknown', 'in_progress', 'retry_approved'].includes(status);
""")

# Older databases can contain null/legacy dry_run values. Treat anything that
# casts to 0/null as a live attempt, consistently everywhere History uses it.
text_path = ROOT / 'lib/claim-database.js'
text = text_path.read_text(encoding='utf-8')
text = text.replace('ca.dry_run = 0 AND ca.id = (', 'COALESCE(CAST(ca.dry_run AS INTEGER), 0) = 0 AND ca.id = (')
text = text.replace('latest_ca.shipment_id = ca.shipment_id AND latest_ca.dry_run = 0', 'latest_ca.shipment_id = ca.shipment_id AND COALESCE(CAST(latest_ca.dry_run AS INTEGER), 0) = 0')
text = text.replace('latest.shipment_id = ca.shipment_id AND latest.dry_run = 0', 'latest.shipment_id = ca.shipment_id AND COALESCE(CAST(latest.dry_run AS INTEGER), 0) = 0')
text = text.replace('WHERE ca.dry_run = 0\n          AND ca.id = (', 'JOIN shipments history_shipments ON history_shipments.id = ca.shipment_id\n        WHERE COALESCE(CAST(ca.dry_run AS INTEGER), 0) = 0\n          AND ca.id = (')
text = text.replace("SUM(CASE WHEN status IN ('unknown', 'in_progress') OR (status = 'failed' AND attempt_number >= ?) THEN 1 ELSE 0 END) AS reconciliation,\n        SUM(CASE WHEN status = 'failed' AND attempt_number < ? THEN 1 ELSE 0 END) AS failed", "SUM(CASE WHEN status IN ('unknown', 'in_progress', 'retry_approved') THEN 1 ELSE 0 END) AS reconciliation,\n        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed")
text = text.replace('`).get(Number(maxAttempts || 3), Number(maxAttempts || 3));', '`).get();')
text = text.replace("FROM claim_attempts ca\n      WHERE ca.dry_run = 0\n        AND ca.id = (", "FROM claim_attempts ca\n      JOIN shipments history_shipments ON history_shipments.id = ca.shipment_id\n      WHERE COALESCE(CAST(ca.dry_run AS INTEGER), 0) = 0\n        AND ca.id = (")
text_path.write_text(text, encoding='utf-8')

# History summary cards must come from the exact records rendered in History,
# not a second dashboard query with different semantics.
replace_once('renderer.js', """async function refreshHistory() {
  if (!window.cpApp?.listHistory) return;
  renderHistoryRecordMessage('historyList', tr('history.loading', 'Loading claim history…'), 'loading');
  const [history, dashboard] = await Promise.all([
    window.cpApp.listHistory({ limit: 500, offset: 0, latestOnly: true }),
    window.cpApp.getDashboard()
  ]);
  if (history.ok) {
    renderHistory(history.items || []);
    if (!dashboard.ok) updateHistorySummary(historySummaryFromItems(history.items || []));
  } else {
    setLocalizedText($('historyResultCount'), 'common.unavailable', {}, 'Unavailable');
    renderHistoryRecordMessage('historyList', history.error || tr('history.loadAttemptsFailed', 'Could not load claim attempts.'));
  }
  if (dashboard.ok) updateHistorySummary(dashboard.dashboard || {});
}
""", """async function refreshHistory() {
  if (!window.cpApp?.listHistory) return;
  renderHistoryRecordMessage('historyList', tr('history.loading', 'Loading claim history…'), 'loading');
  const history = await window.cpApp.listHistory({ limit: 500, offset: 0, latestOnly: true });
  if (history.ok) {
    const items = history.items || [];
    renderHistory(items);
    updateHistorySummary(historySummaryFromItems(items));
  } else {
    updateHistorySummary({});
    setLocalizedText($('historyResultCount'), 'common.unavailable', {}, 'Unavailable');
    renderHistoryRecordMessage('historyList', history.error || tr('history.loadAttemptsFailed', 'Could not load claim attempts.'));
  }
}
""")

# Strengthen existing browser History regression: the cards must always equal
# the exact current rows even if a stale dashboard API would claim otherwise.
replace_once('tests/history-refinement-test.js', """      getDashboard: async () => ({ ok: true, dashboard: {
        submitted: window.__historyRecords.filter(item => ['submitted', 'submitted_manual'].includes(item.status)).length,
        reconciliation: window.__historyRecords.filter(item => item.needsAttention === true).length,
        historyRecords: window.__historyRecords.length
      }, integrity: { ok: true } }),
""", """      getDashboard: async () => ({ ok: true, dashboard: {
        submitted: 999,
        reconciliation: 999,
        historyRecords: 999
      }, integrity: { ok: true } }),
""")

# Source contract catches the regression that produced nonzero cards with an
# empty History table and prevents failed claims being double-counted.
contract = ROOT / 'tests/history-source-of-truth-test.js'
contract.write_text(r'''\'use strict\';

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
'''.replace("\\'use strict\\';", "'use strict';"), encoding='utf-8')

# Run the new contract in the normal npm test chain if there is an existing
# History contract anchor.
p = ROOT / 'package.json'
package = p.read_text(encoding='utf-8')
anchor = 'node tests/history-kiss-contract-test.js'
if anchor in package and 'history-source-of-truth-test.js' not in package:
    package = package.replace(anchor, anchor + ' && node tests/history-source-of-truth-test.js', 1)
    p.write_text(package, encoding='utf-8')

print('Applied History single-source-of-truth and legacy-current-row fixes.')
