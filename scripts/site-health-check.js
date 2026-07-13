'use strict';

const { chromium } = require('playwright');
const {
  isCanadaPostUrl,
  classifyAuthenticatedSnapshot,
  findClaimNavigationStage,
  maybeOpenNavigationMenu
} = require('../lib/canadapost-navigation');
const { findLoginControls, describeEditableControls } = require('../lib/canadapost-login');
const { readRuntimeSecrets } = require('../lib/runtime-secrets');

const CDP_URL = String(process.env.ELECTRON_CDP_URL || '');
const TARGET_TOKEN = String(process.env.ELECTRON_TARGET_TOKEN || '');
let USERNAME = String(process.env.CANADAPOST_USERNAME || '');
let PASSWORD = String(process.env.CANADAPOST_PASSWORD || '');
const LOGIN_URL = 'https://www.canadapost-postescanada.ca/lfe-cap/en/login?stepupId=smb_mode1,consumer,commercial_link,smb_link&sourceUrl=https:%2F%2Fwww.canadapost-postescanada.ca%2Fdash%2Fen&targetUrl=https:%2F%2Fwww.canadapost-postescanada.ca%2Fdash%2Fen&authlvl=&language=en';

function emit(type, payload = {}) {
  process.stdout.write(JSON.stringify({ type, ...payload }) + '\n');
}

async function pageText(page) {
  return String(await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
}

async function visible(locator, timeout = 1500) {
  if (!locator) return false;
  return locator.first().isVisible({ timeout }).catch(() => false);
}

async function acceptCookiesIfVisible(page) {
  if (!page) return false;

  async function clickInFrame(frame) {
    return frame.evaluate(() => {
      const labels = [
        /^\s*accept all\s*$/i,
        /\baccept all\b/i,
        /^\s*tout accepter\s*$/i,
        /\btout accepter\b/i,
        /\baccepter tout\b/i,
        /\ballow all\b/i,
        /\bagree and continue\b/i
      ];

      const visibleElement = element => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number.parseFloat(style.opacity || '1') > 0
          && rect.width > 12
          && rect.height > 12;
      };

      const labelFor = element => [
        element.textContent,
        element.value,
        element.getAttribute('aria-label'),
        element.getAttribute('title')
      ].map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');

      const candidates = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a, [role="button"]')]
        .filter(visibleElement)
        .filter(element => labels.some(pattern => pattern.test(labelFor(element))));

      const cookieContext = /cookie|cookies|cookie policy|current cookie settings|privacy preference|consent|t[eé]moins|fichiers t[eé]moins/i;
      const best = candidates.find(element => {
        const context = [
          element.closest('[role="dialog"]')?.innerText,
          element.closest('[class*="cookie" i]')?.innerText,
          element.closest('[id*="cookie" i]')?.innerText,
          element.closest('[class*="consent" i]')?.innerText,
          element.closest('[id*="consent" i]')?.innerText,
          document.body?.innerText
        ].map(value => String(value || '')).join(' ');
        return cookieContext.test(context);
      }) || candidates[0];

      if (!best) return false;
      best.scrollIntoView({ block: 'center', inline: 'center' });
      best.click();
      return true;
    }).catch(() => false);
  }

  for (const frame of page.frames()) {
    if (await clickInFrame(frame)) {
      await page.waitForTimeout(400).catch(() => {});
      return true;
    }
  }
  return false;
}

