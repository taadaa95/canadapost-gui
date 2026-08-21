from pathlib import Path
import json
import re


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'missing expected block in {path}: {old[:80]!r}')
    text = text.replace(old, new, 1)
    p.write_text(text, encoding='utf-8')


# History UI: one simple status filter.
replace_once(
    'index.html',
    '''        <div class="history-content">\n          <div class="history-section">''',
    '''        <div class="history-filter-row">\n          <label for="historyStatusFilter" data-i18n="history.filter.label"></label>\n          <select id="historyStatusFilter">\n            <option value="all" data-i18n="history.filter.all"></option>\n            <option value="submitted" data-i18n="history.filter.submitted"></option>\n            <option value="needs_attention" data-i18n="history.filter.needsAttention"></option>\n            <option value="failed" data-i18n="history.filter.failed"></option>\n            <option value="already_submitted" data-i18n="history.filter.alreadySubmitted"></option>\n            <option value="rejected" data-i18n="history.filter.rejected"></option>\n          </select>\n        </div>\n\n        <div class="history-content">\n          <div class="history-section">'''
)

# Database: visible History can ask for only the latest live attempt for each shipment.
replace_once(
    'lib/claim-database.js',
    '''  const search = clean(options.search, 256);\n  const status = clean(options.status, 64);\n  return withDatabase(dbPath, db => {''',
    '''  const search = clean(options.search, 256);\n  const status = clean(options.status, 64);\n  const latestOnly = options.latestOnly === true;\n  return withDatabase(dbPath, db => {'''
)
replace_once(
    'lib/claim-database.js',
    '''    if (status && status !== 'all') {\n      where.push('ca.status = ?');\n      params.push(status);\n    }\n    const rows = db.prepare(`''',
    '''    if (status && status !== 'all') {\n      where.push('ca.status = ?');\n      params.push(status);\n    }\n    if (latestOnly) {\n      where.push(`ca.dry_run = 0 AND ca.id = (\n        SELECT MAX(latest_ca.id) FROM claim_attempts latest_ca\n        WHERE latest_ca.shipment_id = ca.shipment_id AND latest_ca.dry_run = 0\n      )`);\n    }\n    const rows = db.prepare(`'''
)
replace_once(
    'lib/claim-database.js',
    '''    const historyRecords = Number(db.prepare('SELECT COUNT(*) AS n FROM claim_attempts').get().n || 0);''',
    '''    const historyRecords = Number(db.prepare(`\n      SELECT COUNT(*) AS n\n      FROM claim_attempts ca\n      WHERE ca.dry_run = 0\n        AND ca.id = (\n          SELECT MAX(latest_ca.id) FROM claim_attempts latest_ca\n          WHERE latest_ca.shipment_id = ca.shipment_id AND latest_ca.dry_run = 0\n        )\n    `).get().n || 0);'''
)

