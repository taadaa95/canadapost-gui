const $ = (id) => document.getElementById(id);

const UI_FIX_VERSION = 'crossplatform-ui-v27';
const MAX_VISIBLE_LOG_LINES = 2000;
const LOG_BOTTOM_THRESHOLD_PX = 56;

const THEME_STORAGE_KEY = 'canadapostClaimRunnerTheme';
const DEFAULT_THEME = 'system';
const HISTORY_DEFAULT_FILTERS = Object.freeze({ search: '', status: 'all', page: 1, offset: 0 });
let activeMessages = {};
let preferredLocale = '';
let localeRequestVersion = 0;
const historyViewState = { ...HISTORY_DEFAULT_FILTERS };
let reconciliationFocusAttemptId = null;
const step3QueueController = window.Step3Queue.createController();
const rendererEvents = window.RendererContext.events;

function tr(key, fallback = '') { return activeMessages[key] || fallback || key; }
function trf(key, values = {}, fallback = '') {
  return tr(key, fallback).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  ));
}

function applyLocalizedDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = tr(element.dataset.i18n, '');
  });
  for (const attribute of ['placeholder', 'aria-label', 'title', 'alt']) {
    const dataAttribute = `data-i18n-${attribute}`;
    root.querySelectorAll(`[${dataAttribute}]`).forEach(element => {
      element.setAttribute(attribute, tr(element.getAttribute(dataAttribute), ''));
    });
  }
  root.querySelectorAll('[data-i18n-current]').forEach(element => {
    let values = {};
    try { values = JSON.parse(element.dataset.i18nValues || '{}'); } catch (_) { values = {}; }
    element.textContent = trf(element.dataset.i18nCurrent, values, element.textContent);
  });
}

function setLocalizedText(element, key, values = {}, fallback = '') {
  if (!element) return;
  element.dataset.i18nCurrent = key;
  element.dataset.i18nValues = JSON.stringify(values);
  element.textContent = trf(key, values, fallback);
}

async function applyLocale(locale) {
  const requestVersion = ++localeRequestVersion;
  const result = await window.cpApp.loadLocale(locale);
  if (requestVersion !== localeRequestVersion) return false;
  activeMessages = result.messages || {};
  document.documentElement.lang = result.locale || 'en-CA';
  if ($('localeSelect')) $('localeSelect').value = result.locale || 'en-CA';
  applyLocalizedDom(document);
  window.Step2Copy.apply(document, key => tr(key));
  updateNotificationIndicator();
  for (const stepId of ['step1', 'step2', 'step3']) updateJumpToLatest(stepId);
  renderResultsList();
  renderNeedsReview();
  if (state.claimQueueLoaded) renderClaimQueue(state.claimQueueItems, true);
  renderPortalCompatibilityAdvisory();
  if (state.step3ActionReport) showStep3ActionIssues(state.step3ActionReport);
  if (!$('setupWizard')?.classList.contains('hidden')) renderSetupWizardReadiness(await window.cpApp.loadConfig());
  rendererEvents.emit('locale:changed', { locale: result.locale || 'en-CA' });
  return true;
}

function applyTheme(theme) {
  const selectedTheme = window.Onboarding.normalizeTheme(theme || DEFAULT_THEME);
  const resolvedTheme = selectedTheme === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : selectedTheme;
  document.documentElement.setAttribute('data-theme', resolvedTheme);
  document.documentElement.setAttribute('data-theme-preference', selectedTheme);
  rendererEvents.emit('theme:changed', { theme: selectedTheme });
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, selectedTheme);
  } catch (_) {
    // Ignore storage failures; theme still applies for current session.
  }
}

function loadSavedTheme() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME;
  } catch (_) {
    return DEFAULT_THEME;
  }
}

function initThemePicker() {
  const picker = $('themeSelect');
  if (!picker) return;

  const savedTheme = loadSavedTheme();
  const hasSavedTheme = Array.from(picker.options).some((option) => option.value === savedTheme);
  picker.value = hasSavedTheme ? savedTheme : DEFAULT_THEME;
  applyTheme(picker.value);

  picker.addEventListener('change', () => applyTheme(picker.value));
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (picker.value === 'system') applyTheme('system');
  });
}

let activeTabId = 'settingsTab';
let currentProcessStep = 'step1';
const liveLogState = new Map();

function activateTab(tabId) {
  const target = tabId || 'step1';
  activeTabId = target;
  document.documentElement.classList.toggle('page-scroll-layout', target === 'step3' || target === 'historyTab');
  document.body.classList.toggle('page-scroll-layout', target === 'step3' || target === 'historyTab');
  document.querySelectorAll('.step-tab').forEach((button) => {
    const active = button.dataset.tab === target;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    const active = panel.id === target;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  if (target === 'resultsTab') {
    operations.unreadNotifications = 0;
  }
  if (target === 'historyTab') {
    refreshHistory().catch((error) => console.error(error));
  }
  if (target === 'step3') {
    if (!state.claimQueueLoaded) refreshClaimQueue().catch((error) => console.error(error));
    refreshPortalCompatibilityStatus().catch((error) => console.error(error));
  }
  updateNotificationIndicator();
  requestBuiltinBrowserLayout(target === 'step3' ? 'step3-tab-activation' : 'app-tab-change');
  rendererEvents.emit('tab:changed', { tabId: target });
}

function stepForStage(stage) {
  if (stage === 'est-history' || stage === 'history') return 'step1';
  if (stage === 'tracking') return 'step2';
  if (stage === 'submit' || stage === 'health') return 'step3';
  return currentProcessStep || activeTabId || 'step1';
}

function logIdForStep(stepId) {
  if (stepId === 'step1') return 'step1Log';
  if (stepId === 'step2') return 'step2Log';
  if (stepId === 'step3') return 'step3Log';
  return 'step1Log';
}

function logStepForId(logId) {
  return logId === 'step2Log' ? 'step2' : (logId === 'step3Log' ? 'step3' : 'step1');
}

function isLogNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= LOG_BOTTOM_THRESHOLD_PX;
}

function updateJumpToLatest(stepId) {
  const stateForLog = liveLogState.get(stepId);
  const button = $(`${stepId}JumpLatest`);
  if (!stateForLog || !button) return;
  button.hidden = stateForLog.following || stateForLog.unread === 0;
  if (stateForLog.unread > 0) {
    setLocalizedText(button, 'log.jumpLatestCount', { count: stateForLog.unread > 999 ? '999+' : stateForLog.unread }, 'Jump to latest ({count})');
  } else {
    setLocalizedText(button, 'log.jumpLatest', {}, 'Jump to latest');
  }
}

function jumpToLatest(stepId) {
  const element = $(logIdForStep(stepId));
  const stateForLog = liveLogState.get(stepId);
  if (!element || !stateForLog) return;
  element.scrollTop = element.scrollHeight;
  stateForLog.following = true;
  stateForLog.unread = 0;
  updateJumpToLatest(stepId);
}

function initLiveLogs() {
  for (const logId of ['step1Log', 'step2Log', 'step3Log']) {
    const element = $(logId);
    if (!element) continue;
    const stepId = logStepForId(logId);
    liveLogState.set(stepId, { following: true, unread: 0 });
    element.addEventListener('scroll', () => {
      const stateForLog = liveLogState.get(stepId);
      stateForLog.following = isLogNearBottom(element);
      if (stateForLog.following) stateForLog.unread = 0;
      updateJumpToLatest(stepId);
    }, { passive: true });
    $(`${stepId}JumpLatest`)?.addEventListener('click', () => jumpToLatest(stepId));
  }
}

function statusIdForStep(stepId) {
  if (stepId === 'step1') return 'step1RunStatus';
  if (stepId === 'step2') return 'step2RunStatus';
  if (stepId === 'step3') return 'step3RunStatus';
  return 'step1RunStatus';
}

function actionIdForStep(stepId) {
  if (stepId === 'step1') return 'step1CurrentAction';
  if (stepId === 'step2') return 'step2CurrentAction';
  if (stepId === 'step3') return 'step3CurrentAction';
  return 'step1CurrentAction';
}

function initStepTabs() {
  const tabs = Array.from(document.querySelectorAll('.step-tab'));
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => activateTab(button.dataset.tab));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      activateTab(tabs[nextIndex].dataset.tab);
      tabs[nextIndex].focus();
    });
  });
  activateTab('settingsTab');
}

let builtinBrowserLayoutFrame = 0;
let builtinBrowserRepositionFrame = 0;
let builtinBrowserResizeObserver = null;
let builtinBrowserDisplayState = { visible: false, reason: 'not-created' };
let builtinBrowserRunActive = false;
let builtinBrowserManualActionPending = false;

function useBuiltinBrowser() {
  return $('builtinBrowser') ? $('builtinBrowser').checked : false;
}

function setBuiltinBrowserStatus(text, kind = '') {
  const status = $('builtinBrowserStatus');
  if (!status) return;
  status.textContent = text;
  status.className = `pill ${kind}`.trim();
}

let browserActivityHideTimer = 0;

function setBuiltinBrowserActivity(active, text = '', kind = '') {
  const container = $('builtinBrowserActivity');
  const label = $('builtinBrowserActivityText');
  if (!container || !label) return;

  if (browserActivityHideTimer) {
    clearTimeout(browserActivityHideTimer);
    browserActivityHideTimer = 0;
  }

  label.textContent = text || (active ? tr('step3.browser.working', 'Canada Post is working…') : tr('step3.browser.idleStatus', 'Browser idle'));
  container.classList.toggle('active', Boolean(active));
  container.classList.toggle('error', kind === 'error');
  container.setAttribute('aria-busy', active ? 'true' : 'false');
}

function finishBuiltinBrowserActivity(text = '', kind = '') {
  text ||= tr('step3.browser.ready', 'Browser ready');
  setBuiltinBrowserActivity(false, text, kind);
  browserActivityHideTimer = window.setTimeout(() => {
    if (!$('builtinBrowserActivity')?.classList.contains('active')) {
      setBuiltinBrowserActivity(false, tr('step3.browser.idleStatus', 'Browser idle'));
    }
  }, 1800);
}

function syncBuiltinBrowserClass() {
  const step3 = $('step3');
  if (!step3) return;
  step3.classList.toggle('builtin-browser-enabled', useBuiltinBrowser());
}

function browserSlotPlaceholder() {
  return $('builtinBrowserSlot')?.querySelector('.browser-slot-placeholder') || null;
}

function setBrowserSlotPlaceholder(visible, text = '', localizationKey = '') {
  const placeholder = browserSlotPlaceholder();
  if (!placeholder) return;
  placeholder.hidden = !visible;
  placeholder.setAttribute('aria-hidden', visible ? 'false' : 'true');
  if (text && localizationKey) setLocalizedText(placeholder, localizationKey, {}, text);
  else if (text) {
    delete placeholder.dataset.i18nCurrent;
    delete placeholder.dataset.i18nValues;
    placeholder.textContent = text;
  }
}

function browserSlotMeasurement(reason = 'renderer-measurement') {
  const slot = $('builtinBrowserSlot');
  if (!slot) return {
    reason,
    step3Active: activeTabId === 'step3',
    browserEnabled: useBuiltinBrowser(),
    placeholderVisible: true,
    rawDomRect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
  };
  const rect = slot.getBoundingClientRect();
  return {
    reason,
    step3Active: activeTabId === 'step3',
    browserEnabled: useBuiltinBrowser(),
    placeholderVisible: !browserSlotPlaceholder()?.hidden,
    rawDomRect: {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    },
    viewport: {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight
    }
  };
}

function builtinBrowserBounds() {
  const measurement = browserSlotMeasurement('bounds-read');
  const rect = measurement.rawDomRect;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.right);
  const bottom = Math.min(viewportHeight, rect.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width < 80 || height < 80) return null;

  // A native WebContentsView does not participate in DOM sizing. Give it only
  // the visible portion of the bounded slot so page content can never enlarge
  // or paint beyond the Step 3 workspace.
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(width),
    height: Math.round(height)
  };
}

function waitingForManualActionText() {
  return tr('step3.browser.waitingManualAction', 'Waiting for manual action');
}

function idleBrowserPlaceholderLocalization() {
  const summary = step3QueueController.snapshot();
  if (!summary.total) return { key: 'step3.browser.noCandidates', fallback: 'No late-delivery candidates are currently available.' };
  if (!summary.executable) return { key: 'step3.browser.noExecutable', fallback: 'No executable claims are available. Review blocked attempts in History.' };
  return { key: 'step3.browser.idle', fallback: 'Canada Post will open here after an executable claim passes preflight.' };
}

function applyBuiltinBrowserDisplayState(result = {}) {
  builtinBrowserDisplayState = { ...builtinBrowserDisplayState, ...result };
  if (result.visible && builtinBrowserRunActive) {
    setBrowserSlotPlaceholder(false);
    if (builtinBrowserManualActionPending) {
      setBuiltinBrowserStatus(waitingForManualActionText(), 'warn');
    } else if (!$('builtinBrowserActivity')?.classList.contains('active')) {
      setBuiltinBrowserStatus(tr('step3.browser.opening', 'Loading Canada Post'), 'warn');
    }
    return;
  }
  if (result.reason === 'browser-preparing' && builtinBrowserRunActive) {
    setBrowserSlotPlaceholder(true, tr('step3.browser.preparing', 'Preparing the secure Canada Post browser…'), 'step3.browser.preparing');
    setBuiltinBrowserStatus(tr('step3.browser.preparingStatus', 'Preparing browser'), 'warn');
    return;
  }
  if (result.reason === 'slot-offscreen' || result.reason === 'step3-inactive') {
    setBrowserSlotPlaceholder(true, tr('step3.browser.hidden', 'Canada Post is hidden while the browser area is offscreen.'), 'step3.browser.hidden');
    setBuiltinBrowserStatus(tr('step3.browser.hiddenStatus', 'Browser hidden'), 'warn');
    return;
  }
  if (result.ok === false && builtinBrowserRunActive) {
    setBrowserSlotPlaceholder(true, tr('step3.browser.displayError', 'The built-in browser could not be displayed. Stop Step 3 and review diagnostics.'), 'step3.browser.displayError');
    setBuiltinBrowserStatus(tr('step3.browser.displayErrorStatus', 'Browser display error'), 'bad');
    return;
  }
  const idlePlaceholder = idleBrowserPlaceholderLocalization();
  setBrowserSlotPlaceholder(true, tr(idlePlaceholder.key, idlePlaceholder.fallback), idlePlaceholder.key);
  setBuiltinBrowserStatus(tr('step3.browser.idleStatus', 'Browser idle'), '');
}

async function deactivateBuiltinBrowser(reason = 'run-inactive', placeholderText = '', placeholderKey = '') {
  builtinBrowserRunActive = false;
  builtinBrowserManualActionPending = false;
  if (window.cpApp?.hideBuiltinBrowser) await window.cpApp.hideBuiltinBrowser().catch(() => {});
  applyBuiltinBrowserDisplayState({ ok: true, visible: false, reason });
  if (placeholderText) setBrowserSlotPlaceholder(true, placeholderText, placeholderKey);
  setBuiltinBrowserActivity(false, tr('step3.browser.idleStatus', 'Browser idle'));
}

async function synchronizeBuiltinBrowserVisibility(options = {}) {
  syncBuiltinBrowserClass();
  if (options.activate === true) builtinBrowserRunActive = true;
  if (!builtinBrowserRunActive) {
    if (window.cpApp?.hideBuiltinBrowser) await window.cpApp.hideBuiltinBrowser().catch(() => {});
    const result = { ok: true, visible: false, reason: 'run-inactive' };
    applyBuiltinBrowserDisplayState(result);
    return result;
  }
  const slot = $('builtinBrowserSlot');
  if (options.scrollIntoView && activeTabId === 'step3' && slot) {
    slot.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  if (!window.cpApp?.syncBuiltinBrowserVisibility) return { ok: false, error: 'Browser visibility IPC is unavailable.' };
  const measurement = browserSlotMeasurement(options.reason || 'renderer-sync');
  const result = await window.cpApp.syncBuiltinBrowserVisibility({
    ...measurement,
    requestId: String(options.requestId || ''),
    force: Boolean(options.force),
    requireVisible: Boolean(options.requireVisible)
  }).catch(error => ({ ok: false, error: error.message, code: 'BROWSER_DISPLAY_ERROR' }));
  applyBuiltinBrowserDisplayState(result);
  return result;
}

function requestBuiltinBrowserLayout(reason = 'layout-request') {
  syncBuiltinBrowserClass();
  if (builtinBrowserLayoutFrame) cancelAnimationFrame(builtinBrowserLayoutFrame);
  builtinBrowserLayoutFrame = requestAnimationFrame(async () => {
    builtinBrowserLayoutFrame = 0;
    const result = await synchronizeBuiltinBrowserVisibility({ reason, force: true });
    if (result?.ok === false && result.code !== 'BROWSER_DISABLED') log(result.error || 'Could not synchronize the built-in browser display.', 'log-submit-error', 'step3');
  });
}

function resizeBuiltinBrowserToSlot(reason = 'resize-to-slot') {
  return synchronizeBuiltinBrowserVisibility({ reason, force: true });
}

function scheduleBuiltinBrowserReposition() {
  if (builtinBrowserRepositionFrame) return;
  builtinBrowserRepositionFrame = requestAnimationFrame(async () => {
    builtinBrowserRepositionFrame = 0;

    await synchronizeBuiltinBrowserVisibility({ reason: 'scroll-or-resize', force: true });
  });
}

function initBuiltinBrowserPositionTracking() {
  // Capture scroll events from the window and every nested scroll container.
  window.addEventListener('scroll', scheduleBuiltinBrowserReposition, { capture: true, passive: true });
  window.addEventListener('resize', () => requestBuiltinBrowserLayout('window-resize'));
  window.visualViewport?.addEventListener('scroll', scheduleBuiltinBrowserReposition, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleBuiltinBrowserReposition, { passive: true });

  const slot = $('builtinBrowserSlot');
  if (slot && typeof ResizeObserver === 'function') {
    builtinBrowserResizeObserver = new ResizeObserver(() => requestBuiltinBrowserLayout('browser-slot-resize'));
    builtinBrowserResizeObserver.observe(slot);
  }
}

const state = window.RendererContext.state;
Object.assign(state, {
  step1Orders: 0,
  step1Imported: 0,
  step1TotalRows: 0,
  step1Workgroups: 0,
  step1Warnings: 0,
  step1WarningMessages: [],
  checked: 0,
  trackingTotal: 0,
  late: 0,
  onTime: 0,
  notDelivered: 0,
  deliveredReview: 0,
  overdueInTransit: 0,
  reviewRequired: 0,
  trackingErrors: 0,
  skipped: 0,
  submitted: 0,
  alreadySubmitted: 0,
  rejected: 0,
  failed: 0,
  submitTotal: 0,
  developerMode: false,
  passwordStored: false,
  trackingApiCredentialsStored: false,
  trackingApiEnvironment: 'test',
  trackingDiagnosticGateSatisfied: false,
  trackingDiagnosticMode: false,
  trackingTokenLogged: false,
  trackingApiVersion: '1.0.0',
  isolatedTestMode: false,
  evidenceRetentionDays: 90,
  dryRunDefault: true,
  claimQueueItems: [],
  claimQueueLoaded: false,
  portalCompatibility: { ok: false, code: 'PORTAL_COMPATIBILITY_REQUIRED' },
  portalCompatibilityViewId: '',
  portalCompatibilityWarningDismissed: false,
  step3ActionReport: null,
  privacyPreview: null
});

const operations = {
  runStartedAt: null,
  submitStartedAt: null,
  finishedAt: null,
  current: {
    tracking: '—',
    row: '—',
    index: null,
    total: null,
    step: 'Waiting',
    result: '—',
    kind: '',
    startedAt: null
  },
  recentResults: [],
  needsReview: [],
  detailItems: new Map(),
  detailCounter: 0,
  selectedDetailId: null,
  unreadNotifications: 0
};

let operationsTimer = null;
let selectedDetail = null;

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = String(value);
}

function classifyLogLine(text) {
  const clean = String(text || '').trim();

  if (/^(\[tracking\]\s+)?LATE:/i.test(clean)) return 'log-late';
  if (/^(\[tracking\]\s+)?(?:Not delivered yet:|OVERDUE \/ NOT DELIVERED:)/i.test(clean)) return 'log-not-delivered';
  if (/^(\[tracking\]\s+)?On time:/i.test(clean)) return 'log-on-time';
  if (/CAPTCHA detected|manual CAPTCHA solve|CAPTCHA still active|Still waiting for manual CAPTCHA/i.test(clean)) return 'log-captcha';
  if (/^(?:\[submit\]\s*)?ALREADY SUBMITTED\b|already submitted:/i.test(clean)) return 'log-submit-already';
  if (/^(?:\[(?:est-history|history|tracking|submit)\]\s*)?(?:complete|completed|success|succeeded)\b|Tracking stage complete|Claim submission complete\.?$|Submission complete\. Succeeded:\s*[1-9]|EST Desktop history export complete|tracking\.csv was generated/i.test(clean)) return 'log-submit-success';
  if (/\bRETRY\b|\bbackoff\b/i.test(clean)) return 'log-retry';
  if (/^(?:\[(?:est-history|history|tracking|submit)\]\s*)?(?:warning|warn)\b|warnings?:\s*[1-9]|not recommended/i.test(clean)) return 'log-warning';
  if (/^(?:\[(?:est-history|history|tracking|submit)\]\s*)?ERROR\b|failed with code|stage failed|process finished with code [1-9]|Failed:\s*[1-9]|Could not|Missing .*\bsetting/i.test(clean)) return 'log-submit-error';
  if (/^(\[DEV RAW\]|\[(history|tracking|submit|est-history)\] \[DEV RAW\])/i.test(clean)) return 'log-dev';

  return '';
}

function log(message, cls = '', stepId = null, options = {}) {
  const requestedStep = stepId || activeTabId || currentProcessStep || 'step1';
  const selectedStep = ['step1', 'step2', 'step3'].includes(requestedStep) ? requestedStep : (currentProcessStep || 'step1');
  const el = $(logIdForStep(selectedStep));
  if (!el) return;

  const stateForLog = liveLogState.get(selectedStep) || { following: true, unread: 0 };
  liveLogState.set(selectedStep, stateForLog);
  const shouldFollow = stateForLog.following && (el.childElementCount === 0 || isLogNearBottom(el));
  const rawText = String(message || '');
  const text = options.allowFullTrackingNumber === true
    ? rawText
    : rawText.replace(/\b(?=[A-Z0-9]{10,35}\b)(?=[A-Z0-9]*\d{6})[A-Z0-9]+\b/gi, '[REDACTED_ID]');
  const detectedClass = classifyLogLine(text);
  const line = document.createElement('div');
  line.className = `log-line ${cls || detectedClass}`.trim();
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.appendChild(line);
  while (el.childElementCount > MAX_VISIBLE_LOG_LINES) el.firstElementChild.remove();
  if (shouldFollow) {
    el.scrollTop = el.scrollHeight;
    stateForLog.following = true;
    stateForLog.unread = 0;
  } else {
    stateForLog.following = false;
    stateForLog.unread += 1;
  }
  updateJumpToLatest(selectedStep);
}

