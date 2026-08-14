'use strict';

const { validateIpcPayload } = require('../../lib/ipc-contracts');

const groups = Object.freeze({
  settings: require('./settings'),
  setupAssistant: require('./setup-assistant'),
  step1: require('./step1'),
  step2: require('./step2'),
  step3Browser: require('./step3-browser'),
  historyReconciliation: require('./history-reconciliation'),
  backupsPrivacy: require('./backups-privacy'),
  updates: require('./updates'),
  diagnostics: require('./diagnostics')
});

const ownership = new Map();
for (const [group, channels] of Object.entries(groups)) {
  for (const channel of channels) {
    if (ownership.has(channel)) throw new Error(`IPC channel ${channel} is assigned to multiple feature modules.`);
    ownership.set(channel, group);
  }
}

function createFocusedRegistrar(ipcMain) {
  const registered = new Set();
  return (channel, handler) => {
    if (!ownership.has(channel)) throw new Error(`IPC channel ${channel} has no focused module owner.`);
    if (registered.has(channel)) throw new Error(`IPC channel ${channel} was registered more than once.`);
    if (typeof handler !== 'function') throw new TypeError(`IPC handler ${channel} must be a function.`);
    registered.add(channel);
    ipcMain.handle(channel, (event, payload, ...rest) => {
      try {
        return handler(event, validateIpcPayload(channel, payload), ...rest);
      } catch (error) {
        if (String(error?.code || '').startsWith('IPC_')) {
          return { ok: false, code: error.code, error: error.message };
        }
        throw error;
      }
    });
    return { channel, group: ownership.get(channel) };
  };
}

module.exports = { groups, ownership, createFocusedRegistrar };