# Renderer: replace the History presentation with latest-state rows, filtering,
# color classes, and the existing explicit retry approval routed to Step 2.
p = Path('renderer.js')
text = p.read_text(encoding='utf-8')
pattern = re.compile(r"function historyDate\(value\) \{.*?\nasync function exportClaimHistory\(\) \{", re.S)
replacement = r'''let historyItems = [];

function historyDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function historyCell(text, className = '') {
  const cell = document.createElement('div');
  cell.className = className;
  cell.textContent = text === undefined || text === null || text === '' ? '—' : String(text);
  return cell;
}

function historyStatus(item = {}) {
  return String(item.status || '').toLowerCase();
}

function historyMatchesFilter(item, filter) {
  const status = historyStatus(item);
  if (!filter || filter === 'all') return true;
  if (filter === 'submitted') return ['submitted', 'submitted_manual'].includes(status);
  if (filter === 'needs_attention') return item.needsAttention === true;
  if (filter === 'failed') return status === 'failed';
  return status === filter;
}

function historyRowClasses(item = {}) {
  const classes = ['history-row'];
  const status = historyStatus(item);
  if (['submitted', 'submitted_manual'].includes(status)) classes.push('history-status-submitted');
  if (status === 'already_submitted') classes.push('history-status-already');
  if (status === 'failed' || status === 'rejected') classes.push('history-status-failed');
  if (item.needsAttention === true) classes.push('history-status-attention');
  return classes.join(' ');
}

function historyCanRetry(item = {}) {
  const status = historyStatus(item);
  return item.needsAttention === true || status === 'failed';
}

function updateHistorySummary(data = {}) {
  setText('historySubmitted', data.submitted || 0);
  setText('historyNeedsAttention', data.reconciliation || 0);
  setText('historyRecordTotal', data.historyRecords || 0);
}

function historySummaryFromItems(items = []) {
  return {
    submitted: items.filter(item => ['submitted', 'submitted_manual'].includes(historyStatus(item))).length,
    reconciliation: items.filter(item => item.needsAttention === true).length,
    historyRecords: items.length
  };
}

function setHistoryRecordState(root, state) {
  if (!root) return;
  root.classList.remove('is-empty', 'is-loading', 'is-error');
  if (state) root.classList.add(`is-${state}`);
  root.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
}

function renderHistoryRecordMessage(rootId, message, state = 'error') {
  const root = $(rootId);
  if (!root) return;
  setHistoryRecordState(root, state);
  root.replaceChildren();
  const notice = document.createElement('div');
  notice.className = 'history-empty';
  notice.textContent = message;
  root.appendChild(notice);
}

async function retryHistoryItemInStep2(item) {
  if (!historyCanRetry(item)) return;
  const status = historyStatus(item);
  if (item.needsAttention === true && ['unknown', 'in_progress'].includes(status)) {
    const confirmed = window.confirm(tr('history.retryConfirm', 'Retry this claim in Step 2? Only continue if the previous attempt did not submit successfully.'));
    if (!confirmed) return;
  }

  const result = await window.cpApp.reconcileAttempt({
    attemptId: item.id,
    action: 'retry',
    note: 'Retry requested from History'
  });
  if (!result?.ok) {
    window.alert(result?.error || tr('history.retryFailed', 'Could not prepare this claim for Step 2.'));
    return;
  }

  state.claimQueueLoaded = false;
  const queue = await refreshClaimQueue();
  if (!queue?.ok) {
    await refreshHistory();
    window.alert(queue?.error || tr('history.retryQueueFailed', 'The Step 2 queue could not be refreshed.'));
    return;
  }

  const candidate = state.claimQueueItems.find(candidateItem => (
    String(candidateItem.trackingNumber || '') === String(item.trackingNumber || '')
  ));
  if (!candidate) {
    await refreshHistory();
    window.alert(tr('history.retryUnavailable', 'This claim is not currently available in Step 2. Run Step 1 again, then retry.'));
    return;
  }

  step3QueueController.set(candidate.recordId, true);
  renderClaimQueue(state.claimQueueItems, true);
  await refreshHistory();
  activateTab('step3');
}

function renderHistory(items = []) {
  const root = $('historyList');
  if (!root) return;
  historyItems = Array.isArray(items) ? items.slice() : [];
  const filter = $('historyStatusFilter')?.value || 'all';
  const visibleItems = historyItems.filter(item => historyMatchesFilter(item, filter));
  setHistoryRecordState(root, visibleItems.length ? '' : 'empty');
  setLocalizedText($('historyResultCount'), visibleItems.length === 1 ? 'history.oneRecord' : 'history.recordCount', { count: visibleItems.length }, visibleItems.length === 1 ? '1 record' : '{count} records');
  root.replaceChildren();
  const head = document.createElement('div');
  head.className = 'history-row head';
  ['common.tracking', 'history.attemptTime', 'common.status', 'history.confirmation', 'history.message'].forEach(key => head.appendChild(historyCell(tr(key))));
  root.appendChild(head);
  if (!visibleItems.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = historyItems.length
      ? tr('history.noMatchingAttempts', 'No claim history records match this status.')
      : tr('history.noAttempts', 'No claim history records yet.');
    root.appendChild(empty);
    return;
  }
  for (const item of visibleItems) {
    const row = document.createElement('div');
    row.className = historyRowClasses(item);
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
    if (historyCanRetry(item)) {
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.className = item.needsAttention ? 'warning' : 'secondary';
      retryButton.textContent = tr('history.retryStep2', 'Retry in Step 2');
      retryButton.addEventListener('click', () => retryHistoryItemInStep2(item));
      actions.appendChild(retryButton);
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
  if (history.ok) {
    renderHistory(history.items || []);
    if (!dashboard.ok) updateHistorySummary(historySummaryFromItems(history.items || []));
  } else {
    setLocalizedText($('historyResultCount'), 'common.unavailable', {}, 'Unavailable');
    renderHistoryRecordMessage('historyList', history.error || tr('history.loadAttemptsFailed', 'Could not load claim attempts.'));
  }
  if (dashboard.ok) updateHistorySummary(dashboard.dashboard || {});
}

async function exportClaimHistory() {'''
text2, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit(f'failed to replace renderer History block; replacements={count}')
text = text2
text = text.replace(
    "    retry_approved: 'history.status.retryApproved', dry_run_ready: 'history.status.dryRunReady', dry_run_interrupted: 'history.status.dryRunInterrupted'",
    "    retry_approved: 'history.status.retryApproved', rejected: 'outcome.rejected', dry_run_ready: 'history.status.dryRunReady', dry_run_interrupted: 'history.status.dryRunInterrupted'",
    1
)
text = text.replace(
    "$('refreshHistory')?.addEventListener('click', () => refreshHistory());\n$('exportHistory')?.addEventListener('click', exportClaimHistory);",
    "$('refreshHistory')?.addEventListener('click', () => refreshHistory());\n$('historyStatusFilter')?.addEventListener('change', () => renderHistory(historyItems));\n$('exportHistory')?.addEventListener('click', exportClaimHistory);",
    1
)
p.write_text(text, encoding='utf-8')

