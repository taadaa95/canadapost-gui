const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const claimDb = require('../lib/claim-database');
const claimQueue = require('../lib/claim-queue');
const { verifyQueueSnapshot, revalidateQueueItem } = require('../lib/eligibility-revalidation');
const { findClaimNavigationStage, maybeOpenNavigationMenu, classifyAuthenticatedSnapshot, claimNavigationUrlContext } = require('../lib/canadapost-navigation');
const { findLoginControls } = require('../lib/canadapost-login');
const { readRuntimeSecrets } = require('../lib/runtime-secrets');
const { Step3Diagnostics, sanitizeUrl } = require('../lib/step3-diagnostics');
const { isAllowedCanadaPostUrl, portalUrl } = require('../lib/origin-policy');
const { faultPoint } = require('../lib/fault-injection');
const { waitForExactPageTarget } = require('../lib/cdp-page-target');

const DUPLICATE_CLAIM_FIX_VERSION = 'hardening-v35-navigation-stability';
let diagnostics = null;
const LATE_PACKAGE_SUPPORT_URL = portalUrl(
  'https://www.canadapost-postescanada.ca/cpc/en/support/kb/claims/late-packages.page',
  '/cpc/en/support/kb/claims/late-packages.page'
);

function automationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function diag(level, category, action, details = {}, options = {}) {
  return diagnostics?.record(level, category, action, details, options) || null;
}

function emit(type, payload = {}) {
  process.stdout.write(JSON.stringify({ type, ...payload }) + '\n');
  if (diagnostics && !['diagnostics_started', 'diagnostics_complete'].includes(type)) {
    diagnostics.record(type === 'error' || type === 'claim_error' ? 'error' : 'info', 'worker-event', type, payload, { critical: type === 'error' || type === 'claim_error' });
  }
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


function manualInteractionTimeoutMs() {
  const parsed = Number.parseInt(String(process.env.MANUAL_INTERACTION_TIMEOUT_MS || ''), 10);
  const value = Number.isFinite(parsed) ? parsed : 15 * 60 * 1000;
  return Math.max(60 * 1000, Math.min(60 * 60 * 1000, value));
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}


const isCanadaPostUrl = isAllowedCanadaPostUrl;

function assertCanadaPostPage(page, label = 'Canada Post page') {
  const url = page?.url?.() || '';
  if (!isCanadaPostUrl(url)) throw new Error(`${label} is outside the allowed Canada Post domain: ${url || 'blank URL'}`);
}


const BUILTIN_BROWSER_MODE = String(process.env.BROWSER_MODE || '').toLowerCase() === 'builtin';
const DRY_RUN_MODE = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
const BACKGROUND_BROWSER_MODE = false;
const IS_LINUX = process.platform === 'linux';
const ELECTRON_CDP_URL = String(process.env.ELECTRON_CDP_URL || '');
const ELECTRON_TARGET_ID = String(process.env.ELECTRON_TARGET_ID || '');
const ELECTRON_TARGET_NONCE = String(process.env.ELECTRON_TARGET_NONCE || '');
const ELECTRON_TARGET_WEB_CONTENTS_HASH = String(process.env.ELECTRON_TARGET_WEB_CONTENTS_HASH || '');
const BROWSER_VISIBILITY_ACK_FILE = String(process.env.BROWSER_VISIBILITY_ACK_FILE || '');
const CANADAPOST_LOGIN_URL = portalUrl(
  'https://www.canadapost-postescanada.ca/lfe-cap/en/login?stepupId=smb_mode1,consumer,commercial_link,smb_link&sourceUrl=https:%2F%2Fwww.canadapost-postescanada.ca%2Fdash%2Fen&targetUrl=https:%2F%2Fwww.canadapost-postescanada.ca%2Fdash%2Fen&authlvl=&language=en',
  '/login'
);

async function requireBuiltinBrowserVisibility(kind, message) {
  if (!BUILTIN_BROWSER_MODE) return { visible: true, requestId: '' };
  if (!BROWSER_VISIBILITY_ACK_FILE) throw automationError('BROWSER_VISIBILITY_REQUIRED', 'The browser visibility acknowledgement path was not provided by Electron.');
  const requestId = crypto.randomUUID();
  emit('manual_verification_required', {
    requestId,
    kind: String(kind || 'verification'),
    message: String(message || 'Manual verification is required in the visible built-in browser.')
  });
  diag('info', 'browser', 'manual-verification-display-requested', {
    requestId,
    kind: String(kind || 'verification'),
    webContentsIdentityHash: ELECTRON_TARGET_WEB_CONTENTS_HASH
  }, { critical: true });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (stopRequested()) throw automationError('STOP_REQUESTED', 'Stop requested while preparing the browser for manual verification.');
    try {
      const acknowledgement = JSON.parse(fs.readFileSync(BROWSER_VISIBILITY_ACK_FILE, 'utf8'));
      if (acknowledgement.requestId === requestId) {
        if (acknowledgement.visible && acknowledgement.webContentsIdentityHash === ELECTRON_TARGET_WEB_CONTENTS_HASH) {
          diag('info', 'browser', 'manual-verification-display-ready', {
            requestId,
            kind: String(kind || 'verification'),
            webContentsIdentityHash: ELECTRON_TARGET_WEB_CONTENTS_HASH
          }, { critical: true });
          return acknowledgement;
        }
        throw automationError(
          acknowledgement.errorCode || 'BROWSER_VISIBILITY_REQUIRED',
          'Manual verification is required, but the built-in browser could not be displayed safely.'
        );
      }
    } catch (error) {
      if (error?.code && !['ENOENT', 'EACCES'].includes(error.code) && error.name !== 'SyntaxError') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw automationError('BROWSER_VISIBILITY_REQUIRED', 'Manual verification is required, but browser display readiness was not confirmed.');
}

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

const guardedPages = new WeakSet();
const dryRunGuardPages = new WeakSet();

async function installCanadaPostNavigationGuard(page) {
  if (!page || guardedPages.has(page)) return;
  guardedPages.add(page);
  diagnostics?.attachPage(page, 'canada-post');

  // Electron's built-in BrowserView is guarded by the main process. External
  // Playwright pages need their own main-frame navigation interception.
  if (!BUILTIN_BROWSER_MODE) {
    await page.route('**/*', async route => {
      const request = route.request();
      const url = request.url();
      const isMainFrameNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
      if (isMainFrameNavigation && url !== 'about:blank' && !isCanadaPostUrl(url)) {
        emit('log', { message: `Blocked main-frame navigation outside Canada Post: ${url}` });
        diag('warn', 'security', 'navigation-blocked', { url: sanitizeUrl(url), source: 'playwright-route' }, { critical: true });
        await route.abort('blockedbyclient').catch(() => {});
        return;
      }
      await route.continue().catch(() => {});
    });
  }

  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (url === 'about:blank' || isCanadaPostUrl(url)) return;
    emit('log', { message: `Detected unexpected main-frame navigation outside Canada Post: ${url}` });
    diag('error', 'security', 'unexpected-navigation', { url: sanitizeUrl(url) }, { critical: true });
  });
  page.on('crash', () => {
    emit('log', { message: 'The Canada Post page renderer crashed. The active claim will be left for reconciliation.' });
    diag('error', 'browser', 'renderer-crashed', {}, { critical: true });
  });
  page.on('close', () => {
    emit('log', { message: 'The Canada Post claim page closed.' });
    diag('warn', 'browser', 'page-closed', {}, { critical: true });
  });
}

