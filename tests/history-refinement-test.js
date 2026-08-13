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
  await page.addInitScript(value => { window.__evidencePath = value; }, evidencePath);
  await page.addInitScript(() => {
    window.__historyRecords = Array.from({ length: 500 }, (_, index) => ({
      id: index + 1,
      trackingNumber: index === 498 ? `LONG${'9'.repeat(180)}` : `HISTORY${String(index).padStart(12, '0')}`,
      referenceNumber: index === 497 ? `REFERENCE-${'unbroken'.repeat(100)}` : `REFERENCE-${index}`,
      attemptedAt: '2026-07-29T12:00:00.000Z',
      status: index === 0 ? 'unknown' : (index % 3 === 0 ? 'failed' : 'submitted'),
      needsAttention: index === 0,
      confirmationNumber: `CONF-${index}`,
      message: index === 499 ? `Long error ${'message-with-detail/'.repeat(200)}` : (index === 496 ? '' : `Outcome ${index}`),
      screenshotPath: index === 0 ? window.__evidencePath : '',
      textPath: ''
    }));
    window.__historyCalls = [];
    window.__mutationCalls = [];
    window.prompt = () => '';
    const ok = async () => ({ ok: true });
    window.cpApp = new Proxy({
      onEvent: () => {}, onRun: () => {}, onStage: () => {}, onBrowserActivity: () => {},
      loadLocale: async () => ({ ok: true, messages: {}, locale: 'en-CA' }),
      loadConfig: async () => ({ ok: true, appVersion: '0.4.2', setupCompleted: true, databaseIntegrity: { ok: true }, dashboard: {}, reconciliationCount: 0 }),
      listHistory: async options => {
        window.__historyCalls.push({ ...options });
        return { ok: true, items: window.__historyRecords.slice(Number(options.offset || 0), Number(options.offset || 0) + Number(options.limit || 500)) };
      },
      getDashboard: async () => ({ ok: true, dashboard: { submitted: 333, reconciliation: 1, historyRecords: 500 }, integrity: { ok: true } }),
      getFinancialReport: async () => ({ ok: true, report: { currency: 'CAD', totalsMinor: {}, pendingMinor: 0, recoveryRateBasisPoints: null } }),
      reconcileAttempt: async value => { window.__mutationCalls.push(['reconcileAttempt', value]); return { ok: true }; }
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
      assert(Math.abs(layout.tabHeight - layout.adjacentTabHeight) <= 1, 'Removing the History badge changed tab alignment');
    }

    assert.strictEqual(await page.locator('#historySearch').count(), 0);
    assert.strictEqual(await page.locator('#historyStatusFilter').count(), 0);
    assert.strictEqual(await page.locator('#clearHistoryFilters').count(), 0);
    assert.strictEqual(await page.locator('#reconciliationList').count(), 0);
    assert.strictEqual(await page.locator('#manualShipmentList').count(), 0);
    assert.strictEqual(await page.locator('#historyClassificationList').count(), 0);
    assert.strictEqual(await page.locator('#refreshBrowserSession').count(), 0);
    assert.strictEqual(await page.locator('#clearBrowserSession').count(), 0);
    assert.strictEqual(await page.locator('#historyList').getByText('Needs attention', { exact: true }).count(), 1);
    const attentionRow = page.locator('#historyList .history-row:not(.head)').first();
    assert.strictEqual(await attentionRow.getByRole('button', { name: 'View evidence' }).count(), 1,
      'attention records must retain evidence access');
    assert.strictEqual(await attentionRow.getByRole('button', { name: 'Mark submitted' }).count(), 0);
    assert.strictEqual(await attentionRow.getByRole('button', { name: 'Mark not submitted' }).count(), 0);
    assert.strictEqual(await attentionRow.getByRole('button', { name: 'Approve retry' }).count(), 0);
    const ordinaryRow = page.locator('#historyList .history-row:not(.head)').nth(1);
    assert.strictEqual(await ordinaryRow.locator('.history-actions button').count(), 0,
      'ordinary History rows must not expose reconciliation actions');
    assert.strictEqual(await page.evaluate(() => window.__historyRecords.length), 500,
      'History rendering must not delete historical reconciliation records');
    assert.deepStrictEqual(await page.evaluate(() => window.__mutationCalls), [],
      'History rendering must not invoke reconciliation mutation IPC');
    assert.deepStrictEqual(fs.readFileSync(evidencePath), evidence, 'History rendering changed an evidence file');

    await page.evaluate(async () => {
      window.__historyRecords.unshift({ id: 501, trackingNumber: 'NEW-HISTORY-RECORD', attemptedAt: '2026-07-29T15:00:00Z', status: 'submitted', confirmationNumber: 'NEW', message: 'New record' });
      await window.refreshHistory();
    });
    assert.strictEqual(await page.locator('#historyList').getByText('NEW-HISTORY-RECORD', { exact: true }).count(), 1, 'History did not display a newly refreshed record');

    for (const count of [0, 1, 19, 50]) {
      await page.evaluate(recordCount => window.renderHistory(window.__historyRecords.slice(0, recordCount)), count);
      assert.strictEqual(await page.locator('#historyList .history-row:not(.head)').count(), count);
    }

    process.stdout.write('Simple Claim History, evidence-only attention records and 500-record layout tests passed.\n');
  } finally {
    await browser.close();
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