# Status colors use existing theme variables.
css = Path('renderer/base.css')
css_text = css.read_text(encoding='utf-8')
marker = '\n/* KISS History status states */\n'
if marker not in css_text:
    css_text += r'''

/* KISS History status states */
.history-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}

.history-filter-row label {
  margin: 0;
  flex: 0 0 auto;
}

#historyStatusFilter {
  width: auto;
  min-width: 220px;
  height: 36px;
}

.history-row.history-status-submitted {
  background: var(--success-soft);
  border-left: 4px solid var(--success);
}

.history-row.history-status-already {
  background: var(--accent-soft);
  border-left: 4px solid var(--info);
}

.history-row.history-status-failed {
  background: var(--danger-soft);
  border-left: 4px solid var(--danger);
}

.history-row.history-status-attention {
  background: var(--warning-soft);
  border-left: 4px solid var(--warning);
}
'''
css.write_text(css_text, encoding='utf-8')

# Localization.
translations = {
    'locales/en-CA.json': {
        'history.filter.label': 'Status',
        'history.filter.all': 'All',
        'history.filter.submitted': 'Submitted',
        'history.filter.needsAttention': 'Needs attention',
        'history.filter.failed': 'Failed',
        'history.filter.alreadySubmitted': 'Already submitted',
        'history.filter.rejected': 'Rejected',
        'history.retryStep2': 'Retry in Step 2',
        'history.retryConfirm': 'Retry this claim in Step 2? Only continue if the previous attempt did not submit successfully.',
        'history.retryFailed': 'Could not prepare this claim for Step 2.',
        'history.retryQueueFailed': 'The Step 2 queue could not be refreshed.',
        'history.retryUnavailable': 'This claim is not currently available in Step 2. Run Step 1 again, then retry.',
        'history.noMatchingAttempts': 'No claim history records match this status.'
    },
    'locales/fr-CA.json': {
        'history.filter.label': 'Statut',
        'history.filter.all': 'Tous',
        'history.filter.submitted': 'Soumises',
        'history.filter.needsAttention': 'Attention requise',
        'history.filter.failed': 'Échouées',
        'history.filter.alreadySubmitted': 'Déjà soumises',
        'history.filter.rejected': 'Rejetées',
        'history.retryStep2': 'Réessayer à l’étape 2',
        'history.retryConfirm': 'Réessayer cette réclamation à l’étape 2? Continuez seulement si la tentative précédente n’a pas été soumise avec succès.',
        'history.retryFailed': 'Impossible de préparer cette réclamation pour l’étape 2.',
        'history.retryQueueFailed': 'Impossible d’actualiser la file de l’étape 2.',
        'history.retryUnavailable': 'Cette réclamation n’est pas disponible à l’étape 2. Exécutez de nouveau l’étape 1, puis réessayez.',
        'history.noMatchingAttempts': 'Aucun élément de l’historique ne correspond à ce statut.'
    }
}
for filename, values in translations.items():
    fp = Path(filename)
    data = json.loads(fp.read_text(encoding='utf-8'))
    data.update(values)
    fp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

