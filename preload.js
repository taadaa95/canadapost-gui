const { contextBridge, ipcRenderer } = require('electron');

function checkForUpdates() {
  return ipcRenderer.invoke('updates:open');
}

// The current renderer still contains the former "open update page" click
// handler. Capture this one control until renderer.js is decomposed, preventing
// that legacy handler from overwriting the result with obsolete status text.
window.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('checkForUpdates');
  if (!button) return;
  button.addEventListener('click', async event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const status = document.getElementById('settingsStatus');
    if (status) {
      status.textContent = 'Checking for updates…';
      status.className = 'pill';
    }
    const result = await checkForUpdates();
    if (!status) return;
    if (!result?.ok) {
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
