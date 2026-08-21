from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]

def replace_once(path, old, new):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'missing expected block in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

# ---------------------------------------------------------------------------
# Database: current/latest History state, accurate counts, retry metadata.
# ---------------------------------------------------------------------------
replace_once('lib/claim-database.js', '''function normalizeHistoryRow(row) {
  const status = row.attempt_status || row.current_status || row.classification;
  const needsAttention = !Boolean(row.dry_run)
    && Boolean(row.is_latest_live)
    && (['unknown', 'in_progress'].includes(status)
      || (status === 'failed' && Number(row.attempt_number || 0) >= 3));
  return {
''', '''function normalizeHistoryRow(row) {
  const status = row.attempt_status || row.current_status || row.classification;
  const isLatestLive = !Boolean(row.dry_run) && Boolean(row.is_latest_live);
  const needsAttention = isLatestLive && ['unknown', 'in_progress', 'retry_approved'].includes(status);
  const retryable = isLatestLive && (status === 'failed' || needsAttention);
  let historyCategory = 'other';
  if (['submitted', 'submitted_manual', 'already_submitted'].includes(status)) historyCategory = 'submitted';
  else if (['failed', 'rejected'].includes(status)) historyCategory = 'failed';
  else if (needsAttention) historyCategory = 'needs_attention';
  return {
''')

replace_once('lib/claim-database.js', '''    status,
    needsAttention,
    attemptNumber: row.attempt_number || 0,
''', '''    status,
    needsAttention,
    retryable,
    historyCategory,
    isLatestLive,
    attemptNumber: row.attempt_number || 0,
''')

replace_once('lib/claim-database.js', '''  const status = clean(options.status, 64);
  return withDatabase(dbPath, db => {
    const params = [];
    const where = [];
''', '''  const status = clean(options.status, 64);
  const latestOnly = options.latestOnly === true;
  return withDatabase(dbPath, db => {
    const params = [];
    const where = [];
    if (latestOnly) {
      where.push(`ca.dry_run = 0 AND ca.id = (
        SELECT MAX(latest.id) FROM claim_attempts latest
        WHERE latest.shipment_id = ca.shipment_id AND latest.dry_run = 0
      )`);
    }
''')

replace_once('lib/claim-database.js', '''      SELECT
        SUM(CASE WHEN status IN ('submitted', 'submitted_manual') THEN 1 ELSE 0 END) AS submitted,
        SUM(CASE WHEN status = 'already_submitted' THEN 1 ELSE 0 END) AS duplicates,
        SUM(CASE WHEN status IN ('unknown', 'in_progress') OR (status = 'failed' AND attempt_number >= ?) THEN 1 ELSE 0 END) AS reconciliation,
        SUM(CASE WHEN status = 'failed' AND attempt_number < ? THEN 1 ELSE 0 END) AS failed
      FROM latest_attempts
    `).get(Number(maxAttempts || 3), Number(maxAttempts || 3));
    const dryRuns = Number(db.prepare("SELECT COUNT(*) AS n FROM claim_attempts WHERE dry_run = 1").get().n || 0);
    const historyRecords = Number(db.prepare('SELECT COUNT(*) AS n FROM claim_attempts').get().n || 0);
''', '''      SELECT
        COUNT(*) AS history_records,
        SUM(CASE WHEN status IN ('submitted', 'submitted_manual', 'already_submitted') THEN 1 ELSE 0 END) AS submitted,
        SUM(CASE WHEN status = 'already_submitted' THEN 1 ELSE 0 END) AS duplicates,
        SUM(CASE WHEN status IN ('unknown', 'in_progress', 'retry_approved') THEN 1 ELSE 0 END) AS reconciliation,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM latest_attempts
    `).get();
    const dryRuns = Number(db.prepare("SELECT COUNT(*) AS n FROM claim_attempts WHERE dry_run = 1").get().n || 0);
    const historyRecords = Number(latest.history_records || 0);
''')