function logStage(stage, message, cls = '', options = {}) {
  log(message, cls, stepForStage(stage), options);
}

function setStatus(text, kind = '', stepId = null) {
  const step = stepId || currentProcessStep || activeTabId || 'step1';
  const el = $(statusIdForStep(step));
  if (el) {
    const keys = {
      Idle: 'runStatus.idle', Running: 'runStatus.running', Complete: 'runStatus.complete', Warnings: 'runStatus.warnings',
      Failed: 'runStatus.failed', Blocked: 'runStatus.blocked', Stopped: 'runStatus.stopped', Cancelled: 'runStatus.cancelled',
      Validating: 'runStatus.validating', 'Diagnostic passed': 'runStatus.diagnosticPassed', 'Diagnostic failed': 'runStatus.diagnosticFailed',
      'Manual verification required': 'runStatus.manualVerification', CAPTCHA: 'runStatus.captcha',
      'Structural diagnostic running': 'runStatus.structuralDiagnosticRunning', 'Diagnostic running': 'runStatus.diagnosticRunning',
      'Structural diagnostic blocked': 'runStatus.structuralDiagnosticBlocked', 'Diagnostic blocked': 'runStatus.diagnosticBlocked'
    };
    const key = keys[text];
    if (key) setLocalizedText(el, key, {}, text);
    else { delete el.dataset.i18nCurrent; delete el.dataset.i18nValues; el.textContent = text; }
    el.className = `pill ${kind}`.trim();
  }
}

function setAction(text, stepId = null) {
  const step = stepId || currentProcessStep || activeTabId || 'step1';
  const el = $(actionIdForStep(step));
  if (el) {
    delete el.dataset.i18nCurrent;
    delete el.dataset.i18nValues;
    el.textContent = text;
  }
}

function setActionLocalized(key, values = {}, fallback = '', stepId = null) {
  const step = stepId || currentProcessStep || activeTabId || 'step1';
  setLocalizedText($(actionIdForStep(step)), key, values, fallback);
}


function updateNotificationIndicator() {
  const totalCount = operations.recentResults.length;
  const unreadCount = Math.max(0, operations.unreadNotifications || 0);
  const badge = $('notificationsBadge');
  const pill = $('notificationsCountPill');
  const tab = $('tabResults');

  if (badge) {
    badge.textContent = String(unreadCount);
    badge.classList.toggle('hidden', unreadCount === 0 || activeTabId === 'resultsTab');
    badge.classList.toggle('flash', unreadCount > 0 && activeTabId !== 'resultsTab');
  }

  if (tab) {
    tab.classList.toggle('has-notifications', unreadCount > 0 && activeTabId !== 'resultsTab');
    tab.classList.toggle('flash-tab', unreadCount > 0 && activeTabId !== 'resultsTab');
  }

  if (pill) {
    setLocalizedText(pill, totalCount === 1 ? 'results.oneNotification' : 'results.notificationCount', { count: totalCount }, totalCount === 1 ? '1 notification' : '{count} notifications');
    pill.className = `pill ${totalCount > 0 ? 'warn inline-count' : 'inline-count'}`.trim();
  }
}

function processedClaims() {
  return state.submitted + state.alreadySubmitted + state.rejected + state.failed;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function shortTracking(value) {
  if (!value || value === '—') return '—';
  const text = String(value);
  return text.length > 16 ? `…${text.slice(-16)}` : text;
}

function basename(value) {
  if (!value) return '';
  return String(value).split(/[\\/]/).pop();
}

function safeCell(value, fallback = '—') {
  const text = value === undefined || value === null || value === '' ? fallback : String(value);
  return text;
}

function outcomeClass(kind) {
  if (kind === 'submitted') return 'ops-good';
  if (kind === 'already') return 'ops-already';
  if (kind === 'failed') return 'ops-bad';
  if (kind === 'captcha') return 'ops-captcha';
  if (kind === 'warning') return 'ops-warn';
  return '';
}

function outcomeRowClass(kind) {
  if (kind === 'submitted') return 'outcome-submitted';
  if (kind === 'already') return 'outcome-already';
  if (kind === 'failed') return 'outcome-failed';
  if (kind === 'captcha') return 'outcome-captcha';
  if (kind === 'warning') return 'outcome-warning';
  return '';
}

function pillKind(kind) {
  if (kind === 'submitted') return 'good';
  if (kind === 'already') return 'warn';
  if (kind === 'failed') return 'bad';
  if (kind === 'captcha') return 'bad';
  return '';
}

function updateCurrentItem(data = {}) {
  operations.current = {
    ...operations.current,
    ...data
  };
}

function registerDetailItem(item) {
  const id = `detail-${++operations.detailCounter}`;
  const normalized = {
    id,
    time: new Date().toLocaleTimeString(),
    kind: item.kind || '',
    status: item.status || item.result || '—',
    result: item.result || item.status || '—',
    tracking: item.tracking || '—',
    row: item.row || '—',
    source: item.source || 'Notifications',
    issue: item.issue || '',
    message: item.message || '',
    screenshotPath: item.screenshotPath || '',
    textPath: item.textPath || '',
    evidenceName: basename(item.screenshotPath || item.textPath || ''),
    eventType: item.eventType || '',
    decision: item.decision || ''
  };
  operations.detailItems.set(id, normalized);
  return normalized;
}

function addRecentResult(kind, tracking, result, row = '—', detail = {}) {
  const item = registerDetailItem({
    ...detail,
    kind,
    tracking: tracking || '—',
    result: result || '—',
    status: result || '—',
    row: row || '—',
    source: detail.source || 'Notifications'
  });

  operations.recentResults.unshift(item);
  operations.recentResults = operations.recentResults.slice(0, 25);
  if (activeTabId !== 'resultsTab') {
    operations.unreadNotifications = Math.min(99, (operations.unreadNotifications || 0) + 1);
  } else {
    operations.unreadNotifications = 0;
  }
  updateNotificationIndicator();
  return item;
}

function addNeedsReview(kind, tracking, issue, row = '—', screenshotPath = '', detail = {}) {
  const item = registerDetailItem({
    ...detail,
    kind,
    tracking: tracking || '—',
    issue: issue || 'Needs review',
    result: issue || 'Needs review',
    status: kind === 'already' ? 'Already submitted' : 'Needs review',
    row: row || '—',
    source: 'Needs Review',
    screenshotPath: screenshotPath || detail.screenshotPath || ''
  });

  operations.needsReview.unshift(item);
  operations.needsReview = operations.needsReview.slice(0, 10);
  return item;
}

function createCell(text, className = '') {
  const cell = document.createElement('div');
  cell.className = `ops-cell ${className}`.trim();
  cell.textContent = safeCell(text);
  cell.title = safeCell(text, '');
  return cell;
}

function localizedInterfaceValue(value) {
  const text = String(value || '');
  const keys = {
    Submitted: 'outcome.submitted', 'Already submitted': 'outcome.alreadySubmitted', Failed: 'outcome.failed',
    'Rejected / ineligible': 'outcome.rejected', 'CAPTCHA detected': 'outcome.captcha', 'Needs review': 'outcome.needsReview',
    'Duplicate claim': 'outcome.duplicateClaim', 'Claim result received': 'outcome.resultReceived', 'In progress': 'status.inProgress',
    'Manual verification required': 'runStatus.manualVerification', 'Paused for operator': 'outcome.pausedForOperator',
    'Paused for manual solve': 'outcome.pausedForManualSolve', 'Waiting for manual solve': 'outcome.waitingForManualSolve',
    Resuming: 'outcome.resuming', Done: 'outcome.done', 'Runner error': 'event.runnerError',
    submitted: 'outcome.submitted', submitted_manual: 'history.filter.submittedManual', already_submitted: 'outcome.alreadySubmitted',
    failed: 'outcome.failed', unknown: 'history.filter.unknown', not_submitted: 'history.filter.notSubmitted',
    retry_approved: 'history.filter.retryApproved', dry_run_ready: 'history.filter.dryRunReady', dry_run_interrupted: 'history.filter.dryRunInterrupted'
  };
  return keys[text] ? tr(keys[text], text) : (text || '—');
}

function makeClickableRow(row, item) {
  row.classList.add('clickable');
  row.tabIndex = 0;
  row.title = tr('results.openDetailsTitle', 'Open detailed result screen');
  row.addEventListener('click', () => openDetail(item.id));
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDetail(item.id);
    }
  });
}

function resultDetailText(item) {
  if (!item) return '—';
  if (item.issue) return localizedInterfaceValue(item.issue);
  if (item.kind === 'submitted') return tr('results.confirmedByCanadaPost', 'Confirmed by Canada Post success page');
  if (item.kind === 'already') return tr('results.duplicateDetected', 'Duplicate claim detected by Canada Post');
  if (item.kind === 'failed') return item.message || tr('results.needsManualReview', 'Needs manual review');
  if (item.kind === 'captcha') return item.message || tr('results.captchaCaptured', 'CAPTCHA screenshot captured; solve manually in browser');
  return item.message || '—';
}

function resultEvidenceText(item) {
  if (!item) return '—';
  return item.evidenceName || basename(item.screenshotPath || '') || '—';
}

function renderResultsList() {
  const el = $('resultsList');
  if (!el) return;
  el.textContent = '';

  const head = document.createElement('div');
  head.className = 'ops-head results-grid';
  head.append(
    createCell(tr('common.time', 'Time')),
    createCell(tr('common.row', 'Row')),
    createCell(tr('common.tracking', 'Tracking')),
    createCell(tr('common.result', 'Result')),
    createCell(tr('common.details', 'Details')),
    createCell(tr('common.evidence', 'Evidence'))
  );
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'ops-body';
  el.appendChild(body);

  if (operations.recentResults.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ops-empty';
    empty.textContent = tr('results.empty', 'No claim results yet.');
    body.appendChild(empty);
    return;
  }

  for (const item of operations.recentResults) {
    const row = document.createElement('div');
    row.className = `ops-row results-grid ${outcomeRowClass(item.kind)}`.trim();
    makeClickableRow(row, item);
    row.append(
      createCell(item.time, 'ops-muted'),
      createCell(item.row, 'ops-muted'),
      createCell(item.tracking),
      createCell(localizedInterfaceValue(item.result), outcomeClass(item.kind)),
      createCell(resultDetailText(item), outcomeClass(item.kind)),
      createCell(resultEvidenceText(item), 'ops-muted')
    );
    body.appendChild(row);
  }
}

function renderNeedsReview() {
  const el = $('needsReview');
  if (!el) return;
  el.textContent = '';

  const head = document.createElement('div');
  head.className = 'ops-head review-grid';
  head.append(createCell(tr('common.row', 'Row')), createCell(tr('common.tracking', 'Tracking')), createCell(tr('common.issue', 'Issue')));
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'ops-body';
  el.appendChild(body);

  if (operations.needsReview.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ops-empty';
    empty.textContent = tr('results.noReviewItems', 'No review items.');
    body.appendChild(empty);
    return;
  }

  for (const item of operations.needsReview) {
    const row = document.createElement('div');
    row.className = 'ops-row review-grid';
    makeClickableRow(row, item);
    const issueText = item.evidenceName ? `${item.issue} | ${item.evidenceName}` : item.issue;
    row.append(
      createCell(item.row, 'ops-muted'),
      createCell(shortTracking(item.tracking)),
      createCell(issueText, outcomeClass(item.kind))
    );
    body.appendChild(row);
  }
}

function updateOperationsPanel() {
  renderResultsList();
}

function startOperationsTimer() {
  if (operationsTimer) clearInterval(operationsTimer);
  operationsTimer = setInterval(updateOperationsPanel, 1000);
}

function stopOperationsTimer() {
  if (operationsTimer) {
    clearInterval(operationsTimer);
    operationsTimer = null;
  }
}

function updateCounters() {
  setText('step1Orders', state.step1Orders);
  setText('step1Imported', state.step1Imported);
  setText('step1Workgroups', state.step1Workgroups);
  setText('step1Warnings', state.step1Warnings);

  const step1Pct = state.step1TotalRows > 0 ? Math.round((state.step1Imported / state.step1TotalRows) * 100) : 0;
  if ($('step1Progress')) $('step1Progress').value = Math.max(0, Math.min(100, step1Pct));
  setText('step1Pct', `${Math.max(0, Math.min(100, step1Pct))}%`);

  setText('checked', state.checked);
  setText('late', state.late);
  setText('onTime', state.onTime);
  setText('notDelivered', state.notDelivered);

  setText('submitted', state.submitted);
  setText('alreadySubmitted', state.alreadySubmitted);
  setText('failed', state.failed);
  setText('submitTotal', state.submitTotal);

  const trackingPct = state.trackingTotal > 0 ? Math.round((state.checked / state.trackingTotal) * 100) : 0;
  if ($('trackingProgress')) $('trackingProgress').value = trackingPct;
  setText('trackingPct', `${trackingPct}%`);

  const submitPct = state.submitTotal > 0 ? Math.round((processedClaims() / state.submitTotal) * 100) : 0;
  if ($('submitProgress')) $('submitProgress').value = submitPct;
  setText('submitPct', `${submitPct}%`);
  setText('submitProcessedMini', `${processedClaims()}/${state.submitTotal || 0}`);

  updateOperationsPanel();
}

function resetResultsData() {
  operations.recentResults = [];
  operations.needsReview = [];
  operations.detailItems = new Map();
  operations.detailCounter = 0;
  operations.selectedDetailId = null;
  operations.unreadNotifications = 0;
  selectedDetail = null;
  showOperationsList();
  updateNotificationIndicator();
}

function resetStepUi(stepId) {
  const step = stepId || activeTabId || 'step1';

  if (step === 'step1') {
    state.step1Orders = 0;
    state.step1Imported = 0;
    state.step1TotalRows = 0;
    state.step1Workgroups = 0;
    state.step1Warnings = 0;
    state.step1WarningMessages = [];
  }

  if (step === 'step2') {
    state.checked = 0;
    state.trackingTotal = 0;
    state.late = 0;
    state.onTime = 0;
    state.notDelivered = 0;
    state.deliveredReview = 0;
    state.overdueInTransit = 0;
    state.reviewRequired = 0;
    state.trackingErrors = 0;
    state.skipped = 0;
  }

  if (step === 'step3') {
    state.submitted = 0;
    state.alreadySubmitted = 0;
    state.rejected = 0;
    state.failed = 0;
    state.submitTotal = 0;
    resetResultsData();
  }

  operations.runStartedAt = Date.now();
  operations.submitStartedAt = null;
  operations.finishedAt = null;
  operations.current = {
    tracking: '—',
    row: '—',
    index: null,
    total: null,
    step: 'Starting',
    result: '—',
    kind: '',
    startedAt: null
  };

  const logEl = $(logIdForStep(step));
  if (logEl) logEl.textContent = '';
  setStatus('Idle', '', step);
  setLocalizedText($(actionIdForStep(step)), 'status.waiting', {}, 'Waiting.');
  updateCounters();
}

function resetRunUi(stepId = null) {
  resetStepUi(stepId || activeTabId || currentProcessStep || 'step1');
  startOperationsTimer();
}

function addStep1Warning(message, meta = {}) {
  const text = String(message || tr('step1.unknownWarning', 'Unknown warning')).trim() || tr('step1.unknownWarning', 'Unknown warning');
  state.step1Warnings += 1;
  state.step1WarningMessages.push({
    time: new Date().toLocaleTimeString(),
    message: text,
    meta
  });
}

function renderStep1Warnings() {
  const list = $('warningList');
  const summary = $('warningModalSummary');
  if (!list || !summary) return;
  list.textContent = '';

  if (!state.step1WarningMessages.length) {
    summary.textContent = tr('step1.noWarnings', 'No warnings captured for the current Step 1 run.');
    return;
  }

  summary.textContent = trf('step1.warningCount', { count: state.step1WarningMessages.length }, '{count} warning(s) captured for the current Step 1 run.');
  for (const item of state.step1WarningMessages) {
    const row = document.createElement('div');
    row.className = 'warning-item';

    const time = document.createElement('div');
    time.className = 'warning-item-time';
    time.textContent = item.time || '—';

    const body = document.createElement('div');
    body.textContent = item.message || tr('step1.unknownWarning', 'Unknown warning');

    row.append(time, body);
    list.appendChild(row);
  }
}

