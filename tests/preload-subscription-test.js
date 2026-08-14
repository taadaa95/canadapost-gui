'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ownership } = require('../main/ipc');

const listeners = new Map();
const invoked = [];
let exposed;
const ipcRenderer = {
  invoke: async channel => { invoked.push(channel); return {}; },
  on(channel, listener) {
    const bucket = listeners.get(channel) || new Set();
    bucket.add(listener);
    listeners.set(channel, bucket);
  },
  removeListener(channel, listener) {
    listeners.get(channel)?.delete(listener);
  }
};
const sandbox = {
  require(name) {
    assert.strictEqual(name, 'electron');
    return {
      ipcRenderer,
      contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } }
    };
  },
  Map,
  TypeError
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), sandbox);

const calls = [];
const unsubscribeFirst = exposed.onEvent(payload => calls.push(['first', payload]));
const unsubscribeSecond = exposed.onEvent(payload => calls.push(['second', payload]));
assert.strictEqual(listeners.get('event').size, 1, 'repeated renderer initialization must replace the prior listener');
for (const listener of listeners.get('event')) listener({}, { type: 'synthetic' });
assert.deepStrictEqual(calls, [['second', { type: 'synthetic' }]]);
unsubscribeFirst();
assert.strictEqual(listeners.get('event').size, 1, 'stale cleanup must not remove the active listener');
unsubscribeSecond();
assert.strictEqual(listeners.get('event').size, 0);
assert.throws(() => exposed.onRun('not-a-function'), /listener must be a function/i);

for (const [name, method] of Object.entries(exposed)) {
  if (name.startsWith('on')) continue;
  method('synthetic');
}
assert.deepStrictEqual(
  [...new Set(invoked)].sort(),
  [...ownership.keys()].sort(),
  'every exposed invoke channel must have exactly one focused main-process owner'
);

process.stdout.write('Preload subscriptions remain single-owner across repeated initialization.\n');
