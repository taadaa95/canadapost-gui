'use strict';

const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');
const { loadLocale } = require('../lib/i18n');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ bypassCSP: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    await page.goto(`file://${path.resolve(__dirname, '../index.html')}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(messages => {
      document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = messages[element.dataset.i18n]; });
      for (const attribute of ['placeholder', 'aria-label', 'title', 'alt']) {
        document.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => {
          element.setAttribute(attribute, messages[element.getAttribute(`data-i18n-${attribute}`)]);
        });
      }
    }, loadLocale('en-CA').messages);
    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
    const results = await page.evaluate(async () => window.axe.run(document, {
      runOnly: { type: 'rule', values: ['button-name', 'document-title', 'duplicate-id', 'html-has-lang', 'label', 'landmark-one-main'] }
    }));
    assert.deepStrictEqual(results.violations.map(item => ({ id: item.id, nodes: item.nodes.length })), []);
    await page.keyboard.press('Tab');
    const focusStyle = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert.notStrictEqual(focusStyle, 'none');
  } finally {
    await browser.close();
  }
  process.stdout.write('Automated accessibility tests passed.\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
