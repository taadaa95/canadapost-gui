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
    await page.evaluate(() => window.initStepTabs());
    await page.locator('#tabSettings').focus();
    const keyboardPanels = ['step1', 'step2', 'step3', 'historyTab', 'resultsTab'];
    for (const panelId of keyboardPanels) {
      await page.keyboard.press('ArrowRight');
      assert.strictEqual(await page.locator(`#${panelId}`).isVisible(), true, `keyboard users must be able to open ${panelId}`);
      assert.strictEqual(await page.locator(`#${panelId}`).getAttribute('hidden'), null, `${panelId} must not retain a readiness-driven hidden state`);
    }
    await page.keyboard.press('Home');
    assert.strictEqual(await page.locator('#settingsTab').isVisible(), true, 'Home must return keyboard users to Settings');
    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
    const results = await page.evaluate(async () => window.axe.run(document, {
      runOnly: { type: 'rule', values: ['button-name', 'document-title', 'duplicate-id', 'html-has-lang', 'label', 'landmark-one-main'] }
    }));
    assert.deepStrictEqual(results.violations.map(item => ({ id: item.id, nodes: item.nodes.length })), []);
    const layoutContracts = await page.evaluate(() => {
      const fieldIds = ['estFrom', 'estTo'];
      const fields = fieldIds.map(id => {
        const control = document.getElementById(id);
        const wrapperStyle = getComputedStyle(control.closest('.field'));
        const controlStyle = getComputedStyle(control);
        return {
          id,
          wrapperBorder: [wrapperStyle.borderTopWidth, wrapperStyle.borderRightWidth, wrapperStyle.borderBottomWidth, wrapperStyle.borderLeftWidth],
          controlBorderStyle: controlStyle.borderTopStyle,
          controlBorderWidth: controlStyle.borderTopWidth,
          labelled: document.querySelector(`label[for="${id}"]`) !== null
        };
      });
      const settingsButtons = ['saveUserSettings', 'checkForUpdates'].map(id => {
        const button = document.getElementById(id);
        return {
          id,
          justifySelf: getComputedStyle(button).justifySelf,
          width: button.getBoundingClientRect().width,
          containerWidth: button.parentElement.getBoundingClientRect().width
        };
      });
      const tabs = [...document.querySelectorAll('.step-tab')].map(tab => {
        const title = tab.querySelector('.step-tab-title').getBoundingClientRect();
        const detail = tab.querySelector('.step-tab-detail').getBoundingClientRect();
        const bounds = tab.getBoundingClientRect();
        const style = getComputedStyle(tab);
        return {
          flexDirection: style.flexDirection,
          justifyContent: style.justifyContent,
          hasBreak: tab.querySelector('br') !== null,
          contentInside: title.top >= bounds.top && detail.bottom <= bounds.bottom
        };
      });
      return { fields, settingsButtons, tabs };
    });
    for (const field of layoutContracts.fields) {
      assert.deepStrictEqual(field.wrapperBorder, ['0px', '0px', '0px', '0px'], `${field.id} label wrapper must remain unboxed`);
      assert.notStrictEqual(field.controlBorderStyle, 'none', `${field.id} control must retain its border`);
      assert.notStrictEqual(field.controlBorderWidth, '0px', `${field.id} control border must remain visible`);
      assert.strictEqual(field.labelled, true, `${field.id} must retain its associated label`);
    }
    for (const button of layoutContracts.settingsButtons) {
      assert.strictEqual(button.justifySelf, 'start', `${button.id} must not stretch across its settings card`);
      assert(button.width < button.containerWidth, `${button.id} must remain narrower than its settings container`);
    }
    assert.strictEqual(layoutContracts.tabs.length, 6);
    for (const tab of layoutContracts.tabs) {
      assert.strictEqual(tab.flexDirection, 'column');
      assert.strictEqual(tab.justifyContent, 'center');
      assert.strictEqual(tab.hasBreak, false);
      assert.strictEqual(tab.contentInside, true, 'workflow tab title and subtitle must stay inside the card');
    }
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