async function openClaimBrowser(dataDir) {
  if (BUILTIN_BROWSER_MODE) {
    if (!ELECTRON_CDP_URL) throw automationError('CDP_ENDPOINT_UNAVAILABLE', 'The current Electron debugging endpoint was not provided by the main process.');
    if (!ELECTRON_TARGET_ID || !ELECTRON_TARGET_NONCE) throw automationError('TARGET_NOT_PUBLISHED', 'The main process did not publish the exact Step 3 browser target identity.');
    emit('log', { message: 'Built-in browser panel requested. Canada Post should appear inside the Step 3 browser pane.' });
    emit('log', { message: 'Connecting to the exact built-in Step 3 browser target published by Electron.' });
    diag('info', 'browser', 'worker-handshake-started', {
      endpointProvided: true,
      targetIdentityProvided: true,
      webContentsIdentityHash: ELECTRON_TARGET_WEB_CONTENTS_HASH
    }, { critical: true });

    let browser;
    try { browser = await chromium.connectOverCDP(ELECTRON_CDP_URL); }
    catch (error) {
      throw automationError('CDP_CONNECTION_FAILURE', `The worker could not connect to the current Electron debugging endpoint: ${error.message}`);
    }
    let lastInventoryFingerprint = '';
    const selected = await waitForExactPageTarget(browser, {
      targetId: ELECTRON_TARGET_ID,
      targetNonce: ELECTRON_TARGET_NONCE,
      timeoutMs: 15000,
      onInventory: inventory => {
        const safeInventory = {
          attempt: inventory.attempt,
          targetCount: inventory.targetCount,
          pageTargetCount: inventory.pageTargetCount,
          typeCounts: inventory.typeCounts,
          publishedMatchCount: inventory.publishedMatchCount,
          exactMatchCount: inventory.exactMatchCount,
          candidates: inventory.candidates
        };
        const fingerprint = JSON.stringify({ ...safeInventory, attempt: 0 });
        if (fingerprint !== lastInventoryFingerprint) {
          lastInventoryFingerprint = fingerprint;
          diag('debug', 'browser', 'cdp-target-inventory', safeInventory);
        }
      }
    });
    const page = selected.page;
    if (page.isClosed()) throw automationError('TARGET_CLOSED_DURING_CONNECTION', 'The Step 3 browser target closed during connection.');
    diag('info', 'browser', 'target-attached', {
      attempts: selected.attempt,
      targetCount: selected.inventory.targetCount,
      pageTargetCount: selected.inventory.pageTargetCount,
      exactMatchCount: selected.inventory.exactMatchCount,
      webContentsIdentityHash: ELECTRON_TARGET_WEB_CONTENTS_HASH
    }, { critical: true });
    page.once('close', () => diag('error', 'browser', 'target-closed', {
      webContentsIdentityHash: ELECTRON_TARGET_WEB_CONTENTS_HASH
    }, { critical: true }));

    if (page.url() === 'about:blank' || page.url().startsWith('about:blank#')) {
      await page.goto(CANADAPOST_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    await installCanadaPostNavigationGuard(page);
    assertCanadaPostPage(page, 'Built-in browser page');
    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(60000);
    await page.bringToFront().catch(() => {});
    return { page, close: async () => {} };
  }

  const context = await launchClaimContext(dataDir);
  context.on('page', page => installCanadaPostNavigationGuard(page).catch(() => {}));
  const page = await context.newPage();
  await installCanadaPostNavigationGuard(page);
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

function policySettings() {
  return {
    claimStreetNumber: CLAIM_USER_SETTINGS.streetNumber,
    claimStreetName: CLAIM_USER_SETTINGS.streetName,
    claimAddressLine2: CLAIM_USER_SETTINGS.addressLine2,
    claimCity: CLAIM_USER_SETTINGS.city,
    claimProvince: CLAIM_USER_SETTINGS.province,
    claimPostalCode: CLAIM_USER_SETTINGS.postalCode,
    claimContactName: CLAIM_USER_SETTINGS.contactName,
    claimContactPhone: CLAIM_USER_SETTINGS.contactPhone,
    claimContactEmail: CLAIM_USER_SETTINGS.contactEmail,
    claimBusinessName: CLAIM_USER_SETTINGS.businessName
  };
}

function requiredSetting(value, label) {
  const clean = String(value || '').trim();
  if (!clean) throw new Error(`Missing user setting: ${label}. Open the User Settings tab and save the claim address/settings first.`);
  return clean;
}


function getClaimsToRun(allClaims, dataDir, dbPath = process.env.DATABASE_PATH) {
  const seen = new Set();
  const selected = [];
  const dryRun = DRY_RUN_MODE;

  if (dbPath) {
    claimDb.importLegacyData(dbPath, dataDir);
    claimDb.markInterruptedAttempts(dbPath);
    claimDb.quarantineLegacyDryRunReadyAttempts(dbPath);
  }

  for (const claim of allClaims) {
    const tracking = String(claim['Tracking PIN'] || '').trim();
    const status = String(claim.Status || '').trim().toUpperCase();
    if (!tracking || seen.has(tracking)) {
      emit('claim_skipped', { row: claim._csvRowNumber, trackingNumber: tracking || '—', reason: tracking ? 'Duplicate row in claims.csv.' : 'Missing tracking PIN.' });
      continue;
    }
    seen.add(tracking);
    if (!status.startsWith('LATE CANDIDATE')) {
      emit('claim_skipped', { row: claim._csvRowNumber, trackingNumber: tracking, reason: 'Row is not a LATE_CANDIDATE classification.' });
      continue;
    }
    if (!dryRun && dbPath) {
      const maxAttempts = Math.max(1, Number.parseInt(process.env.MAX_CLAIM_ATTEMPTS || '3', 10) || 3);
      const decision = claimDb.canAutomaticallyAttempt(dbPath, tracking, maxAttempts);
      if (!decision.allowed) {
        emit('claim_skipped', { row: claim._csvRowNumber, trackingNumber: tracking, reason: decision.reason });
        continue;
      }
    }
    selected.push(claim);
  }

  const maxClaimsRaw = process.env.MAX_CLAIMS;
  let limited = selected;
  if (maxClaimsRaw) {
    const maxClaims = Number.parseInt(maxClaimsRaw, 10);
    if (Number.isInteger(maxClaims) && maxClaims > 0) limited = selected.slice(0, maxClaims);
  }
  return { claims: limited, dbPath };
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

const REJECTION_PATTERNS = [
  /not eligible/i,
  /does not qualify/i,
  /ineligible/i,
  /request (?:was|has been) (?:declined|rejected)/i,
  /claim (?:was|has been) (?:declined|rejected)/i
];

function extractConfirmationNumber(text) {
  const source = String(text || '');
  const patterns = [
    /(?:service\s*)?ticket\s*(?:number|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})/i,
    /confirmation\s*(?:number|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1] && !/^(?:has|been|created|submitted|received)$/i.test(match[1])) return match[1];
  }
  return '';
}

function classifyAutomationFailure(error, text = '', url = '') {
  const explicitCode = String(error?.code || '');
  const message = String(error?.message || error || 'Unknown automation failure');
  const combined = `${message} ${text}`;

  const explicit = {
    STOP_REQUESTED: { errorCode: 'STOP_REQUESTED', status: 'unknown' },
    INCORRECT_CREDENTIALS: { errorCode: 'INCORRECT_CREDENTIALS', status: 'failed' },
    AUTHENTICATION_NOT_COMPLETED: { errorCode: 'AUTHENTICATION_NOT_COMPLETED', status: 'unknown' },
    AUTHENTICATION_EXPIRED: { errorCode: 'AUTHENTICATION_EXPIRED', status: 'unknown' },
    AUTHENTICATION_VERIFICATION_TIMEOUT: { errorCode: 'AUTHENTICATION_VERIFICATION_TIMEOUT', status: 'unknown' },
    CAPTCHA_TIMEOUT: { errorCode: 'CAPTCHA_TIMEOUT', status: 'unknown' },
    UNEXPECTED_LAYOUT: { errorCode: 'UNEXPECTED_LAYOUT', status: 'unknown' },
    CLAIM_FORM_NOT_READY: { errorCode: 'CLAIM_FORM_NOT_READY', status: 'failed' },
    COUNTRY_SELECTION_FAILED: { errorCode: 'COUNTRY_SELECTION_FAILED', status: 'failed' },
    DRY_RUN_SAFETY_BLOCK: { errorCode: 'DRY_RUN_SAFETY_BLOCK', status: 'unknown' },
    FINAL_ACTION_GUARD: { errorCode: 'FINAL_ACTION_GUARD', status: 'unknown' },
    CLAIM_NAVIGATION_CHANGED: { errorCode: 'CLAIM_NAVIGATION_CHANGED', status: 'failed' },
    CLAIM_NAVIGATION_STALLED: { errorCode: 'CLAIM_NAVIGATION_STALLED', status: 'failed' },
    CLAIM_TICKET_LAUNCHER_NOT_FOUND: { errorCode: 'CLAIM_TICKET_LAUNCHER_NOT_FOUND', status: 'failed' }
  };
  if (explicit[explicitCode]) return explicit[explicitCode];

  if (/incorrect|invalid|unable to sign in|authentication failed/i.test(combined) && /username|password|sign in/i.test(combined)) {
    return { errorCode: 'INCORRECT_CREDENTIALS', status: 'failed' };
  }
  if (/temporarily unavailable|service unavailable|maintenance|technical difficulties|try again later|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(combined)) {
    return { errorCode: 'TEMPORARY_OUTAGE', status: 'failed' };
  }
  if (/claim navigation|ticket launcher|late package ticket|late-delivery support page/i.test(message)) {
    return { errorCode: 'CLAIM_NAVIGATION_CHANGED', status: 'failed' };
  }
  if (/captcha|verify you are human|i'?m not a robot/i.test(combined)) {
    return { errorCode: 'CAPTCHA_PENDING', status: 'unknown' };
  }
  if (/verification code|text verification|security code/i.test(combined)) {
    return { errorCode: 'AUTHENTICATION_VERIFICATION_REQUIRED', status: 'unknown' };
  }
  if (hasAnyPattern(combined, REJECTION_PATTERNS)) {
    return { errorCode: 'CLAIM_REJECTED', status: 'rejected' };
  }
  if (/validation|already exists|already received a refund request/i.test(combined)) {
    return { errorCode: 'KNOWN_VALIDATION_ERROR', status: 'failed' };
  }
  if (/locator|selector|strict mode|waiting for|getByRole|getByLabel|not found|could not click/i.test(combined)) {
    return { errorCode: 'SELECTOR_MISSING', status: 'failed' };
  }
  if (/login|sign in|session|authentication/i.test(combined) || /\/login/i.test(String(url || ''))) {
    return { errorCode: 'AUTHENTICATION_EXPIRED', status: 'unknown' };
  }
  if (/outside the allowed Canada Post domain|unexpected page|layout/i.test(combined)) {
    return { errorCode: 'UNEXPECTED_LAYOUT', status: 'unknown' };
  }
  return { errorCode: 'AUTOMATION_FAILURE', status: 'failed' };
}


async function authenticationSnapshot(page, timeout = 1200) {
  const text = await collectVisibleText(page).catch(() => '');
  const controls = await findLoginControls(page, Math.min(timeout, 1200)).catch(() => ({ recognized: false }));
  const navigation = await findClaimNavigationStage(page, Math.min(timeout, 1200)).catch(() => null);
  const auth = classifyAuthenticatedSnapshot({
    url: page.url(),
    text,
    loginVisible: Boolean(controls.recognized),
    passwordVisible: Boolean(controls.passwordBox),
    navigationStage: navigation?.stage || ''
  });
  const signature = JSON.stringify({
    authenticated: auth.authenticated,
    signal: auth.signal || '',
    loginRecognized: Boolean(controls.recognized),
    usernameControl: Boolean(controls.usernameBox),
    passwordControl: Boolean(controls.passwordBox),
    submitControl: Boolean(controls.submitButton),
    navigationStage: navigation?.stage || '',
    url: sanitizeUrl(page.url())
  });
  if (signature !== lastAuthDiagnosticSignature || Date.now() - lastAuthDiagnosticAt >= 5000) {
    lastAuthDiagnosticSignature = signature;
    lastAuthDiagnosticAt = Date.now();
    diag('info', 'authentication', 'snapshot', JSON.parse(signature));
  }
  return { text, controls, navigation, auth };
}

async function waitForAuthenticatedState(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;

  while (Date.now() < deadline) {
    if (stopRequested()) {
      const error = new Error('Stop requested while waiting for Canada Post authentication.');
      error.code = 'STOP_REQUESTED';
      throw error;
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {});
    await acceptCookiesIfVisible(page, { quiet: true });

    if (await isTextVerificationPresent(page)) {
      await waitForTextVerificationToClear(page);
    }

    lastSnapshot = await authenticationSnapshot(page, 1500);
    if (lastSnapshot.auth.authenticated === true) return lastSnapshot;

    if (/incorrect|invalid|not recognized|unable to sign in|check your (?:username|password)/i.test(lastSnapshot.text)
      && /username|password|sign in/i.test(lastSnapshot.text)) {
      const error = new Error('Canada Post rejected the saved username or password.');
      error.code = 'INCORRECT_CREDENTIALS';
      throw error;
    }

    await page.waitForTimeout(500).catch(() => {});
  }

  const error = new Error('Canada Post did not confirm a signed-in session within the authentication timeout. Complete any visible verification and retry Step 3.');
  error.code = lastSnapshot?.controls?.recognized ? 'AUTHENTICATION_NOT_COMPLETED' : 'AUTHENTICATION_EXPIRED';
  throw error;
}

async function login(page, username, password) {
  assertCanadaPostPage(page, 'Canada Post browser');
  emit('log', { message: 'Checking Canada Post authentication.' });
  diag('info', 'authentication', 'check-started', { url: sanitizeUrl(page.url()) });

  // First inspect the current page. Avoid forcing a login-page navigation when
  // the persistent built-in browser session is already authenticated.
  let snapshot = await authenticationSnapshot(page, 1800);
  if (snapshot.auth.authenticated === true) {
    emit('log', { message: `Existing Canada Post session accepted (${snapshot.auth.signal}).` });
    diag('info', 'authentication', 'existing-session-accepted', { signal: snapshot.auth.signal, url: sanitizeUrl(page.url()) }, { critical: true });
    return;
  }

  emit('log', { message: 'Opening Canada Post login page.' });
  diag('info', 'authentication', 'login-page-navigation', { url: sanitizeUrl(CANADAPOST_LOGIN_URL) });
  await page.goto(CANADAPOST_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  assertCanadaPostPage(page, 'Canada Post login page');
  await acceptCookiesIfVisible(page);

  snapshot = await authenticationSnapshot(page, 2500);
  if (snapshot.auth.authenticated === true) {
    emit('log', { message: 'Canada Post redirected the saved session directly to the authenticated account.' });
    return;
  }

  if (await isTextVerificationPresent(page)) {
    await waitForTextVerificationToClear(page);
    await waitForAuthenticatedState(page, 25000);
    return;
  }

  const loginControls = await findLoginControls(page, 6000);
  const { usernameBox, passwordBox, signInButton } = loginControls;
  if (!loginControls.complete) {
    const error = new Error('Canada Post login was recognized, but the editable username, password, and Sign in controls could not be resolved safely. Complete login manually in the built-in browser, then retry Step 3.');
    error.code = 'UNEXPECTED_LAYOUT';
    throw error;
  }

  await usernameBox.fill(username);
  await passwordBox.fill(password);
  await acceptCookiesIfVisible(page, { quiet: true });

  try {
    await signInButton.click({ timeout: 10000 });
  } catch (clickError) {
    // A click timeout can happen after the browser has already accepted the
    // action. Never click Sign in twice until the resulting page state is checked.
    await page.waitForTimeout(700).catch(() => {});
    const afterClick = await authenticationSnapshot(page, 1200);
    if (afterClick.auth.authenticated !== true && afterClick.controls?.recognized) {
      try { await passwordBox.press('Enter'); }
      catch (_) {
        throw new Error(`Canada Post Sign in could not be activated safely: ${clickError.message}`);
      }
    }
  }

  emit('log', { message: 'Login submitted; waiting for Canada Post to confirm the session.' });
  diag('info', 'authentication', 'login-submitted', { url: sanitizeUrl(page.url()) }, { critical: true });
  await diagnostics?.capturePageState(page, 'login-submitted').catch(() => {});
  await waitForAuthenticatedState(page, 30000);
  emit('log', { message: 'Canada Post authentication confirmed.' });
  diag('info', 'authentication', 'confirmed', { url: sanitizeUrl(page.url()) }, { critical: true });
}


let cookieAcceptLogCount = 0;
let lastAuthDiagnosticSignature = '';
let lastAuthDiagnosticAt = 0;

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
  diag('info', 'browser', 'cookie-banner-dismissed', { label: clickedLabel, url: sanitizeUrl(page.url()) });
  await page.waitForTimeout(350).catch(() => {});
  if (!quiet && cookieAcceptLogCount < 5) {
    cookieAcceptLogCount += 1;
    emit('log', { message: `Cookie banner detected; clicked ${clickedLabel}.` });
  }
  return true;
}

async function activateClaimNavigationControl(page, locator, label) {
  const startedAt = Date.now();
  assertCanadaPostPage(page, label);
  diag('info', 'navigation', 'control-activation-start', { label, url: sanitizeUrl(page.url()) });
  const control = locator.first();
  await acceptCookiesIfVisible(page, { quiet: true });
  await control.waitFor({ state: 'visible', timeout: 10000 });
  await control.scrollIntoViewIfNeeded().catch(() => {});
  const beforeUrl = page.url();
  try {
    await control.click({ timeout: 7000 });
  } catch (clickError) {
    // Check whether the first click was already dispatched before using a DOM
    // fallback. This avoids duplicate popup/ticket actions after navigation timeouts.
    await page.waitForTimeout(500).catch(() => {});
    const stillVisible = await control.isVisible({ timeout: 300 }).catch(() => false);
    if (page.url() !== beforeUrl || !stillVisible) return;
    await acceptCookiesIfVisible(page, { quiet: true });
    try {
      await control.evaluate(element => (element.closest('a, button, [role="link"], [role="button"]') || element).click());
    } catch (_) {
      diag('error', 'navigation', 'control-activation-failed', { label, durationMs: Date.now() - startedAt, error: clickError }, { critical: true });
      throw new Error(`${label} was found, but Canada Post prevented it from being activated: ${clickError.message}`);
    }
  }
  diag('info', 'navigation', 'control-activation-complete', {
    label,
    durationMs: Date.now() - startedAt,
    urlBefore: sanitizeUrl(beforeUrl),
    urlAfter: sanitizeUrl(page.url())
  });
}

async function findClaimNavigationWithMenuFallback(page, timeout = 7000) {
  let navigation = await findClaimNavigationStage(page, timeout);
  if (navigation) return navigation;
  if (await maybeOpenNavigationMenu(page)) navigation = await findClaimNavigationStage(page, 4000);
  return navigation;
}

const NAVIGATION_STAGE_RANK = Object.freeze({ support: 0, category: 1, late: 2, ticket: 3 });

async function waitForClaimNavigationProgress(page, previousStage, previousUrl, timeoutMs = 14000) {
  const deadline = Date.now() + timeoutMs;
  let lastObserved = null;
  while (Date.now() < deadline) {
    if (stopRequested()) throw automationError('STOP_REQUESTED', 'Stop requested while navigating to the Canada Post ticket launcher.');
    await page.waitForLoadState('domcontentloaded', { timeout: 900 }).catch(() => {});
    const navigation = await findClaimNavigationStage(page, 700).catch(() => null);
    const currentUrl = page.url();
    if (navigation) {
      lastObserved = { stage: navigation.stage, url: currentUrl, context: navigation.context || claimNavigationUrlContext(currentUrl) };
      if (navigation.stage === 'ticket') return navigation;
      const previousRank = NAVIGATION_STAGE_RANK[previousStage] ?? -1;
      const currentRank = NAVIGATION_STAGE_RANK[navigation.stage] ?? -1;
      if (currentRank > previousRank) return navigation;
      if (currentUrl !== previousUrl && navigation.stage !== previousStage) return navigation;
    }
    await page.waitForTimeout(175).catch(() => {});
  }
  diag('warn', 'navigation', 'progress-timeout', {
    previousStage,
    previousUrl: sanitizeUrl(previousUrl),
    currentUrl: sanitizeUrl(page.url()),
    lastObserved
  }, { critical: true });
  return null;
}

async function tryCanonicalLatePackageRoute(page) {
  const beforeUrl = page.url();
  diag('info', 'navigation', 'canonical-route-start', {
    urlBefore: sanitizeUrl(beforeUrl),
    target: sanitizeUrl(LATE_PACKAGE_SUPPORT_URL)
  });
  try {
    await page.goto(LATE_PACKAGE_SUPPORT_URL, { waitUntil: 'domcontentloaded', timeout: 22000 });
    assertCanadaPostPage(page, 'Canada Post late-package support page');
    await acceptCookiesIfVisible(page, { quiet: true });
    const navigation = await findClaimNavigationStage(page, 12000);
    if (navigation?.stage === 'ticket') {
      diag('info', 'navigation', 'canonical-route-ready', {
        durationUrl: sanitizeUrl(page.url()),
        context: navigation.context || claimNavigationUrlContext(page.url())
      }, { critical: true });
      return navigation;
    }
    diag('warn', 'navigation', 'canonical-route-incomplete', {
      url: sanitizeUrl(page.url()),
      stage: navigation?.stage || '',
      context: claimNavigationUrlContext(page.url())
    });
  } catch (error) {
    diag('warn', 'navigation', 'canonical-route-failed', {
      urlBefore: sanitizeUrl(beforeUrl),
      currentUrl: sanitizeUrl(page.url()),
      error
    });
  }
  return null;
}

async function navigateToLatePackageTicketLauncher(page) {
  assertCanadaPostPage(page, 'Canada Post claim navigation');
  emit('log', { message: 'Navigating to late package ticket launcher.' });
  diag('info', 'navigation', 'ticket-launcher-start', { url: sanitizeUrl(page.url()) }, { critical: true });
  await acceptCookiesIfVisible(page);

  // Prefer the known Canada Post late-package page. This avoids slow, fragile
  // menu traversal while retaining the UI-navigation fallback below.
  const direct = await tryCanonicalLatePackageRoute(page);
  if (direct?.stage === 'ticket') {
    diag('info', 'navigation', 'ticket-launcher-ready', {
      method: 'canonical-route',
      visited: ['ticket'],
      url: sanitizeUrl(page.url())
    }, { critical: true });
    return;
  }

  const visited = [];
  for (let step = 0; step < 6; step += 1) {
    const navigation = await findClaimNavigationWithMenuFallback(page, 8000);
    if (!navigation) {
      throw automationError(
        'CLAIM_NAVIGATION_CHANGED',
        `Canada Post claim navigation changed. Could not find Support, Lost/late/damaged, Package delivered late, or Open a ticket controls. Visited: ${visited.join(' -> ') || 'none'}.`
      );
    }

    visited.push(navigation.stage);
    diag('info', 'navigation', 'stage-detected', {
      step: step + 1,
      stage: navigation.stage,
      context: navigation.context || claimNavigationUrlContext(page.url()),
      visited,
      url: sanitizeUrl(page.url())
    });
    if (navigation.stage === 'ticket') {
      diag('info', 'navigation', 'ticket-launcher-ready', { method: 'ui-navigation', visited, url: sanitizeUrl(page.url()) }, { critical: true });
      return;
    }

    // The late-package article is already the destination page. Never activate
    // its Support or Late packages breadcrumb controls, which would create the
    // support -> late -> support loop captured by the v0.3.4 diagnostics.
    if (claimNavigationUrlContext(page.url()) === 'late-page') {
      throw automationError(
        'CLAIM_TICKET_LAUNCHER_NOT_FOUND',
        'Canada Post reached the late-package support page, but the Open a ticket control did not become available.'
      );
    }

    const labels = {
      support: 'Canada Post support control',
      category: 'Lost, late or damaged control',
      late: 'Package delivered late control'
    };
    const beforeUrl = page.url();
    await activateClaimNavigationControl(page, navigation.locator, labels[navigation.stage] || 'Canada Post claim navigation control');
    const progressed = await waitForClaimNavigationProgress(page, navigation.stage, beforeUrl, 14000);
    if (!progressed) {
      throw automationError(
        'CLAIM_NAVIGATION_STALLED',
        `Canada Post claim navigation did not progress after activating the ${navigation.stage} control. Visited: ${visited.join(' -> ')}.`
      );
    }
    if (progressed.stage === 'ticket') {
      diag('info', 'navigation', 'ticket-launcher-ready', {
        method: 'ui-navigation',
        visited: [...visited, 'ticket'],
        url: sanitizeUrl(page.url())
      }, { critical: true });
      return;
    }
    diag('debug', 'navigation', 'progress-observed', {
      fromStage: navigation.stage,
      toStage: progressed.stage,
      url: sanitizeUrl(page.url())
    });
    assertCanadaPostPage(page, 'Canada Post claim navigation');
    await acceptCookiesIfVisible(page, { quiet: true });
  }

  throw automationError(
    'CLAIM_NAVIGATION_CHANGED',
    `Canada Post claim navigation did not reach the ticket launcher. Visited: ${visited.join(' -> ')}.`
  );
}

async function claimFormMarkerVisible(page, timeout = 750) {
  const country = await findReceiverCountryControl(page, Math.min(timeout, 500)).catch(() => null);
  if (country) return true;
  const field = await visibleLocatorInFrames(page, frame => [
    frame.getByRole('textbox', { name: /Receiver'?s postal code|Code postal du destinataire/i }),
    frame.getByRole('textbox', { name: /Tracking number|Num[ée]ro de rep[ée]rage/i }),
    frame.locator('input[name*="tracking" i], input[id*="tracking" i], input[name*="postal" i], input[id*="postal" i]')
  ], Math.min(timeout, 750), 'claim-form-marker');
  return Boolean(field);
}

async function openTicketPopup(page) {
  const openedAt = Date.now();
  diag('info', 'claim-form', 'open-started', { url: sanitizeUrl(page.url()), builtin: BUILTIN_BROWSER_MODE });
  await acceptCookiesIfVisible(page);
  assertCanadaPostPage(page, 'Canada Post ticket launcher');
  const navigation = await findClaimNavigationWithMenuFallback(page, 5000);
  if (!navigation || navigation.stage !== 'ticket') {
    throw new Error('Canada Post ticket launcher was not found after navigating to the late-delivery support page.');
  }

  const beforeUrl = page.url();
  const popupPromise = page.waitForEvent('popup', { timeout: BUILTIN_BROWSER_MODE ? 350 : 45000 }).catch(() => null);
  await activateClaimNavigationControl(page, navigation.locator, 'Open a ticket control');
  const claimPage = await popupPromise;
  if (claimPage) {
    await installCanadaPostNavigationGuard(claimPage);
    await claimPage.waitForLoadState('domcontentloaded').catch(() => {});
    assertCanadaPostPage(claimPage, 'Canada Post claim form');
    await acceptCookiesIfVisible(claimPage);
    await waitForClaimFormReady(claimPage, 20000);
    const readySeconds = ((Date.now() - openedAt) / 1000).toFixed(1);
    emit('log', { message: `Claim form ready after ${readySeconds} seconds.` });
    diag('info', 'claim-form', 'popup-ready', { durationMs: Date.now() - openedAt, popup: true, url: sanitizeUrl(claimPage.url()) }, { critical: true });
    diagnostics?.attachPage(claimPage, 'claim-form-popup');
    await diagnostics?.capturePageState(claimPage, 'claim-form-popup-ready').catch(() => {});
    return { claimPage, launcherUrl: beforeUrl };
  }

  if (BUILTIN_BROWSER_MODE) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (stopRequested()) {
        const error = new Error('Stop requested while opening the Canada Post claim form.');
        error.code = 'STOP_REQUESTED';
        throw error;
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => {});
      if (await claimFormMarkerVisible(page, 400)) {
        assertCanadaPostPage(page, 'Canada Post claim form');
        await acceptCookiesIfVisible(page);
        await waitForClaimFormReady(page, 20000);
        const readySeconds = ((Date.now() - openedAt) / 1000).toFixed(1);
        emit('log', { message: `Claim form ready after ${readySeconds} seconds.` });
        diag('info', 'claim-form', 'same-page-ready', { durationMs: Date.now() - openedAt, popup: false, url: sanitizeUrl(page.url()) }, { critical: true });
        await diagnostics?.capturePageState(page, 'claim-form-same-page-ready').catch(() => {});
        return { claimPage: page, launcherUrl: beforeUrl };
      }
      await page.waitForTimeout(250).catch(() => {});
    }
    throw new Error('Canada Post accepted the ticket-launch action, but the built-in browser did not reach a recognizable claim form.');
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
  const pattern = /(verification code|security code|one[- ]?time code|two[- ]?step|2[- ]?step|text message|sms|enter the code|we sent.*code|verify your identity|confirm your identity)/i;
  for (const frame of page.frames()) {
    const text = await frame.locator('body').innerText({ timeout: 800 }).catch(() => '');
    if (pattern.test(text)) return true;
  }
  return false;
}

async function waitForTextVerificationToClear(page) {
  await revealBrowserWindow(page);
  await requireBuiltinBrowserVisibility(
    'text-verification',
    'Manual verification required. Complete the Canada Post verification in the visible built-in browser; Step 3 is paused.'
  );
  emit('log', { message: 'TEXT VERIFICATION detected. Complete the Canada Post verification in the visible browser. The app is paused and will resume after verification clears.' });

  const startedAt = Date.now();
  const deadline = startedAt + manualInteractionTimeoutMs();
  let lastReminderAt = startedAt;

  while (true) {
    if (Date.now() >= deadline) {
      const error = new Error('Timed out waiting for manual Canada Post text verification.');
      error.code = 'AUTHENTICATION_VERIFICATION_TIMEOUT';
      throw error;
    }
    if (stopRequested()) { const error = new Error('Stop requested while waiting for text verification.'); error.code = 'STOP_REQUESTED'; throw error; }

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

  await requireBuiltinBrowserVisibility(
    'captcha',
    `Manual CAPTCHA verification required for ${trackingNumber}. Complete it in the visible built-in browser; Step 3 is paused.`
  );

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
  const deadline = startedAt + manualInteractionTimeoutMs();
  let lastReminderAt = startedAt;

  while (true) {
    if (Date.now() >= deadline) {
      const error = new Error('Timed out waiting for manual CAPTCHA completion.');
      error.code = 'CAPTCHA_TIMEOUT';
      throw error;
    }
    if (stopRequested()) {
      const error = new Error('Stop requested while waiting for CAPTCHA.');
      error.code = 'STOP_REQUESTED';
      throw error;
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

async function findTextboxControl(page, namePattern, timeoutMs = 5000, options = {}) {
  const selectors = Array.isArray(options.selectors) ? options.selectors.filter(Boolean) : [];
  const diagnosticName = options.diagnosticName || `textbox-${String(namePattern)}`;
  return visibleLocatorInFrames(page, frame => [
    ...selectors.map(selector => frame.locator(selector)),
    frame.getByRole('textbox', { name: namePattern }),
    frame.getByLabel(namePattern)
  ], timeoutMs, diagnosticName, { expectedMissing: Boolean(options.expectedMissing) });
}

async function fillResolvedTextbox(input, diagnosticName, value, timeoutMs = 5000, startedAt = Date.now()) {
  const clean = String(value || '').trim();
  if (!clean) {
    diag('debug', 'form', 'field-skipped-empty', { field: diagnosticName });
    return false;
  }
  if (!input) {
    diag('warn', 'form', 'field-not-found', { field: diagnosticName, timeoutMs, valueLength: clean.length });
    throw new Error(`Could not find the required Canada Post text field ${diagnosticName}.`);
  }
  await input.fill(clean, { timeout: Math.min(timeoutMs, 3000) });
  diag('info', 'form', 'field-filled', {
    field: diagnosticName,
    valueLength: clean.length,
    durationMs: Date.now() - startedAt
  });
  return true;
}

async function fillTextboxByRole(page, namePattern, value, timeoutMs = 5000, options = {}) {
  const clean = String(value || '').trim();
  const diagnosticName = options.diagnosticName || `textbox-${String(namePattern)}`;
  if (!clean) {
    diag('debug', 'form', 'field-skipped-empty', { field: diagnosticName });
    return false;
  }
  const startedAt = Date.now();
  const input = await findTextboxControl(page, namePattern, timeoutMs, { ...options, diagnosticName });
  return fillResolvedTextbox(input, diagnosticName, clean, timeoutMs, startedAt);
}

async function maybeFillByRoleTextbox(page, namePattern, value) {
  const clean = String(value || '').trim();
  const diagnosticName = `optional-textbox-${String(namePattern)}`;
  if (!clean) {
    diag('debug', 'form', 'optional-field-not-configured', { field: diagnosticName });
    return false;
  }
  const input = await findTextboxControl(page, namePattern, 350, { expectedMissing: true }).catch(() => null);
  if (!input) {
    diag('debug', 'form', 'optional-field-not-present', { field: diagnosticName });
    return false;
  }

  const fillable = await input.evaluate(element => {
    if (!element || element.disabled || element.readOnly) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number.parseFloat(style.opacity || '1') > 0
      && rect.width > 2
      && rect.height > 2;
  }).catch(() => false);

  if (!fillable) {
    diag('debug', 'form', 'optional-field-not-fillable', { field: diagnosticName });
    return false;
  }
  const startedAt = Date.now();
  const filled = await input.fill(clean, { timeout: 900 }).then(() => true).catch(() => false);
  diag(filled ? 'info' : 'warn', 'form', filled ? 'optional-field-filled' : 'optional-field-fill-failed', {
    field: diagnosticName,
    valueLength: clean.length,
    durationMs: Date.now() - startedAt
  });
  return filled;
}


async function maybeSelectByLabel(page, labelPattern, value) {
  const clean = String(value || '').trim();
  const diagnosticName = `select-${String(labelPattern)}`;
  if (!clean) {
    diag('debug', 'form', 'select-not-configured', { field: diagnosticName });
    return false;
  }
  const startedAt = Date.now();
  const selectLocator = await visibleLocatorInFrames(page, frame => [
    frame.getByLabel(labelPattern),
    frame.getByRole('combobox', { name: labelPattern })
  ], 500, diagnosticName, { expectedMissing: true }).catch(() => null);
  if (!selectLocator) {
    diag('debug', 'form', 'select-not-present', { field: diagnosticName, durationMs: Date.now() - startedAt });
    return false;
  }
  const handle = await selectLocator.elementHandle({ timeout: 250 }).catch(() => null);
  if (!handle) {
    diag('warn', 'form', 'select-handle-missing', { field: diagnosticName, durationMs: Date.now() - startedAt });
    return false;
  }

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

  if (!usable) {
    diag('debug', 'form', 'select-not-usable', { field: diagnosticName, durationMs: Date.now() - startedAt });
    return false;
  }

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

  if (selected) {
    diag('info', 'form', 'select-complete', { field: diagnosticName, strategy: 'dom-option-score', durationMs: Date.now() - startedAt });
    return true;
  }

  // Fallback only, with very short timeouts.
  try {
    await selectLocator.selectOption(clean, { timeout: 500 });
    diag('info', 'form', 'select-complete', { field: diagnosticName, strategy: 'value', durationMs: Date.now() - startedAt });
    return true;
  } catch (_) {}

  try {
    await selectLocator.selectOption({ label: clean }, { timeout: 500 });
    diag('info', 'form', 'select-complete', { field: diagnosticName, strategy: 'label', durationMs: Date.now() - startedAt });
    return true;
  } catch (_) {}

  diag('warn', 'form', 'select-failed', { field: diagnosticName, durationMs: Date.now() - startedAt });
  return false;
}


function isFinalSubmissionLabel(value) {
  return /(?:create\s+(?:service\s+)?ticket|submit\s+(?:claim|ticket|request|inquiry)|send\s+(?:claim|request|inquiry)|confirm(?:\s+(?:claim|ticket|request|submission|inquiry))?|complete(?:\s+(?:claim|ticket|request|submission|inquiry))?|finish(?:\s+(?:claim|ticket|request|submission|inquiry))?|open\s+(?:service\s+)?ticket|cr[ée]er\s+(?:un\s+)?(?:billet|demande)|soumettre\s+(?:la\s+)?(?:demande|r[ée]clamation))/i
    .test(String(value || '').replace(/\s+/g, ' ').trim());
}

async function installDryRunFinalActionGuard(page) {
  if (!DRY_RUN_MODE || !page) return;

  const install = async frame => frame.evaluate(() => {
    if (window.__cpDryRunGuardInstalled) return;
    window.__cpDryRunGuardInstalled = true;
    window.__cpDryRunBlockedActions = [];

    const finalPattern = /(?:create\s+(?:service\s+)?ticket|submit\s+(?:claim|ticket|request|inquiry)|send\s+(?:claim|request|inquiry)|confirm(?:\s+(?:claim|ticket|request|submission|inquiry))?|complete(?:\s+(?:claim|ticket|request|submission|inquiry))?|finish(?:\s+(?:claim|ticket|request|submission|inquiry))?|open\s+(?:service\s+)?ticket|cr[ée]er\s+(?:un\s+)?(?:billet|demande)|soumettre\s+(?:la\s+)?(?:demande|r[ée]clamation))/i;
    const labelFor = element => {
      if (!element) return '';
      return [
        element.innerText,
        element.textContent,
        element.value,
        element.getAttribute && element.getAttribute('aria-label'),
        element.getAttribute && element.getAttribute('title'),
        element.getAttribute && element.getAttribute('name')
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    };
    const actionElement = target => target && target.closest
      ? target.closest('button, a, input[type="submit"], input[type="button"], [role="button"], [role="link"]')
      : null;
    const record = (kind, label) => {
      window.__cpDryRunBlockedActions.push({ kind, label, at: new Date().toISOString() });
    };

    document.addEventListener('click', event => {
      const control = actionElement(event.target);
      const label = labelFor(control);
      if (!control || !finalPattern.test(label)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      record('click', label);
    }, true);

    document.addEventListener('submit', event => {
      const submitter = event.submitter || event.target?.querySelector?.('button[type="submit"], input[type="submit"]');
      const label = labelFor(submitter);
      if (!finalPattern.test(label)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      record('submit', label);
    }, true);

    const nativeClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function guardedClick() {
      const label = labelFor(this);
      if (finalPattern.test(label)) {
        record('programmatic-click', label);
        return;
      }
      return nativeClick.call(this);
    };

    const nativeRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    if (nativeRequestSubmit) {
      HTMLFormElement.prototype.requestSubmit = function guardedRequestSubmit(submitter) {
        const candidate = submitter || this.querySelector('button[type="submit"], input[type="submit"]');
        const label = labelFor(candidate);
        if (finalPattern.test(label)) {
          record('requestSubmit', label);
          return;
        }
        return nativeRequestSubmit.call(this, submitter);
      };
    }

    const nativeSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function guardedSubmit() {
      const candidate = this.querySelector('button[type="submit"], input[type="submit"]');
      const label = labelFor(candidate);
      if (finalPattern.test(label)) {
        record('form-submit', label);
        return;
      }
      return nativeSubmit.call(this);
    };
  }).catch(() => {});

  if (!dryRunGuardPages.has(page)) {
    dryRunGuardPages.add(page);
    await page.addInitScript(() => {
      window.__cpDryRunExpected = true;
    }).catch(() => {});
    page.on('framenavigated', frame => install(frame).catch(() => {}));
  }
  for (const frame of page.frames()) await install(frame);
}

async function readDryRunBlockedActions(page) {
  const actions = [];
  for (const frame of page.frames()) {
    const frameActions = await frame.evaluate(() => Array.isArray(window.__cpDryRunBlockedActions)
      ? window.__cpDryRunBlockedActions.slice(-20)
      : []).catch(() => []);
    actions.push(...frameActions);
  }
  return actions;
}

async function assertDryRunSafetyBarrier(page, senderMarker) {
  if (!DRY_RUN_MODE) return;
  const senderVisible = await senderMarker?.isVisible?.().catch(() => false);
  const visibleLabels = [];
  for (const frame of page.frames()) {
    const labels = await frame.locator('button, a, input[type="submit"], input[type="button"], [role="button"], [role="link"]').evaluateAll(elements => {
      const visible = element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
      };
      return elements.filter(visible).map(element => [
        element.innerText,
        element.textContent,
        element.value,
        element.getAttribute('aria-label'),
        element.getAttribute('title')
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 50);
    }).catch(() => []);
    visibleLabels.push(...labels);
  }
  const finalActions = visibleLabels.filter(isFinalSubmissionLabel).slice(0, 10);
  if (!senderVisible || finalActions.length) {
    const error = new Error('Dry-run safety barrier could not prove that automation remained on the sender/contact page before final review.');
    error.code = 'DRY_RUN_SAFETY_BARRIER_FAILED';
    error.details = { senderVisible, finalActionCount: finalActions.length };
    throw error;
  }
  diagnostics?.state('dry-run-safety-barrier-reached', { checkpoint: 'sender-contact-fields-filled' });
  diag('info', 'dry-run', 'safety-barrier-reached', {
    checkpoint: 'sender-contact-fields-filled',
    senderMarkerVisible: true,
    finalActionCount: 0
  }, { critical: true });
}

async function visibleLocatorInFrames(page, factory, timeout = 8000, diagnosticName = 'unnamed-control', options = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  let iterations = 0;
  let framesScanned = 0;
  let candidatesScanned = 0;
  let candidateErrors = 0;
  do {
    iterations += 1;
    for (const frame of page.frames()) {
      framesScanned += 1;
      let candidates = [];
      try { candidates = factory(frame).filter(Boolean); }
      catch (_) { candidateErrors += 1; continue; }
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        candidatesScanned += 1;
        const locator = candidates[candidateIndex].first();
        if (await locator.isVisible({ timeout: 150 }).catch(() => false)) {
          const durationMs = Date.now() - startedAt;
          diagnostics?.locatorResult(diagnosticName, {
            found: true,
            durationMs,
            iterations,
            framesScanned,
            candidatesScanned,
            candidateIndex,
            frameUrl: sanitizeUrl(frame.url())
          });
          return locator;
        }
      }
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(150).catch(() => {});
  } while (true);
  diagnostics?.locatorResult(diagnosticName, {
    found: false,
    durationMs: Date.now() - startedAt,
    timeoutMs: timeout,
    iterations,
    framesScanned,
    candidatesScanned,
    candidateErrors,
    expectedMissing: Boolean(options.expectedMissing),
    pageUrl: sanitizeUrl(page.url())
  });
  return null;
}

async function findReceiverCountryControl(page, timeout = 10000) {
  return visibleLocatorInFrames(page, frame => [
    frame.getByLabel(/Receiver'?s country|Pays du destinataire/i),
    frame.getByRole('combobox', { name: /Receiver'?s country|Pays du destinataire/i }),
    frame.locator('select[name*="receiver" i][name*="country" i], select[id*="receiver" i][id*="country" i]'),
    frame.locator('select[name*="country" i], select[id*="country" i]'),
    frame.locator('select').filter({ has: frame.locator('option[value="CA"], option').filter({ hasText: /^\s*Canada\s*$/i }) })
  ], timeout, 'receiver-country-control');
}

async function selectReceiverCountry(page) {
  const startedAt = Date.now();
  diag('info', 'form', 'receiver-country-selection-started', { url: sanitizeUrl(page.url()) });
  const control = await findReceiverCountryControl(page, 12000);
  if (!control) {
    const text = await collectVisibleText(page).catch(() => '');
    if (/Receiver'?s country\s*Canada/i.test(text)) {
      diag('info', 'form', 'receiver-country-already-canada', { durationMs: Date.now() - startedAt });
      return true;
    }
    const error = new Error('The receiver country control was not found on the initial Canada Post claim form. The page will be reset before the next claim.');
    error.code = 'CLAIM_FORM_NOT_READY';
    throw error;
  }

  const tagName = await control.evaluate(element => element.tagName.toLowerCase()).catch(() => '');
  diag('debug', 'form', 'receiver-country-control-found', { tagName, durationMs: Date.now() - startedAt });
  if (tagName === 'select') {
    const selected = await control.evaluate(element => {
      const options = [...element.options];
      const option = options.find(item => String(item.value || '').toUpperCase() === 'CA')
        || options.find(item => /^\s*Canada\s*$/i.test(String(item.textContent || '')));
      if (!option) return false;
      element.value = option.value;
      option.selected = true;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }).catch(() => false);
    if (selected) {
      diag('info', 'form', 'receiver-country-selected', { strategy: 'dom-option', durationMs: Date.now() - startedAt });
      return true;
    }
    if (await control.selectOption('CA', { timeout: 1500 }).then(() => true).catch(() => false)) {
      diag('info', 'form', 'receiver-country-selected', { strategy: 'value-CA', durationMs: Date.now() - startedAt });
      return true;
    }
    if (await control.selectOption({ label: 'Canada' }, { timeout: 1500 }).then(() => true).catch(() => false)) {
      diag('info', 'form', 'receiver-country-selected', { strategy: 'label-Canada', durationMs: Date.now() - startedAt });
      return true;
    }
  } else {
    await control.click({ timeout: 2500 }).catch(() => {});
    const canadaOption = await visibleLocatorInFrames(page, frame => [
      frame.getByRole('option', { name: /^Canada$/i }),
      frame.getByText(/^Canada$/i)
    ], 3000, 'receiver-country-canada-option');
    if (canadaOption) {
      await canadaOption.click({ timeout: 2500 });
      diag('info', 'form', 'receiver-country-selected', { strategy: 'combobox-option-click', durationMs: Date.now() - startedAt });
      return true;
    }
  }

  const error = new Error('The receiver country control was found, but Canada could not be selected.');
  error.code = 'COUNTRY_SELECTION_FAILED';
  throw error;
}

async function waitForClaimFormReady(page, timeout = 20000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  let lastProgressAt = 0;
  let checks = 0;
  diag('info', 'claim-form', 'readiness-wait-started', { timeoutMs: timeout, url: sanitizeUrl(page.url()) });
  while (Date.now() < deadline) {
    if (stopRequested()) {
      const error = new Error('Stop requested while waiting for the Canada Post claim form.');
      error.code = 'STOP_REQUESTED';
      throw error;
    }
    checks += 1;
    await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => {});
    await acceptCookiesIfVisible(page, { quiet: true });
    if (await claimFormMarkerVisible(page, 300)) {
      diag('info', 'claim-form', 'ready', { durationMs: Date.now() - startedAt, checks, url: sanitizeUrl(page.url()) }, { critical: true });
      return true;
    }
    if (Date.now() - lastProgressAt >= 2500) {
      lastProgressAt = Date.now();
      diag('debug', 'claim-form', 'readiness-wait-progress', { elapsedMs: Date.now() - startedAt, checks, url: sanitizeUrl(page.url()) });
    }
    await page.waitForTimeout(200).catch(() => {});
  }
  await diagnostics?.capturePageState(page, 'claim-form-readiness-timeout').catch(() => {});
  diag('error', 'claim-form', 'readiness-timeout', { timeoutMs: timeout, checks, url: sanitizeUrl(page.url()) }, { critical: true });
  const error = new Error(`Canada Post did not expose the initial receiver/tracking claim fields within ${Math.round(timeout / 1000)} seconds.`);
  error.code = 'CLAIM_FORM_NOT_READY';
  throw error;
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
  let scans = 0;
  diag('info', 'form', 'continue-search-started', { timeoutMs: timeout, url: sanitizeUrl(page.url()) });

  while (Date.now() - startedAt < timeout) {
    if (stopRequested()) { const error = new Error('Stop requested while clicking Continue.'); error.code = 'STOP_REQUESTED'; throw error; }

    assertCanadaPostPage(page, 'Canada Post claim form');
    await acceptCookiesIfVisible(page, { quiet: true });
    const remaining = Math.max(500, timeout - (Date.now() - startedAt));
    scans += 1;

    for (const frame of page.frames()) {
      const candidates = [
        frame.locator('input[type="submit"][value="Continue"]:visible'),
        frame.locator('input[type="button"][value="Continue"]:visible'),
        frame.locator('button:visible').filter({ hasText: /^\s*Continue\s*$/i }),
        frame.locator('a:visible').filter({ hasText: /^\s*Continue\s*$/i })
      ];

      for (const locator of candidates) {
        try {
          const count = Math.min(await locator.count(), 10);
          for (let index = 0; index < count; index += 1) {
            const candidate = locator.nth(index);
            if (!(await candidate.isVisible().catch(() => false))) continue;
            const label = await candidate.evaluate(element => [
              element.innerText,
              element.textContent,
              element.value,
              element.getAttribute('aria-label'),
              element.getAttribute('title')
            ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()).catch(() => '');
            diag('debug', 'form', 'continue-candidate', {
              label,
              frameUrl: sanitizeUrl(frame.url()),
              elapsedMs: Date.now() - startedAt
            });
            if (isFinalSubmissionLabel(label)) {
              const error = new Error(`Refused to treat a final submission control as Continue: ${label}`);
              error.code = 'FINAL_ACTION_GUARD';
              throw error;
            }
            await candidate.scrollIntoViewIfNeeded({ timeout: Math.min(remaining, 2500) }).catch(() => {});
            const beforeUrl = page.url();
            try {
              await candidate.click({ timeout: Math.min(remaining, 4500) });
              diag('info', 'form', 'continue-clicked', {
                label,
                durationMs: Date.now() - startedAt,
                scans,
                urlBefore: sanitizeUrl(beforeUrl),
                urlAfter: sanitizeUrl(page.url())
              }, { critical: true });
              return;
            } catch (error) {
              lastError = error;
              await page.waitForTimeout(350).catch(() => {});
              const stillVisible = await candidate.isVisible({ timeout: 200 }).catch(() => false);
              if (page.url() !== beforeUrl || !stillVisible) {
                diag('warn', 'form', 'continue-click-uncertain-but-advanced', {
                  label,
                  durationMs: Date.now() - startedAt,
                  scans,
                  urlBefore: sanitizeUrl(beforeUrl),
                  urlAfter: sanitizeUrl(page.url()),
                  stillVisible,
                  error
                }, { critical: true });
                return;
              }
            }
          }
        } catch (error) {
          if (error?.code === 'FINAL_ACTION_GUARD') throw error;
          lastError = error;
        }
      }
    }

    await page.waitForTimeout(200);
  }

  await diagnostics?.capturePageState(page, 'continue-control-timeout').catch(() => {});
  diag('error', 'form', 'continue-not-found', { durationMs: Date.now() - startedAt, timeoutMs: timeout, scans, lastError }, { critical: true });
  const suffix = lastError && lastError.message ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Could not click the real Continue control.${suffix}`);
}

async function fillClaim(claimPage, claim, options = {}) {
  const dryRun = Boolean(options.dryRun);
  assertCanadaPostPage(claimPage, 'Canada Post claim form');
  await acceptCookiesIfVisible(claimPage);

  const receiverPostalCode = normalizePostalCode(required(claim, 'Destination Postal Code'));
  const trackingNumber = required(claim, 'Tracking PIN');
  const referenceNumber = required(claim, 'Reference #');

  diagnostics?.state('claim-form-initial');
  await waitForClaimFormReady(claimPage, 20000);
  await diagnostics?.capturePageState(claimPage, 'claim-form-initial').catch(() => {});
  await selectReceiverCountry(claimPage);

  await fillTextboxByRole(claimPage, /Receiver'?s postal code/i, receiverPostalCode, 5000, {
    selectors: ['input[id="CreateTicket:receiverPostalCode"]', 'input[name="CreateTicket:receiverPostalCode"]'],
    diagnosticName: 'receiver-postal-code'
  });
  await fillTextboxByRole(claimPage, /Tracking number/i, trackingNumber, 5000, {
    selectors: ['input[id="CreateTicket:ZZ_KEYDOC"]', 'input[name="CreateTicket:ZZ_KEYDOC"]'],
    diagnosticName: 'tracking-number'
  });
  faultPoint('after_tracking_entry');
  diagnostics?.state('receiver-tracking-filled');
  await diagnostics?.capturePageState(claimPage, 'receiver-tracking-filled').catch(() => {});

  // Canada Post currently uses a deterministic three-page setup flow. Move to
  // the next page once, then wait for the exact next-stage marker instead of
  // spending ~500-700 ms probing for a field that is expected not to exist yet.
  await clickVisibleContinue(claimPage);
  const referencePattern = /Reference Number 1|Reference number/i;
  const referenceStartedAt = Date.now();
  const referenceInput = await findTextboxControl(claimPage, referencePattern, 7000, {
    diagnosticName: 'reference-number'
  });
  diagnostics?.state('reference-page');
  await diagnostics?.capturePageState(claimPage, 'reference-page-ready').catch(() => {});
  emit('log', { message: `Receiver and tracking details accepted for ${trackingNumber}.` });
  if (dryRun) await installDryRunFinalActionGuard(claimPage);
  await fillResolvedTextbox(referenceInput, 'reference-number', referenceNumber, 7000, referenceStartedAt);
  diagnostics?.state('reference-filled');

  await clickVisibleContinue(claimPage);
  const streetNumberPattern = /Street Number/i;
  const streetStartedAt = Date.now();
  const streetNumberInput = await findTextboxControl(claimPage, streetNumberPattern, 7000, {
    selectors: [
      'input[id="claimAddressAndContacts:userAddress:streetNumber"]',
      'input[name="claimAddressAndContacts:userAddress:streetNumber"]'
    ],
    diagnosticName: 'sender-street-number'
  });
  diagnostics?.state('sender-contact-page');
  await diagnostics?.capturePageState(claimPage, 'sender-contact-page-ready').catch(() => {});
  emit('log', { message: `Reference details accepted for ${trackingNumber}.` });
  if (dryRun) await installDryRunFinalActionGuard(claimPage);

  const senderStreetNumber = requiredSetting(CLAIM_USER_SETTINGS.streetNumber, 'claim sender street number');
  const senderStreetName = requiredSetting(CLAIM_USER_SETTINGS.streetName, 'claim sender street name / Canada Post street dropdown option');

  await fillResolvedTextbox(streetNumberInput, 'sender-street-number', senderStreetNumber, 7000, streetStartedAt);

  const streetSelected = await maybeSelectByLabel(claimPage, /Street Name/i, senderStreetName);
  if (!streetSelected) {
    throw new Error(`Could not select claim sender street name "${senderStreetName}". Try entering only the main street name, for example "Example Street". The app now matches accents, punctuation, street suffixes, and close dropdown text automatically.`);
  }

  await fillOptionalClaimUserSettings(claimPage);
  diagnostics?.state('sender-contact-filled');
  await diagnostics?.capturePageState(claimPage, 'sender-contact-filled').catch(() => {});
  emit('log', { message: `Sender and contact fields filled for ${trackingNumber}.` });

  // Dry run stops before leaving the sender/contact page. This is deliberately
  // conservative: it fills every visible claim field but does not activate any
  // later Continue/review control whose semantics Canada Post could change.
  if (dryRun) {
    await assertDryRunSafetyBarrier(claimPage, streetNumberInput);
    diag('info', 'dry-run', 'safe-checkpoint-reached', { checkpoint: 'sender-contact-fields-filled' }, { critical: true });
    return { stoppedBeforeFinalReviewTransition: true, safeCheckpoint: 'sender-contact-fields-filled' };
  }

  await clickVisibleContinue(claimPage);
  diagnostics?.state('review-transition-1');
  await diagnostics?.capturePageState(claimPage, 'review-transition-1').catch(() => {});
  if (await findCreateTicketControl(claimPage, 1800)) {
    return { stoppedBeforeFinalReviewTransition: false, reviewTransitions: 1 };
  }

  await clickVisibleContinue(claimPage);
  diagnostics?.state('review-transition-2');
  await diagnostics?.capturePageState(claimPage, 'review-transition-2').catch(() => {});
  if (!(await findCreateTicketControl(claimPage, 10000))) {
    const error = new Error('Canada Post did not expose the final Create Ticket control after the expected review transitions. No final submission action was attempted.');
    error.code = 'UNEXPECTED_LAYOUT';
    throw error;
  }
  return { stoppedBeforeFinalReviewTransition: false, reviewTransitions: 2 };
}

async function findCreateTicketControl(claimPage, timeout = 30000) {
  return visibleLocatorInFrames(claimPage, frame => [
    frame.getByRole('button', { name: /^Create\s+Ticket$/i }),
    frame.getByRole('link', { name: /^Create\s+Ticket$/i }),
    frame.locator('button, a, input[type="submit"]').filter({ hasText: /^\s*Create\s+Ticket\s*$/i }),
    frame.locator('input[type="submit"][value*="Create" i][value*="Ticket" i]')
  ], timeout, 'create-ticket-control');
}

async function clickCreateTicket(claimPage) {
  const startedAt = Date.now();
  diag('warn', 'submission', 'final-action-preparation', { url: sanitizeUrl(claimPage.url()), dryRun: DRY_RUN_MODE }, { critical: true });
  await acceptCookiesIfVisible(claimPage);
  assertCanadaPostPage(claimPage, 'Canada Post final claim page');

  const createTicketControl = await findCreateTicketControl(claimPage, 30000);
  if (!createTicketControl) {
    await diagnostics?.capturePageState(claimPage, 'create-ticket-control-missing').catch(() => {});
    diag('error', 'submission', 'final-control-missing', { durationMs: Date.now() - startedAt, url: sanitizeUrl(claimPage.url()) }, { critical: true });
    throw new Error('The final Create Ticket control was not found.');
  }
  diag('warn', 'submission', 'final-control-found', { durationMs: Date.now() - startedAt, url: sanitizeUrl(claimPage.url()) }, { critical: true });
  await diagnostics?.capturePageState(claimPage, 'before-create-ticket-click').catch(() => {});
  await createTicketControl.scrollIntoViewIfNeeded().catch(() => {});
  const beforeUrl = claimPage.url();

  try {
    await createTicketControl.click({ timeout: 12000 });
    diag('warn', 'submission', 'final-action-click-dispatched', {
      durationMs: Date.now() - startedAt,
      urlBefore: sanitizeUrl(beforeUrl),
      urlAfter: sanitizeUrl(claimPage.url()),
      uncertain: false
    }, { critical: true });
    return { actionAccepted: true, uncertain: false };
  } catch (clickError) {
    // A timeout can occur after the final click has already been dispatched and
    // navigation has started. Never retry the financially significant action.
    await claimPage.waitForTimeout(1000).catch(() => {});
    const visibleText = await collectVisibleText(claimPage).catch(() => '');
    const outcome = classifyClaimOutcome(visibleText);
    const stillVisible = await createTicketControl.isVisible({ timeout: 400 }).catch(() => false);
    const disabled = await createTicketControl.isDisabled({ timeout: 400 }).catch(() => false);
    if (outcome || claimPage.url() !== beforeUrl || !stillVisible || disabled) {
      emit('log', { message: 'Create Ticket click entered an uncertain navigation state; the control was not clicked again. Waiting for the final Canada Post outcome.' });
      diag('warn', 'submission', 'final-action-uncertain', {
        durationMs: Date.now() - startedAt,
        urlBefore: sanitizeUrl(beforeUrl),
        urlAfter: sanitizeUrl(claimPage.url()),
        outcomeDetected: Boolean(outcome),
        stillVisible,
        disabled,
        error: clickError
      }, { critical: true });
      return { actionAccepted: true, uncertain: true };
    }
    diag('error', 'submission', 'final-action-failed-before-dispatch', {
      durationMs: Date.now() - startedAt,
      error: clickError,
      url: sanitizeUrl(claimPage.url())
    }, { critical: true });
    throw new Error(`Create Ticket could not be activated safely: ${clickError.message}`);
  }
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
  for (const frame of page.frames()) {
    const frameText = await frame.locator('body').innerText({ timeout: frame === page.mainFrame() ? 2500 : 1200 }).catch(() => '');
    if (frameText) chunks.push(frameText);
  }
  // Outcome classification intentionally uses rendered text only. Raw HTML can
  // contain hidden success/error templates and must never decide claim status.
  return oneLine(chunks.filter(Boolean).join(' '));
}

function classifyClaimOutcome(text) {
  const source = String(text || '');
  if (hasAnyPattern(source, DUPLICATE_PATTERNS)) {
    return {
      status: 'already_submitted',
      ok: false,
      message: 'Claim already submitted: Canada Post says an inquiry/refund request already exists for this tracking number.',
      errorCode: 'DUPLICATE_CLAIM'
    };
  }

  if (hasAnyPattern(source, REJECTION_PATTERNS)) {
    return {
      status: 'rejected',
      ok: false,
      message: 'Canada Post rejected the claim as ineligible.',
      reason: oneLine(source).slice(0, 2000),
      errorCode: 'CLAIM_REJECTED',
      businessOutcome: true
    };
  }

  if (hasAnyPattern(source, FAILURE_PATTERNS)) {
    return {
      status: 'failed',
      ok: false,
      message: 'Canada Post displayed a submission error after Create Ticket.',
      errorCode: 'SUBMISSION_ERROR'
    };
  }

  const confirmationNumber = extractConfirmationNumber(source);
  if (confirmationNumber) {
    return {
      status: 'submitted',
      ok: true,
      message: 'Canada Post accepted the claim and displayed a confirmation/ticket number.',
      confirmationNumber
    };
  }

  if (hasAnyPattern(source, SUCCESS_PATTERNS)) {
    return {
      status: 'unknown',
      ok: false,
      message: 'Canada Post displayed success-like text but no confirmation/ticket number was captured. Manual reconciliation is required.',
      errorCode: 'CONFIRMATION_NUMBER_MISSING'
    };
  }

  return null;
}

function summarizeClaimResults(results = []) {
  const values = Array.isArray(results) ? results : [];
  const succeeded = values.filter(result => result.status === 'submitted').length;
  const dryRunReady = values.filter(result => result.status === 'dry_run_ready').length;
  const alreadySubmitted = values.filter(result => result.status === 'already_submitted').length;
  const rejected = values.filter(result => result.status === 'rejected').length;
  const failed = values.filter(result => !['submitted', 'dry_run_ready', 'already_submitted', 'rejected'].includes(result.status)).length;
  return { total: values.length, succeeded, dryRunReady, alreadySubmitted, rejected, failed };
}

async function waitForClaimOutcome(claimPage, timeoutMs, trackingNumber, rowNumber, dataDir) {
  let startedAt = Date.now();
  let lastText = '';
  let polls = 0;
  let lastProgressAt = 0;
  let lastFingerprint = '';
  diag('warn', 'outcome', 'wait-started', { timeoutMs, url: sanitizeUrl(claimPage.url()) }, { critical: true });

  while (Date.now() - startedAt < timeoutMs) {
    polls += 1;
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
    if (outcome) {
      diag(outcome.status === 'submitted' ? 'info' : 'warn', 'outcome', 'classified', {
        status: outcome.status,
        errorCode: outcome.errorCode || '',
        confirmationNumberPresent: Boolean(outcome.confirmationNumber),
        durationMs: Date.now() - startedAt,
        polls,
        url: sanitizeUrl(claimPage.url())
      }, { critical: true });
      await diagnostics?.capturePageState(claimPage, `outcome-${outcome.status}`).catch(() => {});
      return { ...outcome, pageText: lastText.slice(0, 4000) };
    }

    const fingerprint = `${sanitizeUrl(claimPage.url())}|${lastText.slice(0, 180)}`;
    if (fingerprint !== lastFingerprint || Date.now() - lastProgressAt >= 5000) {
      lastFingerprint = fingerprint;
      lastProgressAt = Date.now();
      diag('debug', 'outcome', 'wait-progress', {
        elapsedMs: Date.now() - startedAt,
        polls,
        url: sanitizeUrl(claimPage.url()),
        visibleTextLength: lastText.length,
        visibleTextSample: lastText.slice(0, 500)
      });
    }

    await claimPage.waitForTimeout(750);
  }

  await diagnostics?.capturePageState(claimPage, 'outcome-timeout').catch(() => {});
  diag('error', 'outcome', 'timeout', {
    timeoutMs,
    polls,
    url: sanitizeUrl(claimPage.url()),
    visibleTextLength: lastText.length,
    visibleTextSample: lastText.slice(0, 1000)
  }, { critical: true });
  return {
    status: 'unknown',
    ok: false,
    message: `No Canada Post confirmation or known rejection was detected within ${Math.round(timeoutMs / 1000)} seconds. This was not counted as submitted.`,
    errorCode: 'UNKNOWN_RESULT',
    pageText: lastText.slice(0, 4000)
  };
}

async function saveClaimArtifacts(claimPage, dataDir, prefix, rowNumber, pageText = '', screenshotDelayMs = 0) {
  faultPoint('during_evidence_write');
  const startedAt = Date.now();
  const artifactId = `${rowNumber}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const screenshotPath = path.resolve(dataDir, `${prefix}-row-${artifactId}.png`);
  const textPath = path.resolve(dataDir, `${prefix}-row-${artifactId}.txt`);

  if (screenshotDelayMs > 0) await waitBeforeEvidenceScreenshot(claimPage, screenshotDelayMs).catch(() => {});
  await acceptCookiesIfVisible(claimPage, { quiet: true });
  await claimPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  try { fs.chmodSync(screenshotPath, 0o600); } catch (_) {}
  if (pageText) fs.writeFileSync(textPath, pageText + '\n', { mode: 0o600 });
  try { if (pageText) fs.chmodSync(textPath, 0o600); } catch (_) {}

  const result = { screenshotPath, textPath: pageText ? textPath : '' };
  diag('info', 'evidence', 'saved', {
    prefix,
    durationMs: Date.now() - startedAt,
    screenshotPresent: fs.existsSync(screenshotPath),
    textPresent: Boolean(pageText && fs.existsSync(textPath)),
    screenshotBytes: fs.existsSync(screenshotPath) ? fs.statSync(screenshotPath).size : 0,
    textBytes: pageText && fs.existsSync(textPath) ? fs.statSync(textPath).size : 0
  });
  return result;
}


async function resetToTicketLauncher(page, launcherUrl, username, password) {
  const startedAt = Date.now();
  diag('info', 'navigation', 'reset-started', { launcherUrl: sanitizeUrl(launcherUrl), currentUrl: sanitizeUrl(page?.url?.()) });
  if (!page || page.isClosed()) throw new Error('The built-in Canada Post browser closed before the next claim.');

  if (launcherUrl && isCanadaPostUrl(launcherUrl)) {
    emit('log', { message: 'Resetting the built-in browser directly to the late-package ticket launcher.' });
    await page.goto(launcherUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await acceptCookiesIfVisible(page, { quiet: true });
    const directNavigation = await findClaimNavigationWithMenuFallback(page, 3500).catch(() => null);
    if (directNavigation?.stage === 'ticket') {
      emit('log', { message: 'Ticket launcher reset complete.' });
      diag('info', 'navigation', 'reset-complete-direct', { durationMs: Date.now() - startedAt, url: sanitizeUrl(page.url()) }, { critical: true });
      return page.url();
    }
  }

  const snapshot = await authenticationSnapshot(page, 1500).catch(() => null);
  if (snapshot?.auth?.authenticated !== true) await login(page, username, password);
  await navigateToLatePackageTicketLauncher(page);
  diag('info', 'navigation', 'reset-complete-full', { durationMs: Date.now() - startedAt, url: sanitizeUrl(page.url()) }, { critical: true });
  return page.url();
}

async function processClaim(page, claim, index, total, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const dataDir = process.env.DATA_DIR || process.cwd();
  const trackingNumber = required(claim, 'Tracking PIN');
  const receiverPostalCode = normalizePostalCode(required(claim, 'Destination Postal Code'));
  const referenceNumber = required(claim, 'Reference #');
  const afterSubmitMs = Number.parseInt(process.env.AFTER_SUBMIT_MS || '20000', 10);

  emit('claim_start', { index: index + 1, total, row: claim._csvRowNumber, trackingNumber, receiverPostalCode, referenceNumber });
  diag('info', 'claim', 'process-started', {
    index: index + 1,
    total,
    row: claim._csvRowNumber,
    dryRun,
    receiverPostalCodeConfigured: Boolean(receiverPostalCode),
    referenceNumberConfigured: Boolean(referenceNumber)
  }, { critical: true });

  const opened = diagnostics
    ? await diagnostics.operation('claim-form.open', { claimIndex: index + 1 }, () => openTicketPopup(page))
    : await openTicketPopup(page);
  const claimPage = opened.claimPage;
  const launcherUrl = opened.launcherUrl;
  await hideBrowserWindow(claimPage);
  if (dryRun) await installDryRunFinalActionGuard(claimPage);

  try {
    const fillResult = diagnostics
      ? await diagnostics.operation('claim-form.fill', { dryRun }, () => fillClaim(claimPage, claim, { dryRun }))
      : await fillClaim(claimPage, claim, { dryRun });
    faultPoint('after_form_completion');

    if (dryRun) {
      const blockedActions = await readDryRunBlockedActions(claimPage);
      diag(blockedActions.length ? 'error' : 'info', 'dry-run', 'guard-check', {
        blockedActionCount: blockedActions.length,
        blockedActions
      }, { critical: true });
      if (blockedActions.length) {
        const error = new Error(`Dry-run safety guard blocked a final submission action: ${blockedActions.map(item => item.label || item.kind).join(', ')}`);
        error.code = 'DRY_RUN_SAFETY_BLOCK';
        throw error;
      }
      const pageText = await collectVisibleText(claimPage).catch(() => '');
      const artifacts = await saveClaimArtifacts(claimPage, dataDir, 'claim-dry-run', claim._csvRowNumber, pageText);
      const pageTitle = await claimPage.title().catch(() => '');
      const lastUrl = claimPage.url();
      emit('claim_dry_run', {
        row: claim._csvRowNumber,
        trackingNumber,
        message: 'Dry run filled the claim fields and stopped on the sender/contact page before any final review or submission transition.',
        screenshotPath: artifacts.screenshotPath,
        textPath: artifacts.textPath,
        pageTitle,
        lastUrl
      });
      return {
        ok: true,
        status: 'dry_run_ready',
        dryRun: true,
        row: claim._csvRowNumber,
        trackingNumber,
        message: 'Dry run filled the claim fields and stopped on the sender/contact page before any final review or submission transition.',
        screenshotPath: artifacts.screenshotPath,
        textPath: artifacts.textPath,
        pageTitle,
        lastUrl,
        launcherUrl,
        dryRunCheckpoint: fillResult
      };
    }

    emit('log', { message: `Clicking Create Ticket for ${trackingNumber}.` });
    diagnostics?.state('final-submission-action');
    faultPoint('before_final_submission');
    await clickCreateTicket(claimPage);
    faultPoint('immediately_after_submission');
    diagnostics?.state('waiting-for-outcome');

    const resultTimeoutMs = Math.max(afterSubmitMs, 45000);
    emit('claim_wait', { trackingNumber, ms: resultTimeoutMs, mode: 'wait_for_canada_post_confirmation_or_duplicate_error' });

    faultPoint('before_confirmation_capture');
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
        confirmationNumber: outcome.confirmationNumber || '',
        screenshotPath: artifacts.screenshotPath,
        textPath: artifacts.textPath,
        lastUrl: claimPage.url(),
        pageTitle: await claimPage.title().catch(() => '')
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
        errorCode: outcome.errorCode || 'DUPLICATE_CLAIM',
        screenshotPath: artifacts.screenshotPath,
        textPath: artifacts.textPath,
        lastUrl: claimPage.url(),
        pageTitle: await claimPage.title().catch(() => '')
      };
    }

    const rejected = outcome.status === 'rejected';
    const artifacts = await saveClaimArtifacts(claimPage, dataDir, rejected ? 'claim-rejected' : 'claim-error', claim._csvRowNumber, outcome.pageText, 2600);
    const returnedReason = outcome.reason || '';
    const errorMessage = [outcome.message, returnedReason ? `Returned reason: ${returnedReason}` : '', outcome.pageText ? `Page text saved to ${artifacts.textPath}` : ''].filter(Boolean).join(' ');
    emit(rejected ? 'claim_rejected' : 'claim_error', {
      row: claim._csvRowNumber,
      trackingNumber,
      message: errorMessage,
      reason: returnedReason,
      screenshotPath: artifacts.screenshotPath,
      textPath: artifacts.textPath
    });
    return {
      ok: false,
      status: outcome.status || 'failed',
      row: claim._csvRowNumber,
      trackingNumber,
      error: errorMessage,
      reason: returnedReason,
      errorCode: outcome.errorCode || 'UNKNOWN_RESULT',
      screenshotPath: artifacts.screenshotPath,
      textPath: artifacts.textPath,
      lastUrl: claimPage.url(),
      pageTitle: await claimPage.title().catch(() => '')
    };
  } catch (error) {
    diag('error', 'claim', 'process-error', { error, url: sanitizeUrl(claimPage.url()) }, { critical: true });
    await diagnostics?.capturePageState(claimPage, 'claim-process-error').catch(() => {});
    const pageText = await collectVisibleText(claimPage).catch(() => '');
    const artifacts = await saveClaimArtifacts(claimPage, dataDir, 'claim-error', claim._csvRowNumber, pageText, 2600);
    const lastUrl = claimPage.url();
    const classified = classifyAutomationFailure(error, pageText, lastUrl);
    emit('claim_error', {
      row: claim._csvRowNumber,
      trackingNumber,
      message: error.message,
      errorCode: classified.errorCode,
      screenshotPath: artifacts.screenshotPath,
      textPath: artifacts.textPath
    });
    return {
      ok: false,
      status: classified.status,
      row: claim._csvRowNumber,
      trackingNumber,
      error: error.message,
      errorCode: classified.errorCode,
      screenshotPath: artifacts.screenshotPath,
      textPath: artifacts.textPath,
      lastUrl,
      pageTitle: await claimPage.title().catch(() => '')
    };
  } finally {
    if (!BUILTIN_BROWSER_MODE && claimPage !== page) {
      await claimPage.close().catch(() => {});
    }
  }
}


function initializeDiagnostics({ dataDir, runId, dryRun, browserMode }) {
  if (String(process.env.STEP3_DIAGNOSTICS_ENABLED || 'true').toLowerCase() === 'false') return null;
  const runDirectory = process.env.STEP3_DIAGNOSTICS_RUN_DIR
    ? path.resolve(process.env.STEP3_DIAGNOSTICS_RUN_DIR)
    : path.resolve(process.env.LOG_DIR || dataDir, 'step3-runs', `step3-${new Date().toISOString().replace(/[:.]/g, '-')}-run-${runId || process.pid}`);
  return new Step3Diagnostics({
    runDirectory,
    appVersion: process.env.APP_VERSION || '',
    runId,
    dryRun,
    browserMode
  });
}

async function finalizeDiagnostics(extra = {}) {
  if (!diagnostics) return '';
  try {
    const summaryPath = await diagnostics.finalize(extra);
    process.stdout.write(JSON.stringify({
      type: 'diagnostics_complete',
      directory: diagnostics.directory,
      summaryPath
    }) + '\n');
    return summaryPath;
  } catch (error) {
    process.stdout.write(JSON.stringify({ type: 'log', message: `Step 3 diagnostics finalization warning: ${error.message}` }) + '\n');
    return '';
  }
}

async function main() {
  const dataDir = process.env.DATA_DIR || process.cwd();
  const dbPath = process.env.DATABASE_PATH || path.resolve(dataDir, 'database', 'app.sqlite');
  const dryRun = DRY_RUN_MODE;
  const runId = Number.parseInt(process.env.RUN_ID || '0', 10) || null;
  const csvPath = process.env.CLAIMS_CSV || path.resolve(dataDir, 'claims.csv');
  diagnostics = initializeDiagnostics({
    dataDir,
    runId,
    dryRun,
    browserMode: BUILTIN_BROWSER_MODE ? 'builtin' : 'external'
  });
  if (diagnostics) {
    process.stdout.write(JSON.stringify({
      type: 'diagnostics_started',
      directory: diagnostics.directory,
      timelinePath: diagnostics.timelinePath,
      humanLogPath: diagnostics.humanLogPath
    }) + '\n');
    diagnostics.state('loading-claims');
    diagnostics.record('info', 'run', 'configuration', {
      dryRun,
      browserMode: BUILTIN_BROWSER_MODE ? 'builtin' : 'external',
      claimsCsv: csvPath,
      databaseConfigured: Boolean(dbPath),
      stopFileConfigured: Boolean(process.env.STOP_FILE),
      maxClaims: process.env.MAX_CLAIMS || '',
      betweenClaimsMs: process.env.BETWEEN_CLAIMS_MS || '750',
      afterSubmitMs: process.env.AFTER_SUBMIT_MS || '20000',
      manualInteractionTimeoutMs: manualInteractionTimeoutMs()
    }, { critical: true });
  }
  claimDb.importLegacyData(dbPath, dataDir);
  claimDb.markInterruptedAttempts(dbPath);
  claimDb.quarantineLegacyDryRunReadyAttempts(dbPath);

  const allClaims = await (diagnostics
    ? diagnostics.operation('claims.read-csv', { csvPath }, async () => readClaims(csvPath))
    : readClaims(csvPath));
  const selection = getClaimsToRun(allClaims, dataDir, dbPath);
  const claimsToRun = selection.claims;
  const snapshotPath = process.env.QUEUE_SNAPSHOT_PATH || '';
  if (!snapshotPath || !fs.existsSync(snapshotPath)) throw new Error('Reviewed queue snapshot is missing. Refresh and review the claim queue.');
  let queueSnapshot;
  try { queueSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); } catch (_) { throw new Error('Reviewed queue snapshot is invalid.'); }
  const policyClaims = allClaims.map(claim => claimQueue.claimInputFromRow(claim, policySettings()));
  const snapshotIntegrity = verifyQueueSnapshot(queueSnapshot, policyClaims);
  if (!snapshotIntegrity.ok) throw new Error(`Reviewed queue snapshot failed integrity validation (${snapshotIntegrity.reason}). Refresh the queue.`);
  diagnostics?.record('info', 'claims', 'selection-complete', {
    totalRows: allClaims.length,
    selectedClaims: claimsToRun.length,
    skippedClaims: Math.max(0, allClaims.length - claimsToRun.length)
  }, { critical: true });

  const runtimeSecrets = await readRuntimeSecrets();
  const username = runtimeSecrets.username;
  const password = runtimeSecrets.password;
  diagnostics?.setSensitiveValues([
    username,
    password,
    ...Object.values(CLAIM_USER_SETTINGS)
  ]);
  diagnostics?.record('info', 'credentials', 'runtime-status', {
    usernameConfigured: Boolean(username),
    passwordConfigured: Boolean(password),
    claimAddressConfigured: Boolean(CLAIM_USER_SETTINGS.streetNumber && CLAIM_USER_SETTINGS.streetName),
    optionalAddressLine2Configured: Boolean(CLAIM_USER_SETTINGS.addressLine2),
    cityConfigured: Boolean(CLAIM_USER_SETTINGS.city),
    provinceConfigured: Boolean(CLAIM_USER_SETTINGS.province),
    postalCodeConfigured: Boolean(CLAIM_USER_SETTINGS.postalCode),
    contactNameConfigured: Boolean(CLAIM_USER_SETTINGS.contactName),
    contactPhoneConfigured: Boolean(CLAIM_USER_SETTINGS.contactPhone),
    contactEmailConfigured: Boolean(CLAIM_USER_SETTINGS.contactEmail),
    businessNameConfigured: Boolean(CLAIM_USER_SETTINGS.businessName)
  });

  if (!username || !password) throw new Error('Missing protected Canada Post runtime credentials.');
  requiredSetting(CLAIM_USER_SETTINGS.streetNumber, 'claim sender street number');
  requiredSetting(CLAIM_USER_SETTINGS.streetName, 'claim sender street name / Canada Post street dropdown option');

  if (claimsToRun.length === 0) {
    diagnostics?.state('complete-no-claims');
    emit('submit_complete', { total: 0, succeeded: 0, dryRunReady: 0, alreadySubmitted: 0, failed: 0 });
    await finalizeDiagnostics({ outcome: 'complete-no-claims', counts: { total: 0, succeeded: 0, dryRunReady: 0, alreadySubmitted: 0, failed: 0 } });
    return;
  }

  emit('submit_start', { total: claimsToRun.length, claimsCsv: csvPath, version: DUPLICATE_CLAIM_FIX_VERSION, dryRun });
  emit('log', { message: `Duplicate-claim detector active: ${DUPLICATE_CLAIM_FIX_VERSION}` });
  if (dryRun) emit('log', { message: 'DRY RUN ENABLED: the runner will stop on the sender/contact page before final review or submission controls.' });
  if (BUILTIN_BROWSER_MODE) {
    emit('log', { message: 'Using built-in Electron browser panel for Step 3.' });
    emit('log', { message: 'Using the app browser session for Canada Post login, verification, and claim submission.' });
  } else {
    emit('log', { message: 'Using external visible Chromium browser for Step 3.' });
    emit('log', { message: 'Using saved Playwright browser profile. This reduces repeated Canada Post text verification prompts.' });
  }

  diagnostics?.state('opening-browser');
  const browserSession = diagnostics
    ? await diagnostics.operation('browser.open', { mode: BUILTIN_BROWSER_MODE ? 'builtin' : 'external' }, () => openClaimBrowser(dataDir))
    : await openClaimBrowser(dataDir);
  const page = browserSession.page;
  diagnostics?.attachPage(page, 'claim-runner');
  await diagnostics?.capturePageState(page, 'browser-connected').catch(() => {});
  await hideBrowserWindow(page);
  const results = [];
  let activeAttemptId = null;

  try {
    diagnostics?.state('authenticating');
    if (diagnostics) await diagnostics.operation('authentication.login', {}, () => login(page, username, password));
    else await login(page, username, password);
    diagnostics?.state('authenticated');
    await diagnostics?.capturePageState(page, 'authenticated').catch(() => {});
    await hideBrowserWindow(page);
    diagnostics?.state('navigating-to-ticket-launcher');
    faultPoint('before_navigation');
    if (diagnostics) await diagnostics.operation('navigation.ticket-launcher', {}, () => navigateToLatePackageTicketLauncher(page));
    else await navigateToLatePackageTicketLauncher(page);
    faultPoint('after_navigation');
    let ticketLauncherUrl = page.url();
    diagnostics?.state('ticket-launcher-ready', { url: sanitizeUrl(ticketLauncherUrl) });
    await diagnostics?.capturePageState(page, 'ticket-launcher-ready').catch(() => {});
    await hideBrowserWindow(page);

    for (let i = 0; i < claimsToRun.length; i++) {
      if (stopRequested()) {
        emit('submit_stopped', { index: i, total: claimsToRun.length });
        break;
      }

      const claim = claimsToRun[i];
      const trackingNumber = required(claim, 'Tracking PIN');
      const policyClaim = claimQueue.claimInputFromRow(claim, policySettings());
      const revalidation = revalidateQueueItem({
        snapshot: queueSnapshot,
        claims: policyClaims,
        claim: policyClaim,
        currentEvidence: policyClaim,
        options: { asOf: new Date().toISOString(), classificationTimestamp: new Date().toISOString() }
      });
      const currentClassification = revalidation.current || null;
      if (currentClassification) claimDb.recordClassification(dbPath, trackingNumber, currentClassification, policyClaim);
      claimDb.recordWorkerRevalidation(dbPath, {
        snapshotId: Number(process.env.QUEUE_SNAPSHOT_ID || 0) || null,
        trackingNumber,
        allowed: revalidation.allowed,
        reason: revalidation.reason,
        snapshotHash: queueSnapshot.snapshotHash,
        result: revalidation
      });
      if (!revalidation.allowed) {
        emit('claim_revalidation_blocked', { row: claim._csvRowNumber, trackingNumber, reason: revalidation.reason, classification: currentClassification?.classification || '' });
        diagnostics?.record('warn', 'policy', 'claim-revalidation-blocked', { reason: revalidation.reason, classification: currentClassification?.classification || '' }, { critical: true });
        break;
      }
      diagnostics?.setClaim({
        index: i + 1,
        total: claimsToRun.length,
        row: claim._csvRowNumber,
        trackingNumber,
        referenceNumber: claim['Reference #'],
        postalCode: claim['Destination Postal Code']
      });
      diagnostics?.state('claim-starting', { claimIndex: i + 1, totalClaims: claimsToRun.length });
      activeAttemptId = claimDb.beginClaimAttempt(dbPath, {
        runId,
        dryRun,
        maxAttempts: Math.max(1, Number.parseInt(process.env.MAX_CLAIM_ATTEMPTS || '3', 10) || 3),
        trackingNumber,
        referenceNumber: claim['Reference #'],
        serviceCode: claim['Service Code'],
        destinationPostalCode: claim['Destination Postal Code'],
        expectedDate: claim['Expected Delivery Date'],
        firstAttemptDate: claim['First Attempt Date'],
        deliveryDate: claim['Actual Delivery Date'],
        classification: 'LATE_CANDIDATE',
        eligibilityReason: claim['Eligibility Reason'] || claim.Reason || 'Tracking shows the first delivery attempt occurred after the expected-delivery date.',
        message: dryRun ? 'Dry-run attempt started.' : 'Claim attempt started.'
      });

      diagnostics?.record('info', 'database', 'claim-attempt-created', { attemptId: activeAttemptId, dryRun });
      const result = diagnostics
        ? await diagnostics.operation('claim.process', { claimIndex: i + 1, totalClaims: claimsToRun.length }, () => processClaim(page, claim, i, claimsToRun.length, { dryRun }))
        : await processClaim(page, claim, i, claimsToRun.length, { dryRun });
      results.push(result);
      diagnostics?.record(result.ok ? 'info' : 'warn', 'claim', 'result', result, { critical: !result.ok });
      faultPoint('during_database_write');
      claimDb.completeClaimAttempt(dbPath, activeAttemptId, {
        status: result.status === 'dry_run_ready'
          ? 'dry_run_ready'
          : (result.status === 'submitted' || result.status === 'already_submitted' || result.status === 'rejected' || result.status === 'failed' || result.status === 'unknown'
              ? result.status
              : (result.ok ? 'submitted' : 'unknown')),
        confirmationNumber: result.confirmationNumber || '',
        message: result.message || result.error || '',
        errorCode: result.errorCode || '',
        screenshotPath: result.screenshotPath || '',
        textPath: result.textPath || '',
        lastUrl: result.lastUrl || page.url(),
        pageTitle: result.pageTitle || await page.title().catch(() => '')
      });
      diagnostics?.record('info', 'database', 'claim-attempt-completed', {
        attemptId: activeAttemptId,
        status: result.status,
        errorCode: result.errorCode || ''
      }, { critical: true });
      activeAttemptId = null;
      diagnostics?.clearClaim({ status: result.status, ok: result.ok });

      if (i < claimsToRun.length - 1 && !stopRequested()) {
        const delayMs = Number.parseInt(process.env.BETWEEN_CLAIMS_MS || '750', 10);
        if (delayMs > 0) await page.waitForTimeout(delayMs);
        if (BUILTIN_BROWSER_MODE) {
          diagnostics?.state('resetting-ticket-launcher', { nextClaimIndex: i + 2 });
          ticketLauncherUrl = diagnostics
            ? await diagnostics.operation('navigation.reset-ticket-launcher', { nextClaimIndex: i + 2 }, () => resetToTicketLauncher(page, ticketLauncherUrl, username, password))
            : await resetToTicketLauncher(page, ticketLauncherUrl, username, password);
          diagnostics?.state('ticket-launcher-ready', { url: sanitizeUrl(ticketLauncherUrl), nextClaimIndex: i + 2 });
          await diagnostics?.capturePageState(page, `ticket-launcher-reset-${i + 2}`).catch(() => {});
        }
      }
    }
  } catch (error) {
    diagnostics?.state('run-error', { error });
    diagnostics?.record('error', 'run', 'fatal-error', { error }, { critical: true });
    await diagnostics?.capturePageState(page, 'run-fatal-error').catch(() => {});
    const pageText = await collectVisibleText(page).catch(() => '');
    const lastUrl = page.url();
    const classified = classifyAutomationFailure(error, pageText, lastUrl);
    const artifacts = await saveClaimArtifacts(page, dataDir, 'claim-error-global', Date.now(), pageText, 2600).catch(() => ({ screenshotPath: '', textPath: '' }));
    const message = `Claim process error: ${error.message}`;
    if (activeAttemptId) {
      claimDb.completeClaimAttempt(dbPath, activeAttemptId, {
        status: 'unknown',
        message,
        errorCode: classified.errorCode,
        screenshotPath: artifacts.screenshotPath,
        textPath: artifacts.textPath,
        lastUrl,
        pageTitle: await page.title().catch(() => '')
      });
      activeAttemptId = null;
      diagnostics?.clearClaim({ status: 'unknown', errorCode: classified.errorCode });
    }
    emit('claim_error', {
      row: 'global',
      trackingNumber: '—',
      message,
      errorCode: classified.errorCode,
      screenshotPath: artifacts.screenshotPath,
      textPath: artifacts.textPath
    });
    results.push({
      ok: false,
      status: classified.status,
      row: 'global',
      trackingNumber: '—',
      error: message,
      errorCode: classified.errorCode,
      screenshotPath: artifacts.screenshotPath,
      textPath: artifacts.textPath,
      lastUrl,
      pageTitle: await page.title().catch(() => '')
    });
  } finally {
    diagnostics?.state('closing-browser');
    if (diagnostics) await diagnostics.operation('browser.close', {}, () => browserSession.close().catch(() => {}));
    else await browserSession.close().catch(() => {});
    faultPoint('during_process_termination');
  }

  const summaryPath = path.resolve(dataDir, 'claim-run-summary.json');
  const archivedSummaryPath = path.resolve(dataDir, `claim-run-summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeJsonAtomic(summaryPath, results);
  writeJsonAtomic(archivedSummaryPath, results);

  const { succeeded, dryRunReady, alreadySubmitted, rejected, failed } = summarizeClaimResults(results);
  diagnostics?.state(failed > 0 ? 'complete-with-errors' : 'complete', {
    total: results.length,
    succeeded,
    dryRunReady,
    alreadySubmitted,
    rejected,
    failed
  });
  emit('submit_complete', { total: results.length, succeeded, dryRunReady, alreadySubmitted, rejected, failed, summaryPath, dryRun });
  await finalizeDiagnostics({
    outcome: failed > 0 ? 'complete-with-errors' : 'complete',
    counts: { total: results.length, succeeded, dryRunReady, alreadySubmitted, rejected, failed },
    claimSummaryPath: summaryPath
  });

  // Approved, duplicate, rejected and dry-run-ready are ordinary business
  // outcomes. Only submission/automation errors make the worker fail.
  if (failed > 0) process.exitCode = 1;
}

function finishCli(exit = code => process.exit(code), stdout = process.stdout) {
  const code = Number.isInteger(process.exitCode) ? process.exitCode : 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    exit(code);
  };
  const timer = setTimeout(finish, 300);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    stdout.write('', finish);
  } catch (_) {
    finish();
  }
}

if (require.main === module) {
  main().catch(async error => {
    diagnostics?.state('fatal-startup-error', { error });
    diagnostics?.record('error', 'run', 'unhandled-main-error', { error }, { critical: true });
    emit('error', { message: error.message, stack: error.stack });
    await finalizeDiagnostics({ outcome: 'fatal-error', fatalError: error.message });
    process.exitCode = 1;
  }).finally(() => finishCli());
}

module.exports = {
  parseCsvLine,
  readClaims,
  getClaimsToRun,
  isCanadaPostUrl,
  classifyClaimOutcome,
  summarizeClaimResults,
  classifyAutomationFailure,
  extractConfirmationNumber,
  isFinalSubmissionLabel,
  waitForClaimNavigationProgress,
  finishCli,
  openClaimBrowser,
  requireBuiltinBrowserVisibility
};