function openStep1Warnings() {
  renderStep1Warnings();
  const modal = $('warningModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeStep1Warnings() {
  const modal = $('warningModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function resetAllUiState() {
  resetStepUi('step1');
  resetStepUi('step2');
  resetStepUi('step3');
  resetResultsData();
  operations.runStartedAt = null;
  operations.submitStartedAt = null;
  operations.finishedAt = null;
  currentProcessStep = 'step1';
  activateTab('settingsTab');
  updateCounters();
}

function resultTitle(item) {
  if (!item) return tr('results.detailTitle', 'Result detail');
  if (item.kind === 'submitted') return tr('results.title.submitted', 'Submitted successfully');
  if (item.kind === 'already') return tr('results.title.already', 'Already submitted / duplicate claim');
  if (item.kind === 'failed') return tr('results.title.failed', 'Failed claim / needs review');
  if (item.kind === 'captcha') return tr('results.title.captcha', 'CAPTCHA detected / manual action required');
  return item.result || item.status || tr('results.detailTitle', 'Result detail');
}

function resultExplanation(item) {
  if (!item) return tr('results.noSelection', 'No result selected.');

  if (item.kind === 'submitted') {
    return trf('results.explanation.submitted', { message: item.message || tr('results.noRunnerMessage', 'No extra result message was provided by the runner.') });
  }

  if (item.kind === 'already') {
    return trf('results.explanation.already', { message: item.message || tr('results.expectedDuplicateMessage') });
  }

  if (item.kind === 'captcha') {
    return trf('results.explanation.captcha', { screenshot: item.screenshotPath ? basename(item.screenshotPath) : tr('results.notAvailable') });
  }

  if (item.kind === 'failed') {
    return trf('results.explanation.failed', { message: item.message || tr('results.noDetailedRunnerMessage') });
  }

  return item.message || tr('results.noExplanation', 'No detailed explanation is available for this result type.');
}

function resultDecision(item) {
  if (!item) return tr('results.noDecision', 'No decision available.');

  if (item.kind === 'submitted') {
    return trf('results.decision.submitted', { screenshot: item.screenshotPath ? basename(item.screenshotPath) : tr('results.notAvailable') });
  }

  if (item.kind === 'already') {
    return trf('results.decision.already', { screenshot: item.screenshotPath ? basename(item.screenshotPath) : tr('results.notAvailable') });
  }

  if (item.kind === 'captcha') {
    return trf('results.decision.captcha', { screenshot: item.screenshotPath ? basename(item.screenshotPath) : tr('results.notAvailable') });
  }

  if (item.kind === 'failed') {
    return trf('results.decision.failed', { screenshot: item.screenshotPath ? basename(item.screenshotPath) : tr('results.notAvailable') });
  }

  return item.decision || tr('results.decisionUnavailable', 'Decision details are unavailable.');
}

function setDetailLoadingState() {
  setText('detailEvidenceStatus', tr('results.loadingEvidence', 'Loading evidence…'));
  const imgWrap = $('detailScreenshotWrap');
  const img = $('detailScreenshot');
  if (imgWrap) imgWrap.classList.add('hidden');
  if (img) img.removeAttribute('src');
  if ($('openScreenshot')) $('openScreenshot').disabled = true;
}

async function loadDetailEvidence(item) {
  setDetailLoadingState();

  if (!item || (!item.screenshotPath && !item.textPath)) {
    setText('detailEvidenceStatus', tr('results.noAttachedEvidence', 'No saved Canada Post evidence file was attached to this result.'));
    return;
  }

  try {
    const res = await window.cpApp.loadEvidence({ screenshotPath: item.screenshotPath, textPath: item.textPath });
    if (!res.ok) {
      setText('detailEvidenceStatus', res.error || tr('results.noEvidenceFound', 'No evidence found.'));
      return;
    }

    if (res.screenshotDataUrl) {
      const img = $('detailScreenshot');
      const imgWrap = $('detailScreenshotWrap');
      if (img && imgWrap) {
        img.src = res.screenshotDataUrl;
        imgWrap.classList.remove('hidden');
      }
      if ($('openScreenshot')) $('openScreenshot').disabled = false;
      setText('detailEvidenceStatus', res.screenshotName ? trf('results.loadedScreenshot', { name: res.screenshotName }) : tr('results.screenshotLoaded'));
      return;
    }

    setText('detailEvidenceStatus', tr('results.noScreenshotEvidence', 'No screenshot evidence is available for this result.'));
  } catch (error) {
    setText('detailEvidenceStatus', trf('results.loadEvidenceFailed', { error: error.message }, 'Could not load evidence: {error}'));
  }
}

function openDetail(id) {
  const item = operations.detailItems.get(id);
  if (!item) return;

  operations.selectedDetailId = id;
  selectedDetail = item;

  const listScreen = $('opsListScreen');
  const detailScreen = $('detailScreen');
  if (listScreen) listScreen.classList.add('hidden');
  if (detailScreen) detailScreen.classList.remove('hidden');

  setText('detailTitle', resultTitle(item));
  setText('detailStatus', localizedInterfaceValue(item.status || item.result || '—'));
  setText('detailTime', item.time || '—');
  setText('detailRow', item.row || '—');
  setText('detailSource', item.source || '—');
  setText('detailTracking', item.tracking || '—');
  setText('detailExplanation', resultExplanation(item));
  setText('detailDecision', resultDecision(item));

  const badge = $('detailBadge');
  if (badge) {
    badge.textContent = item.status || item.result ? localizedInterfaceValue(item.status || item.result) : tr('results.detailBadge', 'Result Detail');
    badge.className = `pill ${pillKind(item.kind)}`.trim();
  }

  loadDetailEvidence(item);
}

function showOperationsList() {
  const listScreen = $('opsListScreen');
  const detailScreen = $('detailScreen');
  if (listScreen) listScreen.classList.remove('hidden');
  if (detailScreen) detailScreen.classList.add('hidden');
  operations.selectedDetailId = null;
  operations.unreadNotifications = 0;
  selectedDetail = null;
}

function detailForEvent(kind, event, result, extra = {}) {
  return {
    kind,
    tracking: event.trackingNumber || operations.current.tracking || '—',
    row: event.row || operations.current.row || '—',
    result,
    status: result,
    message: event.message || '',
    screenshotPath: event.screenshotPath || '',
    textPath: event.textPath || '',
    eventType: event.type || '',
    ...extra
  };
}

function trackingDate(value) {
  const clean = String(value || '').trim();
  return clean || '—';
}

function trackingDateSuffix(event) {
  const parts = [];
  if (event.expectedDate) parts.push(`standard ${trackingDate(event.expectedDate)}`);
  if (event.revisedExpectedDeliveryDate) parts.push(`revised ${trackingDate(event.revisedExpectedDeliveryDate)}`);
  if (event.firstAttemptDate) parts.push(`first attempt ${trackingDate(event.firstAttemptDate)}`);
  if (event.deliveryDate) parts.push(`delivered ${trackingDate(event.deliveryDate)}`);
  if (event.deliveryStatus) parts.push(`status ${event.deliveryStatus}`);
  if (event.eligibilityReason && (event.primaryCategory === 'not_delivered' || event.primaryCategory === 'delivered_review')) parts.push(event.eligibilityReason);
  return parts.length ? ` | ${parts.join(' | ')}` : '';
}

function trackingDisplayPin(event) {
  return event.displayTrackingNumber || event.pin || 'tracking row';
}

function applyTrackingPrimaryCategory(event) {
  if (!event.terminal) return;
  if (event.primaryCategory === 'late') state.late += 1;
  else if (event.primaryCategory === 'on_time') state.onTime += 1;
  else if (event.primaryCategory === 'not_delivered') state.notDelivered += 1;
  else if (event.primaryCategory === 'delivered_review') state.deliveredReview = (state.deliveredReview || 0) + 1;
  else if (event.primaryCategory === 'error') state.trackingErrors += 1;
}

function stringifyPretty(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function formatDeveloperRaw(stage, event) {
  if (!state.developerMode) return null;

  if (event.type === 'debug_process_line') {
    return `[DEV RAW][${stage}][${event.source || 'process'}] ${event.line || ''}`;
  }

  const title = `[DEV RAW][${stage}] ${event.label || event.operation || event.url || 'raw data'}`;
  const parts = [title];

  if (event.method || event.url || event.status || event.accept) {
    parts.push(`method=${event.method || 'GET'} status=${event.status ?? '—'} accept=${event.accept || '—'} url=${event.url || '—'}`);
  }

  if (event.requestXml) parts.push(`--- SOAP REQUEST ---
${event.requestXml}`);
  if (event.responseXml) parts.push(`--- SOAP RESPONSE ---
${event.responseXml}`);
  if (event.requestBody) parts.push(`--- REQUEST BODY ---
${stringifyPretty(event.requestBody)}`);
  if (event.responseHeaders) parts.push(`--- RESPONSE HEADERS ---
${stringifyPretty(event.responseHeaders)}`);
  if (event.responseBody) parts.push(`--- RESPONSE BODY ---
${event.responseBody}`);
  if (event.error) parts.push(`--- ERROR ---
${event.error}`);

  if (parts.length === 1) parts.push(stringifyPretty(event));
  return parts.join('\n');
}

function describeEvent(stage, event) {
  const type = event.type || 'log';
  const localizedEventMessage = event.messageKey ? trf(event.messageKey, event.messageValues || {}, event.message || '') : '';

  if (type === 'debug_raw' || type === 'debug_process_line') {
    return formatDeveloperRaw(stage, event);
  }

  if (stage === 'health') {
    if (type === 'health_start') {
      return tr('step3.portalValidation.started', 'Step 3 portal compatibility validation started.');
    }
    if (type === 'health_progress') return tr('step3.portalValidation.progress', 'Step 3 portal compatibility validation is checking the current Canada Post page.');
    if (type === 'health_complete') {
      refreshHistory().catch(() => {});
      return trf(event.status === 'healthy' ? 'step3.portalValidation.passed' : 'step3.portalValidation.failed', {
        code: event.code || 'UNKNOWN'
      }, event.status === 'healthy' ? 'Step 3 portal compatibility validation passed ({code}).' : 'Step 3 portal compatibility validation did not pass ({code}).');
    }
  }

  if (stage === 'est-history') {
    if (type === 'est_endpoint') return localizedEventMessage || trf('event.est.endpoint', { host: event.host || '' }, 'EST Desktop API endpoint: {host}');
    if (type === 'est_start') {
      operations.runStartedAt ||= Date.now();
      updateCurrentItem({ step: 'Exporting EST Desktop history', result: 'In progress', kind: '' });
      setActionLocalized('event.est.exportingRange', { from: event.from, to: event.to }, 'Exporting EST Desktop history from {from} to {to}.', 'step1');
      return trf('event.est.started', { from: event.from, to: event.to, customer: event.customerNumber || '—', workgroup: event.workgroup || tr('common.auto', 'auto'), mobo: event.mobo || '-2', category: event.categoryGroup || 'SHP' }, 'EST Desktop export started: {from} to {to}. Customer {customer}, workgroup {workgroup}, MOBO {mobo}, category {category}.');
    }
    if (type === 'est_connect') return trf('event.est.connected', { bytes: event.byteLength || 0 }, 'EST connect succeeded. Response validated as XML ({bytes} bytes).');
    if (type === 'est_workgroups') {
      state.step1Workgroups = event.count || 0;
      return trf('event.est.workgroups', { mode: event.mode || tr('common.auto', 'auto'), count: event.count || 0 }, 'EST workgroups {mode}: {count}.');
    }
    if (type === 'est_mobos') return trf('event.est.mobos', { workgroup: event.workgroup || '—', count: event.count || 0 }, 'EST MOBO diagnostic for workgroup {workgroup}: {count} values.');
    if (type === 'est_probe') return localizedEventMessage || trf('event.est.probe', { url: event.url || '' }, 'EST probe: {url}');
    if (type === 'est_orders') {
      state.step1Orders += event.count || 0;
      return trf('event.est.orders', { format: event.dateFormat || tr('common.date', 'date'), count: event.count || 0 }, 'EST order IDs found using {format} dates: {count}.');
    }
    if (type === 'est_export') {
      if (Object.prototype.hasOwnProperty.call(event, 'manifestItemsParsed')) {
        state.step1TotalRows += event.manifestItemsParsed || 0;
        return trf('event.est.chunkParsed', { chunk: event.chunk || '?', orders: event.orders || 0, rows: event.manifestItemsParsed || 0 }, 'EST export chunk {chunk} parsed. Orders: {orders}; ManifestItems rows: {rows}.');
      }
      return trf('event.est.chunkStarted', { chunk: event.chunk || '?', orders: event.orders || 0, fileTypes: event.fileTypes || '2' }, 'EST export chunk {chunk} started. Orders: {orders}; filetypes={fileTypes}.');
    }
    if (type === 'est_imported_detail') {
      state.step1Imported = event.current || (state.step1Imported + 1);
      updateCurrentItem({
        tracking: 'Redacted shipment',
        step: 'Importing EST Desktop history',
        result: `${event.current || 0} imported`,
        kind: ''
      });
      return null;
    }
    if (type === 'est_import_progress') {
      state.step1Imported = event.current || state.step1Imported;
      setActionLocalized('event.est.importing', { count: state.step1Imported }, 'Importing EST shipment rows: {count} imported.', 'step1');
      return trf('event.est.progress', { count: state.step1Imported }, 'EST import progress: {count} shipments imported.');
    }
    if (type === 'est_export_diagnostic') return trf('event.est.exportDiagnostic', { format: event.format || tr('event.est.expectedFormat', 'expected format'), rows: event.parsedRows || 0 }, 'EST export recognized as {format}; parsed rows: {rows}.');
    if (type === 'est_backup') return tr('event.est.backup', 'Previous tracking.csv backed up before EST import.');
    if (type === 'est_warning') {
      addStep1Warning(event.message, event);
      return trf('event.warning', { message: event.message }, 'WARNING: {message}');
    }
    if (type === 'est_stopped') return trf('event.est.stopped', { imported: event.imported || 0 }, 'EST Desktop export stopped. Imported so far: {imported}.');
    if (type === 'est_complete') {
      if (event.outcome === 'EMPTY') {
        updateCurrentItem({ step: 'EST Desktop export complete', result: 'No orders found', kind: '' });
        state.step1Orders = 0;
        state.step1Imported = 0;
        setStatus('Complete', 'good', 'step1');
        setActionLocalized('event.est.empty', {}, 'Completed — no EST orders found for the selected date range.', 'step1');
        return tr('event.est.empty', 'Completed — no EST orders found for the selected date range.');
      }
      updateCurrentItem({ step: 'EST Desktop export complete', result: `${event.imported || 0} imported`, kind: '' });
      state.step1Orders = event.orders || state.step1Orders;
      state.step1Imported = event.imported || state.step1Imported;
      if (!state.step1TotalRows && event.imported) state.step1TotalRows = event.imported;
      setStatus('Complete', 'good', 'step1');
      setActionLocalized('event.est.completeAction', { imported: event.imported || 0 }, 'EST Desktop export complete. Imported {imported} shipments into tracking.csv.', 'step1');
      return trf('event.est.complete', { orders: event.orders || 0, imported: event.imported || 0 }, 'EST Desktop export complete. Orders: {orders}. Imported: {imported}.');
    }
  }

  if (stage === 'history') {
    if (type === 'history_endpoint') return localizedEventMessage || trf('event.history.endpoint', { host: event.host || '' }, 'Canada Post API endpoint: production {host}');
    if (type === 'history_start') {
      operations.runStartedAt ||= Date.now();
      updateCurrentItem({ step: 'Importing shipping history', result: 'In progress', kind: '' });
      setActionLocalized('event.history.importing', { from: event.from, to: event.to }, 'Importing Canada Post shipping history from {from} to {to}.', 'step1');
      return trf('event.history.started', { from: event.from, to: event.to, environment: event.endpointEnvironment || 'production', host: event.endpointHost || '' }, 'Shipping history import started: {from} to {to}. Endpoint: {environment} {host}.');
    }
    if (type === 'history_mobo_discovery') return localizedEventMessage || trf('event.history.moboDiscovery', { count: event.count || 0 }, 'MOBO auto-discovery complete. Values to try: {count}.');
    if (type === 'history_mobo') return trf('event.history.mobo', { index: event.index || '?', total: event.total || '?', mobo: event.mobo || tr('common.unknown', 'unknown') }, 'Checking MOBO/customer {index}/{total}: {mobo}.');
    if (type === 'history_manifest_list') return trf('event.history.manifestList', { count: event.count || 0 }, 'Manifest links found: {count}.');
    if (type === 'history_manifest') return trf('event.history.manifest', { index: event.index, total: event.total, manifest: event.manifestId || tr('event.history.unknownId', 'unknown id') }, 'Manifest {index}/{total}: {manifest}');
    if (type === 'history_shipments') return trf('event.history.shipments', { manifest: event.manifestId || tr('event.history.manifestFallback', 'manifest'), count: event.count || 0 }, 'Shipments found for {manifest}: {count}.');
    if (type === 'history_no_manifest_day') return trf('event.history.noManifestDay', { index: event.index, total: event.total, date: event.date }, 'No-manifest lookup {index}/{total}: {date}.');
    if (type === 'history_imported') {
      updateCurrentItem({
        tracking: event.pin || operations.current.tracking,
        step: 'Importing shipping history',
        result: `${event.current || 0} imported`,
        kind: ''
      });
      return trf('event.history.imported', { tracking: event.pin, postal: event.postalCode || '—', reference: event.reference || '—' }, 'Imported shipment: {tracking} | postal {postal} | reference {reference}');
    }
    if (type === 'history_backup') return tr('event.history.backup', 'Previous tracking.csv backed up.');
    if (type === 'history_warning') {
      addStep1Warning(event.message, event);
      return trf('event.warning', { message: event.message }, 'WARNING: {message}');
    }
    if (type === 'history_stopped') return trf('event.history.stopped', { imported: event.imported || 0 }, 'Shipping history import stopped. Imported so far: {imported}.');
    if (type === 'history_complete') {
      updateCurrentItem({ step: 'Shipping history import complete', result: `${event.imported || 0} imported`, kind: '' });
      setActionLocalized('event.history.completeAction', { imported: event.imported || 0 }, 'Shipping history import complete. Imported {imported} shipments into tracking.csv.', 'step1');
      return trf('event.history.complete', { imported: event.imported || 0, warnings: event.warnings || 0 }, 'Shipping history import complete. Imported: {imported}. Warnings: {warnings}.');
    }
  }

  if (stage === 'tracking') {
    applyTrackingPrimaryCategory(event);
    if (type === 'tracking_credential_metadata') {
      const valid = event.clientId?.present && event.clientSecret?.present;
      return trf('event.tracking.credentialMetadata', {
        validity: tr(valid ? 'common.valid' : 'common.invalid'), clientId: tr(event.clientId?.present ? 'common.present' : 'common.missing'),
        clientSecret: tr(event.clientSecret?.present ? 'common.present' : 'common.missing'), environment: event.selectedEnvironment || 'test',
        api: event.apiVersion || '1.0.0', scope: event.scope || 'merchant', legacy: tr('common.no')
      }, 'Tracking API configuration {validity}: client ID {clientId}; client secret {clientSecret}; environment {environment}; API {api}; scope {scope}; legacy credentials active: {legacy}.');
    }
    if (type === 'tracking_protocol_stage') {
      const labels = {
        token_request_sent: tr('event.tracking.protocol.tokenRequest', 'OAuth token request sent'), token_acquired: tr('event.tracking.protocol.tokenAcquired', 'OAuth token acquired'), token_cached: tr('event.tracking.protocol.tokenCached', 'Valid in-memory OAuth token reused'),
        token_failed: tr('event.tracking.protocol.tokenFailed', 'OAuth token request failed'), tracking_request_sent: tr('event.tracking.protocol.requestSent', 'Tracking API request sent'), tracking_json_received: tr('event.tracking.protocol.jsonReceived', 'Tracking JSON response received'),
        token_cleared: tr('event.tracking.protocol.tokenCleared', 'In-memory OAuth token cleared'), tracking_timeout_backoff: tr('event.tracking.protocol.timeoutRetry', 'Tracking resource timeout retry')
      };
      if (!state.trackingDiagnosticMode) {
        if (event.stage === 'token_acquired' && !state.trackingTokenLogged) state.trackingTokenLogged = true;
        else if (event.stage !== 'token_failed' && event.stage !== 'tracking_backoff') return null;
      }
      if (event.stage === 'tracking_rate_limit_wait') return null;
      if (event.stage === 'tracking_backoff') return trf('event.tracking.protocol.backoff', { reason: event.category === 'slm_throttle' ? 'Canada Post SLM Monitor' : (event.status ? `HTTP ${event.status}` : tr('event.tracking.protocol.networkTimeout', 'network timeout')), delay: event.delayMs, source: event.retrySource || tr('event.tracking.protocol.boundedRetry', 'bounded retry'), attempt: event.retryAttempt, max: event.maxRetries || 2 }, 'RETRY — {reason}; waiting {delay} ms ({source}), retry {attempt}/{max}.');
      if (event.stage === 'tracking_timeout_backoff') return trf('event.tracking.protocol.timeoutBackoff', { timeout: event.timeoutMs, attempt: event.retryAttempt, max: event.maxRetries, delay: event.delayMs, environment: event.environment }, 'Tracking resource request timed out after {timeout} ms; retry {attempt}/{max} after {delay} ms; environment {environment}.');
      const status = event.tokenHttpStatus || event.resourceHttpStatus;
      return trf('event.tracking.protocol.stage', { label: labels[event.stage] || tr('event.tracking.protocol.unknownStage', 'Tracking protocol stage'), status: status ? `HTTP ${status}` : '—', environment: event.environment || 'test', api: event.apiVersion || '1.0.0', scope: event.scope || 'merchant', expiry: event.expiresIn ? trf('event.tracking.protocol.expiry', { seconds: event.expiresIn }, 'expires in {seconds} seconds') : '—' }, '{label}; status {status}; environment {environment}; API {api}; scope {scope}; {expiry}.');
    }
    if (type === 'tracking_start') {
      operations.runStartedAt ||= Date.now();
      updateCurrentItem({ step: 'Checking tracking data', result: '—', kind: '' });
      state.trackingTotal = event.total || 0;
      state.trackingDiagnosticMode = Boolean(event.diagnosticMode);
      state.trackingTokenLogged = false;
      setStatus('Running', 'warn', 'step2');
      return trf('event.tracking.started', { total: state.trackingTotal, interval: event.requestIntervalMs || 3100, jitter: event.jitterMaxMs ?? 100 }, 'Tracking stage started. {total} row(s). Sequential requests use a minimum {interval} ms start-to-start interval plus up to {jitter} ms positive jitter.');
    }
    if (type === 'tracking_progress') {
      state.checked = event.current || state.checked;
      updateCurrentItem({ step: trf('event.tracking.check', { current: event.current, total: event.total }, 'Tracking check {current}/{total}') });
      return (event.current === event.total || event.current % 10 === 0) ? trf('event.tracking.progress', { current: event.current, total: event.total }, 'Tracking progress: {current}/{total}') : null;
    }
    if (type === 'pin_late') {
      const pin = trackingDisplayPin(event);
      setActionLocalized('event.tracking.lateAction', { tracking: pin }, 'Late-delivery candidate found: {tracking}. Recorded in the database candidate queue.', 'step2');
      updateCurrentItem({ tracking: pin, step: tr('event.tracking.lateCandidate', 'Late-delivery candidate found'), result: tr('event.tracking.recorded', 'Recorded in candidate queue'), kind: 'submitted' });
      return trf('event.tracking.late', { tracking: pin, dates: trackingDateSuffix(event) }, '{tracking} — LATE — successful delivery after delivery standard{dates}');
    }
    if (type === 'pin_on_time') {
      return trf('event.tracking.onTime', { tracking: trackingDisplayPin(event), dates: trackingDateSuffix(event) }, '{tracking} — ON TIME — successful delivery on or before delivery standard{dates}');
    }
    if (type === 'pin_not_delivered') {
      return trf('event.tracking.notDelivered', { tracking: trackingDisplayPin(event), dates: trackingDateSuffix(event) }, '{tracking} — NOT DELIVERED{dates}');
    }
    if (type === 'pin_overdue' || type === 'pin_overdue_in_transit') {
      state.overdueInTransit += 1;
      const deliveryStatus = event.deliveryStatus || (event.deliveryDate ? 'Delivered' : (event.firstAttemptDate ? 'Delivery attempted but not delivered' : 'In transit'));
      addNeedsReview('warning', event.pin, event.eligibilityReason || `Overdue — ${deliveryStatus.toLowerCase()}`, event.row || '—', '', {
        kind: 'warning', tracking: event.pin, row: event.row || '—', result: 'Missing-package review', status: `Overdue — ${deliveryStatus}`, message: event.eligibilityReason || ''
      });
      return trf('event.tracking.overdue', { tracking: trackingDisplayPin(event), dates: trackingDateSuffix(event) }, '{tracking} — NOT DELIVERED — OVERDUE{dates}');
    }
    if (type === 'pin_review_required') {
      state.reviewRequired += 1;
      addNeedsReview('warning', event.pin, event.eligibilityReason || 'Eligibility review required', event.row || '—', '', {
        kind: 'warning', tracking: event.pin, row: event.row || '—', result: 'Eligibility review', status: event.classification || 'Review required', message: event.eligibilityReason || ''
      });
      return trf(event.primaryCategory === 'not_delivered' ? 'event.tracking.notDeliveredReview' : 'event.tracking.review', { tracking: trackingDisplayPin(event), dates: trackingDateSuffix(event) }, event.primaryCategory === 'not_delivered' ? '{tracking} — NOT DELIVERED — REVIEW{dates}' : '{tracking} — REVIEW{dates}');
    }
    if (type === 'pin_no_data') {
      state.reviewRequired += 1;
      return trf('event.tracking.noData', { tracking: trackingDisplayPin(event), reason: event.eligibilityReason || localizedEventMessage || tr('event.tracking.noDeliveryEvidence', 'No usable successful-delivery evidence') }, '{tracking} — NOT DELIVERED — REVIEW | {reason}');
    }
    if (type === 'pin_error') {
      const diagnostic = event.diagnostic || {};
      const redirect = diagnostic.redirectDestination;
      const protocol = [
        `HTTP ${diagnostic.status || 0}`,
        diagnostic.contentType || 'content type unavailable',
        diagnostic.endpointFamily || 'tracking endpoint',
        diagnostic.environment || 'test',
        diagnostic.apiVersion ? `API ${diagnostic.apiVersion}` : '',
        diagnostic.scope ? `scope ${diagnostic.scope}` : '',
        diagnostic.requestMethod || 'GET',
        diagnostic.responseHostname || 'response host unavailable',
        diagnostic.redirectStatus ? `redirect ${diagnostic.redirectStatus} to ${redirect?.hostname || 'unknown'}${redirect?.pathname || '/'}` : 'no redirect',
        diagnostic.wwwAuthenticateScheme ? `WWW-Authenticate ${diagnostic.wwwAuthenticateScheme}` : 'no authentication challenge',
        diagnostic.applicationCode ? `application code ${diagnostic.applicationCode}` : 'no application code',
        diagnostic.requestId ? `request ID ${diagnostic.requestId}` : 'no request ID',
        diagnostic.htmlClassification ? `HTML classification ${diagnostic.htmlClassification}` : '',
        diagnostic.bodyFingerprint ? `body type ${diagnostic.bodyFingerprint}` : ''
        , Number.isFinite(diagnostic.retryAfterSeconds) ? `Retry-After ${diagnostic.retryAfterSeconds} seconds` : ''
      ].filter(Boolean).join('; ');
      return trf('event.tracking.error', { tracking: trackingDisplayPin(event), message: localizedEventMessage || event.message || tr('event.tracking.unknownError', 'Unknown tracking error'), protocol }, '{tracking} — ERROR — {message} Protocol diagnostics: {protocol}.');
    }
    if (type === 'tracking_circuit_open') {
      setStatus('Blocked', 'bad', 'step2');
      setActionLocalized('event.tracking.systemicFailureAction', {}, 'Stopped — systemic integration failure. Correct the API configuration, then deliberately retry.', 'step2');
      return trf('event.tracking.circuitOpen', { attempted: event.attempted || event.processed || 0, total: event.total || state.trackingTotal || 0, remaining: event.remaining || 0, errors: event.errors || event.consecutiveFailures || 0, preserved: tr(event.queuePreserved ? 'common.yes' : 'common.no') }, 'Stopped — systemic integration failure. Attempted: {attempted}; total: {total}; remaining: {remaining}; errors: {errors}; queue preserved: {preserved}.');
    }
    if (type === 'tracking_semantic_circuit_open') {
      setStatus('Blocked', 'bad', 'step2');
      setActionLocalized(event.messageKey || 'event.tracking.semanticFailureAction', event.messageValues || {}, event.message || 'Stopped — Tracking API responses were received, but required fields could not be normalized.', 'step2');
      return trf('event.tracking.semanticCircuitOpen', { message: localizedEventMessage || tr('event.tracking.semanticFailureAction'), attempted: event.attempted || 0, total: event.total || 0, remaining: event.remaining || 0, preserved: tr(event.queuePreserved ? 'common.yes' : 'common.no') }, '{message} Attempted: {attempted}; total: {total}; remaining: {remaining}; queue preserved: {preserved}.');
    }
    if (type === 'tracking_invariant_failure') {
      setStatus('Blocked', 'bad', 'step2');
      setActionLocalized(event.messageKey || 'event.tracking.invariantFailureAction', event.messageValues || {}, event.message || 'Internal classification invariant failed.', 'step2');
      return trf('event.tracking.invariantFailure', { message: localizedEventMessage || tr('event.tracking.invariantFailureAction'), preserved: tr(event.queuePreserved ? 'common.yes' : 'common.no') }, '{message} Run stopped; queue preserved: {preserved}.');
    }
    if (type === 'tracking_aborted') {
      updateCurrentItem({ step: 'Tracking stopped', result: 'Systemic integration failure', kind: 'failed' });
      setStatus('Blocked', 'bad', 'step2');
      setActionLocalized(event.messageKey || 'event.tracking.incompleteAction', event.messageValues || {}, event.message || 'Stopped — incomplete Tracking API run. A deliberate retry is required.', 'step2');
      return trf('event.tracking.aborted', { attempted: event.attempted || 0, total: event.total || 0, remaining: event.remaining || 0, errors: event.errorCount || 0, preserved: tr(event.queuePreserved ? 'common.yes' : 'common.no') }, 'Run stopped. Attempted: {attempted}; total: {total}; remaining: {remaining}; errors: {errors}; queue preserved: {preserved}.');
    }
    if (type === 'tracking_diagnostic') {
      const evidence = event.semanticValidation?.deliveryEvidence || {};
      const evidenceSummary = trf('event.tracking.evidenceSummary', {
        code: evidence.firstQualifyingEventCode || tr('common.noneLower', 'none'), category: evidence.firstQualifyingEventCategory || tr('common.noneLower', 'none'),
        firstAttempt: tr(evidence.firstAttemptTimestampPresent ? 'common.present' : 'common.absent'), delivery: tr(evidence.actualDeliveryTimestampPresent ? 'common.present' : 'common.absent'),
        sameEvent: tr(evidence.sameEvent ? 'common.yes' : 'common.no'), provenance: evidence.provenance || tr('common.noneLower', 'none'), confidence: evidence.confidence || tr('common.noneLower', 'none')
      }, 'first qualifying code {code}; category {category}; first-attempt timestamp {firstAttempt}; actual-delivery timestamp {delivery}; same event {sameEvent}; provenance {provenance}; confidence {confidence}');
      return event.ok
        ? trf('event.tracking.diagnosticSucceeded', { tracking: event.tracking, api: event.apiVersion || '1.0.0', status: event.status, count: event.eventCount, source: event.serviceResolution?.source || tr('common.unknown', 'unknown'), evidence: evidenceSummary, export: event.structureExported ? tr('event.tracking.structureExportedSuffix', 'Sanitized structure exported.') : '' }, 'One-request semantic diagnostic succeeded for {tracking}. API {api}; HTTP {status}; status parsed; events {count}; service source {source}; {evidence}; state unchanged. {export}')
        : trf('event.tracking.diagnosticFailedDetail', { tracking: event.tracking, failures: (event.semanticValidation?.failures || []).join(', ') || event.diagnostic?.message || tr('event.tracking.responseUnusable', 'Response was not semantically usable.'), evidence: evidenceSummary }, 'One-request semantic diagnostic failed for {tracking}. {failures} {evidence}. State modified: no.');
    }
    if (type === 'tracking_diagnostic_complete') {
      const ok = event.status === 'DIAGNOSTIC_COMPLETE';
      setStatus(ok ? 'Diagnostic passed' : 'Diagnostic failed', ok ? 'good' : 'bad', 'step2');
      setActionLocalized('event.tracking.diagnosticFinishedAction', {}, 'One-request diagnostic finished. Claim, eligibility, and queue state were not modified.', 'step2');
      return trf('event.tracking.diagnosticCompleteSummary', { result: tr(ok ? 'common.completeLower' : 'common.failedLower') }, 'One-request diagnostic {result}. Tracking resource requests: 1. Eligibility, claims, queue, and summary state changed: no.');
    }
    if (type === 'pin_skipped') {
      state.skipped += 1;
      return trf('event.tracking.skipped', { tracking: event.pin }, 'Skipped already processed: {tracking}');
    }
    if (type === 'tracking_complete') {
      const eligible = Number(event.eligibleLateCount || 0);
      const overdue = Number(event.overdueInTransitCount || 0);
      const review = Number(event.reviewRequiredCount || 0);
      const errors = Number(event.errorCount || 0);
      state.checked = Number(event.checked || event.attempted || state.checked);
      state.late = eligible;
      state.onTime = Number(event.onTimeCount || 0);
      state.notDelivered = Number(event.notDeliveredCount || 0);
      state.trackingErrors = errors;
      updateCurrentItem({ step: 'Tracking complete', result: `${eligible} late-delivery candidates` });
      setStatus(errors > 0 ? 'Warnings' : 'Complete', errors > 0 ? 'warn' : 'good', 'step2');
      setActionLocalized('event.tracking.completeAction', { late: eligible, onTime: state.onTime, notDelivered: state.notDelivered, review, errors }, 'Tracking complete: {late} late, {onTime} on time, {notDelivered} not delivered, {review} review required, {errors} errors.', 'step2');
      return trf('event.tracking.complete', { checked: state.checked, late: eligible, onTime: state.onTime, notDelivered: state.notDelivered, deliveredReview: Number(event.deliveredReviewCount || 0), review, overdue, errors, reconciled: tr(event.countersReconciled ? 'common.yes' : 'common.no') }, 'Tracking complete. Checked: {checked}. Late candidates: {late}. On time: {onTime}. Not delivered: {notDelivered}. Delivered but unclassifiable: {deliveredReview}. Review required: {review}. Overdue/in transit: {overdue}. Errors: {errors}. Counters reconciled: {reconciled}.');
    }
  }

  if (stage === 'submit') {
    if (type === 'diagnostics_started') {
      return trf('event.submit.diagnosticsStarted', { path: event.directory || tr('event.submit.diagnosticsFolder', 'Step 3 diagnostics folder') }, 'Detailed diagnostics started: {path}');
    }
    if (type === 'diagnostics_complete') {
      return trf('event.submit.diagnosticsComplete', { path: event.summaryPath || event.directory || tr('common.savedLower', 'saved') }, 'Detailed diagnostics complete: {path}');
    }
    if (type === 'submit_start') {
      builtinBrowserManualActionPending = false;
      setBuiltinBrowserActivity(true, tr('event.submit.preparing', 'Preparing Canada Post claim workflow…'));
      operations.submitStartedAt = Date.now();
      state.submitTotal = event.total || 0;
      setStatus('Running', 'warn', 'step3');
      updateCurrentItem({ step: tr('event.submit.startedShort', 'Claim submission started'), result: '—', kind: '' });
      return trf('event.submit.started', { total: state.submitTotal }, 'Claim submission started. {total} claims.');
    }
    if (type === 'manual_verification_required') {
      builtinBrowserManualActionPending = true;
      setBuiltinBrowserStatus(waitingForManualActionText(), 'warn');
      finishBuiltinBrowserActivity(waitingForManualActionText());
      updateCurrentItem({ step: 'Manual verification required', result: 'Paused for operator', kind: 'captcha' });
      setStatus('Manual verification required', 'bad', 'step3');
      setAction(localizedEventMessage || tr('event.submit.manualVerificationAction', 'Complete verification in the visible built-in browser. Step 3 is paused.'), 'step3');
      synchronizeBuiltinBrowserVisibility({ reason: 'manual-verification-required', scrollIntoView: true, force: true, requireVisible: true }).catch(() => {});
      return localizedEventMessage || tr('event.submit.manualVerification', 'Manual verification required. The built-in browser has been brought into view.');
    }
    if (type === 'manual_verification_display_failed') {
      builtinBrowserManualActionPending = false;
      setBuiltinBrowserStatus(tr('step3.browser.displayErrorStatus', 'Browser display error'), 'bad');
      finishBuiltinBrowserActivity(tr('step3.browser.displayErrorStatus', 'Browser display error'), 'error');
      setStatus('Failed', 'bad', 'step3');
      setAction(localizedEventMessage || tr('event.submit.manualDisplayFailedAction', 'Manual verification could not be displayed safely.'), 'step3');
      return localizedEventMessage || tr('event.submit.manualDisplayFailed', 'Manual verification could not be displayed safely; Step 3 stopped.');
    }
    if (type === 'claim_start') {
      builtinBrowserManualActionPending = false;
      setBuiltinBrowserActivity(true, trf('event.submit.openingClaim', { index: event.index || '', total: event.total || '' }, 'Opening claim {index} of {total}…'));
      updateCurrentItem({
        tracking: event.trackingNumber || '—',
        row: event.row || '—',
        index: event.index || null,
        total: event.total || null,
        step: 'Opening claim ticket',
        result: 'In progress',
        kind: '',
        startedAt: Date.now()
      });
      setActionLocalized('event.submit.submitting', { index: event.index, total: event.total, tracking: event.trackingNumber }, 'Submitting claim {index}/{total}: {tracking}', 'step3');
      return trf('event.submit.claimStarted', { index: event.index, total: event.total, tracking: event.trackingNumber }, 'Claim {index}/{total}: {tracking}');
    }
    if (type === 'captcha_detected') {
      builtinBrowserManualActionPending = true;
      setBuiltinBrowserStatus(waitingForManualActionText(), 'warn');
      finishBuiltinBrowserActivity(tr('event.submit.waitingCaptcha', 'Waiting for manual CAPTCHA'));
      updateCurrentItem({ step: 'CAPTCHA detected', result: 'Paused for manual solve', kind: 'captcha' });
      setStatus('CAPTCHA', 'bad', 'step3');
      setAction(tr('event.submit.captchaAction', 'CAPTCHA detected. Solve it manually in the visible browser window. The app is paused and will resume after it clears.'), 'step3');
      const detail = detailForEvent('captcha', event, 'CAPTCHA detected', {
        issue: 'Manual CAPTCHA solve required',
        status: 'CAPTCHA detected',
        message: event.message || tr('event.submit.captchaAction', 'CAPTCHA detected. Solve it manually in the visible browser window.'),
        source: 'Notifications / CAPTCHA'
      });
      addRecentResult('captcha', event.trackingNumber || operations.current.tracking, 'CAPTCHA detected', event.row || operations.current.row, detail);
      if (useBuiltinBrowser()) synchronizeBuiltinBrowserVisibility({ reason: 'captcha-required', scrollIntoView: true, force: true, requireVisible: true }).catch(() => {});
      return trf('event.submit.captchaDetected', {
        tracking: event.trackingNumber || tr('event.submit.currentClaim', 'current claim'),
        screenshot: event.screenshotPath ? trf('event.submit.screenshotSaved', { path: event.screenshotPath }, 'Screenshot saved: {path}') : tr('event.submit.screenshotSkipped', 'Screenshot skipped in built-in browser mode to keep focus.')
      }, 'CAPTCHA detected for {tracking} — solve it manually in the visible browser. The app is paused. {screenshot}');
    }
    if (type === 'captcha_waiting') {
      builtinBrowserManualActionPending = true;
      setBuiltinBrowserStatus(waitingForManualActionText(), 'warn');
      finishBuiltinBrowserActivity(tr('event.submit.waitingCaptcha', 'Waiting for manual CAPTCHA'));
      updateCurrentItem({ step: 'CAPTCHA still active', result: 'Waiting for manual solve', kind: 'already' });
      setAction(localizedEventMessage || tr('event.submit.captchaWaitingAction', 'Still waiting for CAPTCHA solve.'), 'step3');
      return localizedEventMessage || trf('event.submit.captchaWaiting', { tracking: event.trackingNumber || tr('event.submit.currentClaim', 'current claim') }, 'Still waiting for CAPTCHA solve for {tracking}.');
    }
    if (type === 'captcha_cleared') {
      builtinBrowserManualActionPending = false;
      setBuiltinBrowserActivity(true, tr('event.submit.captchaClearedActivity', 'CAPTCHA cleared — resuming…'));
      updateCurrentItem({ step: 'CAPTCHA cleared', result: 'Resuming', kind: '' });
      setStatus('Running', 'warn', 'step3');
      setAction(localizedEventMessage || tr('event.submit.captchaClearedAction', 'CAPTCHA cleared. Resuming claim submission.'), 'step3');
      return localizedEventMessage || trf('event.submit.captchaCleared', { tracking: event.trackingNumber || tr('event.submit.currentClaim', 'current claim') }, 'CAPTCHA cleared for {tracking}. Resuming.');
    }
    if (type === 'claim_wait') {
      builtinBrowserManualActionPending = false;
      setBuiltinBrowserActivity(true, tr('event.submit.waitingConfirmation', 'Waiting for Canada Post confirmation…'));
      updateCurrentItem({ tracking: event.trackingNumber || operations.current.tracking, step: 'Waiting for Canada Post result', result: 'In progress', kind: '' });
      setActionLocalized('event.submit.waitingResultAction', { tracking: event.trackingNumber, seconds: Math.round((event.ms || 0) / 1000) }, 'Waiting for Canada Post result for {tracking}. Timeout: {seconds} seconds.', 'step3');
      return trf('event.submit.waitingResult', { seconds: Math.round((event.ms || 0) / 1000) }, 'Waiting for Canada Post result: {seconds} seconds');
    }
    if (type === 'claim_submitted') {
      finishBuiltinBrowserActivity(tr('event.submit.claimSubmittedActivity', 'Claim submitted'));
      state.submitted += 1;
      updateCurrentItem({
        tracking: event.trackingNumber || operations.current.tracking,
        row: event.row || operations.current.row,
        step: 'Claim result received',
        result: 'Submitted',
        kind: 'submitted'
      });
      addRecentResult('submitted', event.trackingNumber, 'Submitted', event.row, detailForEvent('submitted', event, 'Submitted'));
      setAction(trf('event.submit.submittedAction', { tracking: event.trackingNumber }, 'Submitted successfully: {tracking}'));
      return trf('event.submit.submitted', { tracking: event.trackingNumber }, 'Submitted: {tracking}');
    }
    if (type === 'claim_already_submitted') {
      finishBuiltinBrowserActivity(tr('event.submit.claimAlreadySubmittedActivity', 'Claim already submitted'));
      state.alreadySubmitted += 1;
      updateCurrentItem({
        tracking: event.trackingNumber || operations.current.tracking,
        row: event.row || operations.current.row,
        step: 'Claim result received',
        result: 'Already submitted',
        kind: 'already'
      });
      const detail = detailForEvent('already', event, 'Already submitted', { issue: 'Duplicate claim' });
      addRecentResult('already', event.trackingNumber, 'Already submitted', event.row, detail);
      addNeedsReview('already', event.trackingNumber, 'Duplicate claim', event.row, event.screenshotPath, detail);
      setActionLocalized('event.submit.alreadySubmittedAction', { tracking: event.trackingNumber }, 'Already submitted: {tracking}', 'step3');
      return trf('event.submit.alreadySubmittedLog', { row: event.row, tracking: event.trackingNumber, message: localizedEventMessage || event.message }, 'ALREADY SUBMITTED row {row}, {tracking}: {message}');
    }
    if (type === 'claim_rejected') {
      finishBuiltinBrowserActivity(tr('event.submit.claimRejectedActivity', 'Claim rejected'));
      state.rejected += 1;
      updateCurrentItem({
        tracking: event.trackingNumber || operations.current.tracking,
        row: event.row || operations.current.row,
        step: 'Claim result received',
        result: 'Rejected / ineligible',
        kind: 'already'
      });
      const detail = detailForEvent('already', event, 'Rejected / ineligible', { issue: event.reason || event.message || 'Canada Post rejection' });
      addRecentResult('already', event.trackingNumber, 'Rejected / ineligible', event.row, detail);
      addNeedsReview('already', event.trackingNumber, event.reason || event.message || 'Canada Post rejection', event.row, event.screenshotPath, detail);
      setActionLocalized('event.submit.rejectedAction', { tracking: event.trackingNumber }, 'Rejected by Canada Post: {tracking}', 'step3');
      return trf('event.submit.rejectedLog', { row: event.row, tracking: event.trackingNumber, message: localizedEventMessage || event.message }, 'REJECTED row {row}, {tracking}: {message}');
    }
    if (type === 'claim_error') {
      finishBuiltinBrowserActivity(tr('event.submit.claimFailedActivity', 'Claim failed'), 'error');
      state.failed += 1;
      updateCurrentItem({
        tracking: event.trackingNumber || operations.current.tracking,
        row: event.row || operations.current.row,
        step: 'Claim result received',
        result: 'Failed',
        kind: 'failed'
      });
      const detail = detailForEvent('failed', event, 'Failed', { issue: event.message || 'Claim failed' });
      addRecentResult('failed', event.trackingNumber, 'Failed', event.row, detail);
      addNeedsReview('failed', event.trackingNumber, event.message || 'Claim failed', event.row, event.screenshotPath, detail);
      setActionLocalized('event.submit.failedAction', { tracking: event.trackingNumber }, 'Failed: {tracking}', 'step3');
      return trf('event.submit.errorLog', { row: event.row, tracking: event.trackingNumber, message: localizedEventMessage || event.message }, 'ERROR row {row}, {tracking}: {message}');
    }
    if (type === 'submit_complete') {
      builtinBrowserManualActionPending = false;
      finishBuiltinBrowserActivity(tr('event.submit.runCompleteActivity', 'Submission run complete'));
      operations.finishedAt = Date.now();
      const dryReady = Number(event.dryRunReady || 0);
      updateCurrentItem({ step: 'Submission complete', result: dryReady ? `${dryReady} dry-run ready` : 'Done', kind: '' });
      setStatus('Complete', 'good', 'step3');
      const summary = dryReady
        ? trf('event.submit.dryComplete', { ready: dryReady, failed: event.failed || 0 }, 'Dry run complete. Ready: {ready}, Failed: {failed}. No claims were submitted.')
        : trf('event.submit.complete', { succeeded: event.succeeded, already: event.alreadySubmitted || 0, rejected: event.rejected || 0, failed: event.failed }, 'Submission complete. Approved/success: {succeeded}, Already submitted: {already}, Rejected/ineligible: {rejected}, Submission errors: {failed}.');
      setAction(summary, 'step3');
      stopOperationsTimer();
      refreshHistory().catch(() => {});
      return summary;
    }
  }

  if (type === 'stop_requested') {
    updateCurrentItem({ step: 'Stop requested', result: 'Stopping after current item', kind: 'already' });
    return localizedEventMessage || event.message;
  }
  if (type === 'error') {
    updateCurrentItem({ step: 'Runner error', result: 'Failed', kind: 'failed' });
    addNeedsReview('failed', operations.current.tracking, event.message || 'Runner error', operations.current.row, '', {
      kind: 'failed',
      tracking: operations.current.tracking,
      row: operations.current.row,
      result: 'Runner error',
      status: 'Runner error',
      message: localizedEventMessage || event.message || tr('event.runnerError', 'Runner error')
    });
    return `${tr('common.error', 'ERROR')}: ${localizedEventMessage || event.message}`;
  }
  if (localizedEventMessage) return localizedEventMessage;
  if (event.message) {
    if (/duplicate-claim detector active/i.test(event.message)) return null;
    return event.message;
  }
  return JSON.stringify(event);
}


function historyDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function historyCell(text, className = '') {
  const cell = document.createElement('div');
  cell.className = className;
  cell.textContent = text === undefined || text === null || text === '' ? '—' : String(text);
  return cell;
}

function updateReconciliationCount(count) {
  const pill = $('reconciliationCountPill');
  if (pill) setLocalizedText(pill, 'history.unresolvedCount', { count: count || 0 }, '{count} unresolved');
}

function setHistoryRecordState(root, state) {
  if (!root) return;
  root.classList.remove('is-empty', 'is-loading', 'is-error');
  if (state) root.classList.add(`is-${state}`);
  root.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
}

function renderHistoryRecordMessage(rootId, message, state = 'error') {
  const root = $(rootId);
  if (!root) return;
  setHistoryRecordState(root, state);
  root.replaceChildren();
  const notice = document.createElement('div');
  notice.className = 'history-empty';
  notice.textContent = message;
  root.appendChild(notice);
}

function updateClearHistoryFiltersButton() {
  const button = $('clearHistoryFilters');
  if (!button) return;
  const active = getFieldValue('historySearch') !== HISTORY_DEFAULT_FILTERS.search
    || ($('historyStatusFilter')?.value || 'all') !== HISTORY_DEFAULT_FILTERS.status
    || historyViewState.page !== HISTORY_DEFAULT_FILTERS.page
    || historyViewState.offset !== HISTORY_DEFAULT_FILTERS.offset;
  button.disabled = !active;
}

function setHistoryPagination(page = 1, offset = 0) {
  historyViewState.page = Math.max(1, Number(page) || 1);
  historyViewState.offset = Math.max(0, Number(offset) || 0);
  updateClearHistoryFiltersButton();
}

function getHistoryViewState() {
  return { ...historyViewState };
}

function renderHistory(items = []) {
  const root = $('historyList');
  if (!root) return;
  setHistoryRecordState(root, items.length ? '' : 'empty');
  setLocalizedText($('historyResultCount'), items.length === 1 ? 'history.oneRecord' : 'history.recordCount', { count: items.length }, items.length === 1 ? '1 record' : '{count} records');
  root.replaceChildren();
  const head = document.createElement('div');
  head.className = 'history-row head';
  ['common.tracking', 'history.attemptTime', 'common.status', 'history.confirmation', 'history.message'].forEach(key => head.appendChild(historyCell(tr(key))));
  root.appendChild(head);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = tr('history.noAttempts', 'No claim attempts match the current filters.');
    root.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.appendChild(historyCell(item.trackingNumber));
    row.appendChild(historyCell(historyDate(item.attemptedAt)));
    row.appendChild(historyCell(localizedInterfaceValue(item.status)));
    row.appendChild(historyCell(item.confirmationNumber));
    const messageCell = document.createElement('div');
    messageCell.textContent = item.message || '—';
    if (item.screenshotPath || item.textPath) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = tr('history.viewEvidence', 'View evidence');
      button.style.marginLeft = '8px';
      button.addEventListener('click', async () => {
        const detail = {
          kind: item.status === 'submitted' ? 'submitted' : (item.status === 'already_submitted' ? 'already' : 'failed'),
          tracking: item.trackingNumber,
          row: item.id,
          result: item.status,
          status: item.status,
          message: item.message,
          screenshotPath: item.screenshotPath,
          textPath: item.textPath,
          source: tr('history.databaseSource', 'History database'),
          createdAt: item.attemptedAt
        };
        const registered = registerDetailItem(detail);
        activateTab('resultsTab');
        openDetail(registered.id);
      });
      messageCell.appendChild(button);
    }
    row.appendChild(messageCell);
    root.appendChild(row);
  }
}

function reconciliationActionButton(item, label, action, className = 'secondary') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', async () => {
    let confirmationNumber = '';
    if (action === 'submitted') {
      const confirmation = window.prompt(trf('history.reconcile.confirmationPrompt', { tracking: item.trackingNumber }, 'Confirmation or ticket number for {tracking} (optional):'), item.confirmationNumber || '');
      if (confirmation === null) return;
      confirmationNumber = confirmation.trim();
    }
    const noteValue = window.prompt(trf('history.reconcile.notePrompt', { tracking: item.trackingNumber }, 'Optional reconciliation note for {tracking}:'), '');
    if (noteValue === null) return;
    const result = await window.cpApp.reconcileAttempt({ attemptId: item.id, action, note: noteValue.trim(), confirmationNumber });
    if (!result.ok) {
      window.alert(result.error || tr('history.reconcile.updateFailed', 'Could not update reconciliation state.'));
      return;
    }
    await refreshHistory();
  });
  return button;
}