async function activateControl(page, locator, options = {}) {
  const control = locator.first();
  const label = String(options.label || 'Expected control');
  const timeout = Number(options.timeout || 7000);

  await acceptCookiesIfVisible(page);
  await control.waitFor({ state: 'visible', timeout });
  await control.scrollIntoViewIfNeeded().catch(() => {});

  try {
    await control.click({ timeout: Math.min(timeout, 6000) });
    return 'pointer';
  } catch (pointerError) {
    await acceptCookiesIfVisible(page);

    if (options.keyboardTarget) {
      try {
        await options.keyboardTarget.focus();
        await options.keyboardTarget.press('Enter');
        return 'keyboard';
      } catch (_) {}
    }

    try {
      await control.evaluate(element => (element.closest('a, button, [role="link"], [role="button"]') || element).click());
      return 'dom';
    } catch (domError) {
      const error = new Error(`${label} was found, but the page prevented it from being activated. A cookie banner, loading overlay, or page animation may still be covering it.`);
      error.code = 'CONTROL_BLOCKED';
      error.detail = String(pointerError?.message || domError?.message || '');
      throw error;
    }
  }
}

function classifyHealthError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (code === 'CONTROL_BLOCKED') return { code, status: 'warning', message };
  if (/timeout|locator/i.test(message)) return { code: 'SELECTOR_MISSING', status: 'failed', message };
  return { code: code || 'HEALTH_CHECK_FAILED', status: 'failed', message };
}

function classifyPage(text, url) {
  if (/temporarily unavailable|service unavailable|maintenance|try again later|technical difficulties/i.test(text)) {
    return { code: 'TEMPORARY_OUTAGE', status: 'failed', message: 'Canada Post appears temporarily unavailable.' };
  }
  if (/incorrect|invalid|does not match|unable to sign in|authentication failed/i.test(text) && /password|username|sign in/i.test(text)) {
    return { code: 'INCORRECT_CREDENTIALS', status: 'failed', message: 'Canada Post rejected the saved username or password.' };
  }
  if (/verification code|send.*code|text message|security code/i.test(text)) {
    return { code: 'VERIFICATION_REQUIRED', status: 'warning', message: 'Canada Post requires manual text/email verification.' };
  }
  if (/captcha|verify you are human|i'?m not a robot/i.test(text)) {
    return { code: 'CAPTCHA_PENDING', status: 'warning', message: 'A CAPTCHA challenge is active.' };
  }
  if (!isCanadaPostUrl(url)) {
    return { code: 'UNEXPECTED_DOMAIN', status: 'failed', message: 'The browser is not on an approved Canada Post domain.' };
  }
  return null;
}


function shouldResetToCanonicalEntry(authState, navigation, loginVisible) {
  return !navigation && !loginVisible && authState?.authenticated === null;
}

function redactDiagnosticText(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:\d[ -]?){10,}\b/g, '[number]')
    .replace(/\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi, '[postal-code]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

async function diagnosticSnapshot(page) {
  const title = redactDiagnosticText(await page.title().catch(() => ''));
  const controls = await page.locator('a, button, [role="link"], [role="button"]').evaluateAll(elements => {
    const visible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
    };
    return elements.filter(visible).slice(0, 20).map(element => ({
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || element.textContent || element.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 120),
      href: element.tagName.toLowerCase() === 'a' ? String(element.getAttribute('href') || '').slice(0, 240) : ''
    }));
  }).catch(() => []);

  const editableControls = await describeEditableControls(page).catch(() => []);

  return {
    title,
    url: page.url(),
    visibleControls: controls.map(control => ({
      tag: control.tag,
      text: redactDiagnosticText(control.text),
      href: redactDiagnosticText(control.href)
    })).filter(control => control.text || control.href).slice(0, 12),
    editableControls: editableControls.map(control => ({
      tag: redactDiagnosticText(control.tag),
      type: redactDiagnosticText(control.type),
      name: redactDiagnosticText(control.name),
      id: redactDiagnosticText(control.id),
      autocomplete: redactDiagnosticText(control.autocomplete),
      placeholder: redactDiagnosticText(control.placeholder),
      ariaLabel: redactDiagnosticText(control.ariaLabel),
      formControlName: redactDiagnosticText(control.formControlName)
    }))
  };
}