# ---------------------------------------------------------------------------
# History UI: one compact status filter.
# ---------------------------------------------------------------------------
replace_once('index.html', '''            <div class="history-section-head"><h3 data-i18n="history.claimAttempts"></h3><span id="historyResultCount" class="pill" role="status" aria-live="polite" data-i18n="history.zeroRecords"></span></div>
''', '''            <div class="history-section-head">
              <h3 data-i18n="history.claimAttempts"></h3>
              <div class="history-toolbar">
                <label class="history-filter-label" for="historyStatusFilter" data-i18n="history.filterStatus"></label>
                <select id="historyStatusFilter" data-i18n-aria-label="history.filterStatus">
                  <option value="all" data-i18n="history.filter.all"></option>
                  <option value="submitted" data-i18n="history.filter.submitted"></option>
                  <option value="needs_attention" data-i18n="history.filter.needsAttention"></option>
                  <option value="failed" data-i18n="history.filter.failed"></option>
                </select>
                <span id="historyResultCount" class="pill" role="status" aria-live="polite" data-i18n="history.zeroRecords"></span>
              </div>
            </div>
''')

# ---------------------------------------------------------------------------
# Renderer: current records, status colors/filter, Retry in Step 2.
# ---------------------------------------------------------------------------
old_render = '''function renderHistory(items = []) {
  const root = $('historyList');
  if (!root) return;
  setHistoryRecordState(root, items.length ? '' : 'empty');
  setLocalizedText($('historyResultCount'), items.length === 1 ? 'history.oneRecord' : 'history.recordCount', { count: items.length }, items.length === 1 ? '1 record' : '{count} records');
  root.replaceChildren();
  const head = document.createElement('div');
  head.className = 'history-row head';
  ['common.tracking', 'history.attemptTime', 'common.status', 'history.confirmation', 'history.message'].forEach(key => head.appendChild(historyCell(tr(key))));
  root.appendChild(head);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = tr('history.noAttempts', 'No claim history records yet.');
    root.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.appendChild(historyCell(item.trackingNumber));
    row.appendChild(historyCell(historyDate(item.attemptedAt)));
    row.appendChild(historyCell(item.needsAttention ? tr('history.needsAttention', 'Needs attention') : localizedInterfaceValue(item.status)));
    row.appendChild(historyCell(item.confirmationNumber));
    const messageCell = document.createElement('div');
    const resultText = document.createElement('span');
    resultText.textContent = item.message || '—';
    messageCell.appendChild(resultText);
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    if (item.screenshotPath || item.textPath) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = tr('history.viewEvidence', 'View evidence');
      button.addEventListener('click', async () => {
        const detail = {
          kind: item.status === 'submitted' ? 'submitted' : (item.status === 'already_submitted' ? 'already' : 'failed'),
          tracking: item.trackingNumber,
          row: item.id,
          result: item.status,
          status: item.status,
          message: item.message,
          screenshotPath: item.screenshotPath,
          textPath: item.textPath,
          source: tr('history.databaseSource', 'History database'),
          createdAt: item.attemptedAt
        };
        const registered = registerDetailItem(detail);
        activateTab('resultsTab');
        openDetail(registered.id);
      });
      actions.appendChild(button);
    }
    if (actions.childElementCount) messageCell.appendChild(actions);
    row.appendChild(messageCell);
    root.appendChild(row);
  }
}

async function refreshHistory() {
  if (!window.cpApp?.listHistory) return;
  renderHistoryRecordMessage('historyList', tr('history.loading', 'Loading claim history…'), 'loading');
  const [history, dashboard] = await Promise.all([
    window.cpApp.listHistory({ limit: 500, offset: 0 }),
    window.cpApp.getDashboard()
  ]);
  if (history.ok) renderHistory(history.items || []);
  else {
    setLocalizedText($('historyResultCount'), 'common.unavailable', {}, 'Unavailable');
    renderHistoryRecordMessage('historyList', history.error || tr('history.loadAttemptsFailed', 'Could not load claim attempts.'));
  }
  if (dashboard.ok) {
    const data = dashboard.dashboard || {};
    setText('historySubmitted', data.submitted || 0);
    setText('historyNeedsAttention', data.reconciliation || 0);
    setText('historyRecordTotal', data.historyRecords || 0);
  }
}
'''

