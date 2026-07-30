const { contextBridge, ipcRenderer } = require('electron');

function checkForUpdates() {
  return ipcRenderer.invoke('updates:open');
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
}

function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec remaining`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} min remaining`;
}

function ensureUpdateProgress() {
  let overlay = document.getElementById('updateProgressOverlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'updateProgressOverlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'updateProgressTitle');
  overlay.innerHTML = `
    <div class="update-progress-card">
      <div id="updateProgressTitle" class="update-progress-title">Application update</div>
      <div id="updateProgressStage" class="update-progress-stage">Checking for updates…</div>
      <div class="update-progress-track" aria-hidden="true">
        <div id="updateProgressFill" class="update-progress-fill"></div>
      </div>
      <div id="updateProgressPercent" class="update-progress-percent"></div>
      <div id="updateProgressDetail" class="update-progress-detail"></div>
      <button id="updateProgressCancel" type="button">Cancel download</button>
    </div>`;
  const style = document.createElement('style');
  style.textContent = `
    #updateProgressOverlay[hidden] { display: none !important; }
    #updateProgressOverlay {
      position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
      background: rgba(3, 8, 18, 0.72); backdrop-filter: blur(2px); padding: 24px;
    }
    .update-progress-card {
      width: min(560px, calc(100vw - 48px)); border: 1px solid #41516b; background: #101827;
      color: #e8eef8; padding: 24px; box-shadow: 0 20px 70px rgba(0, 0, 0, 0.55);
      font-family: inherit;
    }
    .update-progress-title { font-size: 18px; font-weight: 700; margin-bottom: 10px; }
    .update-progress-stage { font-size: 14px; margin-bottom: 16px; color: #c8d4e8; }
    .update-progress-track { height: 18px; border: 1px solid #41516b; background: #07101f; overflow: hidden; }
    .update-progress-fill { height: 100%; width: 0%; background: #16a34a; transition: width 120ms linear; }
    .update-progress-track.indeterminate .update-progress-fill {
      width: 35%; animation: update-progress-slide 1.1s linear infinite;
    }
    @keyframes update-progress-slide { from { transform: translateX(-120%); } to { transform: translateX(310%); } }
    .update-progress-percent { margin-top: 10px; font-weight: 700; min-height: 20px; }
    .update-progress-detail { margin-top: 4px; color: #9fb0c9; min-height: 20px; }
    #updateProgressCancel {
      margin-top: 18px; width: 100%; min-height: 40px; border: 1px solid #526581;
      background: #1d2a3e; color: #e8eef8; font: inherit; cursor: pointer;
    }
    #updateProgressCancel:hover:not(:disabled) { background: #263650; }
    #updateProgressCancel:disabled { opacity: 0.5; cursor: default; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlay);
  overlay.querySelector('#updateProgressCancel').addEventListener('click', async () => {
    const button = overlay.querySelector('#updateProgressCancel');
    button.disabled = true;
    button.textContent = 'Cancelling…';
    await ipcRenderer.invoke('updates:cancel');
  });
  return overlay;
}

function renderUpdateProgress(payload = {}) {
  const overlay = ensureUpdateProgress();
  if (payload.stage === 'hidden') {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  const stage = overlay.querySelector('#updateProgressStage');
  const track = overlay.querySelector('.update-progress-track');
  const fill = overlay.querySelector('#updateProgressFill');
  const percent = overlay.querySelector('#updateProgressPercent');
  const detail = overlay.querySelector('#updateProgressDetail');
  const cancel = overlay.querySelector('#updateProgressCancel');
  const labels = {
    checking: 'Checking GitHub Releases…',
    connecting: `Connecting to download version ${payload.version || ''}…`,
    downloading: `Downloading version ${payload.version || ''}…`,
    verifying: 'Verifying SHA-256 and package size…',
    ready: 'Download complete and verified.',
    preparing: 'Preparing installation and restart…'
  };
  stage.textContent = labels[payload.stage] || 'Processing update…';
  cancel.disabled = !payload.cancellable;
  cancel.hidden = !payload.cancellable;
  cancel.textContent = 'Cancel download';

  if (payload.stage === 'downloading' && Number.isFinite(payload.ratio)) {
    const ratio = Math.max(0, Math.min(Number(payload.ratio), 1));
    const value = Math.floor(ratio * 100);
    track.classList.remove('indeterminate');
    fill.style.width = `${value}%`;
    percent.textContent = `${value}%`;
    const size = `${formatBytes(payload.received)} / ${formatBytes(payload.total)}`;
    const speed = payload.bytesPerSecond ? `${formatBytes(payload.bytesPerSecond)}/s` : '';
    const eta = formatDuration(payload.etaSeconds);
    detail.textContent = [size, speed, eta].filter(Boolean).join(' • ');
  } else if (payload.stage === 'ready') {
    track.classList.remove('indeterminate');
    fill.style.width = '100%';
    percent.textContent = '100%';
    detail.textContent = 'The package passed size and SHA-256 verification.';
  } else {
    track.classList.add('indeterminate');
    fill.style.width = '';
    percent.textContent = '';
    detail.textContent = payload.stage === 'preparing' ? 'The application will close and restart.' : '';
  }
}

ipcRenderer.on('updates:progress', (_event, payload) => {
  window.addEventListener('DOMContentLoaded', () => renderUpdateProgress(payload), { once: true });
  if (document.body) renderUpdateProgress(payload);
});

// Capture this control until renderer.js is decomposed, preventing the legacy
// handler from overwriting updater status with obsolete text.
window.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('checkForUpdates');
  if (!button) return;
  button.addEventListener('click', async event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const status = document.getElementById('settingsStatus');
    button.disabled = true;
    if (status) {
      status.textContent = 'Checking for updates…';
      status.className = 'pill';
    }
    try {
      const result = await checkForUpdates();
      if (!status) return;
      if (result?.cancelled) {
        status.textContent = 'Update download cancelled';
        status.className = 'pill warn';
      } else if (!result?.ok) {
        status.textContent = result?.error || 'Update check failed';
        status.className = 'pill bad';
      } else if (result.installing) {
        status.textContent = 'Installing update';
        status.className = 'pill good';
      } else if (result.downloaded) {
        status.textContent = 'Update downloaded';
        status.className = 'pill good';
      } else if (result.available) {
        status.textContent = 'Update available';
        status.className = 'pill warn';
      } else {
        status.textContent = 'Application is up to date';
        status.className = 'pill good';
      }
    } finally {
      button.disabled = false;
      renderUpdateProgress({ stage: 'hidden' });
    }
  }, { capture: true });
}, { once: true });

contextBridge.exposeInMainWorld('cpApp', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  clearTrackingApiCredentials: (options) => ipcRenderer.invoke('credentials:clearTrackingApi', options),
  loadLocale: (locale) => ipcRenderer.invoke('locale:load', locale),
  selectTrackingCsv: () => ipcRenderer.invoke('file:selectTrackingCsv'),
  importHistory: (options) => ipcRenderer.invoke('history:import', options),
  importEstHistory: (options) => ipcRenderer.invoke('est:importHistory', options),
  openDataFolder: () => ipcRenderer.invoke('folder:openData'),
  openLogsFolder: () => ipcRenderer.invoke('folder:openLogs'),
  openStep3Diagnostics: () => ipcRenderer.invoke('folder:openStep3Diagnostics'),
  openUpdatePage: checkForUpdates,
  loadEvidence: (payload) => ipcRenderer.invoke('evidence:load', payload),
  openEvidence: (filePath) => ipcRenderer.invoke('evidence:open', filePath),
  getDashboard: () => ipcRenderer.invoke('dashboard:get'),
  getFinancialReport: (options) => ipcRenderer.invoke('financial:get', options),
  recordFinancialEntry: (payload) => ipcRenderer.invoke('financial:record', payload),
  listHistory: (options) => ipcRenderer.invoke('history:list', options),
  exportHistory: (options) => ipcRenderer.invoke('history:export', options),
  listReconciliation: () => ipcRenderer.invoke('reconciliation:list'),
  reconcileAttempt: (payload) => ipcRenderer.invoke('reconciliation:update', payload),
  listManualReviews: (options) => ipcRenderer.invoke('manualReview:list', options),
  listClassificationQueue: (options) => ipcRenderer.invoke('classification:list', options),
  updateManualReview: (payload) => ipcRenderer.invoke('manualReview:update', payload),
  addManualShipment: (payload) => ipcRenderer.invoke('shipment:manualAdd', payload),
  listManualShipments: (options) => ipcRenderer.invoke('shipment:listManual', options),
  createBackup: (options) => ipcRenderer.invoke('backup:create', options),
  restoreBackup: (options) => ipcRenderer.invoke('backup:restore', options),
  createDiagnostics: () => ipcRenderer.invoke('diagnostics:create'),
  runPreflight: (options) => ipcRenderer.invoke('preflight:run', options),
  previewClaims: () => ipcRenderer.invoke('claims:preview'),
  runSiteHealth: (options) => ipcRenderer.invoke('siteHealth:run', options),
  startRun: (options) => ipcRenderer.invoke('run:start', options),
  runTracking: (options) => ipcRenderer.invoke('tracking:run', options),
  discardIncompleteTracking: (options) => ipcRenderer.invoke('tracking:discardIncomplete', options),
  runSubmit: (options) => ipcRenderer.invoke('submit:run', options),
  prepareBuiltinBrowser: () => ipcRenderer.invoke('browser:prepareBuiltin'),
  builtinBrowserTargetState: () => ipcRenderer.invoke('browser:targetState'),
  syncBuiltinBrowserVisibility: (payload) => ipcRenderer.invoke('browser:syncVisibility', payload),
  showBuiltinBrowser: (options) => ipcRenderer.invoke('browser:showBuiltin', options),
  setBuiltinBrowserBounds: (bounds) => ipcRenderer.invoke('browser:setBuiltinBounds', bounds),
  hideBuiltinBrowser: () => ipcRenderer.invoke('browser:hideBuiltin'),
  focusBuiltinBrowser: () => ipcRenderer.invoke('browser:focusBuiltin'),
  browserSessionStatus: () => ipcRenderer.invoke('browser:sessionStatus'),
  clearBrowserSession: (options) => ipcRenderer.invoke('browser:clearSession', options),
  requestStop: () => ipcRenderer.invoke('run:requestStop'),
  forceStop: () => ipcRenderer.invoke('run:forceStop'),
  onEvent: (callback) => ipcRenderer.on('event', (_event, payload) => callback(payload)),
  onBrowserActivity: (callback) => ipcRenderer.on('browser:activity', (_event, payload) => callback(payload)),
  onBuiltinBrowserDisplayState: (callback) => ipcRenderer.on('browser:display-state', (_event, payload) => callback(payload)),
  onBuiltinBrowserVisibilityRequest: (callback) => ipcRenderer.on('browser:visibility-request', (_event, payload) => callback(payload)),
  onRun: (callback) => ipcRenderer.on('run', (_event, payload) => callback(payload)),
  onStage: (callback) => ipcRenderer.on('stage', (_event, payload) => callback(payload))
});