function renderManualShipments(items = []) {
  const root = $('manualShipmentList');
  if (!root) return;
  root.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = tr('history.manual.empty', 'No manually entered shipments.');
    root.appendChild(empty);
    return;
  }
  const head = document.createElement('div');
  head.className = 'history-row head';
  ['common.tracking', 'history.manual.referenceShort', 'step3.queue.service', 'history.manual.expectedShort', 'history.manual.note'].forEach(key => head.appendChild(historyCell(tr(key))));
  root.appendChild(head);
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.appendChild(historyCell(item.trackingNumber));
    row.appendChild(historyCell(item.referenceNumber));
    row.appendChild(historyCell(item.serviceCode));
    row.appendChild(historyCell(item.expectedDate));
    row.appendChild(historyCell(item.note));
    root.appendChild(row);
  }
}

function renderReconciliation(items = []) {
  const root = $('reconciliationList');
  if (!root) return;
  setHistoryRecordState(root, items.length ? '' : 'empty');
  root.replaceChildren();
  const head = document.createElement('div');
  head.className = 'reconciliation-row head';
  ['common.tracking', 'history.attemptTime', 'common.status', 'history.reason', 'history.actions'].forEach(key => head.appendChild(historyCell(tr(key))));
  root.appendChild(head);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = tr('history.reconcile.empty', 'No uncertain or interrupted claims require reconciliation.');
    root.appendChild(empty);
    return;
  }
  const orderedItems = reconciliationFocusAttemptId
    ? [...items].sort((left, right) => (Number(right.id) === Number(reconciliationFocusAttemptId)) - (Number(left.id) === Number(reconciliationFocusAttemptId)))
    : items;
  for (const item of orderedItems) {
    const row = document.createElement('div');
    const focused = Number(item.id) === Number(reconciliationFocusAttemptId);
    row.className = `reconciliation-row${focused ? ' focused' : ''}`;
    row.dataset.attemptId = String(item.id || '');
    row.appendChild(historyCell(item.trackingNumber));
    row.appendChild(historyCell(historyDate(item.attemptedAt)));
    row.appendChild(historyCell(localizedInterfaceValue(item.status)));
    row.appendChild(historyCell(`${item.errorCode ? `${item.errorCode}: ` : ''}${item.message || tr('history.reconcile.uncertain', 'Remote outcome is uncertain.')}`));
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    if (item.screenshotPath || item.textPath) {
      const evidence = document.createElement('button');
      evidence.type = 'button';
      evidence.className = 'secondary';
      evidence.textContent = tr('common.evidence', 'Evidence');
      evidence.addEventListener('click', async () => {
        const loaded = await window.cpApp.loadEvidence({ screenshotPath: item.screenshotPath, textPath: item.textPath });
        if (loaded.ok && item.screenshotPath) await window.cpApp.openEvidence(item.screenshotPath);
        else window.alert(loaded.error || loaded.pageText || tr('history.noEvidence', 'No evidence available.'));
      });
      actions.appendChild(evidence);
    }
    actions.appendChild(reconciliationActionButton(item, tr('history.reconcile.markSubmitted', 'Mark submitted'), 'submitted', 'success'));
    actions.appendChild(reconciliationActionButton(item, tr('history.reconcile.markNotSubmitted', 'Mark not submitted'), 'not_submitted', 'warning'));
    actions.appendChild(reconciliationActionButton(item, tr('history.reconcile.approveRetry', 'Approve retry'), 'retry', 'secondary'));
    row.appendChild(actions);
    root.appendChild(row);
  }
}

