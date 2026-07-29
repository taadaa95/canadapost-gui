'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const modulePath = path.resolve(__dirname, '../lib/origin-policy.js');
const production = spawnSync(process.execPath, ['-e', `const p=require(${JSON.stringify(modulePath)});console.log(JSON.stringify([p.isAllowedCanadaPostUrl('https://www.canadapost-postescanada.ca/a'),p.isAllowedCanadaPostUrl('https://evil.example/a'),p.isAllowedCanadaPostUrl('http://127.0.0.1:3210/a')]))`], { encoding: 'utf8' });
assert.strictEqual(production.status, 0);
assert.deepStrictEqual(JSON.parse(production.stdout.trim()), [true, false, false]);

const testMode = spawnSync(process.execPath, ['-e', `const p=require(${JSON.stringify(modulePath)});console.log(JSON.stringify([p.isAllowedCanadaPostUrl('http://127.0.0.1:3210/a'),p.isAllowedCanadaPostUrl('http://localhost:3210/a'),p.portalUrl('https://www.canadapost-postescanada.ca/live','/mock')]))`], {
  encoding: 'utf8',
  env: { ...process.env, NODE_ENV: 'test', MOCK_PORTAL_ORIGIN: 'http://127.0.0.1:3210' }
});
assert.strictEqual(testMode.status, 0);
assert.deepStrictEqual(JSON.parse(testMode.stdout.trim()), [true, false, 'http://127.0.0.1:3210/mock']);
process.stdout.write('Origin policy tests passed.\n');
