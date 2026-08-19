'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { loadLocale } = require('../lib/i18n');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`file://${path.resolve(__dirname, '../index.html')}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(messages => {
      document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = messages[element.dataset.i18n] || ''; });
      for (const attribute of ['placeholder', 'aria-label', 'title', 'alt']) {
        document.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => {
          element.setAttribute(attribute, messages[element.getAttribute(`data-i18n-${attribute}`)] || '');
        });
      }
      window.initStepTabs();
      window.activateTab('step1');
    }, loadLocale('en-CA').messages);

    assert.strictEqual(await page.locator('#step2').count(), 0, 'old standalone tracking panel must not exist');
    assert.strictEqual(await page.locator('#step1 #importEstHistory:visible').count(), 1, 'Step 1 must have exactly one visible Start button');
    assert.strictEqual(await page.locator('#step1 #forceStopStep1:visible').count(), 1, 'Step 1 must have exactly one visible Stop button');
    assert.strictEqual(await page.locator('#step1 .step-execution-control:visible').count(), 2, 'Step 1 must expose only Start and Stop');

    for (const selector of ['#importEstHistory', '#forceStopStep1']) {
      const clickable = await page.locator(selector).evaluate(button => {
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        return rect.width > 0 && rect.height > 0 && getComputedStyle(button).pointerEvents !== 'none' && (top === button || button.contains(top));
      });
      assert.strictEqual(clickable, true, `${selector} must be unobstructed and clickable`);
    }

    for (const selector of ['#step1Imported', '#step1TrackingProgressCount', '#late', '#step1Progress', '#trackingProgress', '#step1CurrentAction']) {
      assert.strictEqual(await page.locator(selector).isVisible(), true, `${selector} must be visible`);
    }

    const layout = await page.evaluate(() => {
      const rect = selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        title: rect('#step1 .step1-heading-copy'),
        actions: rect('#step1 .step1-primary-actions'),
        workspace: rect('#step1 .step1-workspace'),
        status: rect('#step1 .step1-status-card'),
        log: rect('#step1 .step-log-card'),
      };
    });
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    assert.strictEqual(overlaps(layout.title, layout.actions), false, 'title/description must not overlap Start/Stop');
    assert.strictEqual(overlaps(layout.status, layout.log), false, 'status and live log must not overlap');
    assert(layout.workspace.top >= Math.min(layout.title.bottom, layout.actions.bottom), 'workspace must flow below header controls');

    const artifactDir = path.resolve(__dirname, '../dist/test-artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    await page.locator('#step1').screenshot({ path: path.join(artifactDir, 'step1-kiss-layout.png') });
  } finally {
    await browser.close();
  }
  process.stdout.write('Step 1 KISS layout and clickability tests passed.\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
