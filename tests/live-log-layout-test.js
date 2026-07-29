'use strict';

const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, bypassCSP: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const asyncOk = async () => ({ ok: true, messages: {}, locale: 'en-CA', setupCompleted: true, databaseIntegrity: { ok: true }, dashboard: {}, items: [] });
    window.cpApp = new Proxy({
      onEvent: callback => { window.__emitAppEvent = callback; },
      onRun: () => {}, onStage: () => {}, onBrowserActivity: () => {},
      loadLocale: async () => ({ ok: true, messages: {}, locale: 'en-CA' }),
      loadConfig: async () => ({ setupCompleted: true, databaseIntegrity: { ok: true }, dashboard: {}, apiEnvironment: 'production' })
    }, { get: (target, property) => property in target ? target[property] : asyncOk });
  });

  try {
    await page.goto(`file://${path.resolve(__dirname, '../index.html')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.log === 'function' && typeof window.__emitAppEvent === 'function');

    await page.evaluate(() => window.activateTab('step1'));
    const boundedBefore = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.evaluate(() => {
      for (let index = 0; index < 10000; index += 1) window.log(`Synthetic ${index} tracking 1234567890123456 ${'x'.repeat(300)}`, '', 'step1');
    });
    const bounded = await page.evaluate(() => {
      const log = document.getElementById('step1Log');
      return {
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        children: log.childElementCount,
        overflowY: getComputedStyle(log).overflowY,
        scrollable: log.scrollHeight > log.clientHeight,
        fullPinVisible: log.textContent.includes('1234567890123456')
      };
    });
    assert.strictEqual(bounded.documentHeight, boundedBefore);
    assert.strictEqual(bounded.documentHeight, bounded.viewportHeight);
    assert.strictEqual(bounded.children, 2000);
    assert.strictEqual(bounded.overflowY, 'auto');
    assert.strictEqual(bounded.scrollable, true);
    assert.strictEqual(bounded.fullPinVisible, false, 'generic/persistent-style logs must redact complete IDs');

    const unread = await page.evaluate(() => {
      const log = document.getElementById('step1Log');
      log.scrollTop = 0;
      log.dispatchEvent(new Event('scroll'));
      window.log('Unread entry', '', 'step1');
      return { top: log.scrollTop, hidden: document.getElementById('step1JumpLatest').hidden };
    });
    assert.strictEqual(unread.top, 0);
    assert.strictEqual(unread.hidden, false);

    await page.evaluate(() => {
      window.activateTab('step2');
      document.getElementById('step2Log').replaceChildren();
      const base = { terminal: true, rendererOnlyFullTrackingNumber: true, expectedDate: '2026-07-15', firstAttemptDate: '2026-07-15', deliveryDate: '2026-07-17', deliveryStatus: 'Delivered' };
      const events = [
        { ...base, type: 'pin_late', primaryCategory: 'late', displayTrackingNumber: '1111111111111111' },
        { ...base, type: 'pin_on_time', primaryCategory: 'on_time', displayTrackingNumber: '2222222222222222', deliveryDate: '2026-07-15' },
        { ...base, type: 'pin_overdue', primaryCategory: 'not_delivered', displayTrackingNumber: '3333333333333333', deliveryDate: '', deliveryStatus: 'In transit' },
        { ...base, type: 'pin_review_required', primaryCategory: 'delivered_review', displayTrackingNumber: '4444444444444444', expectedDate: '', eligibilityReason: 'No usable delivery standard' },
        { ...base, type: 'pin_error', primaryCategory: 'error', displayTrackingNumber: '5555555555555555', message: 'Synthetic timeout', diagnostic: {} }
      ];
      for (const event of events) window.__emitAppEvent({ stage: 'tracking', event });
      window.__emitAppEvent({ stage: 'tracking', event: { type: 'tracking_protocol_stage', stage: 'tracking_backoff', category: 'transport_timeout', delayMs: 3100, retryAttempt: 1, maxRetries: 2 } });
    });
    const liveLog = await page.evaluate(() => [...document.querySelectorAll('#step2Log .log-line')].map(line => ({ text: line.textContent, className: line.className })));
    for (const pin of ['1111111111111111', '2222222222222222', '3333333333333333', '4444444444444444', '5555555555555555']) {
      assert(liveLog.some(line => line.text.includes(pin)), `full tracking number ${pin} missing from transient UI`);
    }
    for (const status of ['LATE', 'ON TIME', 'NOT DELIVERED', 'REVIEW', 'ERROR', 'RETRY']) assert(liveLog.some(line => line.text.includes(status)), `${status} text indicator missing`);
    for (const cls of ['log-late', 'log-on-time', 'log-not-delivered', 'log-warning', 'log-submit-error', 'log-retry']) assert(liveLog.some(line => line.className.includes(cls)), `${cls} presentation missing`);
    const fullRunLogCount = await page.evaluate(() => {
      document.getElementById('step2Log').replaceChildren();
      for (let index = 0; index < 284; index += 1) {
        window.__emitAppEvent({ stage: 'tracking', event: {
          type: 'pin_on_time', terminal: true, primaryCategory: 'on_time', rendererOnlyFullTrackingNumber: true,
          displayTrackingNumber: `77${String(index).padStart(14, '0')}`, expectedDate: '2026-07-15', deliveryDate: '2026-07-15', deliveryStatus: 'Delivered'
        } });
      }
      return [...document.querySelectorAll('#step2Log .log-line')].filter(line => line.textContent.includes('— ON TIME —')).length;
    });
    assert.strictEqual(fullRunLogCount, 284, 'a 284-row traversal must show one final line per shipment');

    await page.evaluate(() => {
      window.activateTab('step3');
      for (let index = 0; index < 600; index += 1) window.log(`Step 3 result ${index} ${'long-message/'.repeat(80)}`, '', 'step3');
      const tall = document.createElement('div');
      tall.style.height = '9000px';
      document.getElementById('builtinBrowserSlot').appendChild(tall);
    });

    for (const count of [0, 1, 19, 50]) {
      await page.evaluate(candidateCount => window.renderClaimQueue(Array.from({ length: candidateCount }, (_, index) => ({
        trackingNumber: `SYNTHETIC${String(index).padStart(10, '0')}`,
        referenceNumber: `REFERENCE-${index}-${'x'.repeat(100)}`,
        serviceCode: 'DOM.EP', firstAttemptDate: '2026-07-20', deliveryDate: '2026-07-21', deadline: '2026-09-01',
        businessDaysRemaining: 24, eligibilityReason: `Synthetic ${'long-rejection/'.repeat(30)}`
      }))), count);
      const layout = await page.evaluate(() => {
        const queue = document.getElementById('claimQueueList');
        const slot = document.getElementById('builtinBrowserSlot');
        const log = document.getElementById('step3Log');
        return {
          documentHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
          bodyDisplay: getComputedStyle(document.querySelector('#step3 .step3-body')).display,
          queueHeight: queue.clientHeight,
          queueOverflowY: getComputedStyle(queue).overflowY,
          queueScrollable: queue.scrollHeight > queue.clientHeight,
          browserHeight: slot.clientHeight,
          browserOverflow: getComputedStyle(slot).overflow,
          logHeight: log.clientHeight,
          logOverflowY: getComputedStyle(log).overflowY,
          logScrollable: log.scrollHeight > log.clientHeight,
          inactiveHidden: [...document.querySelectorAll('.tab-panel:not(.active)')].every(node => getComputedStyle(node).display === 'none')
        };
      });
      assert(layout.documentHeight > layout.viewportHeight, 'Step 3 should use normal page-level vertical scrolling');
      assert(layout.documentWidth <= layout.viewportWidth + 1, 'Step 3 caused horizontal document overflow');
      assert.strictEqual(layout.bodyDisplay, 'flex');
      assert(layout.queueHeight >= 310, `claim queue height was ${layout.queueHeight}px`);
      assert.strictEqual(layout.queueOverflowY, 'auto');
      if (count === 50) assert.strictEqual(layout.queueScrollable, true);
      assert(layout.browserHeight >= 650);
      assert.strictEqual(layout.browserOverflow, 'hidden');
      assert(layout.logHeight > 0 && layout.logHeight <= 440);
      assert.strictEqual(layout.logOverflowY, 'auto');
      assert.strictEqual(layout.logScrollable, true);
      assert.strictEqual(layout.inactiveHidden, true);
    }

    const viewports = [{ width: 980, height: 680 }, { width: 1280, height: 720 }, { width: 1600, height: 1000 }, { width: 2560, height: 1440 }];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const resized = await page.evaluate(() => ({
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        browserHeight: document.getElementById('builtinBrowserSlot').clientHeight
      }));
      assert(resized.documentHeight > resized.viewportHeight, `${viewport.width}x${viewport.height} Step 3 did not scroll vertically`);
      assert(resized.documentWidth <= resized.viewportWidth + 1, `${viewport.width}x${viewport.height} has horizontal page overflow`);
      assert(resized.browserHeight >= 650, `${viewport.width}x${viewport.height} browser is unusably short`);
    }

    await page.evaluate(() => {
      const slot = document.getElementById('builtinBrowserSlot');
      slot.scrollIntoView({ block: 'center' });
    });
    const visibleBounds = await page.evaluate(() => window.builtinBrowserBounds());
    assert(visibleBounds && visibleBounds.height > 0 && visibleBounds.y >= 0);
    assert(visibleBounds.y + visibleBounds.height <= await page.evaluate(() => window.innerHeight));
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.id = 'nativeBoundsOffscreenSpacer';
      spacer.style.height = '1800px';
      document.body.appendChild(spacer);
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    assert.strictEqual(await page.evaluate(() => window.builtinBrowserBounds()), null, 'offscreen native browser slot was not hidden');

    await page.evaluate(async () => {
      window.activateTab('historyTab');
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    for (const count of [0, 1, 19, 50, 500]) {
      await page.evaluate(recordCount => {
        window.renderHistory(Array.from({ length: recordCount }, (_, index) => ({
          trackingNumber: `HISTORY${String(index).padStart(12, '0')}`, attemptedAt: '2026-07-29T12:00:00.000Z',
          status: index % 2 ? 'rejected' : 'submitted', confirmationNumber: `CONF-${index}`,
          message: `Long business outcome ${'message/'.repeat(40)}`
        })));
      }, count);
      await page.waitForTimeout(250);
      const history = await page.evaluate(() => {
        const list = document.getElementById('historyList');
        const row = list.querySelector('.history-row:not(.head)');
        const head = list.querySelector('.history-row.head');
        const headStyle = head ? getComputedStyle(head) : null;
        return {
          documentHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
          listOverflowX: getComputedStyle(list).overflowX,
          listOverflowY: getComputedStyle(list).overflowY,
          listHeight: list.clientHeight,
          listMinHeight: getComputedStyle(list).minHeight,
          listClassName: list.className,
          listScrollable: list.scrollHeight > list.clientHeight,
          rowHeight: row?.getBoundingClientRect().height || 0,
          stickyPosition: headStyle?.position || '',
          stickyTop: headStyle?.top || '',
          stickyBackground: headStyle?.backgroundColor || '',
          hasHistoryBadge: Boolean(document.getElementById('reconciliationBadge')),
          clearReachable: document.getElementById('clearHistoryFilters').getBoundingClientRect().width > 0
        };
      });
      assert(history.documentHeight > history.viewportHeight, 'History should use normal page-level scrolling');
      assert(history.documentWidth <= history.viewportWidth + 1, 'History caused horizontal page overflow');
      assert.strictEqual(history.listOverflowX, 'auto');
      assert.strictEqual(history.listOverflowY, count ? 'auto' : 'hidden');
      assert(history.listHeight >= (count ? 258 : 178), `History ${count}-record height was ${history.listHeight}px (${history.listMinHeight}; ${history.listClassName})`);
      assert(history.listHeight <= Math.min(history.viewportHeight * 0.6, 640) + 2);
      if (count) assert(history.rowHeight >= 52);
      if (count === 500) assert.strictEqual(history.listScrollable, true);
      assert.strictEqual(history.stickyPosition, 'sticky');
      assert.strictEqual(history.stickyTop, '0px');
      assert(!['transparent', 'rgba(0, 0, 0, 0)'].includes(history.stickyBackground));
      assert.strictEqual(history.hasHistoryBadge, false);
      assert.strictEqual(history.clearReachable, true);
    }

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const responsiveHistory = await page.evaluate(() => ({
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        rowHeight: document.querySelector('#historyList .history-row')?.getBoundingClientRect().height || 0
      }));
      assert(responsiveHistory.documentHeight > responsiveHistory.viewportHeight, `${viewport.width}x${viewport.height} History did not scroll vertically`);
      assert(responsiveHistory.documentWidth <= responsiveHistory.viewportWidth + 1, `${viewport.width}x${viewport.height} History overflowed horizontally`);
      assert(responsiveHistory.rowHeight >= 52);
    }

    process.stdout.write('Spacious Step 3, History, live-log and responsive layout tests passed.\n');
  } finally {
    await browser.close();
  }
})().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
