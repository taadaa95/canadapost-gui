'use strict';

const assert = require('assert');
const net = require('net');
const { once } = require('events');
const { createMockPortal } = require('../mock-portal/server');

(async () => {
  const portal = createMockPortal();
  const origin = await portal.start();
  const url = new URL(origin);
  const socket = net.createConnection({
    host: url.hostname,
    port: Number(url.port)
  });

  try {
    await once(socket, 'connect');
    const startedAt = Date.now();

    await Promise.race([
      portal.close({ timeoutMs: 2000 }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error('Mock portal close remained blocked by an open socket.')),
          3000
        );
      })
    ]);

    assert.ok(
      Date.now() - startedAt < 3000,
      'Mock portal shutdown must remain bounded when a client retains a socket.'
    );
  } finally {
    socket.destroy();
    await portal.close({ timeoutMs: 1000 }).catch(() => {});
  }

  process.stdout.write('Mock portal retained-socket shutdown test passed.\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
