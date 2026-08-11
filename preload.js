'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const subscriptions = new Map();
function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError(`${channel} listener must be a function.`);
  const previous = subscriptions.get(channel);
  if (previous) ipcRenderer.removeListener(channel, previous);
  const listener = (_event, payload) => callback(payload);
  subscriptions.set(channel, listener);
  ipcRenderer.on(channel, listener);
  return () => {
    if (subscriptions.get(channel) !== listener) return;
    subscriptions.delete(channel);
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('cpApp', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: config => ipcRenderer.invoke('config:save', config),
  clearTrackingApiCredentials: options => ipcRenderer.invoke('credentials:clearTrackingApi', options),
  loadLocale: locale => ipcRenderer.invoke('locale:load', locale),
  selectTrackingCsv: () => ipcRenderer.invoke('file:selectTrackingCsv'),
  importHistory: options => ipcRenderer.invoke('history:import', options),
  importEstHistory: options => ipcRenderer.invoke('est:importHistory', options),
  openDataFolder: () => ipcRenderer.invoke('folder:openData'),
  openLogsFolder: () => ipcRenderer.invoke('folder:openLogs'),
  openStep3Diagnostics: () => ipcRenderer.invoke('folder:openStep3Diagnostics'),
  openUpdatePage: () => ipcRenderer.invoke('updates:open'),
  cancelUpdateDownload: () => ipcRenderer.invoke('updates:cancel'),
  loadEvidence: payload => ipcRenderer.invoke('evidence:load', payload),
  openEvidence: filePath => ipcRenderer.invoke('evidence:open', filePath),
  getDashboard: () => ipcRenderer.invoke('dashboard:get'),
  listHistory: options => ipcRenderer.invoke('history:list', options),
  exportHistory: options => ipcRenderer.invoke('history:export', options),
  listReconciliation: () => ipcRenderer.invoke('reconciliation:list'),
  reconcileAttempt: payload => ipcRenderer.invoke('reconciliation:update', payload),
  listClassificationQueue: options => ipcRenderer.invoke('classification:list', options),
  addManualShipment: payload => ipcRenderer.invoke('shipment:manualAdd', payload),
  listManualShipments: options => ipcRenderer.invoke('shipment:listManual', options),
  createBackup: options => ipcRenderer.invoke('backup:create', options),
  restoreBackup: options => ipcRenderer.invoke('backup:restore', options),
  previewPrivacyDeletion: payload => ipcRenderer.invoke('privacy:preview', payload),
  deletePrivacyData: payload => ipcRenderer.invoke('privacy:delete', payload),
  previewSupportBundle: options => ipcRenderer.invoke('diagnostics:preview', options),
  createDiagnostics: options => ipcRenderer.invoke('diagnostics:create', options),
  runPreflight: options => ipcRenderer.invoke('preflight:run', options),
  previewClaims: () => ipcRenderer.invoke('claims:preview'),
  startRun: options => ipcRenderer.invoke('run:start', options),
  runTracking: options => ipcRenderer.invoke('tracking:run', options),
  getTrackingDiagnosticDefaultRow: () => ipcRenderer.invoke('tracking:diagnosticDefaultRow'),
  discardIncompleteTracking: options => ipcRenderer.invoke('tracking:discardIncomplete', options),
  runSubmit: options => ipcRenderer.invoke('submit:run', options),
  prepareBuiltinBrowser: () => ipcRenderer.invoke('browser:prepareBuiltin'),
  builtinBrowserTargetState: () => ipcRenderer.invoke('browser:targetState'),
  syncBuiltinBrowserVisibility: payload => ipcRenderer.invoke('browser:syncVisibility', payload),
  showBuiltinBrowser: options => ipcRenderer.invoke('browser:showBuiltin', options),
  setBuiltinBrowserBounds: bounds => ipcRenderer.invoke('browser:setBuiltinBounds', bounds),
  hideBuiltinBrowser: () => ipcRenderer.invoke('browser:hideBuiltin'),
  focusBuiltinBrowser: () => ipcRenderer.invoke('browser:focusBuiltin'),
  browserSessionStatus: () => ipcRenderer.invoke('browser:sessionStatus'),
  clearBrowserSession: options => ipcRenderer.invoke('browser:clearSession', options),
  requestStop: () => ipcRenderer.invoke('run:requestStop'),
  forceStop: () => ipcRenderer.invoke('run:forceStop'),
  onUpdateProgress: callback => subscribe('updates:progress', callback),
  onEvent: callback => subscribe('event', callback),
  onBrowserActivity: callback => subscribe('browser:activity', callback),
  onBuiltinBrowserDisplayState: callback => subscribe('browser:display-state', callback),
  onBuiltinBrowserVisibilityRequest: callback => subscribe('browser:visibility-request', callback),
  onRun: callback => subscribe('run', callback),
  onStage: callback => subscribe('stage', callback)
});