async function findPage(browser) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const pages = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
    if (TARGET_TOKEN) {
      for (const candidate of pages) {
        const token = await candidate.evaluate(() => window.name).catch(() => '');
        if (token === TARGET_TOKEN) return candidate;
      }
    }
    const canadaPostPages = pages.filter(candidate => isCanadaPostUrl(candidate.url()));
    if (canadaPostPages.length === 1) return canadaPostPages[0];
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

async function findNavigationWithMenuFallback(page, timeout = 6000) {
  let navigation = await findClaimNavigationStage(page, timeout);
  if (navigation) return navigation;
  if (await maybeOpenNavigationMenu(page)) navigation = await findClaimNavigationStage(page, 3500);
  return navigation;
}

async function advanceToLateControl(page, initialNavigation) {
  let navigation = initialNavigation;
  const visited = [];

  for (let step = 0; step < 4; step += 1) {
    if (!navigation) navigation = await findNavigationWithMenuFallback(page, 5500);
    if (!navigation) return { navigation: null, visited };
    visited.push(navigation.stage);

    if (navigation.stage === 'late' || navigation.stage === 'ticket') return { navigation, visited };

    await activateControl(page, navigation.locator, {
      label: navigation.stage === 'support' ? 'Canada Post support control' : 'Lost, late or damaged control',
      timeout: 8000
    });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(500).catch(() => {});
    await acceptCookiesIfVisible(page);
    navigation = await findClaimNavigationStage(page, 7000);
  }

  return { navigation, visited };
}