function renderManualReviews(items = []) {
  const root = $('manualReviewList');
  if (!root) return;
  setHistoryRecordState(root, items.length ? '' : 'empty');
  root.textContent = '';
  setLocalizedText($('manualReviewCountPill'), 'history.openCount', { count: items.length }, '{count} open');
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = tr('history.manualReviewEmpty', 'No classification records require manual review.');
    root.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.appendChild(historyCell(item.tracking_number || '—'));
    row.appendChild(historyCell(item.service_code || tr('history.unknownService', 'Unknown service')));
    row.appendChild(historyCell([item.expected_date, item.first_attempt_date, item.delivery_date].filter(Boolean).join(' → ')));
    row.appendChild(historyCell(item.reason_codes_json || item.automated_classification || tr('history.manualReviewShort', 'Manual review')));
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    for (const [label, action, className] of [[tr('history.review.addNote', 'Add note'), 'note', 'secondary'], [tr('history.review.resolveCandidate', 'Resolve as candidate'), 'resolved_eligible', 'success'], [tr('history.review.resolveNotCandidate', 'Resolve as not a late candidate'), 'resolved_not_eligible', 'warning'], [tr('history.review.defer', 'Defer'), 'resolved_deferred', 'secondary']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = label;
      button.addEventListener('click', async () => {
        const note = window.prompt(trf('history.review.notePrompt', { action: label }, '{action} — the note is retained in the audit history:'), item.note || '');
        if (note === null) return;
        const result = await window.cpApp.updateManualReview({ reviewId: item.id, action, note });
        if (!result.ok) window.alert(result.error || tr('history.review.updateFailed', 'Could not update manual review.'));
        await refreshHistory();
      });
      actions.appendChild(button);
    }
    row.appendChild(actions);
    root.appendChild(row);
  }
}

function renderHistoryClassifications(items = []) {
  const target = $('historyClassificationList');
  if (!target) return;
  target.textContent = '';
  if (!items.length) {
    target.appendChild(queueCell(tr('history.classificationsEmpty', 'No matching classification records.')));
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.append(
      queueCell(item.tracking_number, 'history-primary'),
      queueCell(tr(`classification.${item.classification}`, item.classification)),
      queueCell(item.service_code),
      queueCell(item.eligibility_reason)
    );
    target.appendChild(row);
  }
}

async function refreshHistory(options = {}) {
  if (!window.cpApp?.listHistory) return;
  if (options.resetPage) {
    historyViewState.page = HISTORY_DEFAULT_FILTERS.page;
    historyViewState.offset = HISTORY_DEFAULT_FILTERS.offset;
  }
  const search = getFieldValue('historySearch');
  const status = $('historyStatusFilter')?.value || 'all';
  historyViewState.search = search;
  historyViewState.status = status;
  updateClearHistoryFiltersButton();
  renderHistoryRecordMessage('historyList', 'Loading claim attempts…', 'loading');
  renderHistoryRecordMessage('reconciliationList', 'Loading reconciliation records…', 'loading');
  renderHistoryRecordMessage('manualReviewList', 'Loading manual reviews…', 'loading');
  const [history, reconciliation, dashboard, manualShipments, manualReviews, reviewClassifications, trackingErrors, onTimeClassifications] = await Promise.all([
    window.cpApp.listHistory({ search, status, limit: 500, page: historyViewState.page, offset: historyViewState.offset }),
    window.cpApp.listReconciliation(),
    window.cpApp.getDashboard(),
    window.cpApp.listManualShipments({ search, limit: 250 }),
    window.cpApp.listManualReviews({ search, status: 'open', limit: 250 }),
    window.cpApp.listClassificationQueue({ classification: 'REVIEW_REQUIRED', search, limit: 250 }),
    window.cpApp.listClassificationQueue({ classification: 'TRACKING_ERROR', search, limit: 250 }),
    window.cpApp.listClassificationQueue({ classification: 'ON_TIME', search, limit: 250 })
  ]);
  if (history.ok) renderHistory(history.items || []);
  else {
    setLocalizedText($('historyResultCount'), 'common.unavailable', {}, 'Unavailable');
    renderHistoryRecordMessage('historyList', history.error || tr('history.loadAttemptsFailed', 'Could not load claim attempts.'));
  }
  if (manualShipments.ok) renderManualShipments(manualShipments.items || []);
  if (manualReviews.ok) renderManualReviews(manualReviews.items || []);
  else renderHistoryRecordMessage('manualReviewList', manualReviews.error || tr('history.loadReviewsFailed', 'Could not load manual reviews.'));
  renderHistoryClassifications([
    ...(reviewClassifications.items || []),
    ...(trackingErrors.items || []),
    ...(onTimeClassifications.items || [])
  ]);
  if (reconciliation.ok) {
    renderReconciliation(reconciliation.items || []);
    updateReconciliationCount((reconciliation.items || []).length);
  } else renderHistoryRecordMessage('reconciliationList', reconciliation.error || tr('history.loadReconciliationFailed', 'Could not load reconciliation records.'));
  if (dashboard.ok) {
    const data = dashboard.dashboard || {};
    setText('historyShipments', data.shipments || 0);
    setText('historySubmitted', data.submitted || 0);
    setText('historyReconciliation', data.reconciliation || 0);
    setText('historyFailed', data.failed || 0);
    const integrity = $('databaseIntegrity');
    if (integrity) {
      setLocalizedText(integrity, dashboard.integrity?.ok ? 'database.healthy' : 'database.failed', {}, dashboard.integrity?.ok ? 'Database healthy' : 'Database check failed');
      integrity.className = dashboard.integrity?.ok ? 'pill good' : 'pill bad';
    }
  }
}

async function clearHistoryFilters() {
  clearTimeout(historySearchTimer);
  if ($('historySearch')) $('historySearch').value = HISTORY_DEFAULT_FILTERS.search;
  if ($('historyStatusFilter')) $('historyStatusFilter').value = HISTORY_DEFAULT_FILTERS.status;
  Object.assign(historyViewState, HISTORY_DEFAULT_FILTERS);
  updateClearHistoryFiltersButton();
  await refreshHistory({ resetPage: true });
}

let backupPasswordResolver = null;

function requestBackupPassword({ confirm = false, restore = false } = {}) {
  const modal = $('backupPasswordModal');
  const input = $('backupPassword');
  const confirmation = $('backupPasswordConfirm');
  const confirmationField = $('backupPasswordConfirmField');
  const error = $('backupPasswordError');
  setLocalizedText($('backupPasswordTitle'), restore ? 'backup.unlockTitle' : 'backup.createTitle', {}, restore ? 'Unlock encrypted backup' : 'Create encrypted backup');
  setLocalizedText($('backupPasswordMessage'), restore ? 'backup.unlockMessage' : 'backup.createMessage', {}, restore
    ? 'Enter the password used when this encrypted backup was created.'
    : 'Enter a strong password of at least 12 characters. It is never saved and cannot be recovered.');
  confirmationField?.classList.toggle('hidden', !confirm);
  input.value = '';
  confirmation.value = '';
  error?.classList.add('hidden');
  modal?.classList.remove('hidden');
  modal?.setAttribute('aria-hidden', 'false');
  setTimeout(() => input?.focus(), 0);
  return new Promise(resolve => { backupPasswordResolver = resolve; });
}

function closeBackupPasswordModal(value = '') {
  const modal = $('backupPasswordModal');
  modal?.classList.add('hidden');
  modal?.setAttribute('aria-hidden', 'true');
  const resolver = backupPasswordResolver;
  backupPasswordResolver = null;
  if (resolver) resolver(value);
}

function submitBackupPassword() {
  const password = $('backupPassword')?.value || '';
  const confirmationVisible = !$('backupPasswordConfirmField')?.classList.contains('hidden');
  const error = $('backupPasswordError');
  if (password.length < 12) {
    error.textContent = tr('backup.tooShort', 'Use at least 12 characters.'); error.classList.remove('hidden'); return;
  }
  if (confirmationVisible && password !== ($('backupPasswordConfirm')?.value || '')) {
    error.textContent = tr('backup.mismatch', 'The passwords do not match.'); error.classList.remove('hidden'); return;
  }
  closeBackupPasswordModal(password);
}

async function createAppBackup() {
  const password = await requestBackupPassword({ confirm: true });
  if (!password) return;
  const result = await window.cpApp.createBackup({ password });
  if (result.ok) window.alert(trf('backup.created', { path: result.path }, 'Backup created:\n{path}'));
  else if (!result.canceled) window.alert(result.error || tr('backup.createFailed', 'Could not create backup.'));
}

async function restoreAppBackup() {
  if (!window.confirm(tr('backup.restoreConfirm', 'Restore a backup? The current database and replaced data files will be preserved in rollback copies.'))) return;
  let result = await window.cpApp.restoreBackup({});
  if (result.passwordRequired) {
    const password = await requestBackupPassword({ restore: true });
    if (!password) return;
    result = await window.cpApp.restoreBackup({ password });
  }
  if (result.ok) {
    window.alert(trf('backup.restored', { count: result.restoredDataFiles || 0 }, 'Backup restored. {count} data/evidence files restored.'));
    await refreshConfig();
    await refreshHistory();
  } else if (!result.canceled) {
    window.alert(result.error || tr('backup.restoreFailed', 'Could not restore backup.'));
  }
}

function privacyElements() {
  return {
    trackingNumbers: $('privacyTrackingNumbers'),
    dateFrom: $('privacyDateFrom'),
    dateTo: $('privacyDateTo'),
    allRecords: $('privacyAllRecords')
  };
}

function openPrivacyDataModal() {
  resetPrivacyPreview();
  const modal = $('privacyDataModal');
  modal?.classList.remove('hidden');
  modal?.setAttribute('aria-hidden', 'false');
  $('privacyTrackingNumbers')?.focus();
}

function closePrivacyDataModal() {
  resetPrivacyPreview();
  $('privacyDataModal')?.classList.add('hidden');
  $('privacyDataModal')?.setAttribute('aria-hidden', 'true');
  $('manageStoredData')?.focus();
}

function currentPrivacyScope() {
  return window.PrivacyDataManagement.scopeFromElements(privacyElements());
}

function resetPrivacyPreview({ preserveStatus = false } = {}) {
  state.privacyPreview = null;
  $('privacyDeletionControls')?.classList.add('hidden');
  if (!preserveStatus && $('privacyDataStatus')) {
    $('privacyDataStatus').textContent = tr('privacy.status.previewRequired', 'Preview required');
    $('privacyDataStatus').className = 'pill';
  }
}

async function previewPrivacyData() {
  const scope = currentPrivacyScope();
  const result = await window.cpApp.previewPrivacyDeletion(scope);
  if (!result?.ok) {
    resetPrivacyPreview();
    window.alert(result?.error || tr('privacy.previewFailed', 'The deletion preview could not be created.'));
    return;
  }
  state.privacyPreview = { scope, result };
  window.PrivacyDataManagement.renderCounts($('privacyPreviewCounts'), result.recordCounts, key => tr(key));
  $('privacyDeletionControls')?.classList.remove('hidden');
  $('privacySecondConfirmWrap')?.classList.toggle('hidden', !result.requiresSecondConfirmation);
  if ($('privacySecondConfirm')) $('privacySecondConfirm').checked = false;
  if ($('privacyDestructiveConfirm')) $('privacyDestructiveConfirm').checked = false;
  if ($('privacyTypedPhrase')) $('privacyTypedPhrase').value = '';
  const phrase = tr(result.confirmationPhraseKey === 'all' ? 'privacy.confirmation.all' : 'privacy.confirmation.selected');
  if ($('privacyExpectedPhrase')) $('privacyExpectedPhrase').textContent = trf('privacy.expectedPhrase', { phrase }, 'Confirmation phrase: {phrase}');
  if ($('privacyDataStatus')) {
    $('privacyDataStatus').textContent = tr('privacy.status.previewReady', 'Deletion preview ready');
    $('privacyDataStatus').className = 'pill warn';
  }
}

async function deletePrivacyData() {
  if (!state.privacyPreview || JSON.stringify(currentPrivacyScope()) !== JSON.stringify(state.privacyPreview.scope)) {
    resetPrivacyPreview();
    return window.alert(tr('privacy.status.previewRequired', 'Preview required'));
  }
  const result = await window.cpApp.deletePrivacyData({
    ...state.privacyPreview.scope,
    locale: document.documentElement.lang,
    confirmed: $('privacyDestructiveConfirm')?.checked === true,
    typedPhrase: $('privacyTypedPhrase')?.value || '',
    secondConfirmed: $('privacySecondConfirm')?.checked === true
  });
  if (!result?.ok) return window.alert(result?.error || tr('privacy.deleteFailed', 'The selected data could not be deleted.'));
  if ($('privacyDataStatus')) {
    $('privacyDataStatus').textContent = tr('privacy.status.complete', 'Deletion complete');
    $('privacyDataStatus').className = 'pill good';
  }
  window.alert(trf('privacy.deleteComplete', { operationId: result.receipt?.operationId || '' }, 'Deletion completed. Operation receipt: {operationId}'));
  resetPrivacyPreview({ preserveStatus: true });
  await refreshHistory();
  await refreshClaimQueue();
  closePrivacyDataModal();
}

async function refreshBrowserSessionStatus() {
  const statuses = [$('browserSessionStatus'), $('step3BrowserSessionStatus')].filter(Boolean);
  for (const status of statuses) setLocalizedText(status, 'browserSession.checking', {}, 'Checking local browser session…');
  const result = await window.cpApp.browserSessionStatus();
  const key = result.ok
    ? (result.exists ? 'browserSession.exists' : 'browserSession.none')
    : 'browserSession.inspectFailed';
  const fallback = result.ok
    ? (result.exists ? 'A local Canada Post browser session exists on this device.' : 'No saved Canada Post browser session was detected.')
    : (result.error || 'Could not inspect browser session state.');
  for (const status of statuses) setLocalizedText(status, key, {}, fallback);
  return result;
}

function renderPortalCompatibilityAdvisory(gate = state.portalCompatibility, { checking = false } = {}) {
  const advisory = $('portalCompatibilityAdvisory');
  const status = $('portalCompatibilityStatus');
  const message = $('portalCompatibilityMessage');
  if (!advisory || !status || !message) return;
  const view = checking
    ? { id: 'checking', kind: 'warn', requiresOverride: true }
    : window.PortalAdvisory.describe(gate);
  if (!checking && state.portalCompatibilityViewId && state.portalCompatibilityViewId !== view.id) {
    state.portalCompatibilityWarningDismissed = false;
  }
  state.portalCompatibilityViewId = view.id;
  advisory.classList.toggle('compatible', view.id === 'compatible');
  advisory.classList.toggle('hidden', !checking && view.requiresOverride && state.portalCompatibilityWarningDismissed);
  status.className = `pill ${view.kind}`;
  setLocalizedText(status, `step3.compatibility.status.${view.id}`, {}, view.id);
  setLocalizedText(message, `step3.compatibility.message.${view.id}`, {}, 'Portal compatibility status is advisory.');
  $('portalCompatibilityRisk')?.classList.toggle('hidden', view.id === 'compatible');
  $('dismissPortalCompatibility')?.classList.toggle('hidden', !view.requiresOverride || checking);
}

async function refreshPortalCompatibilityStatus({ runCheck = false } = {}) {
  let validationResult = null;
  if (runCheck) {
    state.portalCompatibilityWarningDismissed = false;
    renderPortalCompatibilityAdvisory(state.portalCompatibility, { checking: true });
    validationResult = await window.cpApp.runSiteHealth(collectUserSettingsOptions());
    if (!validationResult?.ok) {
      const values = { code: validationResult?.code || 'UNKNOWN' };
      setActionLocalized('step3.compatibility.refreshFailed', values, 'Compatibility remains unverified ({code}). Review the warning before a live run.', 'step3');
      log(trf('step3.compatibility.refreshFailed', values, 'Compatibility remains unverified ({code}). Review the warning before a live run.'), 'log-warning', 'step3');
    }
  }
  const cfg = await window.cpApp.loadConfig();
  state.portalCompatibility = runCheck && validationResult?.ok === false && !validationResult.portalCompatibility
    ? { ok: false, code: 'PORTAL_COMPATIBILITY_WARNING', reason: validationResult.error || '' }
    : (cfg?.portalCompatibility || { ok: false, code: 'PORTAL_COMPATIBILITY_REQUIRED' });
  renderPortalCompatibilityAdvisory();
  return state.portalCompatibility;
}

function dismissPortalCompatibilityWarning() {
  if (window.PortalAdvisory.describe(state.portalCompatibility).requiresOverride) {
    state.portalCompatibilityWarningDismissed = true;
    renderPortalCompatibilityAdvisory();
  }
}

async function clearBrowserSession() {
  const confirmed = window.confirm(tr('browserSession.clearConfirm', 'Log out and clear the Canada Post browser profile? Cookies, cache and site storage will be removed. Claim history and settings will be preserved.'));
  if (!confirmed) return;
  const result = await window.cpApp.clearBrowserSession({ confirmed: true, resetProfile: true });
  if (!result.ok) return window.alert(result.error || tr('browserSession.clearFailed', 'Could not clear browser data.'));
  window.alert(tr('browserSession.cleared', 'Browser cookies, cache and site storage were cleared. Claim history was preserved.'));
  await refreshBrowserSessionStatus();
}

async function createDiagnosticZip() {
  const result = await window.cpApp.previewSupportBundle({});
  if (!result?.ok) return window.alert(result?.error || tr('support.previewFailed', 'Could not preview the support bundle.'));
  const preview = result.preview;
  $('supportReferenceId').textContent = preview.supportReferenceId;
  $('supportBundleMetadata').textContent = trf('support.metadata', { version: preview.applicationVersion, platform: preview.platform, architecture: preview.architecture, schema: preview.databaseSchemaVersion, parser: preview.trackingParserVersion }, '{version} / {platform}-{architecture} / database schema {schema} / parser {parser}');
  $('supportBundleExclusions').textContent = trf('support.exclusions', { exclusions: preview.exclusions.join(', ') }, 'Always excluded: {exclusions}.');
  for (const [name, detail] of Object.entries(preview.components)) {
    const input = document.querySelector(`[data-support-component="${name}"]`);
    if (input) input.checked = detail.selected;
  }
  $('supportBundleAcknowledge').checked = false;
  $('confirmSupportBundle').disabled = true;
  $('supportBundleModal').classList.remove('hidden');
  $('supportBundleModal').setAttribute('aria-hidden', 'false');
}

function closeSupportBundle() {
  $('supportBundleModal')?.classList.add('hidden');
  $('supportBundleModal')?.setAttribute('aria-hidden', 'true');
}

async function confirmSupportBundle() {
  const components = [...document.querySelectorAll('[data-support-component]:checked')].map(input => input.dataset.supportComponent);
  const result = await window.cpApp.createDiagnostics({
    components,
    supportReferenceId: $('supportReferenceId')?.textContent || '',
    acknowledged: $('supportBundleAcknowledge')?.checked === true
  });
  if (result.ok) {
    closeSupportBundle();
    window.alert(trf('support.created', { reference: result.supportReferenceId, path: result.path }, 'Sanitized support bundle {reference} created:\n{path}'));
  } else if (!result.canceled) window.alert(result.error || tr('support.createFailed', 'Could not create support bundle.'));
}