new_render = '''let historyRecords = [];

function historyCategory(item = {}) {
  if (item.historyCategory) return item.historyCategory;
  const status = String(item.status || '').toLowerCase();
  if (['submitted', 'submitted_manual', 'already_submitted'].includes(status)) return 'submitted';
  if (['failed', 'rejected'].includes(status)) return 'failed';
  if (item.needsAttention || ['unknown', 'in_progress', 'retry_approved'].includes(status)) return 'needs_attention';
  return 'other';
}

function historyStatusLabel(item = {}) {
  const status = String(item.status || '').toLowerCase();
  if (status === 'retry_approved') return tr('history.readyToRetry', 'Ready to retry');
  if (historyCategory(item) === 'needs_attention') return tr('history.needsAttention', 'Needs attention');
  return localizedInterfaceValue(item.status);
}

function filteredHistoryRecords() {
  const selected = $('historyStatusFilter')?.value || 'all';
  return selected === 'all' ? historyRecords : historyRecords.filter(item => historyCategory(item) === selected);
}

async function retryHistoryInStep2(item) {
  if (!item?.id || !item?.trackingNumber) return;
  const confirmed = window.confirm(trf('history.retryConfirm', { tracking: item.trackingNumber }, 'Retry {tracking} in Step 2?'));
  if (!confirmed) return;
  const result = await window.cpApp.reconcileAttempt({
    attemptId: item.id,
    action: 'retry',
    note: 'Retry requested from History'
  });
  if (!result?.ok) {
    window.alert(result?.error || tr('history.retryFailed', 'Could not prepare this claim for retry.'));
    await refreshHistory();
    return;
  }

  state.claimQueueLoaded = false;
  await refreshHistory();
  const queue = await refreshClaimQueue();
  if (!queue?.ok) {
    window.alert(queue?.error || tr('history.retryQueueFailed', 'Could not refresh Step 2.'));
    return;
  }
  const candidate = step3QueueController.items().find(entry => entry.trackingNumber === item.trackingNumber);
  if (!candidate) {
    window.alert(tr('history.retryUnavailable', 'This claim is no longer available for submission. Run Step 1 again if its eligibility changed.'));
    return;
  }
  step3QueueController.set(candidate.recordId, true);
  renderClaimQueue(state.claimQueueItems, true);
  activateTab('step3');
}

function renderHistory(items) {
  if (Array.isArray(items)) historyRecords = items;
  const root = $('historyList');
  if (!root) return;
  const visibleItems = filteredHistoryRecords();
  setHistoryRecordState(root, visibleItems.length ? '' : 'empty');
  const selectedFilter = $('historyStatusFilter')?.value || 'all';
  if (selectedFilter === 'all') {
    setLocalizedText($('historyResultCount'), visibleItems.length === 1 ? 'history.oneRecord' : 'history.recordCount', { count: visibleItems.length }, visibleItems.length === 1 ? '1 record' : '{count} records');
  } else {
    setLocalizedText($('historyResultCount'), 'history.filteredRecordCount', { count: visibleItems.length, total: historyRecords.length }, '{count} of {total} records');
  }
  root.replaceChildren();
  const head = document.createElement('div');
  head.className = 'history-row head';
  ['common.tracking', 'history.attemptTime', 'common.status', 'history.confirmation', 'history.message'].forEach(key => head.appendChild(historyCell(tr(key))));
  root.appendChild(head);
  if (!visibleItems.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = tr('history.noMatchingRecords', 'No claim records match this status.');
    root.appendChild(empty);
    return;
  }
  for (const item of visibleItems) {
    const category = historyCategory(item);
    const row = document.createElement('div');
    row.className = `history-row history-status-${category}`;
    row.appendChild(historyCell(item.trackingNumber));
    row.appendChild(historyCell(historyDate(item.attemptedAt)));
    const statusCell = historyCell('', 'history-status-cell');
    const statusPill = document.createElement('span');
    statusPill.className = `pill ${category === 'submitted' ? 'good' : (category === 'failed' ? 'bad' : (category === 'needs_attention' ? 'warn' : ''))}`.trim();
    statusPill.textContent = historyStatusLabel(item);
    statusCell.replaceChildren(statusPill);
    row.appendChild(statusCell);
    row.appendChild(historyCell(item.confirmationNumber));
    const messageCell = document.createElement('div');
    const resultText = document.createElement('span');
    resultText.textContent = item.message || '—';
    messageCell.appendChild(resultText);
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    if (item.retryable === true || item.needsAttention === true || String(item.status || '').toLowerCase() === 'failed') {
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.className = 'warning';
      retryButton.textContent = tr('history.retryStep2', 'Retry in Step 2');
      retryButton.addEventListener('click', () => retryHistoryInStep2(item));
      actions.appendChild(retryButton);
    }
    if (item.screenshotPath || item.textPath) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = tr('history.viewEvidence', 'View evidence');
      button.addEventListener('click', async () => {
        const detail = {
          kind: item.status === 'submitted' ? 'submitted' : (item.status === 'already_submitted' ? 'already' : 'failed'),
          tracking: item.trackingNumber,
          row: item.id,
          result: item.status,
          status: item.status,
          message: item.message,
          screenshotPath: item.screenshotPath,
          textPath: item.textPath,
          source: tr('history.databaseSource', 'History database'),
          createdAt: item.attemptedAt
        };
        const registered = registerDetailItem(detail);
        activateTab('resultsTab');
        openDetail(registered.id);
      });
      actions.appendChild(button);
    }
    if (actions.childElementCount) messageCell.appendChild(actions);
    row.appendChild(messageCell);
    root.appendChild(row);
  }
}

async function refreshHistory() {
  if (!window.cpApp?.listHistory) return;
  renderHistoryRecordMessage('historyList', tr('history.loading', 'Loading claim history…'), 'loading');
  const [history, dashboard] = await Promise.all([
    window.cpApp.listHistory({ limit: 500, offset: 0, latestOnly: true }),
    window.cpApp.getDashboard()
  ]);
  if (history.ok) renderHistory(history.items || []);
  else {
    setLocalizedText($('historyResultCount'), 'common.unavailable', {}, 'Unavailable');
    renderHistoryRecordMessage('historyList', history.error || tr('history.loadAttemptsFailed', 'Could not load claim attempts.'));
  }
  if (dashboard.ok) {
    const data = dashboard.dashboard || {};
    setText('historySubmitted', data.submitted || 0);
    setText('historyNeedsAttention', data.reconciliation || 0);
    setText('historyRecordTotal', data.historyRecords || 0);
  }
}
'''
replace_once('renderer.js', old_render, new_render)

