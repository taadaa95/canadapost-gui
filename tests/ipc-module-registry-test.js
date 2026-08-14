'use strict';

const assert = require('assert');
const { groups, ownership, createFocusedRegistrar } = require('../main/ipc');

const channels = Object.values(groups).flat();
assert.strictEqual(new Set(channels).size, channels.length, 'every mutation/read channel must have exactly one module owner');
assert.strictEqual(ownership.size, channels.length);
for (const required of ['config:save', 'tracking:run', 'submit:run', 'reconciliation:update', 'privacy:delete', 'updates:open', 'updates:cancel']) {
  assert.ok(ownership.has(required), `${required} must be assigned to a focused IPC module`);
}
const calls = [];
const register = createFocusedRegistrar({ handle: (channel, handler) => calls.push({ channel, handler }) });
const handler = () => ({ ok: true });
assert.deepStrictEqual(register('config:load', handler), { channel: 'config:load', group: 'settings' });
assert.deepStrictEqual(calls[0].handler(), handler());
assert.throws(() => register('config:load', handler), /more than once/);
assert.throws(() => register('unknown:mutation', handler), /no focused module owner/);
assert.throws(() => register('tracking:run', null), /must be a function/);
process.stdout.write('Focused IPC module ownership and registration tests passed.\n');