async function exportClaimHistory() {
  const result = await window.cpApp.exportHistory({
    search: getFieldValue('historySearch'),
    status: $('historyStatusFilter')?.value || 'all'
  });
  if (result.ok) window.alert(trf('history.exported', { path: result.path }, 'Claim history exported:\n{path}'));
  else if (!result.canceled) window.alert(result.error || tr('history.exportFailed', 'Could not export claim history.'));
}

async function addManualShipment() {
  const trackingNumber = getFieldValue('manualTracking');
  if (!trackingNumber) {
    window.alert(tr('history.manual.trackingRequired', 'Tracking number is required.'));
    return;
  }
  const result = await window.cpApp.addManualShipment({
    trackingNumber,
    referenceNumber: getFieldValue('manualReference'),
    serviceCode: getFieldValue('manualService'),
    destinationPostalCode: getFieldValue('manualPostal'),
    expectedDate: getFieldValue('manualExpected'),
    deliveryDate: getFieldValue('manualDelivery'),
    note: getFieldValue('manualNote')
  });
  if (!result.ok) {
    window.alert(result.error || tr('history.manual.saveFailed', 'Could not save shipment.'));
    return;
  }
  for (const id of ['manualTracking', 'manualReference', 'manualService', 'manualPostal', 'manualExpected', 'manualDelivery', 'manualNote']) {
    if ($(id)) $(id).value = '';
  }
  await refreshHistory();
}

function isoDateFromOffset(daysOffset) {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);
  return date.toISOString().slice(0, 10);
}

function getFieldValue(id) {
  const el = $(id);
  return el ? String(el.value || '').trim() : '';
}

function collectUserSettingsOptions() {
  const rememberSettings = $('rememberSettings') ? $('rememberSettings').checked : false;
  return {
    webUsername: getFieldValue('webUsername'),
    webPassword: $('webPassword')?.value || '',
    trackingClientId: getFieldValue('trackingClientId'),
    trackingClientSecret: $('trackingClientSecret')?.value || '',
    trackingApiEnvironment: $('trackingApiEnvironment')?.value || state.trackingApiEnvironment || 'test',
    trackingRequestDelayMs: Number.parseInt(getFieldValue('trackingRequestDelayMs') || '3100', 10),
    trackingResourceTimeoutMs: Number.parseInt(getFieldValue('trackingResourceTimeoutMs') || '45000', 10),
    rememberSettings,
    saveLogin: rememberSettings,
    saveUsernameOnly: !rememberSettings,
    estCustomerNumber: getFieldValue('estCustomerNumber'),
    claimStreetNumber: getFieldValue('claimStreetNumber'),
    claimStreetName: getFieldValue('claimStreetName'),
    claimAddressLine2: getFieldValue('claimAddressLine2'),
    claimCity: getFieldValue('claimCity'),
    claimProvince: getFieldValue('claimProvince'),
    claimPostalCode: getFieldValue('claimPostalCode'),
    claimBusinessName: getFieldValue('claimBusinessName'),
    claimContactName: getFieldValue('claimContactName'),
    claimContactPhone: getFieldValue('claimContactPhone'),
    claimContactEmail: getFieldValue('claimContactEmail'),
    evidenceRetentionDays: $('evidenceRetentionDays')
      ? Math.max(7, Math.min(3650, Number(getFieldValue('evidenceRetentionDays') || state.evidenceRetentionDays || 90)))
      : state.evidenceRetentionDays,
    dryRunDefault: $('dryRunDefault') ? Boolean($('dryRunDefault').checked) : state.dryRunDefault
  };
}

function validateSettingsForStep(stepId) {
  const settings = collectUserSettingsOptions();
  const missing = [];
  if (stepId === 'step1' || stepId === 'step3') {
    if (!settings.webUsername) missing.push(tr('settings.website.username', 'Canada Post Web Username'));
    if (!settings.webPassword && !state.passwordStored) missing.push(tr('settings.website.password', 'Canada Post Web Password'));
  }
  if (stepId === 'step1' && !settings.estCustomerNumber) missing.push(tr('settings.est.customerNumber', 'EST customer number'));
  if (stepId === 'step3') {
    if (!settings.claimStreetNumber) missing.push(tr('settings.sender.streetNumberShort', 'Claim sender street number'));
    if (!settings.claimStreetName) missing.push(tr('settings.sender.streetNameShort', 'Claim sender street name dropdown option'));
  }
  return missing;
}

async function saveUserSettings(showLog = true) {
  const settings = collectUserSettingsOptions();
  const payload = { ...settings };
  if (!settings.rememberSettings) payload.webPassword = '';
  const res = await window.cpApp.saveConfig(payload);
  if (!res.ok) {
    const status = $('settingsStatus');
    if (status) { status.textContent = res.error || tr('settings.saveFailed', 'Settings were not saved.'); status.className = 'pill bad'; }
    if (showLog) log(res.error || tr('settings.saveFailed', 'Settings were not saved.'), 'log-submit-error', 'step1');
    return res;
  }
  if (res.ok) {
    state.passwordStored = !!res.passwordStored;
    state.trackingApiCredentialsStored = !!res.trackingApiCredentialsStored;
    state.trackingDiagnosticGateSatisfied = !!res.trackingDiagnosticGateSatisfied;
    const status = $('settingsStatus');
    if (status) {
      status.textContent = res.warning || (state.passwordStored ? tr('settings.savedEncrypted', 'Saved with encrypted password') : tr('settings.savedWithoutPassword', 'Saved without password'));
      status.className = res.warning ? 'pill warn' : 'pill good';
    }
    if ($('webPassword')) $('webPassword').value = '';
    if ($('trackingClientId')) $('trackingClientId').value = '';
    if ($('trackingClientSecret')) $('trackingClientSecret').value = '';
    if ($('trackingApiCredentialMetadata') && res.trackingApiCredentialMetadata) renderTrackingApiCredentialMetadata(res.trackingApiCredentialMetadata);
    renderTrackingDiagnosticGate();
    if (showLog) log(res.warning || tr('settings.saved', 'User settings saved.'), res.warning ? 'log-warning' : '', 'step1');
  }
  return res;
}

async function clearTrackingApiCredentials() {
  const confirmed = window.confirm(tr('tracking.credentials.clearConfirm', 'Clear the current Tracking API client ID and client secret from encrypted storage? Website credentials will not be changed.'));
  if (!confirmed) return;
  const result = await window.cpApp.clearTrackingApiCredentials({ confirmed: true });
  if (!result.ok) return window.alert(result.error || tr('tracking.credentials.clearFailed', 'Could not clear Tracking API credentials.'));
  state.trackingApiCredentialsStored = false;
  state.trackingDiagnosticGateSatisfied = false;
  await refreshConfig();
  window.alert(tr('tracking.credentials.clearComplete', 'Tracking API credentials and the diagnostic gate were cleared. Website credentials were not changed.'));
}

function buildEstHistoryOptions() {
  return {
    ...collectUserSettingsOptions(),
    estFrom: $('estFrom')?.value || $('historyFrom')?.value || '',
    estTo: $('estTo')?.value || $('historyTo')?.value || '',
    estWorkgroup: '',
    estMobo: '-2',
    estCategoryGroup: 'SHP',
    estFileTypes: '1,2',
    developerMode: false
  };
}

function buildHistoryOptions() {
  const customerNumber = ($('historyCustomerNumber')?.value || '').trim();
  const autoMobo = $('historyAutoMobo') ? $('historyAutoMobo').checked : true;
  const moboRaw = autoMobo ? '' : (($('historyMobo')?.value || '').trim());
  return {
    historyFrom: $('historyFrom')?.value || '',
    historyTo: $('historyTo')?.value || '',
    historyCustomerNumber: customerNumber,
    historyAutoMobo: autoMobo,
    historyMobo: moboRaw,
    historyIncludeNoManifest: $('historyIncludeNoManifest')?.checked || false,
    developerMode: false
  };
}

function buildRunOptions(importHistory = false) {
  return {
    ...collectUserSettingsOptions(),
    fresh: $('freshRun')?.checked || false,
    browserMode: 'builtin',
    afterSubmitMs: 20000,
    maxClaims: null,
    dryRun: Boolean($('dryRun')?.checked),
    importHistory,
    ...buildHistoryOptions()
  };
}

function buildTrackingOnlyOptions() {
  return {
    fresh: $('freshTracking') ? $('freshTracking').checked : true,
    trackingApiEnvironment: $('trackingApiEnvironment')?.value || state.trackingApiEnvironment || 'test',
    trackingRequestDelayMs: Number.parseInt(getFieldValue('trackingRequestDelayMs') || '3100', 10),
    trackingResourceTimeoutMs: Number.parseInt(getFieldValue('trackingResourceTimeoutMs') || '45000', 10),
    developerMode: false
  };
}

function renderTrackingApiCredentialMetadata(metadata = {}) {
  const element = $('trackingApiCredentialMetadata');
  if (!element) return;
  element.textContent = trf('settings.api.metadata', {
    version: metadata.apiVersion || state.trackingApiVersion,
    clientId: tr(metadata.clientId?.present ? 'common.present' : 'common.missing'),
    clientSecret: tr(metadata.clientSecret?.present ? 'common.present' : 'common.missing'),
    selectedEnvironment: metadata.selectedEnvironment || 'test',
    credentialEnvironment: metadata.credentialEnvironment || tr('common.unknown', 'unknown'),
    scope: metadata.scope || 'merchant'
  }, 'Tracking API {version} — client ID: {clientId}; client secret: {clientSecret}; selected environment: {selectedEnvironment}; credential environment: {credentialEnvironment}; scope: {scope}. No lengths, values, hashes, or token metadata are displayed.');
}

function renderTrackingDiagnosticGate() {
  const element = $('trackingDiagnosticGate');
  if (element) element.textContent = trf(state.trackingDiagnosticGateSatisfied ? 'settings.api.gatePassed' : 'settings.api.gateRequired', {
    environment: state.trackingApiEnvironment,
    version: state.trackingApiVersion
  });
  if ($('runTrackingOnly')) $('runTrackingOnly').disabled = !state.trackingDiagnosticGateSatisfied;
}

function selectedClassificationRecords() {
  return step3QueueController.selectedRecords();
}

function updateClaimQueueCount() {
  const { selected, total, executable, blocked } = step3QueueController.snapshot();
  const pill = $('claimQueueCount');
  if (pill) {
    setLocalizedText(pill, 'step3.selectedExecutableCount', { selected, executable, blocked, total }, '{selected} selected · {executable} executable · {blocked} blocked · {total} total');
    pill.className = `pill ${selected > 0 ? 'good' : (executable > 0 ? 'warn' : 'bad')}`;
  }
  const runButton = $('runSubmitOnly');
  if (runButton) runButton.disabled = executable < 1 || state.isolatedTestMode === true;
}

function queueCell(text, className = '') {
  const cell = document.createElement('div');
  cell.className = className;
  cell.textContent = text || '—';
  return cell;
}

function deadlineLabel(item) {
  if (item.deadlineState === 'unverified_advisory') return tr('deadline.unverifiedAdvisory', 'Unverified advisory estimate — check current Canada Post policy');
  if (item.deadlineState === 'policy_review_required') return tr('deadline.policyReviewRequired', 'Policy data requires review');
  if (item.deadlineState === 'unavailable') return tr('deadline.unavailable', 'Deadline unavailable');
  if (item.deadlineState === 'expired') return tr('deadline.expired', 'Expired');
  if (Number(item.businessDaysRemaining) === 0) return tr('deadline.today', 'Deadline today');
  const key = item.deadlineState === 'urgent' ? 'deadline.urgent' : 'deadline.knownActive';
  return tr(key, '{days} business days remaining').replace('{days}', String(item.businessDaysRemaining));
}

function filteredClaimQueue(items = []) {
  return step3QueueController.visible({
    search: $('claimQueueSearch')?.value,
    service: $('claimQueueServiceFilter')?.value,
    urgency: $('claimQueueUrgencyFilter')?.value,
    dateFrom: $('claimQueueDateFrom')?.value,
    dateTo: $('claimQueueDateTo')?.value
  });
}

function executionStateLabel(item) {
  const labels = {
    executable: tr('step3.execution.executable', 'Executable'),
    submitted: tr('step3.execution.submitted', 'Already submitted'),
    already_submitted: tr('step3.execution.alreadySubmitted', 'Existing claim'),
    unresolved_attempt: tr('step3.execution.unresolved', 'Unresolved attempt'),
    terminal_failure: tr('step3.execution.terminal', 'Terminal outcome'),
    reconciliation_required: tr('step3.execution.reconciliation', 'Reconciliation required'),
    otherwise_blocked: tr('step3.execution.blocked', 'Blocked')
  };
  return labels[item.executionState] || labels.executable;
}

async function reviewBlockedAttempt(item) {
  if (!item?.trackingNumber) return;
  reconciliationFocusAttemptId = Number(item.attemptId || 0) || null;
  activateTab('historyTab');
  if ($('historySearch')) $('historySearch').value = item.trackingNumber;
  historyViewState.search = item.trackingNumber;
  historyViewState.page = 1;
  historyViewState.offset = 0;
  await refreshHistory().catch(error => console.error(error));
  const target = reconciliationFocusAttemptId
    ? document.querySelector(`#reconciliationList [data-attempt-id="${reconciliationFocusAttemptId}"]`)
    : null;
  (target || $('reconciliationList') || $('historyList'))?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
}

function renderClaimQueue(items = [], preserveState = false) {
  const list = $('claimQueueList');
  if (!list) return;
  list.textContent = '';
  if (!preserveState) {
    state.claimQueueItems = Array.isArray(items) ? items : [];
    step3QueueController.load(state.claimQueueItems);
  }
  state.claimQueueLoaded = true;
  const services = [...new Set(state.claimQueueItems.map(item => item.serviceCode).filter(Boolean))].sort();
  const serviceFilter = $('claimQueueServiceFilter');
  if (serviceFilter && !preserveState) {
    serviceFilter.textContent = '';
    for (const [value, label] of [['all', tr('step3.queue.allServices', 'All services')], ...services.map(value => [value, value])]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      serviceFilter.appendChild(option);
    }
  }
  const visibleItems = filteredClaimQueue(state.claimQueueItems);

  if (!visibleItems.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = state.claimQueueItems.length
      ? tr('step3.noFilterMatches', 'No late-delivery candidates match the current filters.')
      : tr('step3.noCandidates', 'No late-delivery candidates are available. Run Step 2, then refresh this queue.');
    list.appendChild(empty);
    updateClaimQueueCount();
    requestBuiltinBrowserLayout();
    return;
  }

  const header = document.createElement('div');
  header.className = 'claim-queue-row header';
  header.append(queueCell(tr('step3.queue.use', 'Use')), queueCell(tr('step3.queue.tracking', 'Tracking')), queueCell(tr('step3.queue.reference', 'Reference')), queueCell(tr('step3.queue.service', 'Service')), queueCell(tr('step3.queue.deliveryEvidence', 'First attempt / successful delivery')), queueCell(tr('step3.queue.deadline', 'Deadline')), queueCell(tr('step3.queue.policyReason', 'Policy / reason')));
  list.appendChild(header);

  for (const item of visibleItems) {
    const executable = step3QueueController.isExecutable(item);
    const row = document.createElement('div');
    row.className = `claim-queue-row${executable ? '' : ' blocked'}`;
    row.dataset.executionState = item.executionState || 'executable';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = executable && step3QueueController.isSelected(item.recordId);
    checkbox.disabled = !executable;
    checkbox.dataset.recordId = String(item.recordId);
    checkbox.setAttribute('aria-label', executable
      ? tr('step3.queue.includeAria', 'Include candidate {tracking}').replace('{tracking}', item.trackingNumber || '')
      : tr('step3.queue.blockedAria', 'Candidate {tracking} is blocked').replace('{tracking}', item.trackingNumber || ''));
    checkbox.addEventListener('change', () => { step3QueueController.set(item.recordId, checkbox.checked); updateClaimQueueCount(); });
    row.appendChild(checkbox);
    row.appendChild(queueCell(item.trackingNumber));
    row.appendChild(queueCell(item.referenceNumber));
    row.appendChild(queueCell(item.serviceCode));
    row.appendChild(queueCell([item.firstAttemptDate, item.deliveryDate].filter(Boolean).join(' / ')));
    row.appendChild(queueCell([item.deadline, deadlineLabel(item)].filter(Boolean).join(' · ')));

    const statusCell = document.createElement('div');
    statusCell.className = 'claim-queue-status';
    const status = document.createElement('span');
    status.className = `pill ${executable ? 'good' : 'bad'}`;
    status.textContent = executionStateLabel(item);
    const reason = document.createElement('span');
    reason.className = 'claim-queue-block-reason';
    reason.textContent = [item.policyVersion, item.eligibilityReason, item.blockedReason].filter(Boolean).join(' · ');
    statusCell.append(status, reason);
    if (!executable && (item.reconciliationRequired || ['unresolved_attempt', 'reconciliation_required'].includes(item.executionState))) {
      const review = document.createElement('button');
      review.type = 'button';
      review.className = 'secondary compact-button';
      review.textContent = tr('step3.queue.reviewAttempt', 'Review attempt');
      review.addEventListener('click', event => { event.preventDefault(); reviewBlockedAttempt(item); });
      statusCell.appendChild(review);
    }
    row.appendChild(statusCell);
    list.appendChild(row);
  }
  updateClaimQueueCount();
  if (!builtinBrowserRunActive) applyBuiltinBrowserDisplayState({ ok: true, visible: false, reason: 'run-inactive' });
  requestBuiltinBrowserLayout();
}

async function refreshClaimQueue() {
  const list = $('claimQueueList');
  if (list) list.innerHTML = `<div class="history-empty">${tr('step3.loadingCandidates', 'Loading late-delivery candidates…')}</div>`;
  const result = await window.cpApp.previewClaims();
  if (!result?.ok) {
    state.claimQueueItems = [];
    state.claimQueueLoaded = true;
    if (list) list.innerHTML = '';
    if (list) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = result?.error || tr('step3.loadFailed', 'Could not load the database candidate queue.');
      list.appendChild(empty);
    }
    updateClaimQueueCount();
    return result;
  }
  renderClaimQueue(result.items || []);
  return result;
}

function hideStep3ActionIssues() {
  state.step3ActionReport = null;
  $('step3ActionAdvisory')?.classList.add('hidden');
}

function showStep3ActionIssues(report = {}) {
  const advisory = $('step3ActionAdvisory');
  const target = $('step3ActionIssues');
  if (!advisory || !target) return;
  state.step3ActionReport = report;
  target.textContent = '';
  for (const item of (report.checks || []).filter(check => !check.ok && check.severity === 'blocking')) {
    const row = document.createElement('div');
    row.className = 'blocking-check-item';
    const label = document.createElement('strong'); label.textContent = tr(`step3.preflight.check.${item.id}.label`, item.label || item.id);
    const action = document.createElement('span'); action.textContent = tr(`step3.preflight.check.${item.id}.action`, item.action || '');
    row.append(label, action); target.appendChild(row);
  }
  const warningCount = Number(report.warningCount || 0);
  if ($('step3ActionWarningCount')) {
    if (warningCount) {
      setLocalizedText($('step3ActionWarningCount'), 'step3.preflight.warningCount', { count: warningCount }, '{count} advisory warning(s) remain.');
    } else {
      delete $('step3ActionWarningCount').dataset.i18nCurrent;
      delete $('step3ActionWarningCount').dataset.i18nValues;
      $('step3ActionWarningCount').textContent = '';
    }
  }
  advisory.classList.remove('hidden');
}

async function runStep3Preflight(submitOptions) {
  const result = await window.cpApp.runPreflight({
    scope: 'step3',
    submitOptions: submitOptions || collectUserSettingsOptions()
  });
  if (!result?.ok) return null;
  if (!result.report?.ready) showStep3ActionIssues(result.report);
  else hideStep3ActionIssues();
  return result.report;
}

let portalCompatibilityOverrideResolver = null;

function closePortalCompatibilityOverride(confirmed) {
  const modal = $('portalCompatibilityOverrideModal');
  modal?.classList.add('hidden');
  modal?.setAttribute('aria-hidden', 'true');
  const resolver = portalCompatibilityOverrideResolver;
  portalCompatibilityOverrideResolver = null;
  resolver?.(Boolean(confirmed));
}

function confirmPortalCompatibilityOverride() {
  const modal = $('portalCompatibilityOverrideModal');
  const status = $('portalCompatibilityOverrideStatus');
  if (!modal || !status) return Promise.resolve(false);
  const view = window.PortalAdvisory.describe(state.portalCompatibility);
  status.className = `pill ${view.kind}`;
  setLocalizedText(status, `step3.compatibility.status.${view.id}`, {}, view.id);
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  $('cancelPortalCompatibilityOverride')?.focus();
  return new Promise(resolve => { portalCompatibilityOverrideResolver = resolve; });
}

let liveSubmitResolver = null;

