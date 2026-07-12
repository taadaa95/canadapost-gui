const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DUPLICATE_CLAIM_FIX_VERSION = 'hardening-v30-eligibility-idempotency-audit';

function emit(type, payload = {}) {
  process.stdout.write(JSON.stringify({ type, ...payload }) + '\n');
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values.map(value => value.trim());
}

function readClaims(csvPath) {
  const csvText = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').trim();
  const lines = csvText.split(/\r?\n/).filter(Boolean);

  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);

  return lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    const row = { _csvRowNumber: index + 2 };
    headers.forEach((header, headerIndex) => {
      row[header] = values[headerIndex] || '';
    });
    return row;
  });
}

function required(row, columnName) {
  const value = row[columnName];
  if (!value) throw new Error(`Missing required column value "${columnName}" on CSV row ${row._csvRowNumber}`);
  return String(value).trim();
}

function normalizePostalCode(value) {
  return String(value).replace(/\s+/g, '').toUpperCase();
}

function stopRequested() {
  const stopFile = process.env.STOP_FILE;
  return stopFile && fs.existsSync(stopFile);
}


function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function claimStatePaths(dataDir) {
  return {
    state: path.resolve(dataDir, 'claim-state.json'),
    audit: path.resolve(dataDir, 'claim-history.jsonl')
  };
}

function loadClaimState(dataDir) {
  const paths = claimStatePaths(dataDir);
  const state = readJson(paths.state, { version: 1, claims: {} });
  if (!state.claims || typeof state.claims !== 'object') state.claims = {};
  return { paths, state };
}

function recordClaimState(store, trackingNumber, patch) {
  const previous = store.state.claims[trackingNumber] || { trackingNumber, attempts: 0 };
  const next = { ...previous, ...patch, trackingNumber, updatedAt: new Date().toISOString() };
  store.state.claims[trackingNumber] = next;
  writeJsonAtomic(store.paths.state, store.state);
  fs.appendFileSync(store.paths.audit, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  try { fs.chmodSync(store.paths.audit, 0o600); } catch (_) {}
  return next;
}

function isTerminalClaimState(status) {
  // An interrupted in-progress submission has an unknown remote outcome. Never
  // retry it automatically; require reconciliation in Canada Post first.
  return status === 'in_progress' || status === 'submitted' || status === 'already_submitted' || status === 'unknown';
}

function isCanadaPostUrl(value) {
  try {
    const parsed = new URL(String(value));
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host === 'canadapost-postescanada.ca' || host.endsWith('.canadapost-postescanada.ca'));
  } catch (_) {
    return false;
  }
}

function assertCanadaPostPage(page, label = 'Canada Post page') {
  const url = page?.url?.() || '';
  if (!isCanadaPostUrl(url)) throw new Error(`${label} is outside the allowed Canada Post domain: ${url || 'blank URL'}`);
}


const BUILTIN_BROWSER_MODE = String(process.env.BROWSER_MODE || '').toLowerCase() === 'builtin';
const BACKGROUND_BROWSER_MODE = false;
const IS_LINUX = process.platform === 'linux';
const ELECTRON_CDP_URL = String(process.env.ELECTRON_CDP_URL || '');
const CANADAPOST_LOGIN_URL = 'https://www.canadapost-postescanada.ca/lfe-cap/en/login?stepupId=smb_mode1,consumer,commercial_link,smb_link&sourceUrl=https:%2F%2Fwww.canadapost-postescanada.ca%2Fdash%2Fen&targetUrl=https:%2F%2Fwww.canadapost-postescanada.ca%2Fdash%2Fen&authlvl=&language=en';

function backgroundBrowserArgs() {
  const args = [
    '--window-size=1280,900',
    '--window-position=-32000,-32000',
    '--disable-features=CalculateNativeWinOcclusion'
  ];

  // Do not force XWayland by default. Canada Post's login risk checks can be
  // sensitive to browser/fingerprint changes, and forcing a different platform
  // backend may trigger extra text verification. Keep the browser as normal as
  // possible and use a persistent profile instead.
  if (IS_LINUX && String(process.env.FORCE_XWAYLAND || '').toLowerCase() === 'true') {
    args.push('--ozone-platform=x11');
  }

  return args;
}

async function launchClaimContext(dataDir) {
  const userDataDir = path.resolve(dataDir, 'browser-profile');
  fs.mkdirSync(userDataDir, { recursive: true });

  const launchOptions = {
    headless: false,
    args: BACKGROUND_BROWSER_MODE ? backgroundBrowserArgs() : ['--window-size=1280,900'],
  };

  try {
    return await chromium.launchPersistentContext(userDataDir, launchOptions);
  } catch (error) {
    emit('log', { message: `Persistent browser profile failed, using temporary profile: ${error.message}` });
    const fallbackUserDataDir = path.resolve(dataDir, `browser-profile-temp-${Date.now()}`);
    fs.mkdirSync(fallbackUserDataDir, { recursive: true });
    return chromium.launchPersistentContext(fallbackUserDataDir, launchOptions);
  }
}

async function setBrowserWindowBounds(page, bounds) {
  if (!page || !page.context) return false;
  let client = null;
  try {
    client = await page.context().newCDPSession(page);
    const targetWindow = await client.send('Browser.getWindowForTarget').catch(() => null);
    if (!targetWindow || targetWindow.windowId === undefined) return false;
    await client.send('Browser.setWindowBounds', { windowId: targetWindow.windowId, bounds });
    return true;
  } catch (_) {
    return false;
  } finally {
    if (client) await client.detach().catch(() => {});
  }
}

async function hideBrowserWindow(page) {
  if (!BACKGROUND_BROWSER_MODE || !page) return;

  // Try several non-destructive hiding strategies. Different desktop/window
  // managers honor different Chrome DevTools window commands.
  await page.waitForTimeout(150).catch(() => {});
  const minimized = await setBrowserWindowBounds(page, { windowState: 'minimized' }).catch(() => false);
  const offscreen = await setBrowserWindowBounds(page, { left: -32000, top: -32000, width: 1280, height: 900 }).catch(() => false);

  if (!minimized && !offscreen) {
    emit('log', { message: 'Background browser mode could not hide the browser on this desktop environment. It will still restore normally for CAPTCHA handling.' });
  }
}

