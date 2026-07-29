const $ = (id) => document.getElementById(id);

const UI_FIX_VERSION = 'crossplatform-ui-v27';
const MAX_VISIBLE_LOG_LINES = 2000;
const LOG_BOTTOM_THRESHOLD_PX = 56;

const THEME_STORAGE_KEY = 'canadapostClaimRunnerTheme';
const DEFAULT_THEME = 'dark';
let setupWizardShown = false;
let activeMessages = {};

function tr(key, fallback = '') { return activeMessages[key] || fallback || key; }

async function applyLocale(locale) {
  const result = await window.cpApp.loadLocale(locale);
  activeMessages = result.messages || {};
  document.documentElement.lang = result.locale || 'en-CA';
  if ($('localeSelect')) $('localeSelect').value = result.locale || 'en-CA';
  const tabTargets = { tabSettings: 'nav.settings', tabStep1: 'nav.step1', tabStep2: 'nav.step2', tabStep3: 'nav.step3', tabHistory: 'nav.history', tabResults: 'nav.results' };
  for (const [id, key] of Object.entries(tabTargets)) {
    const button = $(id); const localized = tr(key, '');
    if (!button || !localized) continue;
    const match = localized.match(/^([^<]+)<br><span>(.*)<\/span>$/);
    if (!match) continue;
    const primaryText = [...button.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
    if (primaryText) primaryText.nodeValue = match[1];
    if (button.querySelector('span')) button.querySelector('span').textContent = match[2];
  }
  const textTargets = {
    appTitle: 'app.title', appSubtitle: 'app.subtitle', setupWizardTitle: 'setup.title',
    setupOpenSettings: 'action.settings', setupFinish: 'action.finishSetup', createBackup: 'action.createBackup',
    restoreBackup: 'action.restoreBackup', ['clearBrowserSession']: 'action.clearSession', financialReportTitle: 'financial.title'
  };
  for (const [id, key] of Object.entries(textTargets)) if ($(id)) $(id).textContent = tr(key, $(id).textContent);
}

function applyTheme(theme) {
  const selectedTheme = theme || DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', selectedTheme);
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
    runStep3Preflight().catch((error) => console.error(error));
  }
  updateNotificationIndicator();
  requestBuiltinBrowserLayout();
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
  button.textContent = stateForLog.unread > 0 ? `Jump to latest (${stateForLog.unread > 999 ? '999+' : stateForLog.unread})` : 'Jump to latest';
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

  label.textContent = text || (active ? 'Canada Post is working…' : 'Browser idle');
  container.classList.toggle('active', Boolean(active));
  container.classList.toggle('error', kind === 'error');
  container.setAttribute('aria-busy', active ? 'true' : 'false');
}

function finishBuiltinBrowserActivity(text = 'Browser ready', kind = '') {
  setBuiltinBrowserActivity(false, text, kind);
  browserActivityHideTimer = window.setTimeout(() => {
    if (!$('builtinBrowserActivity')?.classList.contains('active')) {
      setBuiltinBrowserActivity(false, 'Browser idle');
    }
  }, 1800);
}

function syncBuiltinBrowserClass() {
  const step3 = $('step3');
  if (!step3) return;
  step3.classList.toggle('builtin-browser-enabled', useBuiltinBrowser());
}

function builtinBrowserBounds() {
  const slot = $('builtinBrowserSlot');
  if (!slot) return null;
  const rect = slot.getBoundingClientRect();
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

function requestBuiltinBrowserLayout() {
  syncBuiltinBrowserClass();
  if (builtinBrowserLayoutFrame) cancelAnimationFrame(builtinBrowserLayoutFrame);
  builtinBrowserLayoutFrame = requestAnimationFrame(async () => {
    builtinBrowserLayoutFrame = 0;
    syncBuiltinBrowserClass();

    if (!window.cpApp?.showBuiltinBrowser || !window.cpApp?.hideBuiltinBrowser) return;

    if (activeTabId !== 'step3' || !useBuiltinBrowser()) {
      await window.cpApp.hideBuiltinBrowser().catch(() => {});
      return;
    }

    const bounds = builtinBrowserBounds();
    if (!bounds) {
      await window.cpApp.hideBuiltinBrowser().catch(() => {});
      return;
    }
    const res = await window.cpApp.showBuiltinBrowser({ bounds }).catch((error) => ({ ok: false, error: error.message }));
    if (res && res.ok === false) {
      setBuiltinBrowserStatus('Browser error', 'bad');
      log(res.error || 'Could not show built-in browser.', 'log-submit-error', 'step3');
    } else {
      setBuiltinBrowserStatus('Visible', 'good');
    }
  });
}

function resizeBuiltinBrowserToSlot() {
  if (activeTabId !== 'step3' || !useBuiltinBrowser() || !window.cpApp?.setBuiltinBrowserBounds) return;
  const bounds = builtinBrowserBounds();
  if (bounds) window.cpApp.setBuiltinBrowserBounds(bounds).catch(() => {});
}

function scheduleBuiltinBrowserReposition() {
  if (builtinBrowserRepositionFrame) return;
  builtinBrowserRepositionFrame = requestAnimationFrame(async () => {
    builtinBrowserRepositionFrame = 0;

    if (activeTabId !== 'step3' || !useBuiltinBrowser()) {
      await window.cpApp?.hideBuiltinBrowser?.().catch(() => {});
      return;
    }

    const bounds = builtinBrowserBounds();
    if (!bounds) {
      await window.cpApp?.hideBuiltinBrowser?.().catch(() => {});
      return;
    }

    await window.cpApp?.setBuiltinBrowserBounds?.(bounds).catch(() => {});
  });
}

function initBuiltinBrowserPositionTracking() {
  // Capture scroll events from the window and every nested scroll container.
  window.addEventListener('scroll', scheduleBuiltinBrowserReposition, { capture: true, passive: true });
  window.addEventListener('resize', requestBuiltinBrowserLayout);
  window.visualViewport?.addEventListener('scroll', scheduleBuiltinBrowserReposition, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleBuiltinBrowserReposition, { passive: true });

  const slot = $('builtinBrowserSlot');
  if (slot && typeof ResizeObserver === 'function') {
    builtinBrowserResizeObserver = new ResizeObserver(scheduleBuiltinBrowserReposition);
    builtinBrowserResizeObserver.observe(slot);
  }
}

const state = {
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
  apiCredentialsStored: false,
  apiEnvironment: 'production',
  trackingApiCredentialsStored: false,
  trackingApiEnvironment: 'test',
  trackingDiagnosticGateSatisfied: false,
  trackingDiagnosticMode: false,
  trackingTokenLogged: false,
  trackingApiVersion: '1.0.0',
  isolatedTestMode: false,
  evidenceRetentionDays: 90,
  dryRunDefault: false,
  claimQueueItems: [],
  claimQueueLoaded: false,
  step3Preflight: null
};

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
    el.textContent = text;
    el.className = `pill ${kind}`.trim();
  }
}