replace_once('renderer.js', '''$('refreshHistory')?.addEventListener('click', () => refreshHistory());
$('exportHistory')?.addEventListener('click', exportClaimHistory);
''', '''$('refreshHistory')?.addEventListener('click', () => refreshHistory());
$('historyStatusFilter')?.addEventListener('change', () => renderHistory());
$('exportHistory')?.addEventListener('click', exportClaimHistory);
''')

replace_once('renderer.js', '''      stopOperationsTimer();
      refreshHistory().catch(() => {});
      return summary;
''', '''      stopOperationsTimer();
      state.claimQueueLoaded = false;
      refreshHistory().catch(() => {});
      return summary;
''')

# ---------------------------------------------------------------------------
# CSS: compact filter and clear row colors.
# ---------------------------------------------------------------------------
replace_once('renderer/base.css', '''.history-section-head h3 {
  margin: 0;
  font-size: 15px;
  text-transform: uppercase;
  letter-spacing: .04em;
}

.history-list {
''', '''.history-section-head h3 {
  margin: 0;
  font-size: 15px;
  text-transform: uppercase;
  letter-spacing: .04em;
}

.history-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.history-filter-label {
  margin: 0;
  font-size: 12px;
}

#historyStatusFilter {
  width: auto;
  min-width: 170px;
  height: 34px;
  padding: 4px 7px;
  font-size: 13px;
}

.history-list {
''')

replace_once('renderer/base.css', '''.history-row:last-child { border-bottom: 0; }

.history-actions {
''', '''.history-row:last-child { border-bottom: 0; }

.history-row.history-status-submitted {
  border-left: 3px solid var(--success);
  background: var(--success-soft);
}

.history-row.history-status-needs_attention {
  border-left: 3px solid var(--warning);
  background: var(--warning-soft);
}

.history-row.history-status-failed {
  border-left: 3px solid var(--danger);
  background: var(--danger-soft);
}

.history-status-cell .pill { justify-self: start; }

.history-actions {
''')

