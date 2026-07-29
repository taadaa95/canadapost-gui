'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-history-evidence-'));
  const evidencePath = path.join(evidenceRoot, 'unchanged-evidence.txt');
  const evidence = Buffer.from('synthetic evidence sentinel');
  fs.writeFileSync(evidencePath, evidence);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, bypassCSP: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__historyRecords = Array.from({ length: 500 }, (_, index) => ({
      id: index + 1,
      trackingNumber: index === 498 ? `LONG${'9'.repeat(180)}` : `HISTORY${String(index).padStart(12, '0')}`,
      referenceNumber: index === 497 ? `REFERENCE-${'unbroken'.repeat(100)}` : `REFERENCE-${index}`,
      attemptedAt: '2026-07-29T12:00:00.000Z',
      status: index % 3 === 0 ? 'failed' : 'submitted',
      confirmationNumber: `CONF-${index}`,
      message: index === 499 ? `Long error ${'message-with-detail/'.repeat(200)}` : (index === 496 ? '' : `Outcome ${index}`),
      screenshotPath: '',
      textPath: ''
    }));
    window.__historyCalls = [];
    window.__mutationCalls = [];
    const ok = async () => ({ ok: true });
    window.cpApp = new Proxy({
      onEvent: () => {}, onRun: () => {}, onStage: () => {}, onBrowserActivity: () => {},
      loadLocale: async () => ({ ok: true, messages: {}, locale: 'en-CA' }),
      loadConfig: async () => ({ ok: true, appVersion: '0.4.0-dev.4', setupCompleted: true, databaseIntegrity: { ok: true }, dashboard: {}, reconciliationCount: 0 }),
      listHistory: async options => {
        window.__historyCalls.push({ ...options });
        const search = String(options.search || '').toLowerCase();
        const status = String(options.status || 'all');
        const filtered = window.__historyRecords.filter(item => (!search || [item.trackingNumber, item.referenceNumber, item.confirmationNumber].some(value => String(value || '').toLowerCase().includes(search))) && (status === 'all' || item.status === status));
        return { ok: true, items: filtered.slice(Number(options.offset || 0), Number(options.offset || 0) + Number(options.limit || 500)) };
      },
      listReconciliation: async () => ({ ok: true, items: [] }),
      getDashboard: async () => ({ ok: true, dashboard: { shipments: 500, submitted: 333, reconciliation: 0, failed: 167 }, integrity: { ok: true } }),
      listManualShipments: async () => ({ ok: true, items: [] }),
      listManualReviews: async () => ({ ok: true, items: [] }),
      getFinancialReport: async () => ({ ok: true, report: { currency: 'CAD', totalsMinor: {}, pendingMinor: 0, recoveryRateBasisPoints: null } }),
      reconcileAttempt: async value => { window.__mutationCalls.push(['reconcileAttempt', value]); return { ok: true }; },
      updateManualReview: async value => { window.__mutationCalls.push(['updateManualReview', value]); return { ok: true }; },
      addManualShipment: async value => { window.__mutationCalls.push(['addManualShipment', value]); return { ok: true }; }
    }, { get: (target, property) => property in target ? target[property] : ok });
  });

  try {
    await page.goto(`file://${path.resolve(__dirname, '../index.html')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.refreshHistory === 'function');
    await page.evaluate(() => window.activateTab('historyTab'));
    await page.waitForFunction(() => document.querySelectorAll('#historyList .history-row:not(.head)').length === 500);

    assert.strictEqual(await page.locator('#reconciliationBadge').count(), 0);
    assert.strictEqual(await page.locator('#tabHistory .notification-badge').count(), 0);
    assert.strictEqual(await page.locator('#notificationsBadge').count(), 1, 'Results notification indicator must remain');
    const pseudo = await page.locator('#tabHistory').evaluate(element => ({ before: getComputedStyle(element, '::before').content, after: getComputedStyle(element, '::after').content }));
    assert(['none', 'normal', '""'].includes(pseudo.before));
    assert(['none', 'normal', '""'].includes(pseudo.after));

    for (const viewport of [{ width: 980, height: 680 }, { width: 1280, height: 720 }, { width: 1600, height: 1000 }, { width: 2560, height: 1440 }]) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => {
        const list = document.getElementById('historyList');
        const head = list.querySelector('.history-row.head');
        list.scrollTop = 500;
        const style = getComputedStyle(list);
        const headStyle = getComputedStyle(head);
        return {
          height: list.clientHeight,
          maxHeight: Math.min(window.innerHeight * 0.6, 640),
          verticalScroll: list.scrollHeight > list.clientHeight,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          sticky: headStyle.position,
          stickyTop: headStyle.top,
          stickyOffset: Math.abs(head.getBoundingClientRect().top - list.getBoundingClientRect().top),
          headerBackground: headStyle.backgroundColor,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
          clearVisible: document.getElementById('clearHistoryFilters').getBoundingClientRect().height > 0,
          tabHeight: document.getElementById('tabHistory').getBoundingClientRect().height,
          adjacentTabHeight: document.getElementById('tabResults').getBoundingClientRect().height
        };
      });
      assert(layout.height >= 258, `${viewport.width}x${viewport.height} History list lost its useful minimum height`);
      assert(layout.height <= layout.maxHeight + 2, `${viewport.width}x${viewport.height} History list exceeded its responsive maximum`);
      assert.strictEqual(layout.verticalScroll, true);
      assert.strictEqual(layout.overflowX, 'auto');
      assert.strictEqual(layout.overflowY, 'auto');
      assert.strictEqual(layout.sticky, 'sticky');
      assert.strictEqual(layout.stickyTop, '0px');
      assert(layout.stickyOffset <= 2, 'History header did not remain pinned to its scrolling container');
      assert(!['transparent', 'rgba(0, 0, 0, 0)'].includes(layout.headerBackground));
      assert(layout.documentWidth <= layout.viewportWidth + 1, `${viewport.width}x${viewport.height} developed application-level horizontal overflow`);
      assert.strictEqual(layout.clearVisible, true);
      assert(Math.abs(layout.tabHeight - layout.adjacentTabHeight) <= 1, 'Removing the History badge changed tab alignment');
    }

    await page.locator('#historySearch').fill('HISTORY000000000499');
    await page.locator('#historyStatusFilter').selectOption('failed');
    await page.waitForTimeout(300);
    assert.strictEqual(await page.locator('#clearHistoryFilters').isEnabled(), true);
    await page.evaluate(() => {
      window.setHistoryPagination(4, 300);
    });
    await page.locator('#clearHistoryFilters').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#historyList .history-row:not(.head)').length === 500);
    const cleared = await page.evaluate(() => ({
      search: document.getElementById('historySearch').value,
      status: document.getElementById('historyStatusFilter').value,
      disabled: document.getElementById('clearHistoryFilters').disabled,
      count: document.getElementById('historyResultCount').textContent,
      state: window.getHistoryViewState(),
      lastCall: window.__historyCalls.at(-1),
      records: window.__historyRecords.length,
      mutations: window.__mutationCalls.length
    }));
    assert.deepStrictEqual({ search: cleared.search, status: cleared.status }, { search: '', status: 'all' });
    assert.strictEqual(cleared.disabled, true);
    assert.strictEqual(cleared.count, '500 records');
    assert.deepStrictEqual(cleared.state, { search: '', status: 'all', page: 1, offset: 0 });
    assert.strictEqual(cleared.lastCall.offset, 0);
    assert.strictEqual(cleared.lastCall.page, 1);
    assert.strictEqual(cleared.records, 500);
    assert.strictEqual(cleared.mutations, 0, 'Clear filters must not invoke a mutation IPC path');
    assert.deepStrictEqual(fs.readFileSync(evidencePath), evidence, 'Clear filters changed an evidence file');

    await page.evaluate(async () => {
      window.__historyRecords.unshift({ id: 501, trackingNumber: 'NEW-HISTORY-RECORD', attemptedAt: '2026-07-29T15:00:00Z', status: 'submitted', confirmationNumber: 'NEW', message: 'New record' });
      await window.refreshHistory();
    });
    assert.strictEqual(await page.locator('#historyList').getByText('NEW-HISTORY-RECORD', { exact: true }).count(), 1, 'History did not display a newly refreshed record');

    for (const count of [0, 1, 19, 50]) {
      await page.evaluate(recordCount => window.renderHistory(window.__historyRecords.slice(0, recordCount)), count);
      assert.strictEqual(await page.locator('#historyList .history-row:not(.head)').count(), count);
    }

    process.stdout.write('History refinement, 500-record layout and non-destructive filter reset tests passed.\n');
  } finally {
    await browser.close();
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