function closeLiveSubmitModal(confirmed) {
  const modal = $('liveSubmitModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }
  const acknowledge = $('liveSubmitAcknowledge');
  if (acknowledge) acknowledge.checked = false;
  const confirmButton = $('confirmLiveSubmit');
  if (confirmButton) confirmButton.disabled = true;
  const resolver = liveSubmitResolver;
  liveSubmitResolver = null;
  const canaryMode = confirmed ? Boolean($('liveSubmitCanary')?.checked) : false;
  resolver?.({ confirmed: Boolean(confirmed), canaryMode });
}

function confirmLiveSubmission(selectedCount) {
  const modal = $('liveSubmitModal');
  const summary = $('liveSubmitSummary');
  if (!modal || !summary) return Promise.resolve({ confirmed: false, canaryMode: false });
  if ($('liveSubmitCanary')) $('liveSubmitCanary').checked = true;
  summary.textContent = '';
  const lines = [
    trf('step3.confirm.selectedCount', { count: selectedCount }, 'Selected candidates: {count}'),
    tr('step3.confirm.browser'),
    tr('step3.confirm.dryRunOff')
  ];
  for (const text of lines) {
    const line = document.createElement('div');
    line.textContent = text;
    summary.appendChild(line);
  }
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  $('liveSubmitAcknowledge')?.focus();
  return new Promise(resolve => { liveSubmitResolver = resolve; });
}

function buildSubmitOnlyOptions({ liveSubmissionConfirmed = false, canaryMode = false, portalCompatibilityOverride = false } = {}) {

  return {
    ...collectUserSettingsOptions(),
    browserMode: 'builtin',
    afterSubmitMs: 20000,
    maxClaims: null,
    dryRun: Boolean($('dryRun')?.checked),
    selectedClassificationRecords: selectedClassificationRecords(),
    expectedClaimCount: selectedClassificationRecords().length,
    canaryMode: Boolean(canaryMode),
    liveSubmissionConfirmed: Boolean(liveSubmissionConfirmed),
    portalCompatibilityOverride: Boolean(portalCompatibilityOverride),
    developerMode: false
  };
}

async function startRun(importHistory = false) {
  currentProcessStep = importHistory ? 'step1' : 'step2';
  resetRunUi(currentProcessStep);
  setStatus('Running', 'warn', currentProcessStep);
  setActionLocalized(importHistory ? 'run.importAndStart' : 'run.starting', {}, importHistory ? 'Importing shipping history, then running tracking and claims.' : 'Starting tracking and claims run.', currentProcessStep);

  const res = await window.cpApp.startRun(buildRunOptions(importHistory));
  if (!res.ok) {
    finishBuiltinBrowserActivity(tr('step3.browser.startFailed', 'Could not start browser workflow'), 'error');
    setStatus('Failed', 'bad');
    setAction(res.error || tr('run.startFailed', 'Could not start run.'));
    updateCurrentItem({ step: 'Could not start run', result: res.error || 'Failed', kind: 'failed' });
    addNeedsReview('failed', '—', res.error || 'Could not start run', '—', '', {
      kind: 'failed',
      result: 'Start failed',
      status: 'Start failed',
      message: res.error || 'Could not start run'
    });
    log(res.error || 'Could not start run.');
    operations.finishedAt = Date.now();
    stopOperationsTimer();
    updateCounters();
    return;
  }

  log(importHistory ? 'Import + full run started.' : 'Run started.');
}

async function startTrackingOnly() {
  currentProcessStep = 'step2';
  resetRunUi('step2');
  setStatus('Running', 'warn', 'step2');
  setActionLocalized('step2.comparingAction', {}, 'Comparing successful-delivery dates with original Delivery Standards and recording late-delivery candidates.', 'step2');

  const res = await window.cpApp.runTracking(buildTrackingOnlyOptions());
  if (!res.ok) {
    setStatus('Failed', 'bad');
    setActionLocalized('step2.startFailed', {}, 'Could not start tracking check.', 'step2');
    updateCurrentItem({ step: 'Could not start tracking check', result: res.error || 'Failed', kind: 'failed' });
    addNeedsReview('failed', '—', res.error || 'Could not start tracking check', '—', '', {
      kind: 'failed',
      result: 'Tracking start failed',
      status: 'Tracking start failed',
      message: res.error || 'Could not start tracking check'
    });
    log(tr('step2.startFailed', 'Could not start tracking check.'), 'log-submit-error', 'step2');
    operations.finishedAt = Date.now();
    stopOperationsTimer();
    updateCounters();
    return;
  }

  log(tr('step2.started', 'Tracking check started.'), '', 'step2');
}

let trackingDiagnosticResolver = null;

function closeTrackingDiagnosticModal(row = null) {
  $('trackingDiagnosticModal')?.classList.add('hidden');
  $('trackingDiagnosticModal')?.setAttribute('aria-hidden', 'true');
  const resolver = trackingDiagnosticResolver;
  trackingDiagnosticResolver = null;
  resolver?.(row);
}

function confirmTrackingDiagnosticRow() {
  const raw = String($('trackingDiagnosticRow')?.value || '');
  const row = Number(raw);
  const error = $('trackingDiagnosticError');
  if (!Number.isSafeInteger(row) || row < 1) {
    if (error) { error.textContent = tr('step2.diagnostic.invalidRow', 'Choose a valid tracking CSV row.'); error.classList.remove('hidden'); }
    return;
  }
  closeTrackingDiagnosticModal(row);
}

async function requestTrackingDiagnosticRow() {
  const modal = $('trackingDiagnosticModal');
  if (!modal) return null;
  const defaults = await window.cpApp.getTrackingDiagnosticDefaultRow();
  if (!defaults?.ok) {
    window.alert(tr('step2.diagnostic.noUsableRow', 'No usable tracking row is available.'));
    return null;
  }
  if ($('trackingDiagnosticRow')) $('trackingDiagnosticRow').value = String(defaults.row);
  $('trackingDiagnosticError')?.classList.add('hidden');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  $('trackingDiagnosticRow')?.focus();
  return new Promise(resolve => { trackingDiagnosticResolver = resolve; });
}

async function runTrackingDiagnostic({ structureExport = false } = {}) {
  const diagnosticRow = await requestTrackingDiagnosticRow();
  if (!diagnosticRow) return;
  currentProcessStep = 'step2';
  setStatus(structureExport ? 'Structural diagnostic running' : 'Diagnostic running', 'warn', 'step2');
  setActionLocalized(structureExport ? 'step2.diagnostic.structureAction' : 'step2.diagnostic.connectionAction', {}, structureExport ? 'Generating a value-free structural report from one authorized Tracking API response.' : 'Testing the selected Developer Portal Tracking API environment with one authorized shipment.', 'step2');
  if (!structureExport) log(tr('step2.diagnostic.confirmedLog', 'One-request OAuth/JSON diagnostic deliberately confirmed. Configuration, token, resource, and state-integrity stages will be reported without secrets.'), '', 'step2');
  const res = await window.cpApp.runTracking({
    ...buildTrackingOnlyOptions(),
    fresh: false,
    diagnosticMode: true,
    diagnosticConfirmed: true,
    structureExport,
    diagnosticRow
  });
  if (!res.ok) {
    setStatus(structureExport ? 'Structural diagnostic blocked' : 'Diagnostic blocked', 'bad', 'step2');
    const failureKey = structureExport ? 'step2.diagnostic.structureStartFailed' : 'step2.diagnostic.startFailed';
    const failureFallback = structureExport ? 'Could not start sanitized structural diagnostic.' : 'Could not start one-request API diagnostic.';
    setActionLocalized(failureKey, {}, failureFallback, 'step2');
    log(tr(failureKey, failureFallback), 'log-submit-error', 'step2');
  }
}

async function testTrackingConnection() { return runTrackingDiagnostic({ structureExport: false }); }

async function exportTrackingStructure() { return runTrackingDiagnostic({ structureExport: true }); }

async function discardIncompleteTracking() {
  const confirmed = window.confirm(tr('step2.discardConfirm', 'Discard the active incomplete Step 2 staging state? Historical completed runs will be preserved.'));
  if (!confirmed) return;
  const result = await window.cpApp.discardIncompleteTracking({ confirmed: true });
  if (!result.ok) return window.alert(tr('step2.discardFailed', 'Could not discard incomplete Step 2 state.'));
  setLocalizedText($('step2RunStatus'), 'step2.discardedStatus', {}, 'Incomplete run discarded');
  $('step2RunStatus').className = 'pill';
  if (result.messageKey) setActionLocalized(result.messageKey, result.messageValues || {}, result.message || '', 'step2');
  else setActionLocalized('step2.discarded', {}, 'Incomplete Step 2 staging was discarded; completed history was preserved.', 'step2');
  await refreshClaimQueue();
}

async function startSubmitOnly() {
  currentProcessStep = 'step3';
  hideStep3ActionIssues();
  if (!state.claimQueueLoaded) await refreshClaimQueue();
  const selected = selectedClassificationRecords();
  const dryRun = Boolean($('dryRun')?.checked);
  const basePreflightOptions = {
    ...collectUserSettingsOptions(),
    browserMode: 'builtin',
    selectedClassificationRecords: selected,
    expectedClaimCount: selected.length,
    canaryMode: false,
    liveSubmissionConfirmed: false
  };
  const preliminaryPreflight = await runStep3Preflight({ ...basePreflightOptions, dryRun: true });
  if (!preliminaryPreflight?.ready) {
    setStatus('Blocked', 'bad', 'step3');
    setActionLocalized('step3.preflightBlockedAction', {}, 'Step 3 preflight found blocking issues. Resolve them before running claims.', 'step3');
    log(tr('step3.preflightBlockedAction', 'Step 3 preflight found blocking issues. Resolve them before running claims.'), 'log-submit-error', 'step3');
    return;
  }
  if (!selected.length) {
    setStatus('Blocked', 'bad', 'step3');
    setActionLocalized('step3.zeroSelection', {}, 'No late-delivery candidates are selected in the Step 3 candidate queue.', 'step3');
    log(tr('step3.zeroSelectionRecovery', 'Select at least one late-delivery candidate before starting a dry or live run.'), 'log-submit-error', 'step3');
    return;
  }
  let portalCompatibilityOverride = false;
  if (!dryRun) {
    await refreshPortalCompatibilityStatus();
    if (window.PortalAdvisory.describe(state.portalCompatibility).requiresOverride) {
      portalCompatibilityOverride = await confirmPortalCompatibilityOverride();
      if (!portalCompatibilityOverride) {
        setStatus('Cancelled', '', 'step3');
        setActionLocalized('step3.liveCancelledAction', {}, 'Live submission cancelled before the browser workflow started.', 'step3');
        log(tr('step3.liveCancelledAction', 'Live submission cancelled before the browser workflow started.'), 'log-warning', 'step3');
        return;
      }
      state.portalCompatibilityWarningDismissed = false;
      renderPortalCompatibilityAdvisory();
      log(tr('step3.compatibility.override.risk', 'This may fail because the Canada Post portal has not been verified in this session.'), 'log-warning', 'step3');
    } else {
      setActionLocalized('step3.portalValidation.passed', { code: 'HEALTHY' }, 'Step 3 portal compatibility validation passed ({code}).', 'step3');
    }
  }
  const preflight = dryRun ? preliminaryPreflight : await runStep3Preflight({
    ...basePreflightOptions,
    dryRun: false,
    portalCompatibilityOverride
  });
  if (!preflight?.ready) {
    setStatus('Blocked', 'bad', 'step3');
    setActionLocalized('step3.preflightBlockedAction', {}, 'Step 3 preflight found blocking issues. Resolve them before running claims.', 'step3');
    log(tr('step3.preflightBlockedAction', 'Step 3 preflight found blocking issues. Resolve them before running claims.'), 'log-submit-error', 'step3');
    return;
  }
  let liveSubmissionConfirmed = false;
  let canaryMode = false;
  if (!dryRun) {
    const confirmation = await confirmLiveSubmission(selected.length);
    liveSubmissionConfirmed = confirmation.confirmed;
    canaryMode = confirmation.canaryMode;
    if (!confirmation.confirmed) {
      setStatus('Cancelled', '', 'step3');
      setActionLocalized('step3.liveCancelledAction', {}, 'Live submission cancelled before the browser workflow started.', 'step3');
      log('Live submission cancelled.', 'log-warning', 'step3');
      return;
    }
  }

  resetRunUi('step3');
  await deactivateBuiltinBrowser('validating-selection', tr('step3.browser.validating', 'Validating the selected executable claims…'), 'step3.browser.validating');
  setStatus('Validating', 'warn', 'step3');
  setBuiltinBrowserStatus(tr('step3.browser.idleStatus', 'Browser idle'), '');
  setAction(dryRun
    ? trf('step3.dryRunStarting', { count: selected.length })
    : (canaryMode ? tr('step3.confirm.modeCanary') : trf('step3.liveRunStarting', { count: selected.length })), 'step3');

  // The main process validates attempt state and creates an immutable snapshot
  // before it creates, attaches, or navigates the native browser.
  const res = await window.cpApp.runSubmit(buildSubmitOnlyOptions({ liveSubmissionConfirmed, canaryMode, portalCompatibilityOverride }));
  if (!res.ok) {
    if (res.code === 'STEP3_PREFLIGHT_BLOCKED' && res.preflight) {
      showStep3ActionIssues({
        checks: (res.preflight.failedChecks || []).map(item => ({ ...item, ok: false, severity: 'blocking' })),
        warningCount: res.preflight.warningCount
      });
    }
    setStatus('Failed', 'bad');
    setAction(res.error || tr('step3.startFailed', 'Could not start claim submission.'));
    updateCurrentItem({ step: 'Could not start claim submission', result: res.error || 'Failed', kind: 'failed' });
    addNeedsReview('failed', '—', res.error || 'Could not start claim submission', '—', '', {
      kind: 'failed',
      result: 'Submission start failed',
      status: 'Submission start failed',
      message: res.error || 'Could not start claim submission'
    });
    log(res.error || 'Could not start claim submission.');
    const blockedPlaceholder = ['STEP3_UNRESOLVED_ATTEMPT', 'STEP3_TERMINAL_OUTCOME', 'STEP3_NO_EXECUTABLE_CLAIMS'].includes(res.code)
      ? { key: 'step3.browser.noExecutableSelected', fallback: 'No executable claims are selected. Review blocked attempts in History.' }
      : idleBrowserPlaceholderLocalization();
    await deactivateBuiltinBrowser('submission-not-started', tr(blockedPlaceholder.key, blockedPlaceholder.fallback), blockedPlaceholder.key);
    await refreshClaimQueue().catch(() => {});
    operations.finishedAt = Date.now();
    stopOperationsTimer();
    updateCounters();
    return;
  }

  log(dryRun
    ? `Dry run started for ${res.selectedClaimCount || selected.length} selected claim(s). The runner will stop on the sender/contact page.`
    : (canaryMode ? 'Canary live run started. Only the first selected claim will be processed.' : `Live claim submission started for ${res.selectedClaimCount || selected.length} selected claim(s).`));
  if (builtinBrowserRunActive) await resizeBuiltinBrowserToSlot('submission-worker-started');
}

async function refreshConfig() {
  const cfg = await window.cpApp.loadConfig();
  state.isolatedTestMode = cfg.isolatedTestMode === true;
  const isolatedBanner = $('isolatedTestBanner');
  if (isolatedBanner) isolatedBanner.hidden = !state.isolatedTestMode;
  if ($('isolatedTestPath')) $('isolatedTestPath').textContent = state.isolatedTestMode ? String(cfg.isolatedUserDataPath || '') : '';
  if (state.isolatedTestMode) document.title = tr('app.isolatedTitle', 'Canada Post Claim Runner [ISOLATED TEST DATA]');
  for (const id of ['runSubmitOnly', 'checkForUpdates', 'createBackup', 'restoreBackup', 'createDiagnostics', 'exportHistory']) {
    const control = $(id);
    if (!control) continue;
    control.disabled = state.isolatedTestMode;
    if (state.isolatedTestMode) control.title = tr('app.isolatedDisabledTitle', 'Disabled while isolated test data is active.');
  }
  state.passwordStored = !!cfg.passwordStored;
  state.trackingApiCredentialsStored = !!(cfg.trackingApiCredentialsStored || cfg.hasTrackingApiCredentials);
  state.trackingApiEnvironment = cfg.trackingApiEnvironment || 'test';
  state.trackingDiagnosticGateSatisfied = !!cfg.trackingDiagnosticGateSatisfied;
  state.trackingApiVersion = cfg.trackingApiVersion || '1.0.0';
  state.portalCompatibility = cfg.portalCompatibility || { ok: false, code: 'PORTAL_COMPATIBILITY_REQUIRED' };
  if ($('trackingRequestDelayMs')) $('trackingRequestDelayMs').value = String(Math.max(3100, Number(cfg.trackingRequestDelayMs || 3100)));
  if ($('trackingResourceTimeoutMs')) $('trackingResourceTimeoutMs').value = String(cfg.trackingResourceTimeoutMs || 45000);
  await applyLocale(preferredLocale || cfg.locale || 'en-CA');
  if (state.isolatedTestMode) document.title = tr('app.isolatedTitle', 'Canada Post Claim Runner [ISOLATED TEST DATA]');
  if ($('webUsername')) $('webUsername').value = cfg.webUsername || '';
  if ($('webPassword')) {
    $('webPassword').value = '';
    $('webPassword').placeholder = tr(state.passwordStored ? 'settings.website.passwordSavedPlaceholder' : 'settings.website.passwordPlaceholder');
  }
  if ($('trackingClientId')) { $('trackingClientId').value = ''; $('trackingClientId').placeholder = tr(state.trackingApiCredentialsStored ? 'settings.api.clientIdSavedPlaceholder' : 'settings.api.clientIdPlaceholder'); }
  if ($('trackingClientSecret')) { $('trackingClientSecret').value = ''; $('trackingClientSecret').placeholder = tr(state.trackingApiCredentialsStored ? 'settings.api.clientSecretSavedPlaceholder' : 'settings.api.clientSecretPlaceholder'); }
  if ($('trackingApiEnvironment')) $('trackingApiEnvironment').value = state.trackingApiEnvironment;
  renderTrackingApiCredentialMetadata(cfg.trackingApiCredentialMetadata || {});
  renderTrackingDiagnosticGate();
  if ($('rememberSettings')) $('rememberSettings').checked = Object.prototype.hasOwnProperty.call(cfg, 'rememberSettings') ? !!cfg.rememberSettings : true;

  if ($('historyFrom') && !$('historyFrom').value) $('historyFrom').value = cfg.historyFrom || isoDateFromOffset(-14);
  if ($('historyTo') && !$('historyTo').value) $('historyTo').value = cfg.historyTo || isoDateFromOffset(0);

  if ($('estFrom') && !$('estFrom').value) $('estFrom').value = cfg.estFrom || cfg.historyFrom || isoDateFromOffset(-14);
  if ($('estTo') && !$('estTo').value) $('estTo').value = cfg.estTo || cfg.historyTo || isoDateFromOffset(0);
  if ($('estCustomerNumber') && !$('estCustomerNumber').value) $('estCustomerNumber').value = cfg.estCustomerNumber || cfg.historyCustomerNumber || cfg.customerNumber || '';
  if ($('estWorkgroup')) $('estWorkgroup').value = '';
  if ($('estMobo')) $('estMobo').value = '-2';
  if ($('estCategoryGroup')) $('estCategoryGroup').value = 'SHP';
  if ($('estFileTypes')) $('estFileTypes').value = '1,2';

  if ($('claimStreetNumber')) $('claimStreetNumber').value = cfg.claimStreetNumber || '';
  if ($('claimStreetName')) $('claimStreetName').value = cfg.claimStreetName || '';
  if ($('claimAddressLine2')) $('claimAddressLine2').value = cfg.claimAddressLine2 || '';
  if ($('claimCity')) $('claimCity').value = cfg.claimCity || '';
  if ($('claimProvince')) $('claimProvince').value = cfg.claimProvince || '';
  if ($('claimPostalCode')) $('claimPostalCode').value = cfg.claimPostalCode || '';
  if ($('claimBusinessName')) $('claimBusinessName').value = cfg.claimBusinessName || '';
  if ($('claimContactName')) $('claimContactName').value = cfg.claimContactName || '';
  if ($('claimContactPhone')) $('claimContactPhone').value = cfg.claimContactPhone || '';
  if ($('claimContactEmail')) $('claimContactEmail').value = cfg.claimContactEmail || '';
  state.evidenceRetentionDays = Math.max(7, Math.min(3650, Number(cfg.evidenceRetentionDays || 90)));
  state.dryRunDefault = Object.prototype.hasOwnProperty.call(cfg, 'dryRunDefault') ? Boolean(cfg.dryRunDefault) : true;
  if ($('evidenceRetentionDays')) $('evidenceRetentionDays').value = String(state.evidenceRetentionDays);
  if ($('dryRunDefault')) $('dryRunDefault').checked = state.dryRunDefault;
  if ($('dryRun')) $('dryRun').checked = state.dryRunDefault;
  if ($('appVersion')) $('appVersion').textContent = cfg.appVersion || '0.4.0-beta.1';
  if ($('buildTrustStatus')) {
    setLocalizedText($('buildTrustStatus'), cfg.signedBuild ? 'build.signed' : 'build.unsigned', {}, cfg.signedBuild ? 'Production-signed build' : 'Unsigned development build');
    $('buildTrustStatus').className = cfg.signedBuild ? 'pill good' : 'pill warn';
  }
  updateReconciliationCount(Number(cfg.reconciliationCount || 0));

  const configuredCustomer = cfg.estCustomerNumber || cfg.historyCustomerNumber || cfg.customerNumber || '';
  if ($('historyCustomerNumber')) $('historyCustomerNumber').value = configuredCustomer;
  if ($('historyAutoMobo')) $('historyAutoMobo').checked = true;
  if ($('historyMobo')) $('historyMobo').value = '';
  if ($('historyIncludeNoManifest')) $('historyIncludeNoManifest').checked = true;
  state.developerMode = false;

  const status = $('settingsStatus');
  if (status) {
    const webStatus = state.passwordStored
      ? (cfg.secureCredentialStorage ? tr('settings.status.webOsEncrypted') : tr('settings.status.webLocalEncrypted'))
      : tr('settings.status.webNotSaved');
    const apiStatus = state.trackingApiCredentialsStored ? (state.trackingDiagnosticGateSatisfied ? tr('settings.status.apiReady') : tr('settings.status.apiDiagnostic')) : tr('settings.status.apiMissing');
    status.textContent = trf('settings.status.loaded', { webStatus, apiStatus, backend: cfg.credentialBackend ? ` (${cfg.credentialBackend})` : '' }, 'Loaded / {webStatus} / {apiStatus}{backend}');
    status.className = state.passwordStored
      ? (cfg.secureCredentialStorage ? 'pill good' : 'pill warn')
      : (state.trackingApiCredentialsStored ? 'pill warn' : 'pill bad');
    if (cfg.updateRecovery?.pending) {
      status.textContent = tr('update.recovery.message', 'A pending update was interrupted. The pre-update backup and previous executable or installer were preserved.');
      status.className = 'pill warn';
    }
  }
  renderPortalCompatibilityAdvisory();
  $('resumeSetup')?.classList.toggle('hidden', Boolean(cfg.setupCompleted));
}

function showSetupWizard(config) {
  const acknowledgement = $('setupSafetyAcknowledge');
  if (acknowledgement) acknowledgement.checked = config.setupSafetyAcknowledged === true;
  renderSetupWizardReadiness(config);
  $('setupWizard').classList.remove('hidden');
  $('setupWizard').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('setupOpenSettings')?.focus(), 0);
}

function renderSetupWizardReadiness(config) {
  const readiness = {
    ...(config.setupReadiness || {}),
    safetyAcknowledged: $('setupSafetyAcknowledge')?.checked === true
  };
  const labels = Object.fromEntries(window.Onboarding.STEPS.map(step => [step.id, [
    tr(`setup.step.${step.id}.title`, step.id), tr(`setup.step.${step.id}.detail`, '')
  ]]));
  const summary = window.Onboarding.readinessSummary(readiness);
  const rows = summary.steps.map(step => {
    const [title, detail] = labels[step.id];
    const ready = step.ready === true;
    const advisory = step.ready === null;
    const status = advisory ? tr('status.manualGate', 'Manual gate') : (ready ? tr('status.ready', 'Ready') : tr('status.setupRequired', 'Setup required'));
    return `<div class="preflight-item ${ready ? 'pass' : 'warning'}"><div class="preflight-icon" aria-hidden="true">${ready ? '✓' : '!'}</div><div><strong>${title}</strong><span>${detail} ${status}.</span></div></div>`;
  });
  $('setupReadinessList').innerHTML = rows.join('');
  $('setupFinish').disabled = !summary.ready;
  $('setupFinish').title = summary.ready ? '' : trf('setup.blockingCount', { count: summary.blockingCount }, '{count} setup area(s) still require attention.');
}