# ---------------------------------------------------------------------------
# Localization.
# ---------------------------------------------------------------------------
locale_values = {
    'en-CA.json': {
        'history.filterStatus': 'Status',
        'history.filter.all': 'All',
        'history.filter.submitted': 'Submitted',
        'history.filter.needsAttention': 'Needs attention',
        'history.filter.failed': 'Failed',
        'history.retryStep2': 'Retry in Step 2',
        'history.retryConfirm': 'Retry {tracking} in Step 2?',
        'history.retryFailed': 'Could not prepare this claim for retry.',
        'history.retryQueueFailed': 'Could not refresh Step 2.',
        'history.retryUnavailable': 'This claim is no longer available for submission. Run Step 1 again if its eligibility changed.',
        'history.readyToRetry': 'Ready to retry',
        'history.filteredRecordCount': '{count} of {total} records',
        'history.noMatchingRecords': 'No claim records match this status.'
    },
    'fr-CA.json': {
        'history.filterStatus': 'Statut',
        'history.filter.all': 'Tous',
        'history.filter.submitted': 'Soumis',
        'history.filter.needsAttention': 'À vérifier',
        'history.filter.failed': 'Échec',
        'history.retryStep2': 'Réessayer à l’étape 2',
        'history.retryConfirm': 'Réessayer {tracking} à l’étape 2?',
        'history.retryFailed': 'Impossible de préparer cette réclamation pour une nouvelle tentative.',
        'history.retryQueueFailed': 'Impossible d’actualiser l’étape 2.',
        'history.retryUnavailable': 'Cette réclamation n’est plus disponible pour soumission. Relancez l’étape 1 si son admissibilité a changé.',
        'history.readyToRetry': 'Prêt à réessayer',
        'history.filteredRecordCount': '{count} sur {total} dossiers',
        'history.noMatchingRecords': 'Aucun dossier de réclamation ne correspond à ce statut.'
    }
}
for filename, additions in locale_values.items():
    p = ROOT / 'locales' / filename
    data = json.loads(p.read_text(encoding='utf-8'))
    data.update(additions)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

# ---------------------------------------------------------------------------
# Existing History UI regression: filter is now intentional and retry is the
# only mutation action exposed in History.
# ---------------------------------------------------------------------------
replace_once('tests/history-refinement-test.js', "    assert.strictEqual(await page.locator('#historyStatusFilter').count(), 0);\n", "    assert.strictEqual(await page.locator('#historyStatusFilter').count(), 1);\n    assert.deepStrictEqual(await page.locator('#historyStatusFilter option').allTextContents(), ['All', 'Submitted', 'Needs attention', 'Failed']);\n")
replace_once('tests/history-refinement-test.js', "    assert.strictEqual(await attentionRow.getByRole('button', { name: 'Approve retry' }).count(), 0);\n", "    assert.strictEqual(await attentionRow.getByRole('button', { name: 'Approve retry' }).count(), 0);\n    assert.strictEqual(await attentionRow.getByRole('button', { name: 'Retry in Step 2' }).count(), 1);\n")
replace_once('tests/history-refinement-test.js', "      'ordinary History rows must not expose reconciliation actions');\n", "      'ordinary submitted History rows must not expose retry actions');\n")

# Make the synthetic records expose the same current-state metadata as the DB.
replace_once('tests/history-refinement-test.js', "      needsAttention: index === 0,\n", "      needsAttention: index === 0,\n      retryable: index === 0 || (index % 3 === 0),\n      historyCategory: index === 0 ? 'needs_attention' : (index % 3 === 0 ? 'failed' : 'submitted'),\n")

# Add a small filter/color assertion without changing the existing 500-record layout coverage.
replace_once('tests/history-refinement-test.js', "    assert.deepStrictEqual(await page.evaluate(() => window.__mutationCalls), [],\n      'History rendering must not invoke reconciliation mutation IPC');\n", "    assert.deepStrictEqual(await page.evaluate(() => window.__mutationCalls), [],\n      'History rendering must not invoke reconciliation mutation IPC');\n    await page.locator('#historyStatusFilter').selectOption('failed');\n    assert((await page.locator('#historyList .history-row.history-status-failed').count()) > 0, 'Failed filter did not show failed rows');\n    assert.strictEqual(await page.locator('#historyList .history-row.history-status-submitted').count(), 0, 'Failed filter leaked submitted rows');\n    await page.locator('#historyStatusFilter').selectOption('all');\n")