async function revealBrowserWindow(page) {
  if (!page) return;
  if (BACKGROUND_BROWSER_MODE) {
    await setBrowserWindowBounds(page, { windowState: 'normal' }).catch(() => {});
    await setBrowserWindowBounds(page, { left: 80, top: 80, width: 1280, height: 900 }).catch(() => {});
  }
  await page.bringToFront().catch(() => {});
}

async function findBuiltinBrowserPage(browser, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pages = browser.contexts().flatMap(context => context.pages());

    const canadaPostPage = pages.find(page => isCanadaPostUrl(page.url()));
    if (canadaPostPage) return canadaPostPage;

    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

async function openClaimBrowser(dataDir) {
  if (BUILTIN_BROWSER_MODE) {
    if (!ELECTRON_CDP_URL) throw new Error('Built-in browser connection endpoint was not provided by the Electron main process.');
    emit('log', { message: 'Built-in browser panel requested. Canada Post should appear inside the Step 3 browser pane.' });
    emit('log', { message: `Connecting claim runner to Electron built-in browser over CDP: ${ELECTRON_CDP_URL}` });

    const browser = await chromium.connectOverCDP(ELECTRON_CDP_URL);
    const page = await findBuiltinBrowserPage(browser);
    if (!page) {
      throw new Error('Built-in browser panel was not found. Open Step 3, keep “Use built-in browser inside the app” checked, then run Step 3 again.');
    }

    assertCanadaPostPage(page, 'Built-in browser page');
    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(60000);
    await page.bringToFront().catch(() => {});
    return { page, close: async () => {} };
  }

  const context = await launchClaimContext(dataDir);
  const page = await context.newPage();
  return { page, close: async () => context.close().catch(() => {}) };
}

function envValue(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

const CLAIM_USER_SETTINGS = {
  streetNumber: envValue('CLAIM_STREET_NUMBER'),
  streetName: envValue('CLAIM_STREET_NAME'),
  addressLine2: envValue('CLAIM_ADDRESS_LINE2'),
  city: envValue('CLAIM_CITY'),
  province: envValue('CLAIM_PROVINCE'),
  postalCode: envValue('CLAIM_POSTAL_CODE'),
  contactName: envValue('CLAIM_CONTACT_NAME'),
  contactPhone: envValue('CLAIM_CONTACT_PHONE'),
  contactEmail: envValue('CLAIM_CONTACT_EMAIL'),
  businessName: envValue('CLAIM_BUSINESS_NAME')
};

function requiredSetting(value, label) {
  const clean = String(value || '').trim();
  if (!clean) throw new Error(`Missing user setting: ${label}. Open the User Settings tab and save the claim address/settings first.`);
  return clean;
}


function getClaimsToRun(allClaims, dataDir) {
  const store = loadClaimState(dataDir);
  const seen = new Set();
  const selected = [];

  for (const claim of allClaims) {
    const tracking = String(claim['Tracking PIN'] || '').trim();
    const status = String(claim.Status || '').trim().toUpperCase();
    const deliveryDate = String(claim['Actual Delivery Date'] || '').trim();
    if (!tracking || seen.has(tracking)) {
      emit('claim_skipped', { row: claim._csvRowNumber, trackingNumber: tracking || '—', reason: tracking ? 'Duplicate row in claims.csv.' : 'Missing tracking PIN.' });
      continue;
    }
    seen.add(tracking);
    if (status !== 'ELIGIBLE - DELIVERED LATE' || !deliveryDate) {
      emit('claim_skipped', { row: claim._csvRowNumber, trackingNumber: tracking, reason: 'Row is not an eligible delivered-late claim.' });
      continue;
    }
    const existing = store.state.claims[tracking];
    if (existing && isTerminalClaimState(existing.status)) {
      if (existing.status === 'in_progress') {
        recordClaimState(store, tracking, {
          status: 'unknown',
          message: 'A previous run ended while this claim was in progress. Reconcile the outcome in Canada Post before retrying.'
        });
      }
      emit('claim_skipped', { row: claim._csvRowNumber, trackingNumber: tracking, reason: `Local claim state is ${existing.status}; manual reconciliation is required before retry.` });
      continue;
    }
    const maxAttempts = Math.max(1, Number.parseInt(process.env.MAX_CLAIM_ATTEMPTS || '3', 10) || 3);
    if (existing?.status === 'failed' && Number(existing.attempts || 0) >= maxAttempts) {
      emit('claim_skipped', { row: claim._csvRowNumber, trackingNumber: tracking, reason: `Local retry limit reached (${maxAttempts} attempts); manual review is required.` });
      continue;
    }
    selected.push(claim);
  }

  const maxClaimsRaw = process.env.MAX_CLAIMS;
  let limited = selected;
  if (maxClaimsRaw) {
    const maxClaims = Number.parseInt(maxClaimsRaw, 10);
    if (Number.isInteger(maxClaims) && maxClaims > 0) limited = selected.slice(0, maxClaims);
  }
  return { claims: limited, store };
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasAnyPattern(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

const DUPLICATE_PATTERNS = [
  /inquiry of this type already exists/i,
  /already received a refund request/i,
  /refund request for this package/i,
  /refund request.*already.*(?:received|submitted|exists)/i,
  /(?:claim|inquiry|request).*already.*(?:exists|submitted|received)/i,
  /already.*(?:claim|inquiry|refund request).*tracking number/i
];

const SUCCESS_PATTERNS = [
  /(?:service\s*)?ticket\s*(?:number|#)\s*[:#]?\s*[a-z0-9-]{4,}/i,
  /confirmation\s*(?:number|#)\s*[:#]?\s*[a-z0-9-]{4,}/i,
  /your\s+(?:service\s*)?ticket\s+(?:has been|was)\s+(?:created|submitted|received)/i,
  /thank you[^.]{0,160}(?:request|ticket|inquiry)[^.]{0,120}(?:submitted|received|created)/i,
  /(?:request|inquiry)[^.]{0,120}(?:has been|was)\s+(?:submitted|received|created)/i
];

const FAILURE_PATTERNS = [
  /there (?:is|are) (?:an? )?(?:error|errors) on (?:the|this) page/i,
  /(?:unable|not able) to (?:create|submit|process)/i,
  /(?:cannot|can not|can't) (?:create|submit|process)/i,
  /not eligible/i,
  /something went wrong/i,
  /please give us a call/i,
  /try again later/i,
  /technical (?:error|problem|issue)/i
];

async function login(page, username, password) {
  emit('log', { message: 'Opening Canada Post login page.' });
  await page.goto(CANADAPOST_LOGIN_URL);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await acceptCookiesIfVisible(page);

  const usernameBox = page.getByRole('textbox', { name: 'Username' });
  const usernameVisible = await usernameBox.first().isVisible({ timeout: 5000 }).catch(() => false);

  if (!usernameVisible) {
    const text = await collectVisibleText(page).catch(() => '');
    if (/sign out|dashboard|my profile|my account/i.test(text)) {
      emit('log', { message: 'Already logged in through saved browser session.' });
      return;
    }
    // The login page sometimes redirects straight into a text/email verification
    // challenge before showing normal account controls.
    if (await isTextVerificationPresent(page)) {
      await waitForTextVerificationToClear(page);
      return;
    }
  }

  await usernameBox.click();
  await usernameBox.fill(username);
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await acceptCookiesIfVisible(page, { quiet: true });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  emit('log', { message: 'Login submitted.' });

  if (await isTextVerificationPresent(page)) {
    await waitForTextVerificationToClear(page);
  }
}


let cookieAcceptLogCount = 0;

async function acceptCookiesIfVisible(page, options = {}) {
  if (!page) return false;

  const { quiet = false } = options;

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

      const visible = element => {
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
        .filter(visible)
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

      if (!best) return '';
      best.scrollIntoView({ block: 'center', inline: 'center' });
      best.click();
      return labelFor(best) || 'Accept all';
    }).catch(() => '');
  }

  let clickedLabel = '';
  for (const frame of page.frames()) {
    clickedLabel = await clickInFrame(frame);
    if (clickedLabel) break;
  }

  if (!clickedLabel) return false;
  await page.waitForTimeout(350).catch(() => {});
  if (!quiet && cookieAcceptLogCount < 5) {
    cookieAcceptLogCount += 1;
    emit('log', { message: `Cookie banner detected; clicked ${clickedLabel}.` });
  }
  return true;
}

async function navigateToLatePackageTicketLauncher(page) {
  emit('log', { message: 'Navigating to late package ticket launcher.' });
  await acceptCookiesIfVisible(page);
  await page.getByRole('link', { name: 'Support', exact: true }).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await acceptCookiesIfVisible(page, { quiet: true });
  await page.getByRole('button', { name: 'Lost, late or damaged' }).click();
  await acceptCookiesIfVisible(page, { quiet: true });
  await page.getByRole('link', { name: 'Package delivered late' }).click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await acceptCookiesIfVisible(page, { quiet: true });
}

async function openTicketPopup(page) {
  await acceptCookiesIfVisible(page);
  const popupPromise = page.waitForEvent('popup', { timeout: BUILTIN_BROWSER_MODE ? 8000 : 45000 }).catch(() => null);
  await page.getByRole('link', { name: 'Open a ticket. Opens in new' }).click();
  const claimPage = await popupPromise;
  if (claimPage) {
    await claimPage.waitForLoadState('domcontentloaded').catch(() => {});
    await acceptCookiesIfVisible(claimPage);
    return claimPage;
  }

  if (BUILTIN_BROWSER_MODE) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await acceptCookiesIfVisible(page);
    return page;
  }

  throw new Error('Canada Post ticket popup did not open. Check whether popups are blocked.');
}

async function getCaptchaState(page) {
  return page.evaluate(() => {
    const normalize = value => String(value || '').toLowerCase();
    const bodyText = normalize(document.body ? document.body.innerText : '');
    const html = normalize(document.documentElement ? document.documentElement.innerHTML : '');

    // Do not treat every reCAPTCHA iframe as a blocking challenge. Canada Post
    // can keep passive/invisible reCAPTCHA frames on the page after a normal
    // duplicate-claim banner appears. Only pause when an actual visible challenge
    // is active, such as the image grid / hCaptcha modal / "select all squares" prompt.
    const activeCaptchaTextPattern = /(select all squares|select all images|select each image|verify you are human|i'?m not a robot|try again|captcha challenge|hcaptcha challenge|recaptcha challenge)/i;
    const captchaAttrPattern = /(captcha|recaptcha|hcaptcha|arkose|challenge|api2\/anchor|api2\/bframe)/i;

    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 20
        && rect.height > 20;
    };

    const captchaFrames = [...document.querySelectorAll('iframe')]
      .map(frame => {
        const haystack = [
          frame.getAttribute('src'),
          frame.getAttribute('title'),
          frame.getAttribute('name'),
          frame.getAttribute('id'),
          frame.className
        ].map(normalize).join(' ');
        const rect = frame.getBoundingClientRect();
        const src = frame.getAttribute('src') || '';
        const title = frame.getAttribute('title') || '';
        const isCaptchaFrame = captchaAttrPattern.test(haystack);
        const isChallengeFrame = isCaptchaFrame && visible(frame) && (
          rect.height >= 160 ||
          normalize(src).includes('/bframe') ||
          normalize(src).includes('challenge') ||
          normalize(title).includes('challenge') ||
          normalize(title).includes('hcaptcha')
        );
        return {
          match: isCaptchaFrame,
          challenge: isChallengeFrame,
          visible: visible(frame),
          src,
          title,
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      })
      .filter(frame => frame.match && frame.visible);

    const visibleCaptchaWidgets = [...document.querySelectorAll('.g-recaptcha, [data-sitekey], [class*="captcha"], [id*="captcha"]')]
      .filter(visible)
      .length;

    const challengeDomWidgets = [...document.querySelectorAll('.rc-imageselect, .rc-audiochallenge, [class*="challenge"], [id*="challenge"]')]
      .filter(visible)
      .length;

    const challengeFrames = captchaFrames.filter(frame => frame.challenge);
    const bodyLooksLikeCaptcha = activeCaptchaTextPattern.test(bodyText);
    const htmlLooksLikeCaptcha = /(www\.google\.com\/recaptcha|recaptcha\/api|hcaptcha\.com)/i.test(html);
    const present = challengeFrames.length > 0 || challengeDomWidgets > 0 || bodyLooksLikeCaptcha;

    return {
      present,
      frameCount: challengeFrames.length,
      passiveFrameCount: captchaFrames.length - challengeFrames.length,
      widgetCount: visibleCaptchaWidgets,
      challengeWidgetCount: challengeDomWidgets,
      bodyLooksLikeCaptcha,
      htmlLooksLikeCaptcha,
      frames: challengeFrames.slice(0, 5),
      passiveFrames: captchaFrames.filter(frame => !frame.challenge).slice(0, 5)
    };
  }).catch(() => ({ present: false, frameCount: 0, passiveFrameCount: 0, widgetCount: 0, challengeWidgetCount: 0, bodyLooksLikeCaptcha: false, htmlLooksLikeCaptcha: false, frames: [] }));
}

async function isCaptchaPresent(page) {
  const state = await getCaptchaState(page);
  return !!state.present;
}

async function isTextVerificationPresent(page) {
  return page.evaluate(() => {
    const text = String(document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim();
    return /(verification code|security code|one[- ]?time code|two[- ]?step|2[- ]?step|text message|sms|enter the code|we sent.*code|verify your identity|confirm your identity)/i.test(text);
  }).catch(() => false);
}

async function waitForTextVerificationToClear(page) {
  await revealBrowserWindow(page);
  emit('log', { message: 'TEXT VERIFICATION detected. Complete the Canada Post verification in the visible browser. The app is paused and will resume after verification clears.' });

  const startedAt = Date.now();
  let lastReminderAt = startedAt;

  while (true) {
    if (stopRequested()) throw new Error('Stop requested while waiting for text verification.');

    const stillPresent = await isTextVerificationPresent(page);
    const text = await collectVisibleText(page).catch(() => '');
    const loggedIn = /sign out|dashboard|my profile|my account/i.test(text);

    if (!stillPresent || loggedIn) {
      const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
      emit('log', { message: `Text verification cleared after ${waitedSeconds} seconds. Resuming.` });
      await hideBrowserWindow(page);
      return;
    }

    if (Date.now() - lastReminderAt >= 30000) {
      lastReminderAt = Date.now();
      const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
      emit('log', { message: `Still waiting for manual text verification. Waited ${waitedSeconds} seconds.` });
    }

    await page.waitForTimeout(1000);
  }
}

async function waitForCaptchaScreenshotReady(page, maxWaitMs = 15000) {
  const startedAt = Date.now();
  let bestState = await getCaptchaState(page);
  let largeChallengeSeenAt = 0;
  let lastStableSignature = '';
  let stableSince = 0;

  while (Date.now() - startedAt < maxWaitMs) {
    if (stopRequested()) break;

    await page.waitForTimeout(500);
    const state = await getCaptchaState(page);
    bestState = state;

    // The first reCAPTCHA checkbox/anchor iframe can be small and visible before
    // the real image challenge opens. Wait for the larger challenge iframe so
    // the saved screenshot actually shows the CAPTCHA tiles/prompt.
    const frames = Array.isArray(state.frames) ? state.frames : [];
    const largeChallengeVisible = frames.some(frame => {
      const src = String(frame.src || '').toLowerCase();
      const title = String(frame.title || '').toLowerCase();
      return frame.visible
        && (frame.width >= 250 || frame.height >= 180)
        && (frame.height >= 180 || src.includes('/bframe') || title.includes('challenge'));
    });

    const textChallengeVisible = !!state.bodyLooksLikeCaptcha && !!state.present;
    const signature = JSON.stringify(frames.map(frame => [frame.width, frame.height, frame.title]).slice(0, 5));

    if (signature !== lastStableSignature) {
      lastStableSignature = signature;
      stableSince = Date.now();
    }

    if (largeChallengeVisible || textChallengeVisible) {
      if (!largeChallengeSeenAt) largeChallengeSeenAt = Date.now();
      const visibleForMs = Date.now() - largeChallengeSeenAt;
      const stableForMs = Date.now() - stableSince;

      // Let the challenge image grid finish painting before the screenshot.
      if (visibleForMs >= 1800 && stableForMs >= 800) {
        await page.waitForTimeout(750);
        return state;
      }
    }
  }

  return bestState;
}

async function waitForCaptchaToClear(page, trackingNumber, rowNumber, dataDir) {
  const screenshotPath = BUILTIN_BROWSER_MODE ? '' : path.resolve(dataDir, `claim-captcha-row-${rowNumber}.png`);

  await revealBrowserWindow(page);
  emit('captcha_waiting', {
    trackingNumber,
    row: rowNumber,
    waitedSeconds: 0,
    message: BUILTIN_BROWSER_MODE
      ? `CAPTCHA detected for ${trackingNumber}. The app is paused so you can solve it in the built-in browser.`
      : `CAPTCHA detected for ${trackingNumber}. Waiting briefly for the challenge to fully render before saving the screenshot.`
  });

  const state = await waitForCaptchaScreenshotReady(page, 15000);

  // In built-in browser mode, a Playwright screenshot can temporarily break
  // mouse/keyboard focus inside Electron's BrowserView on some Linux/Wayland
  // desktops. The user can already see the challenge in-app, so skip the
  // CAPTCHA screenshot here and keep the embedded browser interactive.
  if (!BUILTIN_BROWSER_MODE) {
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  }

  await revealBrowserWindow(page);

  emit('captcha_detected', {
    trackingNumber,
    row: rowNumber,
    screenshotPath,
    frameCount: state.frameCount || 0,
    widgetCount: state.widgetCount || 0,
    message: BUILTIN_BROWSER_MODE
      ? 'CAPTCHA detected. Solve it manually in the built-in browser. Screenshot capture was skipped to keep the CAPTCHA interactive.'
      : 'CAPTCHA detected. Solve it manually in the visible browser window. The app is paused and will resume after the CAPTCHA clears.'
  });

  const startedAt = Date.now();
  let lastReminderAt = startedAt;

  while (true) {
    if (stopRequested()) {
      throw new Error('Stop requested while waiting for CAPTCHA.');
    }

    const currentState = await getCaptchaState(page);
    if (!currentState.present) {
      const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
      emit('captcha_cleared', {
        trackingNumber,
        row: rowNumber,
        waitedSeconds,
        message: `CAPTCHA cleared after ${waitedSeconds} seconds. Resuming claim result detection.`
      });
      await hideBrowserWindow(page);
      return;
    }

    if (Date.now() - lastReminderAt >= 30000) {
      lastReminderAt = Date.now();
      const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
      emit('captcha_waiting', {
        trackingNumber,
        row: rowNumber,
        waitedSeconds,
        message: `Still waiting for manual CAPTCHA solve for ${trackingNumber}. Waited ${waitedSeconds} seconds.`
      });
    }

    await page.waitForTimeout(1000);
  }
}

async function fillTextboxByRole(page, namePattern, value, timeoutMs = 5000) {
  const clean = String(value || '').trim();
  if (!clean) return false;
  const input = page.getByRole('textbox', { name: namePattern }).first();
  await input.fill(clean, { timeout: timeoutMs });
  return true;
}

async function maybeFillByRoleTextbox(page, namePattern, value) {
  const clean = String(value || '').trim();
  if (!clean) return false;
  const input = page.getByRole('textbox', { name: namePattern }).first();
  const handle = await input.elementHandle({ timeout: 200 }).catch(() => null);
  if (!handle) return false;

  // Canada Post often auto-fills city/province/postal fields as disabled inputs.
  // Check editability in the page immediately instead of using Playwright's
  // actionability waiters, which can add visible delays on disabled fields.
  const fillable = await handle.evaluate((element) => {
    if (!element || element.disabled || element.readOnly) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number.parseFloat(style.opacity || '1') > 0
      && rect.width > 2
      && rect.height > 2;
  }).catch(() => false);

  if (!fillable) return false;

  try {
    await input.fill(clean, { timeout: 700 });
    return true;
  } catch (_) {
    return false;
  }
}

function scoreStreetOrProvinceOption(optionText, wantedText) {
  function normalizeText(input) {
    return String(input || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&amp;#39;|&#39;|’|`/g, "'")
      .toLowerCase()
      .replace(/\b(rue|street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|court|ct|crescent|cres|lane|ln|way|place|pl)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function compact(input) {
    return normalizeText(input).replace(/\s+/g, '');
  }

  const optionNorm = normalizeText(optionText);
  const wantedNorm = normalizeText(wantedText);
  const optionCompact = compact(optionText);
  const wantedCompact = compact(wantedText);
  const wantedTokens = wantedNorm.split(/\s+/).filter(token => token.length >= 2);

  if (!wantedNorm || !optionNorm) return -1;
  if (optionNorm === wantedNorm || optionCompact === wantedCompact) return 1000;
  if (optionNorm.includes(wantedNorm) || optionCompact.includes(wantedCompact)) return 900;
  if (wantedNorm.includes(optionNorm) || wantedCompact.includes(optionCompact)) return 800;

  const hits = wantedTokens.filter(token => optionNorm.includes(token)).length;
  if (wantedTokens.length && hits === wantedTokens.length) return 700 + hits;
  if (wantedTokens.length >= 2 && hits >= Math.ceil(wantedTokens.length * 0.75)) return 500 + hits;
  if (wantedTokens.length === 1 && hits === 1 && wantedTokens[0].length >= 4) return 400;

  return -1;
}

async function maybeSelectByLabel(page, labelPattern, value) {
  const clean = String(value || '').trim();
  if (!clean) return false;
  const selectLocator = page.getByLabel(labelPattern).first();
  const handle = await selectLocator.elementHandle({ timeout: 250 }).catch(() => null);
  if (!handle) return false;

  const usable = await handle.evaluate((element) => {
    if (!element || element.disabled) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number.parseFloat(style.opacity || '1') > 0
      && rect.width > 2
      && rect.height > 2;
  }).catch(() => false);

  if (!usable) return false;

  // Use fast in-page option matching first. Playwright selectOption can wait for
  // exact values/labels that will never exist, adding seconds to every claim.
  const selected = await selectLocator.evaluate((select, wanted) => {
    function normalizeText(input) {
      return String(input || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&amp;#39;|&#39;|’|`/g, "'")
        .toLowerCase()
        .replace(/\b(rue|street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|court|ct|crescent|cres|lane|ln|way|place|pl)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    }

    function compact(input) {
      return normalizeText(input).replace(/\s+/g, '');
    }

    function tokenScore(optionText, wantedText) {
      const optionNorm = normalizeText(optionText);
      const wantedNorm = normalizeText(wantedText);
      const optionCompact = compact(optionText);
      const wantedCompact = compact(wantedText);
      const wantedTokens = wantedNorm.split(/\s+/).filter(token => token.length >= 2);

      if (!wantedNorm || !optionNorm) return -1;
      if (optionNorm === wantedNorm || optionCompact === wantedCompact) return 1000;
      if (optionNorm.includes(wantedNorm) || optionCompact.includes(wantedCompact)) return 900;
      if (wantedNorm.includes(optionNorm) || wantedCompact.includes(optionCompact)) return 800;

      const hits = wantedTokens.filter(token => optionNorm.includes(token)).length;
      if (wantedTokens.length && hits === wantedTokens.length) return 700 + hits;
      if (wantedTokens.length >= 2 && hits >= Math.ceil(wantedTokens.length * 0.75)) return 500 + hits;
      if (wantedTokens.length === 1 && hits === 1 && wantedTokens[0].length >= 4) return 400;

      return -1;
    }

    const rawNeedle = String(wanted || '').trim();
    const options = [...select.options].filter(option => {
      const text = String(option.textContent || '').trim();
      const value = String(option.value || '').trim();
      return text && value && !/^(select|choose|--)/i.test(text);
    });

    let best = null;
    for (const option of options) {
      const optionText = String(option.textContent || '').trim();
      const optionValue = String(option.value || '').trim();
      const score = Math.max(tokenScore(optionText, rawNeedle), tokenScore(optionValue, rawNeedle));
      if (score < 0) continue;
      const current = { option, score, lengthPenalty: Math.abs(compact(optionText).length - compact(rawNeedle).length) };
      if (!best || current.score > best.score || (current.score === best.score && current.lengthPenalty < best.lengthPenalty)) best = current;
    }

    if (!best) return false;
    select.value = best.option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, clean).catch(() => false);

  if (selected) return true;

  // Fallback only, with very short timeouts.
  try {
    await selectLocator.selectOption(clean, { timeout: 500 });
    return true;
  } catch (_) {}

  try {
    await selectLocator.selectOption({ label: clean }, { timeout: 500 });
    return true;
  } catch (_) {}

  return false;
}

async function fillOptionalClaimUserSettings(page) {
  await maybeFillByRoleTextbox(page, /(?:address line 2|suite|unit|apartment)/i, CLAIM_USER_SETTINGS.addressLine2);
  await maybeFillByRoleTextbox(page, /city/i, CLAIM_USER_SETTINGS.city);
  await maybeFillByRoleTextbox(page, /postal code/i, CLAIM_USER_SETTINGS.postalCode);
  await maybeSelectByLabel(page, /province|territory/i, CLAIM_USER_SETTINGS.province);
  await maybeFillByRoleTextbox(page, /(?:contact name|name)/i, CLAIM_USER_SETTINGS.contactName);
  await maybeFillByRoleTextbox(page, /(?:phone|telephone)/i, CLAIM_USER_SETTINGS.contactPhone);
  await maybeFillByRoleTextbox(page, /e-?mail|email/i, CLAIM_USER_SETTINGS.contactEmail);
  await maybeFillByRoleTextbox(page, /(?:business legal name|business name|company)/i, CLAIM_USER_SETTINGS.businessName);
}

async function clickVisibleContinue(page, timeout = 45000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeout) {
    if (stopRequested()) throw new Error('Stop requested while clicking Continue.');

    await acceptCookiesIfVisible(page, { quiet: true });

    const remaining = Math.max(500, timeout - (Date.now() - startedAt));
    const candidates = [
      page.locator('input[type="submit"][value="Continue"]:visible'),
      page.locator('input[type="button"][value="Continue"]:visible'),
      page.locator('button:visible').filter({ hasText: /^\s*Continue\s*$/i }),
      page.locator('a:visible').filter({ hasText: /^\s*Continue\s*$/i })
    ];

    for (const locator of candidates) {
      try {
        const count = Math.min(await locator.count(), 10);
        for (let index = 0; index < count; index += 1) {
          const candidate = locator.nth(index);
          if (!(await candidate.isVisible().catch(() => false))) continue;
          await candidate.scrollIntoViewIfNeeded({ timeout: Math.min(remaining, 3000) }).catch(() => {});
          await candidate.click({ timeout: Math.min(remaining, 5000) });
          return;
        }
      } catch (error) {
        lastError = error;
      }
    }

    await page.waitForTimeout(250);
  }

  const suffix = lastError && lastError.message ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Could not click the real Continue submit button.${suffix}`);
}

async function fillClaim(claimPage, claim) {
  await acceptCookiesIfVisible(claimPage);

  const receiverPostalCode = normalizePostalCode(required(claim, 'Destination Postal Code'));
  const trackingNumber = required(claim, 'Tracking PIN');
  const referenceNumber = required(claim, 'Reference #');

  await claimPage.getByLabel('Receiver\'s country *').selectOption('CA', { timeout: 5000 });

  await fillTextboxByRole(claimPage, 'Receiver\'s postal code *', receiverPostalCode, 5000);
  await fillTextboxByRole(claimPage, 'Tracking number *', trackingNumber, 5000);

  await clickVisibleContinue(claimPage);

  await fillTextboxByRole(claimPage, 'Reference Number 1', referenceNumber, 5000);

  await clickVisibleContinue(claimPage);

  const senderStreetNumber = requiredSetting(CLAIM_USER_SETTINGS.streetNumber, 'claim sender street number');
  const senderStreetName = requiredSetting(CLAIM_USER_SETTINGS.streetName, 'claim sender street name / Canada Post street dropdown option');

  await fillTextboxByRole(claimPage, 'Street Number *', senderStreetNumber, 5000);

  const streetSelected = await maybeSelectByLabel(claimPage, 'Street Name *', senderStreetName);
  if (!streetSelected) {
    throw new Error(`Could not select claim sender street name "${senderStreetName}". Try entering only the main street name, for example "Charles Pimpare". The app now matches accents, punctuation, street suffixes, and close dropdown text automatically.`);
  }

  await fillOptionalClaimUserSettings(claimPage);

  await clickVisibleContinue(claimPage);
  await clickVisibleContinue(claimPage);
}

async function clickCreateTicket(claimPage) {
  await acceptCookiesIfVisible(claimPage);

  const createTicketLink = claimPage.getByRole('link', { name: /Create\s+Ticket/i });

  await createTicketLink.waitFor({ state: 'visible', timeout: 30000 });
  await createTicketLink.scrollIntoViewIfNeeded();
  await createTicketLink.click();
}


async function waitBeforeEvidenceScreenshot(page, delayMs = 2600) {
  const waitMs = Math.max(0, Number.parseInt(String(delayMs || 0), 10) || 0);

  // Give Canada Post's validation banners, modals, and page transitions enough
  // time to finish rendering before we capture evidence for the Notifications tab.
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
  if (waitMs > 0) await page.waitForTimeout(waitMs).catch(() => {});

  // Let the browser paint one more frame after the wait.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))).catch(() => {});
}

async function collectVisibleText(page) {
  const chunks = [];

  // Main document text.
  chunks.push(await page.locator('body').innerText({ timeout: 2500 }).catch(() => ''));

  // Some Canada Post pages render error banners inside frames. Collect frame text too.
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const frameText = await frame.locator('body').innerText({ timeout: 1500 }).catch(() => '');
    if (frameText) chunks.push(frameText);
  }

  // HTML fallback catches text that innerText may miss because of rendering/state quirks.
  chunks.push(await page.content().catch(() => ''));

  return oneLine(chunks.filter(Boolean).join(' '));
}

function classifyClaimOutcome(text) {
  if (hasAnyPattern(text, DUPLICATE_PATTERNS)) {
    return {
      status: 'already_submitted',
      ok: false,
      message: 'Claim already submitted: Canada Post says an inquiry/refund request already exists for this tracking number.'
    };
  }

  // Success is intentionally strict. The runner must see a real confirmation/ticket number.
  // Remaining on the Confirm and submit page is not a success.
  if (hasAnyPattern(text, SUCCESS_PATTERNS)) {
    return {
      status: 'submitted',
      ok: true,
      message: 'Canada Post accepted the claim and displayed a confirmation/ticket result.'
    };
  }

  if (hasAnyPattern(text, FAILURE_PATTERNS)) {
    return {
      status: 'failed',
      ok: false,
      message: 'Canada Post displayed an error/rejection after Create Ticket.'
    };
  }

  return null;
}

async function waitForClaimOutcome(claimPage, timeoutMs, trackingNumber, rowNumber, dataDir) {
  let startedAt = Date.now();
  let lastText = '';

  while (Date.now() - startedAt < timeoutMs) {
    await claimPage.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    await acceptCookiesIfVisible(claimPage, { quiet: true });

    if (await isCaptchaPresent(claimPage)) {
      await waitForCaptchaToClear(claimPage, trackingNumber, rowNumber, dataDir);
      // Do not count manual CAPTCHA time against the Canada Post result timeout.
      startedAt = Date.now();
      continue;
    }

    lastText = await collectVisibleText(claimPage);

    const outcome = classifyClaimOutcome(lastText);
    if (outcome) return { ...outcome, pageText: lastText.slice(0, 4000) };

    await claimPage.waitForTimeout(750);
  }

  return {
    status: 'unknown',
    ok: false,
    message: `No Canada Post confirmation or known rejection was detected within ${Math.round(timeoutMs / 1000)} seconds. This was not counted as submitted.`,
    pageText: lastText.slice(0, 4000)
  };
}

async function saveClaimArtifacts(claimPage, dataDir, prefix, rowNumber, pageText = '', screenshotDelayMs = 0) {
  const screenshotPath = path.resolve(dataDir, `${prefix}-row-${rowNumber}.png`);
  const textPath = path.resolve(dataDir, `${prefix}-row-${rowNumber}.txt`);

  if (screenshotDelayMs > 0) await waitBeforeEvidenceScreenshot(claimPage, screenshotDelayMs).catch(() => {});
  await acceptCookiesIfVisible(claimPage, { quiet: true });
  await claimPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  if (pageText) fs.writeFileSync(textPath, pageText + '\n');

  return { screenshotPath, textPath: pageText ? textPath : '' };
}

async function processClaim(page, claim, index, total) {
  const dataDir = process.env.DATA_DIR || process.cwd();
  const trackingNumber = required(claim, 'Tracking PIN');
  const receiverPostalCode = normalizePostalCode(required(claim, 'Destination Postal Code'));
  const referenceNumber = required(claim, 'Reference #');
  const afterSubmitMs = Number.parseInt(process.env.AFTER_SUBMIT_MS || '20000', 10);

  emit('claim_start', { index: index + 1, total, row: claim._csvRowNumber, trackingNumber, receiverPostalCode, referenceNumber });

  const claimPage = await openTicketPopup(page);
  await hideBrowserWindow(claimPage);

  try {
    await fillClaim(claimPage, claim);

    emit('log', { message: `Clicking Create Ticket for ${trackingNumber}.` });
    await clickCreateTicket(claimPage);

    const resultTimeoutMs = Math.max(afterSubmitMs, 45000);
    emit('claim_wait', { trackingNumber, ms: resultTimeoutMs, mode: 'wait_for_canada_post_confirmation_or_duplicate_error' });

    const outcome = await waitForClaimOutcome(claimPage, resultTimeoutMs, trackingNumber, claim._csvRowNumber, dataDir);

    if (outcome.status === 'submitted') {
      const artifacts = await saveClaimArtifacts(claimPage, dataDir, 'claim-submitted', claim._csvRowNumber, outcome.pageText);
      emit('claim_submitted', {
        row: claim._csvRowNumber,
        trackingNumber,
        message: outcome.message,
        screenshotPath: artifacts.screenshotPath,
        textPath: artifacts.textPath
      });
      return {
        ok: true,
        status: 'submitted',
        row: claim._csvRowNumber,
        trackingNumber,
        message: outcome.message,
        screenshotPath: artifacts.screenshotPath,
        textPath: artifacts.textPath
      };
    }

    if (outcome.status === 'already_submitted') {
      const artifacts = await saveClaimArtifacts(claimPage, dataDir, 'claim-already-submitted', claim._csvRowNumber, outcome.pageText);
      emit('claim_already_submitted', {
        row: claim._csvRowNumber,
        trackingNumber,
        message: outcome.message,
        screenshotPath: artifacts.screenshotPath,
        textPath: artifacts.textPath
      });
      return {
        ok: false,
        status: 'already_submitted',
        row: claim._csvRowNumber,
        trackingNumber,
        error: outcome.message,
        screenshotPath: artifacts.screenshotPath,
        textPath: artifacts.textPath
      };
    }

    const artifacts = await saveClaimArtifacts(claimPage, dataDir, 'claim-error', claim._csvRowNumber, outcome.pageText, 2600);
    const errorMessage = outcome.pageText ? `${outcome.message} Page text saved to ${artifacts.textPath}` : outcome.message;
    emit('claim_error', {
      row: claim._csvRowNumber,
      trackingNumber,
      message: errorMessage,
      screenshotPath: artifacts.screenshotPath,
      textPath: artifacts.textPath
    });
    return {
      ok: false,
      status: outcome.status || 'failed',
      row: claim._csvRowNumber,
      trackingNumber,
      error: errorMessage,
      screenshotPath: artifacts.screenshotPath,
      textPath: artifacts.textPath
    };
  } catch (error) {
    const screenshotPath = path.resolve(dataDir, `claim-error-row-${claim._csvRowNumber}.png`);
    await waitBeforeEvidenceScreenshot(claimPage, 2600);
    await claimPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    emit('claim_error', { row: claim._csvRowNumber, trackingNumber, message: error.message, screenshotPath });
    return { ok: false, status: 'failed', row: claim._csvRowNumber, trackingNumber, error: error.message, screenshotPath };
  } finally {
    if (!BUILTIN_BROWSER_MODE && claimPage !== page) {
      await claimPage.close().catch(() => {});
    }
  }
}

async function main() {
  const dataDir = process.env.DATA_DIR || process.cwd();
  const csvPath = process.env.CLAIMS_CSV || path.resolve(dataDir, 'claims.csv');
  const allClaims = readClaims(csvPath);
  const selection = getClaimsToRun(allClaims, dataDir);
  const claimsToRun = selection.claims;
  const claimStore = selection.store;

  const username = process.env.CANADAPOST_USERNAME;
  const password = process.env.CANADAPOST_PASSWORD;

  if (!username || !password) throw new Error('Missing CANADAPOST_USERNAME or CANADAPOST_PASSWORD.');
  requiredSetting(CLAIM_USER_SETTINGS.streetNumber, 'claim sender street number');
  requiredSetting(CLAIM_USER_SETTINGS.streetName, 'claim sender street name / Canada Post street dropdown option');

  if (claimsToRun.length === 0) {
    emit('submit_complete', { total: 0, succeeded: 0, alreadySubmitted: 0, failed: 0 });
    return;
  }

  emit('submit_start', { total: claimsToRun.length, claimsCsv: csvPath, version: DUPLICATE_CLAIM_FIX_VERSION });
  emit('log', { message: `Duplicate-claim detector active: ${DUPLICATE_CLAIM_FIX_VERSION}` });
  if (BUILTIN_BROWSER_MODE) {
    emit('log', { message: 'Using built-in Electron browser panel for Step 3.' });
    emit('log', { message: 'Using the app browser session for Canada Post login, verification, and claim submission.' });
  } else {
    emit('log', { message: 'Using external visible Chromium browser for Step 3.' });
    emit('log', { message: 'Using saved Playwright browser profile: data/browser-profile. This reduces repeated Canada Post text verification prompts after the first successful verification.' });
  }

  const browserSession = await openClaimBrowser(dataDir);
  const page = browserSession.page;
  await hideBrowserWindow(page);
  const results = [];

  try {
    await login(page, username, password);
    await hideBrowserWindow(page);
    await navigateToLatePackageTicketLauncher(page);
    await hideBrowserWindow(page);

    for (let i = 0; i < claimsToRun.length; i++) {
      if (stopRequested()) {
        emit('submit_stopped', { index: i, total: claimsToRun.length });
        break;
      }

      const trackingNumber = required(claimsToRun[i], 'Tracking PIN');
      const previous = claimStore.state.claims[trackingNumber] || {};
      recordClaimState(claimStore, trackingNumber, {
        status: 'in_progress',
        attempts: Number(previous.attempts || 0) + 1,
        csvRow: claimsToRun[i]._csvRowNumber,
        startedAt: new Date().toISOString()
      });
      const result = await processClaim(page, claimsToRun[i], i, claimsToRun.length);
      results.push(result);
      const durableStatus = result.status === 'submitted' || result.status === 'already_submitted'
        ? result.status
        : (result.status === 'failed' ? 'failed' : 'unknown');
      recordClaimState(claimStore, trackingNumber, {
        status: durableStatus,
        completedAt: new Date().toISOString(),
        message: result.message || result.error || '',
        screenshotPath: result.screenshotPath || '',
        textPath: result.textPath || ''
      });

      if (i < claimsToRun.length - 1 && !stopRequested()) {
        const delayMs = Number.parseInt(process.env.BETWEEN_CLAIMS_MS || '2000', 10);
        await page.waitForTimeout(delayMs);
        if (BUILTIN_BROWSER_MODE) {
          await login(page, username, password);
          await navigateToLatePackageTicketLauncher(page);
        }
      }
    }
  } catch (error) {
    const screenshotPath = path.resolve(dataDir, `claim-error-row-global-${Date.now()}.png`);
    const textPath = path.resolve(dataDir, `claim-error-row-global-${Date.now()}.txt`);
    let pageText = '';
    await waitBeforeEvidenceScreenshot(page, 2600).catch(() => {});
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    pageText = await collectVisibleText(page).catch(() => '');
    if (pageText) fs.writeFileSync(textPath, pageText + '\n');
    const message = `Claim process error: ${error.message}`;
    emit('claim_error', {
      row: 'global',
      trackingNumber: '—',
      message,
      screenshotPath,
      textPath: pageText ? textPath : ''
    });
    results.push({
      ok: false,
      status: 'failed',
      row: 'global',
      trackingNumber: '—',
      error: message,
      screenshotPath,
      textPath: pageText ? textPath : ''
    });
  } finally {
    await browserSession.close().catch(() => {});
  }

  const summaryPath = path.resolve(dataDir, 'claim-run-summary.json');
  const archivedSummaryPath = path.resolve(dataDir, `claim-run-summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeJsonAtomic(summaryPath, results);
  writeJsonAtomic(archivedSummaryPath, results);

  const succeeded = results.filter(result => result.ok).length;
  const alreadySubmitted = results.filter(result => result.status === 'already_submitted').length;
  const failed = results.filter(result => !result.ok && result.status !== 'already_submitted').length;
  emit('submit_complete', { total: results.length, succeeded, alreadySubmitted, failed, summaryPath });

  // Already-submitted is a valid Canada Post business result, not an automation crash.
  // Exit non-zero only for unknown/real failures.
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    emit('error', { message: error.message, stack: error.stack });
    process.exitCode = 1;
  });
}

module.exports = {
  parseCsvLine,
  readClaims,
  getClaimsToRun,
  isTerminalClaimState,
  isCanadaPostUrl
};
