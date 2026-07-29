'use strict';

const crypto = require('crypto');

class CdpTargetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CdpTargetError';
    this.code = code;
    this.details = details;
  }
}

function hashTarget(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20);
}

async function targetInfoForPage(context, page) {
  const session = await context.newCDPSession(page);
  try {
    const result = await session.send('Target.getTargetInfo');
    return result?.targetInfo || null;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function enumerateCdpTargets(browser) {
  const browserSession = await browser.newBrowserCDPSession();
  try {
    const result = await browserSession.send('Target.getTargets');
    return Array.isArray(result?.targetInfos) ? result.targetInfos : [];
  } finally {
    await browserSession.detach().catch(() => {});
  }
}

async function inspectPageTargets(browser, expectedTargetId, expectedNonce) {
  const targetInfos = await enumerateCdpTargets(browser);
  const typeCounts = {};
  for (const target of targetInfos) typeCounts[target.type || 'unknown'] = (typeCounts[target.type || 'unknown'] || 0) + 1;
  const publishedMatches = targetInfos.filter(target => target.type === 'page' && String(target.targetId) === expectedTargetId);
  const candidates = [];
  const wrapperMatches = [];
  for (const context of browser.contexts()) {
    for (const page of context.pages().filter(candidate => !candidate.isClosed())) {
      let targetInfo;
      try { targetInfo = await targetInfoForPage(context, page); }
      catch (error) {
        candidates.push({ targetIdHash: '', reason: 'target-info-unavailable', errorCode: String(error?.code || '') });
        continue;
      }
      const targetId = String(targetInfo?.targetId || '');
      const exactId = targetId === expectedTargetId;
      let markerMatch = null;
      if (exactId && expectedNonce) {
        const marker = await page.evaluate(() => window.name).catch(() => '');
        markerMatch = marker === expectedNonce;
      }
      const reason = !exactId ? 'target-id-mismatch' : (markerMatch === false ? 'target-nonce-mismatch' : 'exact-match');
      candidates.push({ targetIdHash: hashTarget(targetId), reason, closed: page.isClosed() });
      if (exactId && markerMatch !== false) wrapperMatches.push(page);
    }
  }
  return {
    targetCount: targetInfos.length,
    pageTargetCount: Number(typeCounts.page || 0),
    typeCounts,
    publishedMatchCount: publishedMatches.length,
    exactMatchCount: wrapperMatches.length,
    candidates,
    matches: wrapperMatches
  };
}

async function waitForExactPageTarget(browser, options = {}) {
  const expectedTargetId = String(options.targetId || '');
  const expectedNonce = String(options.targetNonce || '');
  if (!expectedTargetId || !expectedNonce) {
    throw new CdpTargetError('TARGET_NOT_PUBLISHED', 'The main process did not publish a complete Step 3 target identity.');
  }
  const timeoutMs = Math.max(100, Number(options.timeoutMs || 15000));
  const intervalMs = Math.max(10, Number(options.intervalMs || 250));
  const sleep = options.sleep || (delay => new Promise(resolve => setTimeout(resolve, delay)));
  const inspect = options.inspect || inspectPageTargets;
  const startedAt = Date.now();
  let attempt = 0;
  let lastInventory = null;
  let publishedSeen = false;
  while (Date.now() - startedAt <= timeoutMs) {
    attempt += 1;
    let inventory;
    try { inventory = await inspect(browser, expectedTargetId, expectedNonce); }
    catch (error) {
      throw new CdpTargetError('CDP_CONNECTION_FAILURE', 'CDP target enumeration failed.', { cause: String(error?.message || '') });
    }
    lastInventory = inventory;
    publishedSeen ||= inventory.publishedMatchCount > 0;
    await options.onInventory?.({ attempt, ...inventory, matches: undefined });
    if (inventory.publishedMatchCount > 1 || inventory.exactMatchCount > 1) {
      throw new CdpTargetError('MULTIPLE_MATCHING_TARGETS', 'More than one top-level page matched the published Step 3 target identity.', { attempt });
    }
    if (inventory.exactMatchCount === 1) {
      const page = inventory.matches[0];
      if (!page || page.isClosed()) throw new CdpTargetError('TARGET_CLOSED_DURING_CONNECTION', 'The Step 3 browser target closed during connection.');
      return { page, attempt, inventory };
    }
    if (Date.now() - startedAt >= timeoutMs) break;
    await sleep(intervalMs);
  }
  const code = publishedSeen ? 'TARGET_NOT_PUBLISHED' : 'TARGET_NOT_FOUND';
  const message = publishedSeen
    ? 'The exact Step 3 target existed but its Playwright page or marker was not ready.'
    : 'The exact Step 3 top-level page target was not found on the current endpoint.';
  throw new CdpTargetError(code, message, {
    attempts: attempt,
    targetCount: Number(lastInventory?.targetCount || 0),
    pageTargetCount: Number(lastInventory?.pageTargetCount || 0),
    exactMatchCount: Number(lastInventory?.exactMatchCount || 0)
  });
}

module.exports = {
  CdpTargetError,
  hashTarget,
  targetInfoForPage,
  enumerateCdpTargets,
  inspectPageTargets,
  waitForExactPageTarget
};
