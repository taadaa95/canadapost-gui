'use strict';

const assert = require('assert');
const { createSharedContext } = require('../renderer/shared-context');

const context = createSharedContext({ ready: false });
const received = [];
const unsubscribe = context.events.on('readiness', payload => received.push(payload));
context.state.ready = true;
context.events.emit('readiness', { ready: context.state.ready });
unsubscribe();
context.events.emit('readiness', { ready: false });
assert.deepStrictEqual(received, [{ ready: true }]);
assert.throws(() => context.events.on('invalid', null), /must be a function/);
assert.ok(Object.isFrozen(context));
process.stdout.write('Renderer shared state and event interface tests passed.\n');
