const $ = (id) => document.getElementById(id);

const UI_FIX_VERSION = 'crossplatform-ui-v27';

const THEME_STORAGE_KEY = 'canadapostClaimRunnerTheme';
const DEFAULT_THEME = 'dark';

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

function activateTab(tabId) {
  const target = tabId || 'step1';
  activeTabId = target;
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
  updateNotificationIndicator();
  requestBuiltinBrowserLayout();
}

function stepForStage(stage) {
  if (stage === 'est-history' || stage === 'history') return 'step1';
  if (stage === 'tracking') return 'step2';
  if (stage === 'submit') return 'step3';
  return currentProcessStep || activeTabId || 'step1';
}

function logIdForStep(stepId) {
  if (stepId === 'step1') return 'step1Log';
  if (stepId === 'step2') return 'step2Log';
  if (stepId === 'step3') return 'step3Log';
  return 'step1Log';
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

function useBuiltinBrowser() {
  return $('builtinBrowser') ? $('builtinBrowser').checked : false;
}

function setBuiltinBrowserStatus(text, kind = '') {
  const status = $('builtinBrowserStatus');
  if (!status) return;
  status.textContent = text;
  status.className = `pill ${kind}`.trim();
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
  if (rect.width < 80 || rect.height < 80) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
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
    if (!bounds) return;
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

window.addEventListener('resize', () => requestBuiltinBrowserLayout());

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
  overdueInTransit: 0,
  reviewRequired: 0,
  trackingErrors: 0,
  skipped: 0,
  submitted: 0,
  alreadySubmitted: 0,
  failed: 0,
  submitTotal: 0,
  developerMode: false,
  passwordStored: false
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
  if (/^(?:\[(?:est-history|history|tracking|submit)\]\s*)?(?:warning|warn)\b|warnings?:\s*[1-9]|not recommended/i.test(clean)) return 'log-warning';
  if (/^(?:\[(?:est-history|history|tracking|submit)\]\s*)?ERROR\b|failed with code|stage failed|process finished with code [1-9]|Failed:\s*[1-9]|Could not|Missing .*\bsetting/i.test(clean)) return 'log-submit-error';
  if (/^(\[DEV RAW\]|\[(history|tracking|submit|est-history)\] \[DEV RAW\])/i.test(clean)) return 'log-dev';

  return '';
}

function log(message, cls = '', stepId = null) {
  const el = $(logIdForStep(stepId || activeTabId || currentProcessStep || 'step1'));
  if (!el) return;

  const text = String(message || '');
  const detectedClass = classifyLogLine(text);
  const line = document.createElement('div');
  line.className = `log-line ${cls || detectedClass}`.trim();
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function logStage(stage, message, cls = '') {
  log(message, cls, stepForStage(stage));
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
  return state.submitted + state.alreadySubmitted + state.failed;
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
    state.overdueInTransit = 0;
    state.reviewRequired = 0;
    state.trackingErrors = 0;
    state.skipped = 0;
  }

  if (step === 'step3') {
    state.submitted = 0;
    state.alreadySubmitted = 0;
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
  return ` | expected ${trackingDate(event.expectedDate)} | delivered ${trackingDate(event.deliveryDate)}`;
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

  if (stage === 'est-history') {
    if (type === 'est_endpoint') return event.message || `EST Desktop API endpoint: ${event.host || ''}`;
    if (type === 'est_start') {
      operations.runStartedAt ||= Date.now();
      updateCurrentItem({ step: 'Exporting EST Desktop history', result: 'In progress', kind: '' });
      setAction(`Exporting EST Desktop history from ${event.from} to ${event.to}.`);
      return `EST Desktop export started: ${event.from} to ${event.to}. Customer ${event.customerNumber || '—'}, workgroup ${event.workgroup || 'auto'}, MOBO ${event.mobo || '-2'}, category ${event.categoryGroup || 'SHP'}.`;
    }
    if (type === 'est_connect') return `EST connect succeeded. Raw connect response saved.`;
    if (type === 'est_workgroups') {
      state.step1Workgroups = event.count || 0;
      return `EST workgroups ${event.mode || 'auto'}: ${event.count || 0}${event.workgroups ? ` (${event.workgroups.join(', ')})` : ''}.`;
    }
    if (type === 'est_mobos') return `EST MOBO diagnostic for workgroup ${event.workgroup || '—'}: ${event.count || 0} values.`;
    if (type === 'est_probe') return event.message || `EST probe: ${event.url || ''}`;
    if (type === 'est_orders') {
      state.step1Orders += event.count || 0;
      return `EST order IDs found for workgroup ${event.workgroup || '—'} using ${event.dateFormat || 'date'} dates: ${event.count || 0}.`;
    }
    if (type === 'est_export') {
      if (Object.prototype.hasOwnProperty.call(event, 'manifestItemsParsed')) {
        state.step1TotalRows += event.manifestItemsParsed || 0;
        return `EST export chunk ${event.chunk || '?'} parsed. Orders: ${event.orders || 0}; ManifestItems rows: ${event.manifestItemsParsed || 0}.`;
      }
      return `EST export chunk ${event.chunk || '?'} started. Orders: ${event.orders || 0}; filetypes=${event.fileTypes || '2'}.`;
    }
    if (type === 'est_imported') {
      state.step1Imported = event.current || (state.step1Imported + 1);
      updateCurrentItem({
        tracking: event.pin || operations.current.tracking,
        step: 'Importing EST Desktop history',
        result: `${event.current || 0} imported`,
        kind: ''
      });
      return `Imported EST shipment: ${event.pin} | postal ${event.postalCode || '—'} | reference ${event.reference || '—'}`;
    }
    if (type === 'est_backup') return `Previous tracking.csv backed up before EST import.`;
    if (type === 'est_warning') {
      addStep1Warning(event.message, event);
      return `WARNING: ${event.message}`;
    }
    if (type === 'est_stopped') return `EST Desktop export stopped. Imported so far: ${event.imported || 0}.`;
    if (type === 'est_complete') {
      updateCurrentItem({ step: 'EST Desktop export complete', result: `${event.imported || 0} imported`, kind: '' });
      state.step1Orders = event.orders || state.step1Orders;
      state.step1Imported = event.imported || state.step1Imported;
      if (!state.step1TotalRows && event.imported) state.step1TotalRows = event.imported;
      setStatus('Complete', 'good', 'step1');
      setAction(`EST Desktop export complete. Imported ${event.imported || 0} shipments into tracking.csv.`, 'step1');
      return `EST Desktop export complete. Orders: ${event.orders || 0}. Imported: ${event.imported || 0}. Raw files: ${event.exportDir || 'data/est-export'}.`;
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
    if (type === 'tracking_start') {
      operations.runStartedAt ||= Date.now();
      updateCurrentItem({ step: 'Checking tracking data', result: '—', kind: '' });
      state.trackingTotal = event.total || 0;
      setStatus('Running', 'warn', 'step2');
      return `Tracking stage started. ${state.trackingTotal} rows. Requests spaced ${(event.requestIntervalMs || 3100) / 1000} seconds apart.`;
    }
    if (type === 'tracking_progress') {
      state.checked = event.current || state.checked;
      updateCurrentItem({ step: `Tracking check ${event.current}/${event.total}` });
      return `Tracking progress: ${event.current}/${event.total}`;
    }
    if (type === 'pin_late') {
      state.late += 1;
      setAction(`Late package found: ${event.pin}. Added to claims.csv.`);
      updateCurrentItem({ tracking: event.pin || '—', step: 'Late package found', result: 'Added to claims.csv', kind: 'submitted' });
      return `LATE: ${event.pin}${trackingDateSuffix(event)}`;
    }
    if (type === 'pin_on_time') {
      state.onTime += 1;
      return `On time: ${event.pin}${trackingDateSuffix(event)}`;
    }
    if (type === 'pin_not_delivered') {
      state.notDelivered += 1;
      return `Not delivered yet: ${event.pin}${trackingDateSuffix(event)}`;
    }
    if (type === 'pin_overdue_in_transit') {
      state.overdueInTransit += 1;
      addNeedsReview('warning', event.pin, event.eligibilityReason || 'Overdue but not delivered', event.row || '—', '', {
        kind: 'warning', tracking: event.pin, row: event.row || '—', result: 'Missing-package review', status: 'Overdue in transit', message: event.eligibilityReason || ''
      });
      return `OVERDUE / NOT DELIVERED: ${event.pin}${trackingDateSuffix(event)} — not added to late-delivery claims.`;
    }
    if (type === 'pin_review_required') {
      state.reviewRequired += 1;
      addNeedsReview('warning', event.pin, event.eligibilityReason || 'Eligibility review required', event.row || '—', '', {
        kind: 'warning', tracking: event.pin, row: event.row || '—', result: 'Eligibility review', status: event.classification || 'Review required', message: event.eligibilityReason || ''
      });
      return `REVIEW REQUIRED: ${event.pin} | service ${event.serviceCode || 'unknown'} | ${event.eligibilityReason || 'Insufficient eligibility data'}`;
    }
    if (type === 'pin_error') {
      state.trackingErrors += 1;
      return `ERROR checking ${event.pin || 'tracking row'}: ${event.message || 'Unknown tracking error'}`;
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
      updateCurrentItem({ step: 'Tracking complete', result: `${eligible} eligible claims` });
      setStatus(errors > 0 ? 'Warnings' : 'Complete', errors > 0 ? 'warn' : 'good', 'step2');
      setAction(`Tracking complete: ${eligible} eligible, ${overdue} overdue/not delivered, ${review} review required, ${errors} errors.`, 'step2');
      return `Tracking complete. Eligible late claims: ${eligible}. Overdue/not delivered: ${overdue}. Review required: ${review}. Errors: ${errors}.`;
    }
  }

  if (stage === 'submit') {
    if (type === 'submit_start') {
      operations.submitStartedAt = Date.now();
      state.submitTotal = event.total || 0;
      setStatus('Running', 'warn', 'step3');
      updateCurrentItem({ step: 'Claim submission started', result: '—', kind: '' });
      return `Claim submission started. ${state.submitTotal} claims.`;
    }
    if (type === 'claim_start') {
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
      updateCurrentItem({ step: 'CAPTCHA still active', result: 'Waiting for manual solve', kind: 'already' });
      setAction(event.message || 'Still waiting for CAPTCHA solve.', 'step3');
      return event.message || `Still waiting for CAPTCHA solve for ${event.trackingNumber || 'current claim'}.`;
    }
    if (type === 'captcha_cleared') {
      updateCurrentItem({ step: 'CAPTCHA cleared', result: 'Resuming', kind: '' });
      setStatus('Running', 'warn', 'step3');
      setAction(event.message || 'CAPTCHA cleared. Resuming claim submission.', 'step3');
      return event.message || `CAPTCHA cleared for ${event.trackingNumber || 'current claim'}. Resuming.`;
    }
    if (type === 'claim_wait') {
      updateCurrentItem({ tracking: event.trackingNumber || operations.current.tracking, step: 'Waiting for Canada Post result', result: 'In progress', kind: '' });
      setAction(`Waiting for Canada Post result for ${event.trackingNumber}. Timeout: ${Math.round((event.ms || 0) / 1000)} seconds.`);
      return `Waiting for Canada Post result: ${Math.round((event.ms || 0) / 1000)} seconds`;
    }
    if (type === 'claim_submitted') {
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
    if (type === 'claim_error') {
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
      operations.finishedAt = Date.now();
      updateCurrentItem({ step: 'Submission complete', result: 'Done', kind: '' });
      setStatus('Complete', 'good', 'step3');
      setAction(`Submission complete. Succeeded: ${event.succeeded}, Already submitted: ${event.alreadySubmitted || 0}, Failed: ${event.failed}.`, 'step3');
      stopOperationsTimer();
      return `Submission complete. Succeeded: ${event.succeeded}, Already submitted: ${event.alreadySubmitted || 0}, Failed: ${event.failed}`;
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
    claimContactEmail: getFieldValue('claimContactEmail')
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
  if (res.ok) {
    state.passwordStored = !!res.passwordStored;
    const status = $('settingsStatus');
    if (status) {
      status.textContent = res.warning || (state.passwordStored ? 'Saved with encrypted password' : 'Saved without password');
      status.className = res.warning ? 'pill warn' : 'pill good';
    }
    if ($('webPassword')) $('webPassword').value = '';
    if (showLog) log(res.warning || 'User settings saved.', res.warning ? 'log-warning' : '', 'step1');
  }
  return res;
}

function buildEstHistoryOptions() {
  return {
    ...collectUserSettingsOptions(),
    estFrom: $('estFrom')?.value || $('historyFrom')?.value || '',
    estTo: $('estTo')?.value || $('historyTo')?.value || '',
    estWorkgroup: '',
    estMobo: '-2',
    estCategoryGroup: 'SHP',
    estFileTypes: '2',
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
    importHistory,
    ...buildHistoryOptions()
  };
}

function buildTrackingOnlyOptions() {
  return {
    fresh: $('freshTracking') ? $('freshTracking').checked : true,
    developerMode: false
  };
}

function buildSubmitOnlyOptions() {
  return {
    ...collectUserSettingsOptions(),
    browserMode: useBuiltinBrowser() ? 'builtin' : 'external',
    afterSubmitMs: 20000,
    maxClaims: null,
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

async function startSubmitOnly() {
  currentProcessStep = 'step3';
  resetRunUi('step3');
  const missing = validateSettingsForStep('step3');
  if (missing.length) {
    setStatus('Failed', 'bad', 'step3');
    setAction(`Missing settings: ${missing.join(', ')}. Open User Settings.`, 'step3');
    log(`Missing settings: ${missing.join(', ')}. Open User Settings.`, 'log-late', 'step3');
    return;
  }
  setStatus('Running', 'warn', 'step3');
  setAction('Submitting claims from claims.csv.', 'step3');
  requestBuiltinBrowserLayout();
  if (useBuiltinBrowser() && window.cpApp?.showBuiltinBrowser) {
    const bounds = builtinBrowserBounds();
    if (bounds) await window.cpApp.showBuiltinBrowser({ bounds }).catch(() => {});
  }

  const res = await window.cpApp.runSubmit(buildSubmitOnlyOptions());
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

  log(useBuiltinBrowser() ? 'Claim submission started in built-in browser mode.' : 'Claim submission started in external browser mode.');
  resizeBuiltinBrowserToSlot();
}

async function refreshConfig() {
  const cfg = await window.cpApp.loadConfig();
  state.passwordStored = !!cfg.passwordStored;
  if ($('webUsername')) $('webUsername').value = cfg.webUsername || '';
  if ($('webPassword')) {
    $('webPassword').value = '';
    $('webPassword').placeholder = state.passwordStored ? 'Encrypted password stored — leave blank to reuse' : 'Web login password';
  }
  if ($('rememberSettings')) $('rememberSettings').checked = Object.prototype.hasOwnProperty.call(cfg, 'rememberSettings') ? !!cfg.rememberSettings : true;

  if ($('historyFrom') && !$('historyFrom').value) $('historyFrom').value = cfg.historyFrom || isoDateFromOffset(-14);
  if ($('historyTo') && !$('historyTo').value) $('historyTo').value = cfg.historyTo || isoDateFromOffset(0);

  if ($('estFrom') && !$('estFrom').value) $('estFrom').value = cfg.estFrom || cfg.historyFrom || isoDateFromOffset(-14);
  if ($('estTo') && !$('estTo').value) $('estTo').value = cfg.estTo || cfg.historyTo || isoDateFromOffset(0);
  if ($('estCustomerNumber') && !$('estCustomerNumber').value) $('estCustomerNumber').value = cfg.estCustomerNumber || cfg.historyCustomerNumber || cfg.customerNumber || '';
  if ($('estWorkgroup')) $('estWorkgroup').value = '';
  if ($('estMobo')) $('estMobo').value = '-2';
  if ($('estCategoryGroup')) $('estCategoryGroup').value = 'SHP';
  if ($('estFileTypes')) $('estFileTypes').value = '2';

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

  const configuredCustomer = cfg.estCustomerNumber || cfg.historyCustomerNumber || cfg.customerNumber || '';
  if ($('historyCustomerNumber')) $('historyCustomerNumber').value = configuredCustomer;
  if ($('historyAutoMobo')) $('historyAutoMobo').checked = true;
  if ($('historyMobo')) $('historyMobo').value = '';
  if ($('historyIncludeNoManifest')) $('historyIncludeNoManifest').checked = true;
  state.developerMode = false;

  const status = $('settingsStatus');
  if (status) {
    const webStatus = state.passwordStored ? 'web password encrypted' : 'web password not saved';
    const apiStatus = (cfg.apiCredentialsStored || cfg.hasApiCredentials) ? 'API credentials ready' : 'API credentials missing';
    status.textContent = `Loaded / ${webStatus} / ${apiStatus}${cfg.credentialBackend ? ` (${cfg.credentialBackend})` : ''}`;
    status.className = (cfg.apiCredentialsStored || cfg.hasApiCredentials) ? 'pill' : 'pill bad';
  }
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
  if (event.key === 'Escape') closeStep1Warnings();
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
$('builtinBrowser')?.addEventListener('change', requestBuiltinBrowserLayout);
$('runSubmitOnly')?.addEventListener('click', startSubmitOnly);

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

window.cpApp.onEvent(({ stage, event }) => {
  const message = describeEvent(stage, event);
  if (message) logStage(stage, `[${stage}] ${message}`);
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
  if (payload.status === 'stopped') {
    operations.finishedAt ||= Date.now();
    stopOperationsTimer();
    setStatus('Stopped', 'warn', step);
  }
  if (payload.message) {
    setAction(payload.message, step);
    log(payload.message, '', step);
  }
  updateCounters();
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
  if (status === 'finished') log(`${stage} process finished with code ${code}.`, '', step);
});

initThemePicker();
initStepTabs();
refreshConfig();
updateCounters();
