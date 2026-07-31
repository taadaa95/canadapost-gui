'use strict';

const assert = require('assert');
const { chromium } = require('playwright');
const { createMockPortal, SCENARIOS } = require('../mock-portal/server');

const TEST_TIMEOUT_MS = 120000;
const CLEANUP_TIMEOUT_MS = 10000;

function withTimeout(promise, label, timeoutMs = CLEANUP_TIMEOUT_MS) {
  let timeout = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label} did not complete within ${timeoutMs} ms.`)),
        timeoutMs
      );
    })
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

const watchdog = setTimeout(() => {
  process.stderr.write(`Mock portal test exceeded ${TEST_TIMEOUT_MS} ms.\n`);
  process.exit(1);
}, TEST_TIMEOUT_MS);

(async () => {
  const portal = createMockPortal();
  const origin = await portal.start();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    assert.ok(SCENARIOS.length >= 19);
    for (const scenario of SCENARIOS.filter(value => !['network-failure', 'browser-crash', 'worker-crash'].includes(value))) {
      const response = await page.goto(`${origin}/login?scenario=${scenario}`, { waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => null);
      if (scenario === 'server-error') assert.strictEqual(response.status(), 503);
      else assert.ok(response, `scenario ${scenario} should provide a deterministic page`);
    }

    await page.goto(`${origin}/cpc/en/support/kb/claims/late-packages.page?scenario=success`);
    await page.getByRole('link', { name: 'Open a ticket' }).click();
    await page.getByLabel("Receiver's country").selectOption('CA');
    await page.getByLabel("Receiver's postal code").fill('K1A0B1');
    await page.getByLabel('Tracking number').fill('SYNTHETIC000001');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Reference Number 1').fill('SYNTHETIC-REF');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Street Number').fill('1');
    await page.getByLabel('Street Name').selectOption({ label: 'Example Street' });
    assert.strictEqual(await page.getByLabel('Street Number').inputValue(), '1');

    const changed = await page.goto(`${origin}/cpc/en/support/kb/claims/late-packages.page?scenario=changed-selector`);
    assert.strictEqual(changed.status(), 200);
    assert.strictEqual(await page.locator('#ticket_open').count(), 0);
  } finally {
    const cleanup = await Promise.allSettled([
      withTimeout(browser.close(), 'Chromium shutdown'),
      withTimeout(portal.close(), 'Mock portal shutdown')
    ]);
    const failedCleanup = cleanup.find(result => result.status === 'rejected');
    if (failedCleanup) throw failedCleanup.reason;
  }
  clearTimeout(watchdog);
  process.stdout.write('Mock portal tests passed.\n');
})().catch(error => {
  clearTimeout(watchdog);
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
