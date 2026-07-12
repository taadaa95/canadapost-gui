const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cpApp', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  selectTrackingCsv: () => ipcRenderer.invoke('file:selectTrackingCsv'),
  importHistory: (options) => ipcRenderer.invoke('history:import', options),
  importEstHistory: (options) => ipcRenderer.invoke('est:importHistory', options),
  openDataFolder: () => ipcRenderer.invoke('folder:openData'),
  openLogsFolder: () => ipcRenderer.invoke('folder:openLogs'),
  openUpdatePage: () => ipcRenderer.invoke('updates:open'),
  loadEvidence: (payload) => ipcRenderer.invoke('evidence:load', payload),
  openEvidence: (filePath) => ipcRenderer.invoke('evidence:open', filePath),
  startRun: (options) => ipcRenderer.invoke('run:start', options),
  runTracking: (options) => ipcRenderer.invoke('tracking:run', options),
  runSubmit: (options) => ipcRenderer.invoke('submit:run', options),
  showBuiltinBrowser: (options) => ipcRenderer.invoke('browser:showBuiltin', options),
  setBuiltinBrowserBounds: (bounds) => ipcRenderer.invoke('browser:setBuiltinBounds', bounds),
  hideBuiltinBrowser: () => ipcRenderer.invoke('browser:hideBuiltin'),
  focusBuiltinBrowser: () => ipcRenderer.invoke('browser:focusBuiltin'),
  requestStop: () => ipcRenderer.invoke('run:requestStop'),
  forceStop: () => ipcRenderer.invoke('run:forceStop'),
  onEvent: (callback) => ipcRenderer.on('event', (_event, payload) => callback(payload)),
  onRun: (callback) => ipcRenderer.on('run', (_event, payload) => callback(payload)),
  onStage: (callback) => ipcRenderer.on('stage', (_event, payload) => callback(payload))
});