# ---------------------------------------------------------------------------
# Backend regression: latest-only records, accurate counters, retry state, and
# successful retry replacing the visible current state while old attempts stay
# in the database.
# ---------------------------------------------------------------------------
backend_test = r'''\'use strict\';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../lib/claim-database');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-history-status-'));
  const dbPath = path.join(root, 'app.sqlite');
  try {
    await db.initializeDatabase(dbPath, { backupDirectory: path.join(root, 'backups') });

    const submitted = db.beginClaimAttempt(dbPath, { trackingNumber: 'SUBMITTED-1' });
    db.completeClaimAttempt(dbPath, submitted, { status: 'submitted', confirmationNumber: 'CONF-1' });

    const already = db.beginClaimAttempt(dbPath, { trackingNumber: 'ALREADY-1' });
    db.completeClaimAttempt(dbPath, already, { status: 'already_submitted' });

    const failed = db.beginClaimAttempt(dbPath, { trackingNumber: 'FAILED-1' });
    db.completeClaimAttempt(dbPath, failed, { status: 'failed', message: 'Synthetic failure' });

    const attention = db.beginClaimAttempt(dbPath, { trackingNumber: 'ATTENTION-1' });
    db.markInterruptedAttempts(dbPath);

    let history = db.listClaimHistory(dbPath, { limit: 100, latestOnly: true });
    assert.strictEqual(history.length, 4, 'latest-only History must contain one current record per shipment');
    const failedRow = history.find(item => item.trackingNumber === 'FAILED-1');
    const attentionRow = history.find(item => item.trackingNumber === 'ATTENTION-1');
    assert.strictEqual(failedRow.historyCategory, 'failed');
    assert.strictEqual(failedRow.retryable, true);
    assert.strictEqual(attentionRow.historyCategory, 'needs_attention');
    assert.strictEqual(attentionRow.needsAttention, true);
    assert.strictEqual(attentionRow.retryable, true);

    let dashboard = db.dashboard(dbPath);
    assert.strictEqual(dashboard.submitted, 2, 'Submitted count must include an already-submitted current claim');
    assert.strictEqual(dashboard.reconciliation, 1, 'Needs-attention count must include current uncertain outcomes only');
    assert.strictEqual(dashboard.failed, 1, 'Failed count must be based on the current attempt only');
    assert.strictEqual(dashboard.historyRecords, 4, 'Total records must mean current claim records, not every historical attempt');

    db.reconcileAttempt(dbPath, attentionRow.id, 'retry', 'Retry requested from History');
    assert.strictEqual(db.canAutomaticallyAttempt(dbPath, 'ATTENTION-1').allowed, true, 'History retry approval must unlock Step 2');
    history = db.listClaimHistory(dbPath, { limit: 100, latestOnly: true });
    const retryReady = history.find(item => item.trackingNumber === 'ATTENTION-1');
    assert.strictEqual(retryReady.status, 'retry_approved');
    assert.strictEqual(retryReady.historyCategory, 'needs_attention');

    const retryAttempt = db.beginClaimAttempt(dbPath, { trackingNumber: 'ATTENTION-1' });
    db.completeClaimAttempt(dbPath, retryAttempt, { status: 'submitted', confirmationNumber: 'CONF-RETRY' });

    history = db.listClaimHistory(dbPath, { limit: 100, latestOnly: true });
    const completedRetry = history.find(item => item.trackingNumber === 'ATTENTION-1');
    assert.strictEqual(completedRetry.status, 'submitted');
    assert.strictEqual(completedRetry.historyCategory, 'submitted');
    assert.strictEqual(history.length, 4, 'Successful retry must replace the visible current state, not add a second current row');

    const fullAudit = db.listClaimHistory(dbPath, { limit: 100, latestOnly: false });
    assert(fullAudit.length > history.length, 'Old attempts must remain preserved in the audit history');

    dashboard = db.dashboard(dbPath);
    assert.strictEqual(dashboard.submitted, 3);
    assert.strictEqual(dashboard.reconciliation, 0);
    assert.strictEqual(dashboard.historyRecords, 4);

    process.stdout.write('KISS History current-state, counters and retry regression tests passed.\\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
'''
(ROOT / 'tests/history-status-model-test.js').write_text(backend_test, encoding='utf-8')

# Keep the regression in the normal suite.
replace_once('package.json', 'node tests/history-refinement-test.js && node tests/github-release-updater-test.js', 'node tests/history-refinement-test.js && node tests/history-status-model-test.js && node tests/github-release-updater-test.js')

print('Applied KISS History retry/filter/current-state changes.')