function setAction(text, stepId = null) {
  const step = stepId || currentProcessStep || activeTabId || 'step1';
  const el = $(actionIdForStep(step));
  if (el) el.textContent = text;
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
    pill.textContent = totalCount === 1 ? '1 notification' : `${totalCount} notifications`;
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

function makeClickableRow(row, item) {
  row.classList.add('clickable');
  row.tabIndex = 0;
  row.title = 'Open detailed result screen';
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
  if (item.issue) return item.issue;
  if (item.kind === 'submitted') return 'Confirmed by Canada Post success page';
  if (item.kind === 'already') return 'Duplicate claim detected by Canada Post';
  if (item.kind === 'failed') return item.message || 'Needs manual review';
  if (item.kind === 'captcha') return item.message || 'CAPTCHA screenshot captured; solve manually in browser';
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
    createCell('Time'),
    createCell('Row'),
    createCell('Tracking'),
    createCell('Result'),
    createCell('Details'),
    createCell('Evidence')
  );
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'ops-body';
  el.appendChild(body);

  if (operations.recentResults.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ops-empty';
    empty.textContent = 'No claim results yet.';
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
      createCell(item.result, outcomeClass(item.kind)),
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
  head.append(createCell('Row'), createCell('Tracking'), createCell('Issue'));
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'ops-body';
  el.appendChild(body);

  if (operations.needsReview.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ops-empty';
    empty.textContent = 'No review items.';
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
  setAction('Waiting.', step);
  updateCounters();
}

function resetRunUi(stepId = null) {
  resetStepUi(stepId || activeTabId || currentProcessStep || 'step1');
  startOperationsTimer();
}

function addStep1Warning(message, meta = {}) {
  const text = String(message || 'Unknown warning').trim() || 'Unknown warning';
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
    summary.textContent = 'No warnings captured for the current Step 1 run.';
    return;
  }

  summary.textContent = `${state.step1WarningMessages.length} warning(s) captured for the current Step 1 run.`;
  for (const item of state.step1WarningMessages) {
    const row = document.createElement('div');
    row.className = 'warning-item';

    const time = document.createElement('div');
    time.className = 'warning-item-time';
    time.textContent = item.time || '—';

    const body = document.createElement('div');
    body.textContent = item.message || 'Unknown warning';

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
  if (!item) return 'Result detail';
  if (item.kind === 'submitted') return 'Submitted successfully';
  if (item.kind === 'already') return 'Already submitted / duplicate claim';
  if (item.kind === 'failed') return 'Failed claim / needs review';
  if (item.kind === 'captcha') return 'CAPTCHA detected / manual action required';
  return item.result || item.status || 'Result detail';
}

function resultExplanation(item) {
  if (!item) return 'No result selected.';

  if (item.kind === 'submitted') {
    return [
      'This item was counted as Submitted because the automation detected Canada Post confirmation language after pressing Create Ticket.',
      '',
      'Important: the app no longer treats a button click as success. It only counts success after the Canada Post page shows a confirmation/ticket result.',
      '',
      item.message ? `Canada Post/result message: ${item.message}` : 'No extra result message was provided by the runner.'
    ].join('\n');
  }

  if (item.kind === 'already') {
    return [
      'This item was not submitted as a new claim.',
      '',
      'Canada Post displayed duplicate/refund-already-received wording after Create Ticket. That means a refund request or inquiry already exists for this tracking number.',
      '',
      'The app therefore classifies it as Already submitted instead of Submitted or Failed.',
      '',
      item.message ? `Detected message: ${item.message}` : 'Expected Canada Post duplicate wording: inquiry already exists / refund request already received.'
    ].join('\n');
  }

  if (item.kind === 'captcha') {
    return [
      'A CAPTCHA appeared during Step 3 claim submission.',
      '',
      'The app paused instead of timing out. Solve the CAPTCHA manually in the visible browser window; the run will continue once the CAPTCHA clears.',
      '',
      item.screenshotPath ? `Captured screenshot: ${basename(item.screenshotPath)}` : 'No CAPTCHA screenshot path was provided.'
    ].join('\n');
  }

  if (item.kind === 'failed') {
    return [
      'This item needs review because the automation did not receive a confirmed successful submission.',
      '',
      'Possible causes include a Canada Post validation error, timeout, session/login issue, unsupported page state, or unknown rejection text.',
      '',
      item.message ? `Runner message: ${item.message}` : 'No detailed runner message was provided.'
    ].join('\n');
  }

  return item.message || 'No detailed explanation is available for this result type.';
}

function resultDecision(item) {
  if (!item) return 'No decision available.';

  if (item.kind === 'submitted') {
    return [
      'Decision: count as Submitted.',
      'Reason: Canada Post page matched the strict success detector: ticket/confirmation/accepted request language was found after Create Ticket.',
      item.screenshotPath ? `Proof screenshot: ${basename(item.screenshotPath)}` : 'Proof screenshot: not available for this row.'
    ].join('\n');
  }

  if (item.kind === 'already') {
    return [
      'Decision: count as Already submitted.',
      'Reason: Canada Post page matched duplicate-claim detector text after Create Ticket.',
      'Matched business result: duplicate refund request / existing inquiry for the same tracking number.',
      item.screenshotPath ? `Proof screenshot: ${basename(item.screenshotPath)}` : 'Proof screenshot: not available for this row.'
    ].join('\n');
  }

  if (item.kind === 'captcha') {
    return [
      'A CAPTCHA appeared during Step 3 claim submission.',
      '',
      'The app paused instead of timing out. Solve the CAPTCHA manually in the visible browser window; the run will continue once the CAPTCHA clears.',
      '',
      item.screenshotPath ? `Captured screenshot: ${basename(item.screenshotPath)}` : 'No CAPTCHA screenshot path was provided.'
    ].join('\n');
  }

  if (item.kind === 'captcha') {
    return [
      'Decision: pause Step 3 and wait for manual CAPTCHA solve.',
      'Reason: the page displayed a CAPTCHA/reCAPTCHA challenge, so the app cannot safely classify the claim result yet.',
      item.screenshotPath ? `CAPTCHA screenshot: ${basename(item.screenshotPath)}` : 'CAPTCHA screenshot: not available.'
    ].join('\n');
  }

  if (item.kind === 'failed') {
    return [
      'Decision: count as Failed / Needs Review.',
      'Reason: the runner did not find a strict success confirmation or a known duplicate business result.',
      item.screenshotPath ? `Diagnostic screenshot: ${basename(item.screenshotPath)}` : 'Diagnostic screenshot: not available for this row.'
    ].join('\n');
  }

  return item.decision || 'Decision details are unavailable.';
}

function setDetailLoadingState() {
  setText('detailEvidenceStatus', 'Loading evidence…');
  const imgWrap = $('detailScreenshotWrap');
  const img = $('detailScreenshot');
  if (imgWrap) imgWrap.classList.add('hidden');
  if (img) img.removeAttribute('src');
  if ($('openScreenshot')) $('openScreenshot').disabled = true;
}

async function loadDetailEvidence(item) {
  setDetailLoadingState();

  if (!item || (!item.screenshotPath && !item.textPath)) {
    setText('detailEvidenceStatus', 'No saved Canada Post evidence file was attached to this result.');
    return;
  }

  try {
    const res = await window.cpApp.loadEvidence({ screenshotPath: item.screenshotPath, textPath: item.textPath });
    if (!res.ok) {
      setText('detailEvidenceStatus', res.error || 'No evidence found.');
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
      setText('detailEvidenceStatus', res.screenshotName ? `Loaded screenshot: ${res.screenshotName}` : 'Screenshot evidence loaded.');
      return;
    }

    setText('detailEvidenceStatus', 'No screenshot evidence is available for this result.');
  } catch (error) {
    setText('detailEvidenceStatus', `Could not load evidence: ${error.message}`);
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
  setText('detailStatus', item.status || item.result || '—');
  setText('detailTime', item.time || '—');
  setText('detailRow', item.row || '—');
  setText('detailSource', item.source || '—');
  setText('detailTracking', item.tracking || '—');
  setText('detailExplanation', resultExplanation(item));
  setText('detailDecision', resultDecision(item));

  const badge = $('detailBadge');
  if (badge) {
    badge.textContent = item.status || item.result || 'Result Detail';
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

  if (type === 'debug_raw' || type === 'debug_process_line') {
    return formatDeveloperRaw(stage, event);
  }

  if (stage === 'health') {
    const resultEl = $('siteHealthResult');
    if (type === 'health_start') {
      setSiteHealthRunning(true);
      if (resultEl) {
        resultEl.textContent = event.message || 'Checking Canada Post workflow…';
        resultEl.className = 'health-result warn';
      }
      return event.message || 'Canada Post workflow health check started.';
    }
    if (type === 'health_complete') {
      setSiteHealthRunning(false);
      const status = event.status === 'healthy' ? 'good' : (event.status === 'warning' ? 'warn' : 'bad');
      if (resultEl) {
        resultEl.textContent = `${event.code || 'RESULT'}: ${event.message || 'Health check completed.'}`;
        resultEl.className = `health-result ${status}`;
      }
      refreshHistory().catch(() => {});
      return `${event.code || 'Health check'}: ${event.message || 'completed'}`;
    }
  }

  if (stage === 'est-history') {
    if (type === 'est_endpoint') return event.message || `EST Desktop API endpoint: ${event.host || ''}`;
    if (type === 'est_start') {
      operations.runStartedAt ||= Date.now();
      updateCurrentItem({ step: 'Exporting EST Desktop history', result: 'In progress', kind: '' });
      setAction(`Exporting EST Desktop history from ${event.from} to ${event.to}.`);
      return `EST Desktop export started: ${event.from} to ${event.to}. Customer ${event.customerNumber || '—'}, workgroup ${event.workgroup || 'auto'}, MOBO ${event.mobo || '-2'}, category ${event.categoryGroup || 'SHP'}.`;
    }
    if (type === 'est_connect') return `EST connect succeeded. Response validated as XML (${event.byteLength || 0} bytes).`;
    if (type === 'est_workgroups') {
      state.step1Workgroups = event.count || 0;
      return `EST workgroups ${event.mode || 'auto'}: ${event.count || 0}.`;
    }
    if (type === 'est_mobos') return `EST MOBO diagnostic for workgroup ${event.workgroup || '—'}: ${event.count || 0} values.`;
    if (type === 'est_probe') return event.message || `EST probe: ${event.url || ''}`;
    if (type === 'est_orders') {
      state.step1Orders += event.count || 0;
      return `EST order IDs found using ${event.dateFormat || 'date'} dates: ${event.count || 0}.`;
    }
    if (type === 'est_export') {
      if (Object.prototype.hasOwnProperty.call(event, 'manifestItemsParsed')) {
        state.step1TotalRows += event.manifestItemsParsed || 0;
        return `EST export chunk ${event.chunk || '?'} parsed. Orders: ${event.orders || 0}; ManifestItems rows: ${event.manifestItemsParsed || 0}.`;
      }
      return `EST export chunk ${event.chunk || '?'} started. Orders: ${event.orders || 0}; filetypes=${event.fileTypes || '2'}.`;
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
      setAction(`Importing EST shipment rows: ${state.step1Imported} imported.`, 'step1');
      return `EST import progress: ${state.step1Imported} shipments imported.`;
    }
    if (type === 'est_export_diagnostic') return `EST export recognized as ${event.format || 'expected format'}; parsed rows: ${event.parsedRows || 0}.`;
    if (type === 'est_backup') return `Previous tracking.csv backed up before EST import.`;
    if (type === 'est_warning') {
      addStep1Warning(event.message, event);
      return `WARNING: ${event.message}`;
    }
    if (type === 'est_stopped') return `EST Desktop export stopped. Imported so far: ${event.imported || 0}.`;
    if (type === 'est_complete') {
      if (event.outcome === 'EMPTY') {
        updateCurrentItem({ step: 'EST Desktop export complete', result: 'No orders found', kind: '' });
        state.step1Orders = 0;
        state.step1Imported = 0;
        setStatus('Complete', 'good', 'step1');
        setAction('Completed — no EST orders found for the selected date range.', 'step1');
        return 'Completed — no EST orders found for the selected date range.';
      }
      updateCurrentItem({ step: 'EST Desktop export complete', result: `${event.imported || 0} imported`, kind: '' });
      state.step1Orders = event.orders || state.step1Orders;
      state.step1Imported = event.imported || state.step1Imported;
      if (!state.step1TotalRows && event.imported) state.step1TotalRows = event.imported;
      setStatus('Complete', 'good', 'step1');
      setAction(`EST Desktop export complete. Imported ${event.imported || 0} shipments into tracking.csv.`, 'step1');
      return `EST Desktop export complete. Orders: ${event.orders || 0}. Imported: ${event.imported || 0}.`;
    }
  }

  if (stage === 'history') {
    if (type === 'history_endpoint') return event.message || `Canada Post API endpoint: production ${event.host || ''}`;
    if (type === 'history_start') {
      operations.runStartedAt ||= Date.now();
      updateCurrentItem({ step: 'Importing shipping history', result: 'In progress', kind: '' });
      setAction(`Importing Canada Post shipping history from ${event.from} to ${event.to}.`);
      return `Shipping history import started: ${event.from} to ${event.to}. Endpoint: ${event.endpointEnvironment || 'production'} ${event.endpointHost || ''}.`;
    }
    if (type === 'history_mobo_discovery') return event.message || `MOBO auto-discovery complete. Values to try: ${event.count || 0}.`;
    if (type === 'history_mobo') return `Checking MOBO/customer ${event.index || '?'}\/${event.total || '?'}: ${event.mobo || 'unknown'}.`;
    if (type === 'history_manifest_list') return `Manifest links found: ${event.count || 0}.`;
    if (type === 'history_manifest') return `Manifest ${event.index}/${event.total}: ${event.manifestId || 'unknown id'}`;
    if (type === 'history_shipments') return `Shipments found for ${event.manifestId || 'manifest'}: ${event.count || 0}.`;
    if (type === 'history_no_manifest_day') return `No-manifest lookup ${event.index}/${event.total}: ${event.date}.`;
    if (type === 'history_imported') {
      updateCurrentItem({
        tracking: event.pin || operations.current.tracking,
        step: 'Importing shipping history',
        result: `${event.current || 0} imported`,
        kind: ''
      });
      return `Imported shipment: ${event.pin} | postal ${event.postalCode || '—'} | reference ${event.reference || '—'}`;
    }
    if (type === 'history_backup') return `Previous tracking.csv backed up.`;
    if (type === 'history_warning') {
      addStep1Warning(event.message, event);
      return `WARNING: ${event.message}`;
    }
    if (type === 'history_stopped') return `Shipping history import stopped. Imported so far: ${event.imported || 0}.`;
    if (type === 'history_complete') {
      updateCurrentItem({ step: 'Shipping history import complete', result: `${event.imported || 0} imported`, kind: '' });
      setAction(`Shipping history import complete. Imported ${event.imported || 0} shipments into tracking.csv.`);
      return `Shipping history import complete. Imported: ${event.imported || 0}. Warnings: ${event.warnings || 0}.`;
    }
  }

  if (stage === 'tracking') {
    applyTrackingPrimaryCategory(event);
    if (type === 'tracking_credential_metadata') {
      const valid = event.clientId?.present && event.clientSecret?.present;
      return `Tracking API configuration ${valid ? 'valid' : 'invalid'}: client ID ${event.clientId?.present ? 'present' : 'missing'}; client secret ${event.clientSecret?.present ? 'present' : 'missing'}; environment ${event.selectedEnvironment || 'test'}; API ${event.apiVersion || '1.0.0'}; scope ${event.scope || 'merchant'}; legacy credentials active: no.`;
    }
    if (type === 'tracking_protocol_stage') {
      const labels = {
        token_request_sent: 'OAuth token request sent', token_acquired: 'OAuth token acquired', token_cached: 'Valid in-memory OAuth token reused',
        token_failed: 'OAuth token request failed', tracking_request_sent: 'Tracking API request sent', tracking_json_received: 'Tracking JSON response received',
        token_cleared: 'In-memory OAuth token cleared', tracking_timeout_backoff: 'Tracking resource timeout retry'
      };
      if (!state.trackingDiagnosticMode) {
        if (event.stage === 'token_acquired' && !state.trackingTokenLogged) state.trackingTokenLogged = true;
        else if (event.stage !== 'token_failed' && event.stage !== 'tracking_backoff') return null;
      }
      if (event.stage === 'tracking_rate_limit_wait') return null;
      if (event.stage === 'tracking_backoff') return `RETRY — ${event.category === 'slm_throttle' ? 'Canada Post SLM Monitor throttle' : (event.status ? `HTTP ${event.status}` : 'network timeout')}; waiting ${event.delayMs} ms (${event.retrySource || 'bounded retry'}), retry ${event.retryAttempt}/${event.maxRetries || 2}.`;
      if (event.stage === 'tracking_timeout_backoff') return `Tracking resource request timed out after ${event.timeoutMs} ms; retry ${event.retryAttempt}/${event.maxRetries} after ${event.delayMs} ms; environment ${event.environment}.`;
      const status = event.tokenHttpStatus || event.resourceHttpStatus;
      return `${labels[event.stage] || 'Tracking protocol stage'}${status ? `; HTTP ${status}` : ''}; environment ${event.environment || 'test'}; API ${event.apiVersion || '1.0.0'}; scope ${event.scope || 'merchant'}${event.expiresIn ? `; expires in ${event.expiresIn} seconds` : ''}.`;
    }
    if (type === 'tracking_start') {
      operations.runStartedAt ||= Date.now();
      updateCurrentItem({ step: 'Checking tracking data', result: '—', kind: '' });
      state.trackingTotal = event.total || 0;
      state.trackingDiagnosticMode = Boolean(event.diagnosticMode);
      state.trackingTokenLogged = false;
      setStatus('Running', 'warn', 'step2');
      return `Tracking stage started. ${state.trackingTotal} row${state.trackingTotal === 1 ? '' : 's'}. Sequential requests use a minimum ${event.requestIntervalMs || 3100} ms start-to-start interval plus up to ${event.jitterMaxMs ?? 100} ms positive jitter.`;
    }
    if (type === 'tracking_progress') {
      state.checked = event.current || state.checked;
      updateCurrentItem({ step: `Tracking check ${event.current}/${event.total}` });
      return (event.current === event.total || event.current % 10 === 0) ? `Tracking progress: ${event.current}/${event.total}` : null;
    }
    if (type === 'pin_late') {
      const pin = trackingDisplayPin(event);
      setAction(`Late package found: ${pin}. Added to claims.csv.`);
      updateCurrentItem({ tracking: pin, step: 'Late candidate found', result: 'Added to claims.csv', kind: 'submitted' });
      return `${pin} — LATE — successful delivery after delivery standard${trackingDateSuffix(event)}`;
    }
    if (type === 'pin_on_time') {
      return `${trackingDisplayPin(event)} — ON TIME — successful delivery on or before delivery standard${trackingDateSuffix(event)}`;
    }
    if (type === 'pin_not_delivered') {
      return `${trackingDisplayPin(event)} — NOT DELIVERED${trackingDateSuffix(event)}`;
    }
    if (type === 'pin_overdue' || type === 'pin_overdue_in_transit') {
      state.overdueInTransit += 1;
      const deliveryStatus = event.deliveryStatus || (event.deliveryDate ? 'Delivered' : (event.firstAttemptDate ? 'Delivery attempted but not delivered' : 'In transit'));
      addNeedsReview('warning', event.pin, event.eligibilityReason || `Overdue — ${deliveryStatus.toLowerCase()}`, event.row || '—', '', {
        kind: 'warning', tracking: event.pin, row: event.row || '—', result: 'Missing-package review', status: `Overdue — ${deliveryStatus}`, message: event.eligibilityReason || ''
      });
      return `${trackingDisplayPin(event)} — NOT DELIVERED — OVERDUE${trackingDateSuffix(event)}`;
    }
    if (type === 'pin_review_required') {
      state.reviewRequired += 1;
      addNeedsReview('warning', event.pin, event.eligibilityReason || 'Eligibility review required', event.row || '—', '', {
        kind: 'warning', tracking: event.pin, row: event.row || '—', result: 'Eligibility review', status: event.classification || 'Review required', message: event.eligibilityReason || ''
      });
      return `${trackingDisplayPin(event)} — ${event.primaryCategory === 'not_delivered' ? 'NOT DELIVERED — REVIEW' : 'REVIEW'}${trackingDateSuffix(event)}`;
    }
    if (type === 'pin_no_data') {
      state.reviewRequired += 1;
      return `${trackingDisplayPin(event)} — NOT DELIVERED — REVIEW | ${event.eligibilityReason || event.message || 'No usable successful-delivery evidence'}`;
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
      return `${trackingDisplayPin(event)} — ERROR — ${event.message || 'Unknown tracking error'} Protocol diagnostics: ${protocol}.`;
    }
    if (type === 'tracking_circuit_open') {
      setStatus('Blocked', 'bad', 'step2');
      setAction('Stopped — systemic integration failure. Correct the API configuration, then deliberately retry.', 'step2');
      return `Stopped — systemic integration failure. Attempted: ${event.attempted || event.processed || 0}; total: ${event.total || state.trackingTotal || 0}; remaining: ${event.remaining || 0}; errors: ${event.errors || event.consecutiveFailures || 0}; queue preserved: ${event.queuePreserved ? 'yes' : 'no'}.`;
    }
    if (type === 'tracking_semantic_circuit_open') {
      setStatus('Blocked', 'bad', 'step2');
      setAction(event.message || 'Stopped — Tracking API responses were received, but required fields could not be normalized.', 'step2');
      return `${event.message} Attempted: ${event.attempted || 0}; total: ${event.total || 0}; remaining: ${event.remaining || 0}; queue preserved: ${event.queuePreserved ? 'yes' : 'no'}.`;
    }
    if (type === 'tracking_invariant_failure') {
      setStatus('Blocked', 'bad', 'step2');
      setAction(event.message || 'Internal classification invariant failed.', 'step2');
      return `${event.message || 'Internal classification invariant failed.'} Run stopped; queue preserved: ${event.queuePreserved ? 'yes' : 'no'}.`;
    }
    if (type === 'tracking_aborted') {
      updateCurrentItem({ step: 'Tracking stopped', result: 'Systemic integration failure', kind: 'failed' });
      setStatus('Blocked', 'bad', 'step2');
      setAction(event.message || 'Stopped — incomplete Tracking API run. A deliberate retry is required.', 'step2');
      return `Run stopped. Attempted: ${event.attempted || 0}; total: ${event.total || 0}; remaining: ${event.remaining || 0}; errors: ${event.errorCount || 0}; queue preserved: ${event.queuePreserved ? 'yes' : 'no'}.`;
    }
    if (type === 'tracking_diagnostic') {
      const evidence = event.semanticValidation?.deliveryEvidence || {};
      const evidenceSummary = `first qualifying code ${evidence.firstQualifyingEventCode || 'none'}; category ${evidence.firstQualifyingEventCategory || 'none'}; first-attempt timestamp ${evidence.firstAttemptTimestampPresent ? 'present' : 'absent'}; actual-delivery timestamp ${evidence.actualDeliveryTimestampPresent ? 'present' : 'absent'}; same event ${evidence.sameEvent ? 'yes' : 'no'}; provenance ${evidence.provenance || 'none'}; confidence ${evidence.confidence || 'none'}`;
      return event.ok
        ? `One-request semantic diagnostic succeeded for ${event.tracking}. API ${event.apiVersion || '1.0.0'}; HTTP ${event.status}; status parsed; events ${event.eventCount}; service source ${event.serviceResolution?.source || 'unknown'}; ${evidenceSummary}; state unchanged.${event.structureExported ? ' Sanitized structure exported.' : ''}`
        : `One-request semantic diagnostic failed for ${event.tracking}. ${(event.semanticValidation?.failures || []).join(', ') || event.diagnostic?.message || 'Response was not semantically usable.'} ${evidenceSummary}. State modified: no.`;
    }
    if (type === 'tracking_diagnostic_complete') {
      const ok = event.status === 'DIAGNOSTIC_COMPLETE';
      setStatus(ok ? 'Diagnostic passed' : 'Diagnostic failed', ok ? 'good' : 'bad', 'step2');
      setAction('One-request diagnostic finished. Claim, eligibility, and queue state were not modified.', 'step2');
      return `One-request diagnostic ${ok ? 'complete' : 'failed'}. Tracking resource requests: 1. Eligibility, claims, queue, and summary state changed: no.`;
    }
    if (type === 'pin_skipped') {
      state.skipped += 1;
      return `Skipped already processed: ${event.pin}`;
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
      updateCurrentItem({ step: 'Tracking complete', result: `${eligible} eligible claims` });
      setStatus(errors > 0 ? 'Warnings' : 'Complete', errors > 0 ? 'warn' : 'good', 'step2');
      setAction(`Tracking complete: ${eligible} late, ${state.onTime} on time, ${state.notDelivered} not delivered, ${review} review required, ${errors} errors.`, 'step2');
      return `Tracking complete. Checked: ${state.checked}. Late candidates: ${eligible}. On time: ${state.onTime}. Not delivered: ${state.notDelivered}. Delivered but unclassifiable: ${Number(event.deliveredReviewCount || 0)}. Review required: ${review}. Overdue/in transit: ${overdue}. Errors: ${errors}. Counters reconciled: ${event.countersReconciled ? 'yes' : 'no'}.`;
    }
  }

  if (stage === 'submit') {
    if (type === 'diagnostics_started') {
      return `Detailed diagnostics started: ${event.directory || 'Step 3 diagnostics folder'}`;
    }
    if (type === 'diagnostics_complete') {
      return `Detailed diagnostics complete: ${event.summaryPath || event.directory || 'saved'}`;
    }
    if (type === 'submit_start') {
      setBuiltinBrowserActivity(true, 'Preparing Canada Post claim workflow…');
      operations.submitStartedAt = Date.now();
      state.submitTotal = event.total || 0;
      setStatus('Running', 'warn', 'step3');
      updateCurrentItem({ step: 'Claim submission started', result: '—', kind: '' });
      return `Claim submission started. ${state.submitTotal} claims.`;
    }
    if (type === 'claim_start') {
      setBuiltinBrowserActivity(true, `Opening claim ${event.index || ''}${event.total ? ` of ${event.total}` : ''}…`);
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
      setAction(`Submitting claim ${event.index}/${event.total}: ${event.trackingNumber}`);
      return `Claim ${event.index}/${event.total}: ${event.trackingNumber}`;
    }
    if (type === 'captcha_detected') {
      finishBuiltinBrowserActivity('Waiting for manual CAPTCHA');
      updateCurrentItem({ step: 'CAPTCHA detected', result: 'Paused for manual solve', kind: 'captcha' });
      setStatus('CAPTCHA', 'bad', 'step3');
      setAction('CAPTCHA detected. Solve it manually in the visible browser window. The app is paused and will resume after it clears.', 'step3');
      const detail = detailForEvent('captcha', event, 'CAPTCHA detected', {
        issue: 'Manual CAPTCHA solve required',
        status: 'CAPTCHA detected',
        message: event.message || 'CAPTCHA detected. Solve it manually in the visible browser window.',
        source: 'Notifications / CAPTCHA'
      });
      addRecentResult('captcha', event.trackingNumber || operations.current.tracking, 'CAPTCHA detected', event.row || operations.current.row, detail);
      if (useBuiltinBrowser() && window.cpApp?.focusBuiltinBrowser) {
        setTimeout(() => window.cpApp.focusBuiltinBrowser().catch(() => {}), 50);
        setTimeout(() => window.cpApp.focusBuiltinBrowser().catch(() => {}), 350);
      }
      return `CAPTCHA detected for ${event.trackingNumber || 'current claim'} — solve it manually in the visible browser. The app is paused.${event.screenshotPath ? ` Screenshot saved: ${event.screenshotPath}` : ' Screenshot skipped in built-in browser mode to keep focus.'}`;
    }
    if (type === 'captcha_waiting') {
      finishBuiltinBrowserActivity('Waiting for manual CAPTCHA');
      updateCurrentItem({ step: 'CAPTCHA still active', result: 'Waiting for manual solve', kind: 'already' });
      setAction(event.message || 'Still waiting for CAPTCHA solve.', 'step3');
      return event.message || `Still waiting for CAPTCHA solve for ${event.trackingNumber || 'current claim'}.`;
    }
    if (type === 'captcha_cleared') {
      setBuiltinBrowserActivity(true, 'CAPTCHA cleared — resuming…');
      updateCurrentItem({ step: 'CAPTCHA cleared', result: 'Resuming', kind: '' });
      setStatus('Running', 'warn', 'step3');
      setAction(event.message || 'CAPTCHA cleared. Resuming claim submission.', 'step3');
      return event.message || `CAPTCHA cleared for ${event.trackingNumber || 'current claim'}. Resuming.`;
    }
    if (type === 'claim_wait') {
      setBuiltinBrowserActivity(true, 'Waiting for Canada Post confirmation…');
      updateCurrentItem({ tracking: event.trackingNumber || operations.current.tracking, step: 'Waiting for Canada Post result', result: 'In progress', kind: '' });
      setAction(`Waiting for Canada Post result for ${event.trackingNumber}. Timeout: ${Math.round((event.ms || 0) / 1000)} seconds.`);
      return `Waiting for Canada Post result: ${Math.round((event.ms || 0) / 1000)} seconds`;
    }
    if (type === 'claim_submitted') {
      finishBuiltinBrowserActivity('Claim submitted');
      state.submitted += 1;
      updateCurrentItem({
        tracking: event.trackingNumber || operations.current.tracking,
        row: event.row || operations.current.row,
        step: 'Claim result received',
        result: 'Submitted',
        kind: 'submitted'
      });
      addRecentResult('submitted', event.trackingNumber, 'Submitted', event.row, detailForEvent('submitted', event, 'Submitted'));
      setAction(`Submitted successfully: ${event.trackingNumber}`);
      return `Submitted: ${event.trackingNumber}`;
    }
    if (type === 'claim_already_submitted') {
      finishBuiltinBrowserActivity('Claim already submitted');
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
      setAction(`Already submitted: ${event.trackingNumber}`);
      return `ALREADY SUBMITTED row ${event.row}, ${event.trackingNumber}: ${event.message}`;
    }
    if (type === 'claim_rejected') {
      finishBuiltinBrowserActivity('Claim rejected');
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
      setAction(`Rejected by Canada Post: ${event.trackingNumber}`);
      return `REJECTED row ${event.row}, ${event.trackingNumber}: ${event.message}`;
    }
    if (type === 'claim_error') {
      finishBuiltinBrowserActivity('Claim failed', 'error');
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
      setAction(`Failed: ${event.trackingNumber}`);
      return `ERROR row ${event.row}, ${event.trackingNumber}: ${event.message}`;
    }
    if (type === 'submit_complete') {
      finishBuiltinBrowserActivity('Submission run complete');
      operations.finishedAt = Date.now();
      const dryReady = Number(event.dryRunReady || 0);
      updateCurrentItem({ step: 'Submission complete', result: dryReady ? `${dryReady} dry-run ready` : 'Done', kind: '' });
      setStatus('Complete', 'good', 'step3');
      const summary = dryReady
        ? `Dry run complete. Ready: ${dryReady}, Failed: ${event.failed || 0}. No claims were submitted.`
        : `Submission complete. Approved/success: ${event.succeeded}, Already submitted: ${event.alreadySubmitted || 0}, Rejected/ineligible: ${event.rejected || 0}, Submission errors: ${event.failed}.`;
      setAction(summary, 'step3');
      stopOperationsTimer();
      refreshHistory().catch(() => {});
      return summary;
    }
  }

  if (type === 'stop_requested') {
    updateCurrentItem({ step: 'Stop requested', result: 'Stopping after current item', kind: 'already' });
    return event.message;
  }
  if (type === 'error') {
    updateCurrentItem({ step: 'Runner error', result: 'Failed', kind: 'failed' });
    addNeedsReview('failed', operations.current.tracking, event.message || 'Runner error', operations.current.row, '', {
      kind: 'failed',
      tracking: operations.current.tracking,
      row: operations.current.row,
      result: 'Runner error',
      status: 'Runner error',
      message: event.message || 'Runner error'
    });
    return `ERROR: ${event.message}`;
  }
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

function updateReconciliationBadge(count) {
  const badge = $('reconciliationBadge');
  const pill = $('reconciliationCountPill');
  if (badge) {
    badge.textContent = String(count || 0);
    badge.classList.toggle('hidden', !count);
  }
  if (pill) pill.textContent = `${count || 0} unresolved`;
}

function renderHistory(items = []) {
  const root = $('historyList');
  if (!root) return;
  root.replaceChildren();
  const head = document.createElement('div');
  head.className = 'history-row head';
  ['Tracking', 'Attempt time', 'Status', 'Confirmation', 'Message'].forEach(value => head.appendChild(historyCell(value)));
  root.appendChild(head);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No claim attempts match the current filters.';
    root.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.appendChild(historyCell(item.trackingNumber));
    row.appendChild(historyCell(historyDate(item.attemptedAt)));
    row.appendChild(historyCell(item.status));
    row.appendChild(historyCell(item.confirmationNumber));
    const messageCell = document.createElement('div');
    messageCell.textContent = item.message || '—';
    if (item.screenshotPath || item.textPath) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = 'View evidence';
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
          source: 'History database',
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
      const confirmation = window.prompt(`Confirmation or ticket number for ${item.trackingNumber} (optional):`, item.confirmationNumber || '');
      if (confirmation === null) return;
      confirmationNumber = confirmation.trim();
    }
    const noteValue = window.prompt(`Optional reconciliation note for ${item.trackingNumber}:`, '');
    if (noteValue === null) return;
    const result = await window.cpApp.reconcileAttempt({ attemptId: item.id, action, note: noteValue.trim(), confirmationNumber });
    if (!result.ok) {
      window.alert(result.error || 'Could not update reconciliation state.');
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
    empty.textContent = 'No manually entered shipments.';
    root.appendChild(empty);
    return;
  }
  const head = document.createElement('div');
  head.className = 'history-row head';
  ['Tracking', 'Reference', 'Service', 'Expected', 'Note'].forEach(value => head.appendChild(historyCell(value)));
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
  root.replaceChildren();
  const head = document.createElement('div');
  head.className = 'reconciliation-row head';
  ['Tracking', 'Attempt time', 'Status', 'Reason', 'Actions'].forEach(value => head.appendChild(historyCell(value)));
  root.appendChild(head);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No uncertain or interrupted claims require reconciliation.';
    root.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'reconciliation-row';
    row.appendChild(historyCell(item.trackingNumber));
    row.appendChild(historyCell(historyDate(item.attemptedAt)));
    row.appendChild(historyCell(item.status));
    row.appendChild(historyCell(`${item.errorCode ? `${item.errorCode}: ` : ''}${item.message || 'Remote outcome is uncertain.'}`));
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    if (item.screenshotPath || item.textPath) {
      const evidence = document.createElement('button');
      evidence.type = 'button';
      evidence.className = 'secondary';
      evidence.textContent = 'Evidence';
      evidence.addEventListener('click', async () => {
        const loaded = await window.cpApp.loadEvidence({ screenshotPath: item.screenshotPath, textPath: item.textPath });
        if (loaded.ok && item.screenshotPath) await window.cpApp.openEvidence(item.screenshotPath);
        else window.alert(loaded.error || loaded.pageText || 'No evidence available.');
      });
      actions.appendChild(evidence);
    }
    actions.appendChild(reconciliationActionButton(item, 'Mark submitted', 'submitted', 'success'));
    actions.appendChild(reconciliationActionButton(item, 'Mark not submitted', 'not_submitted', 'warning'));
    actions.appendChild(reconciliationActionButton(item, 'Approve retry', 'retry', 'secondary'));
    row.appendChild(actions);
    root.appendChild(row);
  }
}

function renderManualReviews(items = []) {
  const root = $('manualReviewList');
  if (!root) return;
  root.textContent = '';
  setText('manualReviewCountPill', `${items.length} open`);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No eligibility decisions require manual review.';
    root.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.appendChild(historyCell(item.tracking_number || '—'));
    row.appendChild(historyCell(item.service_code || 'Unknown service'));
    row.appendChild(historyCell([item.expected_date, item.first_attempt_date, item.delivery_date].filter(Boolean).join(' → ')));
    row.appendChild(historyCell(item.reason_codes_json || item.automated_classification || 'Manual review'));
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    for (const [label, action, className] of [['Add note', 'note', 'secondary'], ['Resolve eligible', 'resolved_eligible', 'success'], ['Resolve not eligible', 'resolved_not_eligible', 'warning'], ['Defer', 'resolved_deferred', 'secondary']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = label;
      button.addEventListener('click', async () => {
        const note = window.prompt(`${label} — the note is retained in the audit history:`, item.note || '');
        if (note === null) return;
        const result = await window.cpApp.updateManualReview({ reviewId: item.id, action, note });
        if (!result.ok) window.alert(result.error || 'Could not update manual review.');
        await refreshHistory();
      });
      actions.appendChild(button);
    }
    row.appendChild(actions);
    root.appendChild(row);
  }
}

async function refreshHistory() {
  if (!window.cpApp?.listHistory) return;
  const search = getFieldValue('historySearch');
  const status = $('historyStatusFilter')?.value || 'all';
  const [history, reconciliation, dashboard, manualShipments, manualReviews] = await Promise.all([
    window.cpApp.listHistory({ search, status, limit: 500 }),
    window.cpApp.listReconciliation(),
    window.cpApp.getDashboard(),
    window.cpApp.listManualShipments({ search, limit: 250 }),
    window.cpApp.listManualReviews({ search, status: 'open', limit: 250 })
  ]);
  if (history.ok) renderHistory(history.items || []);
  if (manualShipments.ok) renderManualShipments(manualShipments.items || []);
  if (manualReviews.ok) renderManualReviews(manualReviews.items || []);
  if (reconciliation.ok) {
    renderReconciliation(reconciliation.items || []);
    updateReconciliationBadge((reconciliation.items || []).length);
  }
  if (dashboard.ok) {
    const data = dashboard.dashboard || {};
    setText('historyShipments', data.shipments || 0);
    setText('historySubmitted', data.submitted || 0);
    setText('historyReconciliation', data.reconciliation || 0);
    setText('historyFailed', data.failed || 0);
    const integrity = $('databaseIntegrity');
    if (integrity) {
      integrity.textContent = dashboard.integrity?.ok ? 'Database healthy' : 'Database check failed';
      integrity.className = dashboard.integrity?.ok ? 'pill good' : 'pill bad';
    }
  }
  await refreshFinancialReport();
}

function formatMoneyMinor(value, currency = 'CAD') {
  return new Intl.NumberFormat(document.documentElement.lang || 'en-CA', { style: 'currency', currency }).format(Number(value || 0) / 100);
}

async function refreshFinancialReport() {
  const result = await window.cpApp.getFinancialReport({ currency: 'CAD' });
  if (!result.ok || !$('financialSummary')) return;
  const report = result.report;
  const values = report.totalsMinor || {};
  const entries = [
    [tr('financial.estimated', 'Estimated'), values.estimated], [tr('financial.claimed', 'Claimed'), values.claimed], [tr('financial.approved', 'Approved'), values.approved],
    [tr('financial.received', 'Received'), values.received], [tr('financial.rejected', 'Rejected'), values.rejected], [tr('financial.pending', 'Pending'), report.pendingMinor]
  ];
  $('financialSummary').innerHTML = entries.map(([label, amount]) => `<div class="stat"><div class="num">${formatMoneyMinor(amount, report.currency)}</div><div class="label">${label}</div></div>`).join('')
    + `<div class="stat"><div class="num">${report.recoveryRateBasisPoints === null ? '—' : `${(report.recoveryRateBasisPoints / 100).toFixed(2)}%`}</div><div class="label">${tr('financial.recoveryRate', 'Recovery rate')}</div></div>`;
}

async function recordFinancialEntry() {
  const result = await window.cpApp.recordFinancialEntry({
    trackingNumber: $('financialTracking')?.value || '', valueType: $('financialType')?.value || '',
    amount: $('financialAmount')?.value || '', source: $('financialSource')?.value || 'manual',
    currency: 'CAD', note: $('financialNote')?.value || ''
  });
  if (!result.ok) return window.alert(result.error || 'Could not record financial value.');
  $('financialAmount').value = '';
  $('financialNote').value = '';
  await refreshFinancialReport();
}

function setSiteHealthRunning(running) {
  const button = $('runSiteHealth');
  if (!button) return;
  button.disabled = Boolean(running);
  button.textContent = running ? 'Health Check Running…' : 'Run Canada Post Workflow Health Check';
}

async function runSiteHealthCheck() {
  currentProcessStep = 'step3';
  const resultEl = $('siteHealthResult');
  setSiteHealthRunning(true);
  if (resultEl) resultEl.textContent = 'Checking Canada Post workflow…';
  requestBuiltinBrowserLayout();
  const bounds = builtinBrowserBounds();
  try {
    const result = await window.cpApp.runSiteHealth({ ...collectUserSettingsOptions(), bounds: bounds || {} });
    if (!result.ok) {
      setSiteHealthRunning(false);
      if (resultEl) resultEl.textContent = result.error || 'Could not start workflow health check.';
    }
  } catch (error) {
    setSiteHealthRunning(false);
    if (resultEl) resultEl.textContent = error.message || 'Could not start workflow health check.';
  }
}

let backupPasswordResolver = null;

function requestBackupPassword({ confirm = false, restore = false } = {}) {
  const modal = $('backupPasswordModal');
  const input = $('backupPassword');
  const confirmation = $('backupPasswordConfirm');
  const confirmationField = $('backupPasswordConfirmField');
  const error = $('backupPasswordError');
  $('backupPasswordTitle').textContent = restore ? 'Unlock encrypted backup' : 'Create encrypted backup';
  $('backupPasswordMessage').textContent = restore
    ? 'Enter the password used when this backup was created. It is not saved.'
    : 'Enter a strong password of at least 12 characters. It is never saved and cannot be recovered.';
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
    error.textContent = 'Use at least 12 characters.'; error.classList.remove('hidden'); return;
  }
  if (confirmationVisible && password !== ($('backupPasswordConfirm')?.value || '')) {
    error.textContent = 'The passwords do not match.'; error.classList.remove('hidden'); return;
  }
  closeBackupPasswordModal(password);
}

async function createAppBackup() {
  const password = await requestBackupPassword({ confirm: true });
  if (!password) return;
  const result = await window.cpApp.createBackup({ password });
  if (result.ok) window.alert(`Backup created:
${result.path}`);
  else if (!result.canceled) window.alert(result.error || 'Could not create backup.');
}

async function restoreAppBackup() {
  if (!window.confirm('Restore a backup? The current database and replaced data files will be preserved in rollback copies.')) return;
  let result = await window.cpApp.restoreBackup({});
  if (result.passwordRequired) {
    const password = await requestBackupPassword({ restore: true });
    if (!password) return;
    result = await window.cpApp.restoreBackup({ password });
  }
  if (result.ok) {
    window.alert(`Backup restored. ${result.restoredDataFiles || 0} data/evidence files restored.`);
    await refreshConfig();
    await refreshHistory();
  } else if (!result.canceled) {
    window.alert(result.error || 'Could not restore backup.');
  }
}

async function refreshBrowserSessionStatus() {
  const status = $('browserSessionStatus');
  if (status) status.textContent = 'Checking local browser session…';
  const result = await window.cpApp.browserSessionStatus();
  if (status) status.textContent = result.ok
    ? (result.exists ? 'A local Canada Post browser session exists on this device.' : 'No saved Canada Post browser session was detected.')
    : (result.error || 'Could not inspect browser session state.');
}

async function clearBrowserSession() {
  const confirmed = window.confirm('Log out and clear the Canada Post browser profile? Cookies, cache and site storage will be removed. Claim history and settings will be preserved.');
  if (!confirmed) return;
  const result = await window.cpApp.clearBrowserSession({ confirmed: true, resetProfile: true });
  if (!result.ok) return window.alert(result.error || 'Could not clear browser data.');
  window.alert('Browser cookies, cache and site storage were cleared. Claim history was preserved.');
  await refreshBrowserSessionStatus();
}

async function createDiagnosticZip() {
  const result = await window.cpApp.createDiagnostics();
  if (result.ok) window.alert(`Sanitized diagnostic ZIP created:
${result.path}`);
  else if (!result.canceled) window.alert(result.error || 'Could not create diagnostic ZIP.');
}

async function exportClaimHistory() {
  const result = await window.cpApp.exportHistory({
    search: getFieldValue('historySearch'),
    status: $('historyStatusFilter')?.value || 'all'
  });
  if (result.ok) window.alert(`Claim history exported:
${result.path}`);
  else if (!result.canceled) window.alert(result.error || 'Could not export claim history.');
}

async function addManualShipment() {
  const trackingNumber = getFieldValue('manualTracking');
  if (!trackingNumber) {
    window.alert('Tracking number is required.');
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
    window.alert(result.error || 'Could not save shipment.');
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
    apiUsername: getFieldValue('apiUsername'),
    apiPassword: $('apiPassword')?.value || '',
    apiEnvironment: $('apiEnvironment')?.value || state.apiEnvironment || 'production',
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
    if (!settings.webUsername) missing.push('Canada Post Web Username');
    if (!settings.webPassword && !state.passwordStored) missing.push('Canada Post Web Password');
  }
  if (stepId === 'step1' && !settings.estCustomerNumber) missing.push('EST customer number');
  if (stepId === 'step3') {
    if (!settings.claimStreetNumber) missing.push('Claim sender street number');
    if (!settings.claimStreetName) missing.push('Claim sender street name dropdown option');
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
    if (status) { status.textContent = res.error || 'Settings were not saved.'; status.className = 'pill bad'; }
    if (showLog) log(res.error || 'Settings were not saved.', 'log-submit-error', 'step1');
    return res;
  }
  if (res.ok) {
    state.passwordStored = !!res.passwordStored;
    state.apiCredentialsStored = !!res.apiCredentialsStored;
    state.trackingApiCredentialsStored = !!res.trackingApiCredentialsStored;
    state.trackingDiagnosticGateSatisfied = !!res.trackingDiagnosticGateSatisfied;
    const status = $('settingsStatus');
    if (status) {
      status.textContent = res.warning || (state.passwordStored ? 'Saved with encrypted password' : 'Saved without password');
      status.className = res.warning ? 'pill warn' : 'pill good';
    }
    if ($('webPassword')) $('webPassword').value = '';
    if ($('apiUsername')) $('apiUsername').value = '';
    if ($('apiPassword')) $('apiPassword').value = '';
    if ($('trackingClientId')) $('trackingClientId').value = '';
    if ($('trackingClientSecret')) $('trackingClientSecret').value = '';
    if ($('apiCredentialMetadata') && res.apiCredentialMetadata) renderApiCredentialMetadata(res.apiCredentialMetadata);
    if ($('trackingApiCredentialMetadata') && res.trackingApiCredentialMetadata) renderTrackingApiCredentialMetadata(res.trackingApiCredentialMetadata);
    renderTrackingDiagnosticGate();
    if (showLog) log(res.warning || 'User settings saved.', res.warning ? 'log-warning' : '', 'step1');
  }
  return res;
}

async function clearTrackingApiCredentials() {
  const confirmed = window.confirm('Clear only the current Tracking API client ID and client secret from encrypted storage? Legacy and website credentials will be preserved.');
  if (!confirmed) return;
  const result = await window.cpApp.clearTrackingApiCredentials({ confirmed: true });
  if (!result.ok) return window.alert(result.error || 'Could not clear Tracking API credentials.');
  state.trackingApiCredentialsStored = false;
  state.trackingDiagnosticGateSatisfied = false;
  await refreshConfig();
  window.alert('Tracking API credentials and the diagnostic gate were cleared. No legacy or website credentials were removed.');
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
    browserMode: 'external',
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

function renderApiCredentialMetadata(metadata = {}) {
  const element = $('apiCredentialMetadata');
  if (!element) return;
  const username = metadata.username || {};
  const password = metadata.password || {};
  element.textContent = `Legacy credentials — username: ${username.present ? 'present' : 'missing'}; password: ${password.present ? 'present' : 'missing'}; environment: ${metadata.credentialEnvironment || 'unknown'}. Deprecated and inactive for Step 2.`;
}

function renderTrackingApiCredentialMetadata(metadata = {}) {
  const element = $('trackingApiCredentialMetadata');
  if (!element) return;
  element.textContent = `Tracking API ${metadata.apiVersion || state.trackingApiVersion} — client ID: ${metadata.clientId?.present ? 'present' : 'missing'}; client secret: ${metadata.clientSecret?.present ? 'present' : 'missing'}; selected environment: ${metadata.selectedEnvironment || 'test'}; credential environment: ${metadata.credentialEnvironment || 'unknown'}; scope: ${metadata.scope || 'merchant'}. No lengths, values, hashes, or token metadata are displayed.`;
}

function renderTrackingDiagnosticGate() {
  const element = $('trackingDiagnosticGate');
  if (element) element.textContent = state.trackingDiagnosticGateSatisfied
    ? `Diagnostic gate passed for the current credential revision, ${state.trackingApiEnvironment}, and Tracking API ${state.trackingApiVersion}.`
    : `Normal Step 2 is disabled until the one-shipment diagnostic succeeds for the current credential revision, ${state.trackingApiEnvironment}, and Tracking API ${state.trackingApiVersion}.`;
  if ($('runTrackingOnly')) $('runTrackingOnly').disabled = !state.trackingDiagnosticGateSatisfied;
}

function selectedClaimTrackingNumbers() {
  return Array.from(document.querySelectorAll('#claimQueueList input[data-tracking]:checked'))
    .map(input => String(input.dataset.tracking || '').trim())
    .filter(Boolean);
}

function updateClaimQueueCount() {
  const selected = selectedClaimTrackingNumbers().length;
  const total = state.claimQueueItems.length;
  const pill = $('claimQueueCount');
  if (pill) {
    pill.textContent = `${selected} of ${total} selected`;
    pill.className = `pill ${selected > 0 ? 'good' : 'bad'}`;
  }
}

function queueCell(text, className = '') {
  const cell = document.createElement('div');
  cell.className = className;
  cell.textContent = text || '—';
  return cell;
}

function filteredClaimQueue(items = []) {
  const search = String($('claimQueueSearch')?.value || '').trim().toLowerCase();
  const service = $('claimQueueServiceFilter')?.value || 'all';
  const urgency = $('claimQueueUrgencyFilter')?.value || 'all';
  const dateFrom = $('claimQueueDateFrom')?.value || '';
  const dateTo = $('claimQueueDateTo')?.value || '';
  return items.filter(item => {
    if (search && !`${item.trackingNumber || ''} ${item.referenceNumber || ''}`.toLowerCase().includes(search)) return false;
    if (service !== 'all' && item.serviceCode !== service) return false;
    const remaining = Number(item.businessDaysRemaining);
    if (urgency === 'urgent' && (!Number.isFinite(remaining) || remaining < 0 || remaining > 7)) return false;
    if (urgency === 'expired' && (!Number.isFinite(remaining) || remaining >= 0)) return false;
    if (dateFrom && String(item.deadline || '') < dateFrom) return false;
    if (dateTo && String(item.deadline || '') > dateTo) return false;
    return true;
  }).sort((a, b) => String(a.deadline || '9999').localeCompare(String(b.deadline || '9999')));
}

function renderClassificationQueue(targetId, countId, items = []) {
  const target = $(targetId); const count = $(countId);
  if (count) count.textContent = String(items.length);
  if (!target) return;
  target.textContent = '';
  if (!items.length) { target.appendChild(queueCell('No records in this queue.')); return; }
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'history-item';
    row.append(queueCell(item.tracking_number, 'history-primary'), queueCell(item.service_code), queueCell(item.eligibility_reason));
    target.appendChild(row);
  }
}

function renderClaimQueue(items = [], preserveState = false) {
  const list = $('claimQueueList');
  if (!list) return;
  list.textContent = '';
  if (!preserveState) state.claimQueueItems = Array.isArray(items) ? items : [];
  state.claimQueueLoaded = true;
  const services = [...new Set(state.claimQueueItems.map(item => item.serviceCode).filter(Boolean))].sort();
  const serviceFilter = $('claimQueueServiceFilter');
  if (serviceFilter && !preserveState) {
    serviceFilter.textContent = '';
    for (const [value, label] of [['all', 'All services'], ...services.map(value => [value, value])]) {
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
    empty.textContent = state.claimQueueItems.length ? 'No automatic claims match the current filters.' : 'No eligible claims are currently available. Run Step 2, then refresh this queue.';
    list.appendChild(empty);
    updateClaimQueueCount();
    requestBuiltinBrowserLayout();
    return;
  }

  const header = document.createElement('div');
  header.className = 'claim-queue-row header';
  header.append(queueCell('Use'), queueCell('Tracking'), queueCell('Reference'), queueCell('Service'), queueCell('First attempt / delivery'), queueCell('Deadline'), queueCell('Policy / reason'));
  list.appendChild(header);

  for (const item of visibleItems) {
    const row = document.createElement('label');
    row.className = 'claim-queue-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.tracking = item.trackingNumber || '';
    checkbox.setAttribute('aria-label', `Include tracking ${item.trackingNumber || ''}`);
    checkbox.addEventListener('change', updateClaimQueueCount);
    row.appendChild(checkbox);
    row.appendChild(queueCell(item.trackingNumber));
    row.appendChild(queueCell(item.referenceNumber));
    row.appendChild(queueCell(item.serviceCode));
    row.appendChild(queueCell([item.firstAttemptDate, item.deliveryDate].filter(Boolean).join(' / ')));
    row.appendChild(queueCell([item.deadline, item.businessDaysRemaining !== '' ? `${item.businessDaysRemaining} business days left` : ''].filter(Boolean).join(' · ')));
    row.appendChild(queueCell([item.policyVersion, item.eligibilityReason].filter(Boolean).join(' · ')));
    list.appendChild(row);
  }
  updateClaimQueueCount();
  requestBuiltinBrowserLayout();
}

async function refreshClaimQueue() {
  const list = $('claimQueueList');
  if (list) list.innerHTML = '<div class="history-empty">Loading eligible claims…</div>';
  const result = await window.cpApp.previewClaims();
  if (!result?.ok) {
    state.claimQueueItems = [];
    state.claimQueueLoaded = true;
    if (list) list.innerHTML = '';
    if (list) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = result?.error || 'Could not load claims.csv.';
      list.appendChild(empty);
    }
    updateClaimQueueCount();
    return result;
  }
  renderClaimQueue(result.items || []);
  const search = String($('claimQueueSearch')?.value || '').trim();
  const [reviewRequired, trackingErrors, onTime] = await Promise.all([
    window.cpApp.listClassificationQueue({ classification: 'REVIEW_REQUIRED', search }),
    window.cpApp.listClassificationQueue({ classification: 'TRACKING_ERROR', search }),
    window.cpApp.listClassificationQueue({ classification: 'ON_TIME', search })
  ]);
  renderClassificationQueue('step3ManualQueue', 'step3ManualCount', [...(reviewRequired.items || []), ...(trackingErrors.items || [])]);
  renderClassificationQueue('step3IneligibleQueue', 'step3IneligibleCount', onTime.items || []);
  return result;
}

function renderStep3Preflight(report) {
  const list = $('step3PreflightList');
  const summary = $('step3PreflightSummary');
  state.step3Preflight = report || null;
  if (!list || !summary) return;
  list.textContent = '';

  if (!report) {
    summary.textContent = 'Unavailable';
    summary.className = 'pill bad';
    return;
  }

  summary.textContent = report.ready
    ? (report.warningCount ? `Ready · ${report.warningCount} warning` : 'Ready')
    : `${report.blockingCount} blocking issue${report.blockingCount === 1 ? '' : 's'}`;
  summary.className = `pill ${report.ready ? (report.warningCount ? 'warn' : 'good') : 'bad'}`;

  for (const item of report.checks || []) {
    const row = document.createElement('div');
    const kind = item.ok ? 'good' : (item.severity === 'warning' ? 'warning' : 'bad');
    row.className = `preflight-item ${kind}`;
    const icon = document.createElement('div');
    icon.className = 'preflight-icon';
    icon.textContent = item.ok ? '✓' : (item.severity === 'warning' ? '!' : '×');
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.label || item.id || 'Check';
    const detail = document.createElement('span');
    detail.textContent = [item.message, !item.ok ? item.action : ''].filter(Boolean).join(' ');
    copy.append(title, detail);
    row.append(icon, copy);
    list.appendChild(row);
  }
}

async function runStep3Preflight() {
  const result = await window.cpApp.runPreflight({
    scope: 'step3',
    submitOptions: collectUserSettingsOptions()
  });
  if (!result?.ok) {
    renderStep3Preflight(null);
    return null;
  }
  renderStep3Preflight(result.report);
  return result.report;
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
  resolver?.(Boolean(confirmed));
}

function confirmLiveSubmission(selectedCount, canaryMode) {
  const modal = $('liveSubmitModal');
  const summary = $('liveSubmitSummary');
  if (!modal || !summary) return Promise.resolve(false);
  summary.textContent = '';
  const lines = [
    `Selected claims: ${selectedCount}`,
    `Mode: ${canaryMode ? 'Canary — only the first selected claim will be processed' : 'Full selected queue'}`,
    'Browser: Built-in Canada Post browser',
    'Dry run: Off'
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

function buildSubmitOnlyOptions(liveSubmissionConfirmed = false) {

  return {
    ...collectUserSettingsOptions(),
    browserMode: 'builtin',
    afterSubmitMs: 20000,
    maxClaims: null,
    dryRun: Boolean($('dryRun')?.checked),
    selectedTrackingNumbers: selectedClaimTrackingNumbers(),
    expectedClaimCount: selectedClaimTrackingNumbers().length,
    canaryMode: Boolean($('canaryMode')?.checked),
    liveSubmissionConfirmed: Boolean(liveSubmissionConfirmed),
    developerMode: false
  };
}

async function startRun(importHistory = false) {
  currentProcessStep = importHistory ? 'step1' : 'step2';
  resetRunUi(currentProcessStep);
  setStatus('Running', 'warn', currentProcessStep);
  setAction(importHistory ? 'Importing shipping history, then running tracking and claims.' : 'Starting tracking and claims run.');

  const res = await window.cpApp.startRun(buildRunOptions(importHistory));
  if (!res.ok) {
    finishBuiltinBrowserActivity('Could not start browser workflow', 'error');
    setStatus('Failed', 'bad');
    setAction(res.error || 'Could not start run.');
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
  setAction('Checking tracking.csv and creating claims.csv for late shipments.', 'step2');

  const res = await window.cpApp.runTracking(buildTrackingOnlyOptions());
  if (!res.ok) {
    setStatus('Failed', 'bad');
    setAction(res.error || 'Could not start tracking check.');
    updateCurrentItem({ step: 'Could not start tracking check', result: res.error || 'Failed', kind: 'failed' });
    addNeedsReview('failed', '—', res.error || 'Could not start tracking check', '—', '', {
      kind: 'failed',
      result: 'Tracking start failed',
      status: 'Tracking start failed',
      message: res.error || 'Could not start tracking check'
    });
    log(res.error || 'Could not start tracking check.');
    operations.finishedAt = Date.now();
    stopOperationsTimer();
    updateCounters();
    return;
  }

  log('Tracking check started.');
}

async function testTrackingConnection() {
  const confirmed = window.confirm('Obtain an OAuth token when needed and run exactly one current Tracking API JSON lookup? This diagnostic does not modify claims, eligibility state, queues, or summary counts and will not continue into the full run.');
  if (!confirmed) return;
  currentProcessStep = 'step2';
  setStatus('Diagnostic running', 'warn', 'step2');
  setAction('Testing the selected Developer Portal Tracking API environment with one authorized shipment.', 'step2');
  log('One-request OAuth/JSON diagnostic deliberately confirmed. Configuration, token, resource, and state-integrity stages will be reported without secrets.', '', 'step2');
  const res = await window.cpApp.runTracking({
    ...buildTrackingOnlyOptions(),
    fresh: false,
    diagnosticMode: true,
    diagnosticConfirmed: true,
    diagnosticRow: Math.max(1, Number.parseInt(getFieldValue('diagnosticRow') || '1', 10) || 1)
  });
  if (!res.ok) {
    setStatus('Diagnostic blocked', 'bad', 'step2');
    setAction(res.error || 'Could not start one-request API diagnostic.', 'step2');
    log(res.error || 'Could not start one-request API diagnostic.', 'log-submit-error', 'step2');
  }
}

async function exportTrackingStructure() {
  const confirmed = window.confirm('Make exactly one authorized Tracking API request and export a sanitized structural report? The raw JSON body and shipment values will not be saved. Claim and queue state will remain unchanged.');
  if (!confirmed) return;
  currentProcessStep = 'step2';
  setStatus('Structural diagnostic running', 'warn', 'step2');
  setAction('Generating a value-free structural report from one authorized Tracking API response.', 'step2');
  const res = await window.cpApp.runTracking({
    ...buildTrackingOnlyOptions(),
    fresh: false,
    diagnosticMode: true,
    diagnosticConfirmed: true,
    structureExport: true,
    diagnosticRow: Math.max(1, Number.parseInt(getFieldValue('diagnosticRow') || '1', 10) || 1)
  });
  if (!res.ok) {
    setStatus('Structural diagnostic blocked', 'bad', 'step2');
    setAction(res.error || 'Could not start sanitized structural diagnostic.', 'step2');
  }
}

async function discardIncompleteTracking() {
  const confirmed = window.confirm('Discard the active incomplete Step 2 staging state? Historical completed runs will be preserved.');
  if (!confirmed) return;
  const result = await window.cpApp.discardIncompleteTracking({ confirmed: true });
  if (!result.ok) return window.alert(result.error || 'Could not discard incomplete Step 2 state.');
  setStatus('Incomplete run discarded', '', 'step2');
  setAction(result.message || 'Incomplete Step 2 staging was discarded; completed history was preserved.', 'step2');
  await refreshClaimQueue();
}

async function startSubmitOnly() {
  currentProcessStep = 'step3';
  const missing = validateSettingsForStep('step3');
  if (missing.length) {
    setStatus('Failed', 'bad', 'step3');
    setAction(`Missing settings: ${missing.join(', ')}. Open User Settings.`, 'step3');
    log(`Missing settings: ${missing.join(', ')}. Open User Settings.`, 'log-late', 'step3');
    return;
  }

  if (!state.claimQueueLoaded) await refreshClaimQueue();
  const selected = selectedClaimTrackingNumbers();
  if (!selected.length) {
    setStatus('Blocked', 'bad', 'step3');
    setAction('No claims are selected in the Step 3 review queue.', 'step3');
    log('No claims are selected. Refresh the queue and select at least one eligible claim.', 'log-submit-error', 'step3');
    return;
  }

  const preflight = await runStep3Preflight();
  if (!preflight?.ready) {
    setStatus('Blocked', 'bad', 'step3');
    setAction('Step 3 preflight found blocking issues. Resolve them before running claims.', 'step3');
    log('Step 3 was blocked by the readiness check.', 'log-submit-error', 'step3');
    return;
  }

  const dryRun = Boolean($('dryRun')?.checked);
  const canaryMode = Boolean($('canaryMode')?.checked);
  let liveSubmissionConfirmed = false;
  if (!dryRun) {
    liveSubmissionConfirmed = await confirmLiveSubmission(selected.length, canaryMode);
    if (!liveSubmissionConfirmed) {
      setStatus('Cancelled', '', 'step3');
      setAction('Live submission cancelled before the browser workflow started.', 'step3');
      log('Live submission cancelled.', 'log-warning', 'step3');
      return;
    }
  }

  resetRunUi('step3');
  setStatus('Running', 'warn', 'step3');
  setBuiltinBrowserActivity(true, 'Starting built-in browser workflow…');
  setAction(dryRun
    ? `Dry run: validating ${selected.length} selected claim(s) and stopping before final review/submission.`
    : (canaryMode ? 'Canary live run: processing the first selected claim only.' : `Submitting ${selected.length} selected claim(s).`), 'step3');
  requestBuiltinBrowserLayout();
  if (window.cpApp?.showBuiltinBrowser) {
    const bounds = builtinBrowserBounds();
    if (bounds) await window.cpApp.showBuiltinBrowser({ bounds }).catch(() => {});
  }

  const res = await window.cpApp.runSubmit(buildSubmitOnlyOptions(liveSubmissionConfirmed));
  if (!res.ok) {
    setStatus('Failed', 'bad');
    setAction(res.error || 'Could not start claim submission.');
    updateCurrentItem({ step: 'Could not start claim submission', result: res.error || 'Failed', kind: 'failed' });
    addNeedsReview('failed', '—', res.error || 'Could not start claim submission', '—', '', {
      kind: 'failed',
      result: 'Submission start failed',
      status: 'Submission start failed',
      message: res.error || 'Could not start claim submission'
    });
    log(res.error || 'Could not start claim submission.');
    operations.finishedAt = Date.now();
    stopOperationsTimer();
    updateCounters();
    return;
  }

  log(dryRun
    ? `Dry run started for ${res.selectedClaimCount || selected.length} selected claim(s). The runner will stop on the sender/contact page.`
    : (canaryMode ? 'Canary live run started. Only the first selected claim will be processed.' : `Live claim submission started for ${res.selectedClaimCount || selected.length} selected claim(s).`));
  resizeBuiltinBrowserToSlot();
}

async function refreshConfig() {
  const cfg = await window.cpApp.loadConfig();
  state.isolatedTestMode = cfg.isolatedTestMode === true;
  const isolatedBanner = $('isolatedTestBanner');
  if (isolatedBanner) isolatedBanner.hidden = !state.isolatedTestMode;
  if ($('isolatedTestPath')) $('isolatedTestPath').textContent = state.isolatedTestMode ? String(cfg.isolatedUserDataPath || '') : '';
  if (state.isolatedTestMode) document.title = 'Canada Post Claim Runner [ISOLATED TEST DATA]';
  for (const id of ['runSubmitOnly', 'runSiteHealth', 'checkForUpdates', 'createBackup', 'restoreBackup', 'createDiagnostics', 'exportHistory']) {
    const control = $(id);
    if (!control) continue;
    control.disabled = state.isolatedTestMode;
    if (state.isolatedTestMode) control.title = 'Disabled while isolated test data is active.';
  }
  state.passwordStored = !!cfg.passwordStored;
  state.apiCredentialsStored = !!(cfg.apiCredentialsStored || cfg.hasApiCredentials);
  state.apiEnvironment = cfg.apiEnvironment || 'production';
  state.trackingApiCredentialsStored = !!(cfg.trackingApiCredentialsStored || cfg.hasTrackingApiCredentials);
  state.trackingApiEnvironment = cfg.trackingApiEnvironment || 'test';
  state.trackingDiagnosticGateSatisfied = !!cfg.trackingDiagnosticGateSatisfied;
  state.trackingApiVersion = cfg.trackingApiVersion || '1.0.0';
  if ($('trackingRequestDelayMs')) $('trackingRequestDelayMs').value = String(Math.max(3100, Number(cfg.trackingRequestDelayMs || 3100)));
  if ($('trackingResourceTimeoutMs')) $('trackingResourceTimeoutMs').value = String(cfg.trackingResourceTimeoutMs || 45000);
  await applyLocale(cfg.locale || 'en-CA');
  if ($('webUsername')) $('webUsername').value = cfg.webUsername || '';
  if ($('webPassword')) {
    $('webPassword').value = '';
    $('webPassword').placeholder = state.passwordStored ? 'Saved password available — leave blank to reuse' : 'Web login password';
  }
  if ($('apiUsername')) { $('apiUsername').value = ''; $('apiUsername').placeholder = state.apiCredentialsStored ? 'Saved API username available — enter both fields to replace' : 'API key username — not website login'; }
  if ($('apiPassword')) { $('apiPassword').value = ''; $('apiPassword').placeholder = state.apiCredentialsStored ? 'Saved API password available — enter both fields to replace' : 'API key password — not EST password'; }
  if ($('apiEnvironment')) $('apiEnvironment').value = state.apiEnvironment;
  renderApiCredentialMetadata(cfg.apiCredentialMetadata || {});
  if ($('trackingClientId')) { $('trackingClientId').value = ''; $('trackingClientId').placeholder = state.trackingApiCredentialsStored ? 'Saved API Key available — enter both current fields to replace' : 'Developer Portal API Key'; }
  if ($('trackingClientSecret')) { $('trackingClientSecret').value = ''; $('trackingClientSecret').placeholder = state.trackingApiCredentialsStored ? 'Saved API Secret available — enter both current fields to replace' : 'Developer Portal API Secret'; }
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
  state.dryRunDefault = Boolean(cfg.dryRunDefault);
  if ($('evidenceRetentionDays')) $('evidenceRetentionDays').value = String(state.evidenceRetentionDays);
  if ($('dryRunDefault')) $('dryRunDefault').checked = state.dryRunDefault;
  if ($('dryRun')) $('dryRun').checked = state.dryRunDefault;
  if ($('appVersion')) $('appVersion').textContent = cfg.appVersion || '0.3.2';
  if ($('buildTrustStatus')) {
    $('buildTrustStatus').textContent = cfg.signedBuild ? 'Production-signed build' : 'Unsigned development build';
    $('buildTrustStatus').className = cfg.signedBuild ? 'pill good' : 'pill warn';
  }
  updateReconciliationBadge(Number(cfg.reconciliationCount || 0));

  const configuredCustomer = cfg.estCustomerNumber || cfg.historyCustomerNumber || cfg.customerNumber || '';
  if ($('historyCustomerNumber')) $('historyCustomerNumber').value = configuredCustomer;
  if ($('historyAutoMobo')) $('historyAutoMobo').checked = true;
  if ($('historyMobo')) $('historyMobo').value = '';
  if ($('historyIncludeNoManifest')) $('historyIncludeNoManifest').checked = true;
  state.developerMode = false;

  const status = $('settingsStatus');
  if (status) {
    const webStatus = state.passwordStored
      ? (cfg.secureCredentialStorage ? 'web password saved with OS encryption' : 'web password saved with device-local encryption')
      : 'web password not saved';
    const apiStatus = state.trackingApiCredentialsStored ? (state.trackingDiagnosticGateSatisfied ? 'Tracking API ready' : 'Tracking API diagnostic required') : 'Tracking API credentials missing';
    status.textContent = `Loaded / ${webStatus} / ${apiStatus}${cfg.credentialBackend ? ` (${cfg.credentialBackend})` : ''}`;
    status.className = state.passwordStored
      ? (cfg.secureCredentialStorage ? 'pill good' : 'pill warn')
      : (state.trackingApiCredentialsStored ? 'pill warn' : 'pill bad');
  }
  if (!cfg.setupCompleted && !setupWizardShown) showSetupWizard(cfg);
}

function showSetupWizard(config) {
  setupWizardShown = true;
  const readiness = config.setupReadiness || {};
  const labels = {
    dataDirectory: 'Application data directory', secureStorage: 'Secure local credential storage',
    accountFields: 'Canada Post account identifier', apiFields: 'Tracking API credentials',
    customerNumber: 'Customer number', senderInformation: 'Sender information',
    contactInformation: 'Main contact information', browserAvailable: 'Bundled browser runtime',
    databaseHealth: 'Database health', policyAvailable: 'Versioned policy data'
  };
  const requiredForDryRun = ['dataDirectory', 'secureStorage', 'accountFields', 'apiFields', 'customerNumber', 'senderInformation', 'contactInformation', 'browserAvailable', 'databaseHealth', 'policyAvailable'];
  const rows = requiredForDryRun.map(key => {
    const ready = readiness[key] === true;
    return `<div class="preflight-item ${ready ? 'pass' : 'warning'}"><div class="preflight-icon" aria-hidden="true">${ready ? '✓' : '!'}</div><div><strong>${labels[key]}</strong><span>${ready ? tr('status.ready', 'Ready') : tr('status.setupRequired', 'Setup required')}</span></div></div>`;
  });
  rows.push('<div class="preflight-item warning"><div class="preflight-icon" aria-hidden="true">!</div><div><strong>Network and account validation</strong><span>Not tested automatically; run only through an explicit user action.</span></div></div>');
  $('setupReadinessList').innerHTML = rows.join('');
  $('setupWizard').classList.remove('hidden');
  $('setupWizard').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('setupOpenSettings')?.focus(), 0);
}

async function finishSetupWizard() {
  await window.cpApp.saveConfig({ setupCompleted: true });
  $('setupWizard')?.classList.add('hidden');
  $('setupWizard')?.setAttribute('aria-hidden', 'true');
  setAction('Setup recorded. Tracking and dry-run readiness still depend on the checks shown in Settings.', 'settingsTab');
}


$('saveUserSettings')?.addEventListener('click', async () => {
  await saveUserSettings(true);
});

$('selectCsv')?.addEventListener('click', async () => {
  const res = await window.cpApp.selectTrackingCsv();
  if (res.ok) log('tracking.csv selected.');
  await refreshConfig();
});

$('openData')?.addEventListener('click', () => window.cpApp.openDataFolder());
$('openLogs')?.addEventListener('click', () => window.cpApp.openLogsFolder());
$('openStep3Diagnostics')?.addEventListener('click', async () => {
  const result = await window.cpApp.openStep3Diagnostics();
  if (!result?.ok) log(result?.error || 'No Step 3 diagnostics are available yet.', 'log-warning', 'step3');
});
$('refreshHistory')?.addEventListener('click', () => refreshHistory());
$('historyStatusFilter')?.addEventListener('change', () => refreshHistory());
let historySearchTimer = null;
$('historySearch')?.addEventListener('input', () => {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => refreshHistory(), 250);
});
$('exportHistory')?.addEventListener('click', exportClaimHistory);
$('createBackup')?.addEventListener('click', createAppBackup);
$('restoreBackup')?.addEventListener('click', restoreAppBackup);
$('refreshBrowserSession')?.addEventListener('click', refreshBrowserSessionStatus);
$('clearBrowserSession')?.addEventListener('click', clearBrowserSession);
$('refreshFinancialReport')?.addEventListener('click', refreshFinancialReport);
$('recordFinancialEntry')?.addEventListener('click', recordFinancialEntry);
$('cancelBackupPassword')?.addEventListener('click', () => closeBackupPasswordModal(''));
$('confirmBackupPassword')?.addEventListener('click', submitBackupPassword);
$('backupPassword')?.addEventListener('keydown', event => { if (event.key === 'Enter') submitBackupPassword(); if (event.key === 'Escape') closeBackupPasswordModal(''); });
$('setupOpenSettings')?.addEventListener('click', () => { $('setupWizard')?.classList.add('hidden'); $('setupWizard')?.setAttribute('aria-hidden', 'true'); activateTab('settingsTab'); $('webUsername')?.focus(); });
$('setupFinish')?.addEventListener('click', finishSetupWizard);
$('createDiagnostics')?.addEventListener('click', createDiagnosticZip);
$('runSiteHealth')?.addEventListener('click', runSiteHealthCheck);
$('addManualShipment')?.addEventListener('click', addManualShipment);
$('checkForUpdates')?.addEventListener('click', async () => {
  const res = await window.cpApp.openUpdatePage();
  const message = res?.message || res?.error || (res?.ok ? 'Opened update page.' : 'Could not open update page.');
  const status = $('settingsStatus');
  if (status) {
    status.textContent = res?.ok ? 'Update page opened' : 'Update URL not configured';
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
    ? 'Developer mode enabled. New runs will show raw Canada Post API logs in the live log. Credentials are redacted.'
    : 'Developer mode disabled. New runs will show normal summarized logs.');
});

$('historyAutoMobo')?.addEventListener('change', async () => {
  const autoMobo = $('historyAutoMobo').checked;
  if ($('historyMobo')) {
    $('historyMobo').disabled = autoMobo;
    if (autoMobo) $('historyMobo').value = '';
  }
  await window.cpApp.saveConfig({ historyAutoMobo: autoMobo, historyMobo: autoMobo ? '' : (($('historyMobo')?.value || '').trim()) });
  log(autoMobo
    ? 'MOBO auto-discovery enabled. The manual MOBO field will be ignored on the next history import.'
    : 'MOBO auto-discovery disabled. The manual MOBO field will be used on the next history import.');
});

$('backToOperations')?.addEventListener('click', showOperationsList);
$('openScreenshot')?.addEventListener('click', async () => {
  if (!selectedDetail?.screenshotPath) return;
  const res = await window.cpApp.openEvidence(selectedDetail.screenshotPath);
  if (!res.ok) log(res.error || 'Could not open screenshot.');
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
    else if (modal.id === 'liveSubmitModal') closeLiveSubmitModal(false);
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
    setAction(`Missing settings: ${missing.join(', ')}. Open User Settings.`, 'step1');
    log(`Missing settings: ${missing.join(', ')}. Open User Settings.`, 'log-late', 'step1');
    return;
  }
  setStatus('Running', 'warn', 'step1');
  setAction('Exporting EST Desktop history and generating tracking.csv.', 'step1');

  const res = await window.cpApp.importEstHistory(buildEstHistoryOptions());
  if (!res.ok) {
    setStatus('Failed', 'bad');
    setAction(res.error || 'Could not start EST Desktop history export.');
    log(res.error || 'Could not start EST Desktop history export.');
    operations.finishedAt = Date.now();
    stopOperationsTimer();
    updateCounters();
    return;
  }

  log('EST Desktop history export started.');
});

$('importHistory')?.addEventListener('click', async () => {
  resetRunUi();
  setStatus('Running', 'warn');
  setAction('Importing shipping history into tracking.csv.');

  const res = await window.cpApp.importHistory(buildHistoryOptions());
  if (!res.ok) {
    setStatus('Failed', 'bad');
    setAction(res.error || 'Could not start history import.');
    log(res.error || 'Could not start history import.');
    operations.finishedAt = Date.now();
    stopOperationsTimer();
    updateCounters();
    return;
  }

  log('Shipping history import started.');
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
$('refreshClaimQueue')?.addEventListener('click', async () => { await refreshClaimQueue(); await runStep3Preflight(); });
$('refreshStep3Preflight')?.addEventListener('click', runStep3Preflight);
$('selectAllClaims')?.addEventListener('click', () => { document.querySelectorAll('#claimQueueList input[data-tracking]').forEach(input => { input.checked = true; }); updateClaimQueueCount(); });
$('clearClaimSelection')?.addEventListener('click', () => { document.querySelectorAll('#claimQueueList input[data-tracking]').forEach(input => { input.checked = false; }); updateClaimQueueCount(); });
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
  if (res.ok) log('Stop requested. Waiting for current item to finish.', '', 'step3');
});

document.querySelectorAll('[data-force-stop]').forEach((button) => {
  button.addEventListener('click', async () => {
    const step = button.dataset.forceStop || activeTabId || currentProcessStep || 'step1';
    currentProcessStep = step;
    const res = await window.cpApp.forceStop();
    if (res.ok) log('Force stop sent.', '', step);
    else log(res.error || 'Nothing to force stop.', '', step);
  });
});

window.cpApp.onBrowserActivity?.(({ active, text, kind }) => {
  if (active) setBuiltinBrowserActivity(true, text || 'Loading Canada Post…', kind || '');
  else finishBuiltinBrowserActivity(text || 'Browser ready', kind || '');
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
    if (step === 'step3') finishBuiltinBrowserActivity('Browser workflow failed', 'error');
    operations.finishedAt ||= Date.now();
    stopOperationsTimer();
    setStatus('Failed', 'bad', step);
    if (step === 'step3') {
      addNeedsReview('failed', operations.current.tracking, payload.message || 'Run failed', operations.current.row, '', {
        kind: 'failed',
        tracking: operations.current.tracking,
        row: operations.current.row,
        result: 'Run failed',
        status: 'Run failed',
        message: payload.message || 'Run failed'
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
    if (step === 'step3') finishBuiltinBrowserActivity('Browser workflow stopped');
    operations.finishedAt ||= Date.now();
    stopOperationsTimer();
    setStatus('Stopped', 'warn', step);
  }
  if (payload.message) {
    setAction(payload.message, step);
    log(payload.message, '', step);
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
    updateCurrentItem({ step: `${stage} process running`, result: 'In progress', kind: '' });
    setStatus('Running', 'warn', step);
    log(`${stage} process started.`, '', step);
  }
  if (status === 'finished') {
    if (stage === 'submit') finishBuiltinBrowserActivity(code === 0 ? 'Browser workflow complete' : 'Browser workflow finished with warnings', code === 0 ? '' : 'error');
    if (stage === 'health') setSiteHealthRunning(false);
    log(`${stage} process finished with code ${code}.`, '', step);
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
  await window.cpApp.saveConfig({ locale });
  await applyLocale(locale);
});