# Update the existing browser-level History regression test for the new KISS UI.
test = Path('tests/history-refinement-test.js')
t = test.read_text(encoding='utf-8')
t = t.replace("    window.prompt = () => '';", "    window.prompt = () => '';\n    window.confirm = () => true;\n    window.alert = message => { window.__lastAlert = String(message || ''); };", 1)
t = t.replace(
    "      getDashboard: async () => ({ ok: true, dashboard: { submitted: 333, reconciliation: 1, historyRecords: 500 }, integrity: { ok: true } }),",
    "      getDashboard: async () => ({ ok: true, dashboard: {\n        submitted: window.__historyRecords.filter(item => ['submitted', 'submitted_manual'].includes(item.status)).length,\n        reconciliation: window.__historyRecords.filter(item => item.needsAttention === true).length,\n        historyRecords: window.__historyRecords.length\n      }, integrity: { ok: true } }),",
    1
)
t = t.replace(
    "      reconcileAttempt: async value => { window.__mutationCalls.push(['reconcileAttempt', value]); return { ok: true }; }",
    "      reconcileAttempt: async value => {\n        window.__mutationCalls.push(['reconcileAttempt', value]);\n        const item = window.__historyRecords.find(record => Number(record.id) === Number(value.attemptId));\n        if (item && value.action === 'retry') { item.status = 'retry_approved'; item.needsAttention = false; }\n        return { ok: true };\n      },\n      previewClaims: async () => ({ ok: true, items: [{\n        recordId: 9001, evidenceHash: 'a'.repeat(64), trackingNumber: 'HISTORY000000000000',\n        referenceNumber: 'REFERENCE-0', serviceCode: 'EXP', executionState: 'executable', executable: true\n      }] })"
    , 1
)
t = t.replace("    assert.strictEqual(await page.locator('#historyStatusFilter').count(), 0);", "    assert.strictEqual(await page.locator('#historyStatusFilter').count(), 1);", 1)
t = t.replace(
    "    assert.strictEqual(await attentionRow.getByRole('button', { name: 'Approve retry' }).count(), 0);",
    "    assert.strictEqual(await attentionRow.getByRole('button', { name: 'Approve retry' }).count(), 0);\n    assert.strictEqual(await attentionRow.getByRole('button', { name: 'Retry in Step 2' }).count(), 1);",
    1
)
t = t.replace(
    "    const ordinaryRow = page.locator('#historyList .history-row:not(.head)').nth(1);\n    assert.strictEqual(await ordinaryRow.locator('.history-actions button').count(), 0,\n      'ordinary History rows must not expose reconciliation actions');",
    "    const ordinaryRow = page.locator('#historyList .history-row:not(.head)').nth(1);\n    assert.strictEqual(await ordinaryRow.locator('.history-actions button').count(), 0,\n      'submitted History rows must not expose retry actions');\n    const failedRow = page.locator('#historyList .history-row:not(.head)').nth(3);\n    assert.strictEqual(await failedRow.getByRole('button', { name: 'Retry in Step 2' }).count(), 1,\n      'failed History rows must expose the simple Step 2 retry action');",
    1
)
anchor = "    assert.deepStrictEqual(fs.readFileSync(evidencePath), evidence, 'History rendering changed an evidence file');\n"
addition = r'''    await page.locator('#historyStatusFilter').selectOption('submitted');
    assert.strictEqual(await page.locator('#historyList .history-row:not(.head)').count(), 333);
    await page.locator('#historyStatusFilter').selectOption('needs_attention');
    assert.strictEqual(await page.locator('#historyList .history-row:not(.head)').count(), 1);
    await page.locator('#historyStatusFilter').selectOption('failed');
    assert.strictEqual(await page.locator('#historyList .history-row:not(.head)').count(), 166);
    await page.locator('#historyStatusFilter').selectOption('all');

    assert.strictEqual(await page.locator('#historySubmitted').textContent(), '333');
    assert.strictEqual(await page.locator('#historyNeedsAttention').textContent(), '1');
    assert.strictEqual(await page.locator('#historyRecordTotal').textContent(), '500');

    await attentionRow.getByRole('button', { name: 'Retry in Step 2' }).click();
    await page.waitForFunction(() => window.__mutationCalls.length === 1);
    assert.deepStrictEqual(await page.evaluate(() => window.__mutationCalls[0][1]), {
      attemptId: 1,
      action: 'retry',
      note: 'Retry requested from History'
    });
    assert.strictEqual(await page.locator('#tabStep3').getAttribute('aria-selected'), 'true', 'retry should navigate to Step 2');
    assert.strictEqual(await page.locator('#claimQueueList input[type="checkbox"]:checked').count(), 1, 'retry target should be selected in Step 2');
    assert.strictEqual(await page.locator('#historyNeedsAttention').textContent(), '0', 'History summary should update after retry approval');

    await page.evaluate(async () => {
      const record = window.__historyRecords.find(item => item.id === 1);
      record.status = 'submitted';
      record.needsAttention = false;
      record.confirmationNumber = 'RETRY-SUCCESS';
      record.message = 'Submitted on retry';
      await window.refreshHistory();
    });
    assert.strictEqual(await page.locator('#historyList').getByText('RETRY-SUCCESS', { exact: true }).count(), 1);
    assert.strictEqual(await page.locator('#historyList').getByText('Submitted', { exact: true }).count() >= 1, true);
    assert.strictEqual(await page.locator('#historySubmitted').textContent(), '334', 'History submitted count should update after a successful retry');
'''
if anchor not in t:
    raise SystemExit('history test anchor missing')
t = t.replace(anchor, anchor + addition, 1)
t = t.replace(
    "      await window.refreshHistory();\n    });\n    assert.strictEqual(await page.locator('#historyList').getByText('NEW-HISTORY-RECORD', { exact: true }).count(), 1, 'History did not display a newly refreshed record');",
    "      await window.refreshHistory();\n    });\n    await page.locator('#historyStatusFilter').selectOption('all');\n    assert.strictEqual(await page.locator('#historyList').getByText('NEW-HISTORY-RECORD', { exact: true }).count(), 1, 'History did not display a newly refreshed record');",
    1
)
t = t.replace(
    "    process.stdout.write('Simple Claim History, evidence-only attention records and 500-record layout tests passed.\\n');",
    "    process.stdout.write('KISS Claim History filtering, retry routing, dynamic status and 500-record layout tests passed.\\n');",
    1
)
test.write_text(t, encoding='utf-8')

# Focused static contract to protect the source-of-truth semantics.
Path('tests/history-kiss-contract-test.js').write_text(r'''\'use strict\';

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
'''.replace("\\'use strict\\';", "'use strict';"), encoding='utf-8')

print('Applied KISS History retry/status changes.')