async function main() {
  const runtimeSecrets = await readRuntimeSecrets();
  USERNAME = runtimeSecrets.username;
  PASSWORD = runtimeSecrets.password;
  if (!CDP_URL) throw Object.assign(new Error('Built-in browser endpoint is unavailable.'), { code: 'BROWSER_UNAVAILABLE' });
  emit('health_start', { message: 'Checking Canada Post login and claim-navigation controls.' });
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = await findPage(browser);
  if (!page) throw Object.assign(new Error('Canada Post browser page was not found.'), { code: 'BROWSER_UNAVAILABLE' });

  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(30000);
  if (!isCanadaPostUrl(page.url()) || page.url() === 'about:blank') {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  }

  await acceptCookiesIfVisible(page);
  let text = await pageText(page);
  let classification = classifyPage(text, page.url());
  if (classification?.status === 'failed') {
    emit('health_complete', { ok: false, ...classification, url: page.url() });
    process.exitCode = 1;
    return;
  }

  let loginControls = await findLoginControls(page, 3000);
  let usernameBox = loginControls.usernameBox;
  let passwordBox = loginControls.passwordBox;
  let signInButton = loginControls.signInButton;
  let loginVisible = loginControls.recognized;
  let loginMethod = '';

  if (loginVisible) {
    if (!USERNAME || !PASSWORD) {
      emit('health_complete', {
        ok: true,
        status: 'warning',
        code: 'AUTHENTICATION_REQUIRED',
        message: 'The Canada Post login page is compatible, but a saved password is unavailable. Sign in manually in the built-in browser, then run the health check again.',
        checks: { domain: true, loginControls: true, authenticatedNavigation: false },
        url: page.url()
      });
      return;
    }
    if (!usernameBox || !passwordBox || !signInButton) {
      emit('health_complete', {
        ok: true,
        status: 'warning',
        code: 'AUTHENTICATION_REQUIRED',
        message: 'The Canada Post login page is available, but its current controls are not safely automatable. Sign in manually in the built-in browser, then run the health check again.',
        checks: { domain: true, loginPage: true, automatedLoginControls: false, authenticatedNavigation: false },
        url: page.url(),
        snapshot: await diagnosticSnapshot(page)
      });
      return;
    }

    await usernameBox.fill(USERNAME);
    await passwordBox.fill(PASSWORD);
    loginMethod = await activateControl(page, signInButton, {
      label: 'Canada Post Sign in button',
      keyboardTarget: passwordBox,
      timeout: 10000
    });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await usernameBox.waitFor({ state: 'hidden', timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(900);
    text = await pageText(page);
    classification = classifyPage(text, page.url());
    if (classification) {
      emit('health_complete', { ok: classification.status !== 'failed', ...classification, loginMethod, url: page.url() });
      if (classification.status === 'failed') process.exitCode = 1;
      return;
    }
    if (await visible(usernameBox, 500)) {
      emit('health_complete', {
        ok: true,
        status: 'warning',
        code: 'LOGIN_NOT_COMPLETED',
        message: 'The Sign in action was sent, but Canada Post remained on the login page. The page may still be processing or require manual verification.',
        checks: { domain: true, loginControls: true, loginAction: true, authenticatedNavigation: false },
        loginMethod,
        url: page.url()
      });
      return;
    }
  }

  await acceptCookiesIfVisible(page);
  let navigation = await findNavigationWithMenuFallback(page, 8000);
  text = await pageText(page);
  let authState = classifyAuthenticatedSnapshot({
    url: page.url(),
    text,
    loginVisible: loginVisible,
    passwordVisible: Boolean(passwordBox),
    navigationStage: navigation?.stage || ''
  });

  if (shouldResetToCanonicalEntry(authState, navigation, loginVisible)) {
    emit('health_progress', {
      message: 'The current Canada Post page is not a recognizable login or claim page. Reopening the canonical login/dashboard entry point.'
    });

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900).catch(() => {});
    await acceptCookiesIfVisible(page);
    text = await pageText(page);
    classification = classifyPage(text, page.url());
    if (classification?.status === 'failed') {
      emit('health_complete', { ok: false, ...classification, loginMethod: loginMethod || undefined, url: page.url() });
      process.exitCode = 1;
      return;
    }

    loginControls = await findLoginControls(page, 3000);
    usernameBox = loginControls.usernameBox;
    passwordBox = loginControls.passwordBox;
    signInButton = loginControls.signInButton;
    loginVisible = loginControls.recognized;
    if (loginVisible) {
      if (!USERNAME || !PASSWORD) {
        emit('health_complete', {
          ok: true,
          status: 'warning',
          code: 'AUTHENTICATION_REQUIRED',
          message: 'The health check recovered to the Canada Post login page, but a saved password is unavailable. Sign in manually in the built-in browser, then run the health check again.',
          checks: { domain: true, loginControls: true, authenticatedNavigation: false },
          snapshot: await diagnosticSnapshot(page)
        });
        return;
      }
      if (!usernameBox || !passwordBox || !signInButton) {
        emit('health_complete', {
          ok: true,
          status: 'warning',
          code: 'AUTHENTICATION_REQUIRED',
          message: 'The canonical Canada Post login page is available, but its current controls are not safely automatable. Sign in manually in the built-in browser, then run the health check again.',
          checks: { domain: true, loginPage: true, automatedLoginControls: false, authenticatedNavigation: false },
          snapshot: await diagnosticSnapshot(page)
        });
        return;
      }

      await usernameBox.fill(USERNAME);
      await passwordBox.fill(PASSWORD);
      loginMethod = await activateControl(page, signInButton, {
        label: 'Canada Post Sign in button',
        keyboardTarget: passwordBox,
        timeout: 10000
      });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await usernameBox.waitFor({ state: 'hidden', timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(900).catch(() => {});
      text = await pageText(page);
      classification = classifyPage(text, page.url());
      if (classification) {
        emit('health_complete', {
          ok: classification.status !== 'failed',
          ...classification,
          loginMethod,
          url: page.url(),
          snapshot: await diagnosticSnapshot(page)
        });
        if (classification.status === 'failed') process.exitCode = 1;
        return;
      }
      if (await visible(usernameBox, 500)) {
        emit('health_complete', {
          ok: true,
          status: 'warning',
          code: 'LOGIN_NOT_COMPLETED',
          message: 'The health check recovered to the login page and sent the Sign in action, but Canada Post remained on the login page.',
          checks: { domain: true, loginControls: true, loginAction: true, authenticatedNavigation: false },
          loginMethod,
          snapshot: await diagnosticSnapshot(page)
        });
        return;
      }
    }

    navigation = await findNavigationWithMenuFallback(page, 9000);
    text = await pageText(page);
    authState = classifyAuthenticatedSnapshot({
      url: page.url(),
      text,
      loginVisible: loginVisible,
      passwordVisible: Boolean(passwordBox),
      navigationStage: navigation?.stage || ''
    });
  }

  if (!navigation) {
    if (authState.authenticated === true) {
      emit('health_complete', {
        ok: false,
        status: 'failed',
        code: 'CLAIM_NAVIGATION_CHANGED',
        message: 'Authentication appears valid, but no recognizable support or late-delivery claim control was found. Canada Post may have changed the claim-navigation layout.',
        checks: { domain: true, authenticated: true, claimNavigation: false },
        authenticatedSignal: authState.signal,
        loginMethod: loginMethod || undefined,
        url: page.url()
      });
      process.exitCode = 1;
      return;
    }

    emit('health_complete', {
      ok: true,
      status: 'warning',
      code: 'AUTH_STATE_UNCONFIRMED',
      message: 'The health check reopened the canonical Canada Post entry point but still could not identify login controls or authenticated claim navigation. The attached snapshot identifies the current page state for diagnosis.',
      checks: { domain: true, authenticated: false, claimNavigation: false, canonicalEntryRetried: true },
      authenticatedSignal: authState.signal,
      loginMethod: loginMethod || undefined,
      url: page.url(),
      snapshot: await diagnosticSnapshot(page)
    });
    return;
  }

  const result = await advanceToLateControl(page, navigation);
  navigation = result.navigation;
  if (!navigation || !['late', 'ticket'].includes(navigation.stage)) {
    emit('health_complete', {
      ok: false,
      status: 'failed',
      code: 'CLAIM_NAVIGATION_CHANGED',
      message: 'Canada Post authentication is valid, but the health check could not reach the late-delivery claim control using the current navigation.',
      checks: { domain: true, authenticated: true, claimNavigation: false },
      navigationVisited: result.visited,
      loginMethod: loginMethod || undefined,
      url: page.url()
    });
    process.exitCode = 1;
    return;
  }

  emit('health_complete', {
    ok: true,
    status: 'healthy',
    code: 'HEALTHY',
    message: navigation.stage === 'ticket'
      ? 'Canada Post authentication and the late-delivery ticket launcher are compatible.'
      : 'Canada Post authentication and the late-delivery claim navigation are compatible.',
    checks: {
      domain: true,
      authenticated: true,
      claimNavigation: true,
      latePackageControl: true,
      ticketLauncher: navigation.stage === 'ticket'
    },
    authenticatedSignal: authState.signal,
    navigationVisited: result.visited,
    loginMethod: loginMethod || undefined,
    url: page.url()
  });
}

function finishCli(exit = code => process.exit(code), stdout = process.stdout) {
  const code = Number.isInteger(process.exitCode) ? process.exitCode : 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    exit(code);
  };
  const timer = setTimeout(finish, 250);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    // Queue an empty write after all JSON events so they flush before the
    // health-check child forcibly drops its persistent CDP connection.
    stdout.write('', finish);
  } catch (_) {
    finish();
  }
}

if (require.main === module) {
  main().catch(error => {
    const classification = classifyHealthError(error);
    emit('health_complete', {
      ok: classification.status === 'warning',
      ...classification,
      detail: error.detail || undefined
    });
    if (classification.status === 'failed') process.exitCode = 1;
  }).finally(() => finishCli());
}

module.exports = {
  isCanadaPostUrl,
  classifyPage,
  classifyHealthError,
  acceptCookiesIfVisible,
  activateControl,
  findNavigationWithMenuFallback,
  advanceToLateControl,
  shouldResetToCanonicalEntry,
  diagnosticSnapshot,
  findLoginControls,
  finishCli
};
