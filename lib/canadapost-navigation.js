'use strict';

const { isAllowedCanadaPostUrl } = require('./origin-policy');

const LABELS = Object.freeze({
  support: /^(?:Support|Help|Customer service|Contact us|Soutien|Aide|Service à la clientèle)$/i,
  category: /(?:Lost|Missing|Perdu).*(?:late|retard).*(?:damaged|endommag)|Lost,? late or damaged/i,
  late: /(?:Package|Parcel|Colis).*(?:delivered late|late delivery|livr[ée].*retard)|Package delivered late/i,
  ticket: /(?:Open|Create).*(?:ticket|service ticket)|Ouvrir.*(?:billet|demande)/i,
  menu: /^(?:Menu|Main menu|Open menu|Open navigation|Navigation)$/i
});

function isCanadaPostUrl(value) {
  return isAllowedCanadaPostUrl(value);
}

function looksLikeLoginUrl(value) {
  try {
    const url = new URL(String(value));
    return /(?:^|\/)(?:login|signin)(?:\/|$)/i.test(url.pathname)
      || /\/lfe-cap\//i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function classifyAuthenticatedSnapshot(snapshot = {}) {
  const url = String(snapshot.url || '');
  const text = String(snapshot.text || '').replace(/\s+/g, ' ').trim();
  const stage = String(snapshot.navigationStage || '');
  const loginVisible = Boolean(snapshot.loginVisible || snapshot.passwordVisible);

  if (stage) return { authenticated: true, confidence: 'high', signal: `claim-${stage}` };
  if (loginVisible) return { authenticated: false, confidence: 'high', signal: 'login-controls' };
  if (/\b(?:sign out|log out|my account|dashboard|business profile|orders|transactions|shipping profile)\b/i.test(text)) {
    return { authenticated: true, confidence: 'medium', signal: 'account-text' };
  }
  if (isCanadaPostUrl(url) && /\/(?:dash|dashboard|support|help|business|smb)(?:\/|$)/i.test(new URL(url).pathname)) {
    return { authenticated: true, confidence: 'medium', signal: 'authenticated-path' };
  }
  if (looksLikeLoginUrl(url)) return { authenticated: false, confidence: 'medium', signal: 'login-url' };
  if (isCanadaPostUrl(url)) return { authenticated: null, confidence: 'low', signal: 'canada-post-page' };
  return { authenticated: false, confidence: 'high', signal: 'unexpected-domain' };
}

async function locatorVisible(locator, timeout = 250) {
  if (!locator) return false;
  return locator.first().isVisible({ timeout }).catch(() => false);
}

async function firstVisibleLocator(candidates, timeout = 5000) {
  const deadline = Date.now() + Math.max(0, Number(timeout) || 0);
  do {
    for (const candidate of candidates.filter(Boolean)) {
      if (await locatorVisible(candidate, 200)) return candidate.first();
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (true);
  return null;
}

function clickableTextLocator(page, pattern) {
  return page.locator('a, button, [role="link"], [role="button"]').filter({ hasText: pattern });
}

function claimNavigationUrlContext(value) {
  try {
    const pathname = new URL(String(value)).pathname.toLowerCase();
    if (/\/support\/kb\/claims\/late-packages(?:\.page)?\/?$/.test(pathname)) return 'late-page';
    if (/\/support(?:\.page)?\/?$/.test(pathname)) return 'support-page';
    if (/\/businesshome-boutiquedaffaires\//.test(pathname)) return 'business-home';
    return 'other';
  } catch (_) {
    return 'other';
  }
}

function stageOrderForPage(page) {
  const context = claimNavigationUrlContext(page?.url?.() || '');
  if (context === 'late-page') return ['ticket'];
  if (context === 'support-page') return ['ticket', 'late', 'category'];
  if (context === 'business-home') return ['ticket', 'support'];
  return ['ticket', 'late', 'category', 'support'];
}

function stageCandidates(page) {
  return {
    ticket: [
      page.locator('#ticket_open, a#ticket_open, [id="ticket_open"]'),
      page.getByRole('link', { name: LABELS.ticket }),
      page.getByRole('button', { name: LABELS.ticket }),
      clickableTextLocator(page, LABELS.ticket),
      page.locator('a[href*="ticket" i], a[href*="inquiry" i], a[href*="case" i]')
    ],
    late: [
      page.getByRole('link', { name: LABELS.late }),
      page.getByRole('button', { name: LABELS.late }),
      clickableTextLocator(page, LABELS.late),
      page.locator('a[href*="late" i], a[href*="delivery" i][href*="support" i]')
    ],
    category: [
      page.getByRole('button', { name: LABELS.category }),
      page.getByRole('link', { name: LABELS.category }),
      clickableTextLocator(page, LABELS.category)
    ],
    support: [
      page.getByRole('link', { name: LABELS.support }),
      page.getByRole('button', { name: LABELS.support }),
      clickableTextLocator(page, LABELS.support),
      page.locator('a[href*="/support" i], a[href*="/help" i], a[href*="contact-us" i], a[href*="customer-service" i]')
    ]
  };
}

async function findClaimNavigationStage(page, timeout = 5000) {
  const candidates = stageCandidates(page);
  const deadline = Date.now() + Math.max(0, Number(timeout) || 0);
  do {
    const order = stageOrderForPage(page);
    for (const stage of order) {
      const locator = await firstVisibleLocator(candidates[stage], 0);
      if (locator) return { stage, locator, context: claimNavigationUrlContext(page?.url?.() || '') };
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 175));
  } while (true);
  return null;
}

async function maybeOpenNavigationMenu(page) {
  const locator = await firstVisibleLocator([
    page.getByRole('button', { name: LABELS.menu }),
    page.locator('button[aria-label*="menu" i], button[title*="menu" i], [role="button"][aria-label*="navigation" i]')
  ], 750);
  if (!locator) return false;
  try {
    await locator.click({ timeout: 2500 });
  } catch (_) {
    await locator.evaluate(element => (element.closest('button, [role="button"]') || element).click()).catch(() => {});
  }
  await page.waitForTimeout(300).catch(() => {});
  return true;
}

module.exports = {
  LABELS,
  isCanadaPostUrl,
  looksLikeLoginUrl,
  classifyAuthenticatedSnapshot,
  claimNavigationUrlContext,
  stageOrderForPage,
  locatorVisible,
  firstVisibleLocator,
  findClaimNavigationStage,
  maybeOpenNavigationMenu
};