async function finishSetupWizard() {
  const cfg = await window.cpApp.loadConfig();
  const acknowledged = $('setupSafetyAcknowledge')?.checked === true;
  const summary = window.Onboarding.readinessSummary({ ...(cfg.setupReadiness || {}), safetyAcknowledged: acknowledged });
  if (!summary.ready) {
    renderSetupWizardReadiness(cfg);
    return;
  }
  const saved = await window.cpApp.saveConfig({ setupCompleted: true, setupSafetyAcknowledged: true });
  if (!saved?.ok) {
    setAction(saved?.error || tr('setup.completeFailed', 'Setup could not be completed.'), 'settingsTab');
    return;
  }
  $('setupWizard')?.classList.add('hidden');
  $('setupWizard')?.setAttribute('aria-hidden', 'true');
  setAction(tr('setup.completed', 'Setup recorded. Tracking and dry-run readiness still depend on the checks shown in Settings.'), 'settingsTab');
}


$('saveUserSettings')?.addEventListener('click', async () => {
  await saveUserSettings(true);
});

$('selectCsv')?.addEventListener('click', async () => {
  const res = await window.cpApp.selectTrackingCsv();
  if (res.ok) log(tr('settings.trackingCsvSelected', 'tracking.csv selected.'));
  await refreshConfig();
});

$('openData')?.addEventListener('click', () => window.cpApp.openDataFolder());
$('openLogs')?.addEventListener('click', () => window.cpApp.openLogsFolder());
$('openStep3Diagnostics')?.addEventListener('click', async () => {
  const result = await window.cpApp.openStep3Diagnostics();
  if (!result?.ok) log(result?.error || tr('diagnostics.noneAvailable', 'No Step 3 diagnostics are available yet.'), 'log-warning', 'step3');
});
$('refreshHistory')?.addEventListener('click', () => refreshHistory());
$('clearHistoryFilters')?.addEventListener('click', clearHistoryFilters);
$('historyStatusFilter')?.addEventListener('change', () => {
  historyViewState.page = HISTORY_DEFAULT_FILTERS.page;
  historyViewState.offset = HISTORY_DEFAULT_FILTERS.offset;
  updateClearHistoryFiltersButton();
  refreshHistory();
});
let historySearchTimer = null;
$('historySearch')?.addEventListener('input', () => {
  clearTimeout(historySearchTimer);
  historyViewState.page = HISTORY_DEFAULT_FILTERS.page;
  historyViewState.offset = HISTORY_DEFAULT_FILTERS.offset;
  updateClearHistoryFiltersButton();
  historySearchTimer = setTimeout(() => refreshHistory(), 250);
});
$('exportHistory')?.addEventListener('click', exportClaimHistory);
$('createBackup')?.addEventListener('click', createAppBackup);
$('restoreBackup')?.addEventListener('click', restoreAppBackup);
$('manageStoredData')?.addEventListener('click', openPrivacyDataModal);
$('closePrivacyDataModal')?.addEventListener('click', closePrivacyDataModal);
$('privacyDataModal')?.addEventListener('click', event => { if (event.target === $('privacyDataModal')) closePrivacyDataModal(); });
$('previewPrivacyData')?.addEventListener('click', previewPrivacyData);
$('deletePrivacyData')?.addEventListener('click', deletePrivacyData);
for (const id of ['privacyTrackingNumbers', 'privacyDateFrom', 'privacyDateTo', 'privacyAllRecords']) {
  $(id)?.addEventListener('change', resetPrivacyPreview);
  if (id === 'privacyTrackingNumbers') $(id)?.addEventListener('input', resetPrivacyPreview);
}
$('refreshBrowserSession')?.addEventListener('click', refreshBrowserSessionStatus);
$('checkStep3BrowserSession')?.addEventListener('click', refreshBrowserSessionStatus);
$('clearBrowserSession')?.addEventListener('click', clearBrowserSession);
$('refreshPortalCompatibility')?.addEventListener('click', () => refreshPortalCompatibilityStatus({ runCheck: true }));
$('openSettingsFromPortalAdvisory')?.addEventListener('click', () => activateTab('settingsTab'));
$('dismissPortalCompatibility')?.addEventListener('click', dismissPortalCompatibilityWarning);
$('cancelPortalCompatibilityOverride')?.addEventListener('click', () => closePortalCompatibilityOverride(false));
$('continuePortalCompatibilityOverride')?.addEventListener('click', () => closePortalCompatibilityOverride(true));
$('cancelTrackingDiagnostic')?.addEventListener('click', () => closeTrackingDiagnosticModal(null));
$('confirmTrackingDiagnostic')?.addEventListener('click', confirmTrackingDiagnosticRow);
$('trackingDiagnosticRow')?.addEventListener('keydown', event => { if (event.key === 'Enter') confirmTrackingDiagnosticRow(); });
$('cancelBackupPassword')?.addEventListener('click', () => closeBackupPasswordModal(''));
$('confirmBackupPassword')?.addEventListener('click', submitBackupPassword);
$('backupPassword')?.addEventListener('keydown', event => { if (event.key === 'Enter') submitBackupPassword(); if (event.key === 'Escape') closeBackupPasswordModal(''); });
$('setupOpenSettings')?.addEventListener('click', () => { $('setupWizard')?.classList.add('hidden'); $('setupWizard')?.setAttribute('aria-hidden', 'true'); activateTab('settingsTab'); $('webUsername')?.focus(); });
$('setupLater')?.addEventListener('click', () => { $('setupWizard')?.classList.add('hidden'); $('setupWizard')?.setAttribute('aria-hidden', 'true'); });
$('resumeSetup')?.addEventListener('click', async () => showSetupWizard(await window.cpApp.loadConfig()));
$('setupFinish')?.addEventListener('click', finishSetupWizard);
$('setupSafetyAcknowledge')?.addEventListener('change', async () => renderSetupWizardReadiness(await window.cpApp.loadConfig()));
$('createDiagnostics')?.addEventListener('click', createDiagnosticZip);
$('cancelSupportBundle')?.addEventListener('click', closeSupportBundle);
$('confirmSupportBundle')?.addEventListener('click', confirmSupportBundle);
$('supportBundleAcknowledge')?.addEventListener('change', () => { $('confirmSupportBundle').disabled = !$('supportBundleAcknowledge').checked; });
$('addManualShipment')?.addEventListener('click', addManualShipment);
$('checkForUpdates')?.addEventListener('click', async () => {
  const res = await window.cpApp.openUpdatePage();
  const message = res?.message || res?.error || tr(res?.ok ? 'update.pageOpenedMessage' : 'update.pageOpenFailedMessage', res?.ok ? 'Opened update page.' : 'Could not open update page.');
  const status = $('settingsStatus');
  if (status) {
    setLocalizedText(status, res?.ok ? 'update.pageOpened' : 'update.urlMissing', {}, res?.ok ? 'Update page opened' : 'Update URL not configured');
    status.className = res?.ok ? 'pill good' : 'pill bad';
  }
  log(message, res?.ok ? '' : 'log-late', 'step1');
});
$('fullRefresh')?.addEventListener('click', () => {
  resetAllUiState();
  window.location.reload();
});
$('developerMode')?.addEventListener('change', async () => {
  state.developerMode = $('developerMode').checked;
  await window.cpApp.saveConfig({ developerMode: state.developerMode });
  log(state.developerMode
    ? tr('settings.developer.enabledLog', 'Developer mode enabled. New runs will show raw Canada Post API logs in the live log. Credentials are redacted.')
    : tr('settings.developer.disabledLog', 'Developer mode disabled. New runs will show normal summarized logs.'));
});

$('historyAutoMobo')?.addEventListener('change', async () => {
  const autoMobo = $('historyAutoMobo').checked;
  if ($('historyMobo')) {
    $('historyMobo').disabled = autoMobo;
    if (autoMobo) $('historyMobo').value = '';
  }
  await window.cpApp.saveConfig({ historyAutoMobo: autoMobo, historyMobo: autoMobo ? '' : (($('historyMobo')?.value || '').trim()) });
  log(autoMobo
    ? tr('settings.mobo.autoEnabledLog', 'MOBO auto-discovery enabled. The manual MOBO field will be ignored on the next history import.')
    : tr('settings.mobo.autoDisabledLog', 'MOBO auto-discovery disabled. The manual MOBO field will be used on the next history import.'));
});

$('backToOperations')?.addEventListener('click', showOperationsList);
$('openScreenshot')?.addEventListener('click', async () => {
  if (!selectedDetail?.screenshotPath) return;
  const res = await window.cpApp.openEvidence(selectedDetail.screenshotPath);
  if (!res.ok) log(res.error || tr('results.screenshotOpenFailed', 'Could not open screenshot.'));
});

$('step1WarningsCard')?.addEventListener('click', openStep1Warnings);
$('step1WarningsCard')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openStep1Warnings();
  }
});
$('closeWarningModal')?.addEventListener('click', closeStep1Warnings);
$('warningModal')?.addEventListener('click', (event) => {
  if (event.target === $('warningModal')) closeStep1Warnings();
});
document.addEventListener('keydown', (event) => {
  const modal = [...document.querySelectorAll('.modal-backdrop:not(.hidden)')].at(-1);
  if (!modal) return;
  if (event.key === 'Escape') {
    if (modal.id === 'warningModal') closeStep1Warnings();
    else if (modal.id === 'backupPasswordModal') closeBackupPasswordModal('');
    else if (modal.id === 'portalCompatibilityOverrideModal') closePortalCompatibilityOverride(false);
    else if (modal.id === 'liveSubmitModal') closeLiveSubmitModal(false);
    else if (modal.id === 'trackingDiagnosticModal') closeTrackingDiagnosticModal(null);
    else if (modal.id === 'privacyDataModal') closePrivacyDataModal();
    event.preventDefault();
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = [...modal.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')]
    .filter(control => !control.disabled && control.getClientRects().length > 0);
  if (!controls.length) return;
  const first = controls[0]; const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
  else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
});

$('importEstHistory')?.addEventListener('click', async () => {
  currentProcessStep = 'step1';
  resetRunUi('step1');
  const missing = validateSettingsForStep('step1');
  if (missing.length) {
    setStatus('Failed', 'bad', 'step1');
    const missingMessage = trf('step1.missingSettings', { settings: missing.join(', ') }, 'Missing settings: {settings}. Open User Settings.');
    setActionLocalized('step1.missingSettings', { settings: missing.join(', ') }, 'Missing settings: {settings}. Open User Settings.', 'step1');
    log(missingMessage, 'log-late', 'step1');
    return;
  }
  setStatus('Running', 'warn', 'step1');
  setActionLocalized('step1.exportStarting', {}, 'Exporting EST Desktop history and generating tracking.csv.', 'step1');

  const res = await window.cpApp.importEstHistory(buildEstHistoryOptions());
  if (!res.ok) {
    setStatus('Failed', 'bad');
    setActionLocalized('step1.exportStartFailed', {}, 'Could not start EST Desktop history export.', 'step1');
    log(tr('step1.exportStartFailed', 'Could not start EST Desktop history export.'), 'log-submit-error', 'step1');
    operations.finishedAt = Date.now();
    stopOperationsTimer();
    updateCounters();
    return;
  }

  log(tr('step1.exportStarted', 'EST Desktop history export started.'));
});

$('importHistory')?.addEventListener('click', async () => {
  resetRunUi();
  setStatus('Running', 'warn');
  setActionLocalized('step1.historyImportStarting', {}, 'Importing shipping history into tracking.csv.', 'step1');

  const res = await window.cpApp.importHistory(buildHistoryOptions());
  if (!res.ok) {
    setStatus('Failed', 'bad');
    setActionLocalized('step1.historyStartFailed', {}, 'Could not start history import.', 'step1');
    log(tr('step1.historyStartFailed', 'Could not start history import.'), 'log-submit-error', 'step1');
    operations.finishedAt = Date.now();
    stopOperationsTimer();
    updateCounters();
    return;
  }

  log(tr('step1.historyStarted', 'Shipping history import started.'));
});

$('importAndStart')?.addEventListener('click', () => startRun(true));
$('start')?.addEventListener('click', () => startRun(false));
$('runTrackingOnly')?.addEventListener('click', startTrackingOnly);
$('testTrackingConnection')?.addEventListener('click', testTrackingConnection);
$('exportTrackingStructure')?.addEventListener('click', exportTrackingStructure);
$('discardIncompleteTracking')?.addEventListener('click', discardIncompleteTracking);
$('clearTrackingApiCredentials')?.addEventListener('click', clearTrackingApiCredentials);
$('trackingApiEnvironment')?.addEventListener('change', () => { state.trackingApiEnvironment = $('trackingApiEnvironment').value; state.trackingDiagnosticGateSatisfied = false; renderTrackingDiagnosticGate(); });
for (const id of ['trackingClientId', 'trackingClientSecret']) $(id)?.addEventListener('input', () => { if ($(id).value) { state.trackingDiagnosticGateSatisfied = false; renderTrackingDiagnosticGate(); } });
$('builtinBrowser')?.addEventListener('change', requestBuiltinBrowserLayout);
$('runSubmitOnly')?.addEventListener('click', startSubmitOnly);
$('refreshClaimQueue')?.addEventListener('click', refreshClaimQueue);
$('selectAllClaims')?.addEventListener('click', () => {
  step3QueueController.selectVisible({
    search: $('claimQueueSearch')?.value,
    service: $('claimQueueServiceFilter')?.value,
    urgency: $('claimQueueUrgencyFilter')?.value,
    dateFrom: $('claimQueueDateFrom')?.value,
    dateTo: $('claimQueueDateTo')?.value
  });
  renderClaimQueue(state.claimQueueItems, true);
});
$('clearClaimSelection')?.addEventListener('click', () => { step3QueueController.clear(); renderClaimQueue(state.claimQueueItems, true); });
$('claimQueueSearch')?.addEventListener('input', () => renderClaimQueue(state.claimQueueItems, true));
$('claimQueueServiceFilter')?.addEventListener('change', () => renderClaimQueue(state.claimQueueItems, true));
$('claimQueueUrgencyFilter')?.addEventListener('change', () => renderClaimQueue(state.claimQueueItems, true));
$('claimQueueDateFrom')?.addEventListener('change', () => renderClaimQueue(state.claimQueueItems, true));
$('claimQueueDateTo')?.addEventListener('change', () => renderClaimQueue(state.claimQueueItems, true));
$('liveSubmitAcknowledge')?.addEventListener('change', () => { if ($('confirmLiveSubmit')) $('confirmLiveSubmit').disabled = !$('liveSubmitAcknowledge').checked; });
$('cancelLiveSubmit')?.addEventListener('click', () => closeLiveSubmitModal(false));
$('confirmLiveSubmit')?.addEventListener('click', () => closeLiveSubmitModal(true));

$('stop')?.addEventListener('click', async () => {
  const res = await window.cpApp.requestStop();
  if (res.ok) log(tr('event.stopWaiting', 'Stop requested. Waiting for current item to finish.'), '', 'step3');
});

document.querySelectorAll('[data-force-stop]').forEach((button) => {
  button.addEventListener('click', async () => {
    const step = button.dataset.forceStop || activeTabId || currentProcessStep || 'step1';
    currentProcessStep = step;
    const res = await window.cpApp.forceStop();
    if (res.ok) log(tr('event.forceStopSentShort', 'Force stop sent.'), '', step);
    else log(tr('event.forceStopNone', 'Nothing to force stop.'), '', step);
  });
});

window.cpApp.onUpdateProgress?.(payload => {
  window.UpdateProgress.render(document, payload || {}, key => tr(key), () => window.cpApp.cancelUpdateDownload());
});

window.cpApp.onBrowserActivity?.(({ active, text, kind }) => {
  if (active) {
    builtinBrowserRunActive = true;
    if (builtinBrowserManualActionPending) {
      setBuiltinBrowserStatus(waitingForManualActionText(), 'warn');
    } else {
      setBuiltinBrowserStatus(tr('step3.browser.opening', 'Loading Canada Post'), 'warn');
    }
    setBuiltinBrowserActivity(true, builtinBrowserManualActionPending
      ? tr('step3.browser.waitingManualAction', 'Waiting for manual action')
      : tr('step3.browser.opening', 'Loading Canada Post'), kind || '');
  } else {
    const loaded = /Canada Post page (?:ready|loaded)/i.test(String(text || ''));
    finishBuiltinBrowserActivity(kind === 'error'
      ? tr('step3.browser.navigationFailed', 'Browser navigation failed')
      : (loaded ? tr('step3.browser.loaded', 'Canada Post loaded') : tr('step3.browser.idleStatus', 'Browser idle')), kind || '');
    if (kind === 'error') {
      builtinBrowserManualActionPending = false;
      setBuiltinBrowserStatus(tr('step3.browser.navigationFailed', 'Browser navigation failed'), 'bad');
    } else if (builtinBrowserManualActionPending && builtinBrowserDisplayState.visible) {
      setBuiltinBrowserStatus(waitingForManualActionText(), 'warn');
    } else if (loaded && builtinBrowserDisplayState.visible) {
      setBuiltinBrowserStatus(tr('step3.browser.loaded', 'Canada Post loaded'), 'good');
    } else if (builtinBrowserRunActive) {
      setBuiltinBrowserStatus(tr('step3.browser.opening', 'Loading Canada Post'), 'warn');
    }
  }
});

window.cpApp.onBuiltinBrowserDisplayState?.((payload) => applyBuiltinBrowserDisplayState(payload));

window.cpApp.onBuiltinBrowserVisibilityRequest?.((payload) => {
  builtinBrowserRunActive = true;
  synchronizeBuiltinBrowserVisibility({
    requestId: payload?.requestId,
    reason: payload?.reason || 'main-process-request',
    requireVisible: Boolean(payload?.requireVisible),
    scrollIntoView: Boolean(payload?.scrollIntoView),
    force: true,
    activate: true
  }).catch(error => {
    applyBuiltinBrowserDisplayState({ ok: false, visible: false, reason: 'display-error', error: error.message });
  });
});

window.cpApp.onEvent(({ stage, event }) => {
  const message = describeEvent(stage, event);
  const classByType = {
    pin_late: 'log-late', pin_on_time: 'log-on-time', pin_overdue: 'log-not-delivered', pin_overdue_in_transit: 'log-not-delivered',
    pin_not_delivered: 'log-not-delivered', pin_review_required: 'log-warning', pin_no_data: 'log-warning', pin_error: 'log-submit-error'
  };
  if (event?.type === 'tracking_protocol_stage' && event.stage === 'tracking_backoff') classByType.tracking_protocol_stage = 'log-retry';
  if (message) logStage(stage, `[${stage}] ${message}`, classByType[event?.type] || '', {
    allowFullTrackingNumber: stage === 'tracking' && event?.terminal === true && event?.rendererOnlyFullTrackingNumber === true
  });
  updateCounters();
});

window.cpApp.onRun((payload) => {
  const step = currentProcessStep || activeTabId || 'step1';
  const fallbackMessageKeys = {
    step1: { failed: 'step1.runFailed', blocked: 'step1.runBlocked' },
    step2: { failed: 'step2.runFailed', blocked: 'step2.runBlocked' }
  };
  const payloadMessageKey = payload.messageKey || fallbackMessageKeys[step]?.[payload.status] || '';
  const payloadMessage = payloadMessageKey
    ? trf(payloadMessageKey, payload.messageValues || {}, payload.messageKey ? (payload.message || '') : '')
    : payload.message;
  if (payload.status === 'started') {
    operations.runStartedAt ||= Date.now();
    startOperationsTimer();
    setStatus('Running', 'warn', step);
  }
  if (payload.status === 'complete') {
    operations.finishedAt ||= Date.now();
    stopOperationsTimer();
    setStatus('Complete', 'good', step);
  }
  if (payload.status === 'complete_with_warnings') {
    operations.finishedAt ||= Date.now();
    stopOperationsTimer();
    setStatus('Warnings', 'warn', step);
  }
  if (payload.status === 'failed') {
    if (step === 'step3') finishBuiltinBrowserActivity(tr('step3.browser.workflowFailed', 'Browser workflow failed'), 'error');
    operations.finishedAt ||= Date.now();
    stopOperationsTimer();
    setStatus('Failed', 'bad', step);
    if (step === 'step3') {
      addNeedsReview('failed', operations.current.tracking, payloadMessage || tr('event.runFailed', 'Run failed'), operations.current.row, '', {
        kind: 'failed',
        tracking: operations.current.tracking,
        row: operations.current.row,
        result: tr('event.runFailed', 'Run failed'),
        status: tr('event.runFailed', 'Run failed'),
        message: payloadMessage || tr('event.runFailed', 'Run failed')
      });
    }
  }
  if (payload.status === 'blocked') {
    operations.finishedAt ||= Date.now();
    stopOperationsTimer();
    setStatus('Blocked', 'bad', step);
  }
  if (payload.status === 'diagnostic_complete') {
    operations.finishedAt ||= Date.now();
    stopOperationsTimer();
    setStatus('Diagnostic passed', 'good', step);
    refreshConfig().catch(() => {});
  }
  if (payload.status === 'stopped') {
    if (step === 'step3') finishBuiltinBrowserActivity(tr('step3.browser.workflowStopped', 'Browser workflow stopped'));
    operations.finishedAt ||= Date.now();
    stopOperationsTimer();
    setStatus('Stopped', 'warn', step);
  }
  if (payloadMessage) {
    if (payloadMessageKey) setActionLocalized(payloadMessageKey, payload.messageValues || {}, payload.messageKey ? (payload.message || '') : '', step);
    else setAction(payloadMessage, step);
    log(payloadMessage, '', step);
  }
  if (step === 'step3' && ['complete', 'complete_with_warnings', 'failed', 'blocked', 'stopped'].includes(payload.status)) {
    deactivateBuiltinBrowser(`run-${payload.status}`).catch(() => {});
  }
  updateCounters();
  if (['complete', 'complete_with_warnings', 'failed', 'blocked', 'stopped', 'diagnostic_complete'].includes(payload.status)) {
    refreshHistory().catch(() => {});
  }
});

window.cpApp.onStage(({ stage, status, code }) => {
  const step = stepForStage(stage);
  currentProcessStep = step;
  if (status === 'running') {
    operations.runStartedAt ||= Date.now();
    updateCurrentItem({ step: trf('event.stage.running', { stage }, '{stage} process running'), result: tr('status.inProgress', 'In progress'), kind: '' });
    setStatus('Running', 'warn', step);
    log(trf('event.stage.started', { stage }, '{stage} process started.'), '', step);
  }
  if (status === 'finished') {
    if (stage === 'submit') {
      finishBuiltinBrowserActivity(code === 0 ? tr('step3.browser.workflowComplete', 'Browser workflow complete') : tr('step3.browser.workflowWarnings', 'Browser workflow finished with warnings'), code === 0 ? '' : 'error');
      deactivateBuiltinBrowser('worker-finished').catch(() => {});
    }
    log(trf('event.stage.finished', { stage, code }, '{stage} process finished with code {code}.'), '', step);
  }
});

initThemePicker();
initStepTabs();
initLiveLogs();
initBuiltinBrowserPositionTracking();
refreshConfig();
updateCounters();

$('localeSelect')?.addEventListener('change', async () => {
  const locale = $('localeSelect').value;
  preferredLocale = locale;
  await window.cpApp.saveConfig({ locale });
  if (preferredLocale !== locale) return;
  await applyLocale(locale);
});
