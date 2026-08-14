#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { resolveWorkerLaunch, spawnResolvedWorker } = require('../lib/runtime-workers');
const { rowsAsObjects } = require('../lib/csv');
const { resolvePackagedLayout } = require('./packaged-layout');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function quotedRow(values) {
  return values.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',');
}

function liveManifestRow(mailingDate) {
  const values = Array(24).fill('');
  Object.assign(values, { 0: '97531', 1: '86420', 2: 'SHP', 3: '24680', 4: '24680', 5: 'SHP', 6: '75319', 7: '20260531', 8: mailingDate, 9: 'M', 10: '2' });
  return quotedRow(values);
}

function liveManifestItemRow(index) {
  const values = Array(38).fill('');
  Object.assign(values, {
    0: '97531', 1: String(index + 1), 2: '000000000000000908', 3: '1', 4: '100', 10: '100', 14: '100',
    16: `999${String(index).padStart(13, '0')}`, 19: 'Synthetic Recipient', 22: '1 Synthetic Road',
    23: 'Ottawa', 25: 'ON', 26: 'CA', 27: 'K1A 0B1', 30: `SYNTHETIC-${index + 1}`
  });
  return quotedRow(values);
}

function responseFor(request, scenario) {
  if (scenario === 'parser-v5' && request.url === '/oauth2/token') return JSON.stringify({ token_type: 'Bearer', access_token: 'synthetic-token', expires_in: 3600, scope: 'merchant' });
  if (scenario === 'parser-v5' && /\/pins\/[^/]+\/details/.test(request.url)) return JSON.stringify({
    pin: decodeURIComponent(request.url.match(/\/pins\/([^/]+)\/details/)[1]),
    activeExists: true,
    archiveExists: false,
    signatureImageExists: false,
    suppressSignature: false,
    expectedDeliveryDate: '2026-06-02',
    serviceName: 'Xpresspost',
    significantEvents: [{ eventIdentifier: '1442', eventDate: '2026-06-03', eventTime: '12:00:00', eventTimeZone: 'EDT', eventDescription: 'Delivered' }]
  });
  if (request.url === '/dop/connect') return '<connect><status>ok</status></connect>';
  if (/^\/dop\/24680\/workgroup\/customerNumber\/24680$/.test(request.url)) {
    return '<workgroups><workgroup-id>13579</workgroup-id></workgroups>';
  }
  if (/^\/ship\/desktop\/24680\/13579\/SHP\/order\//.test(request.url)) {
    if (scenario === 'empty') return '<list></list>';
    return '<orders><order-id>97531</order-id></orders>';
  }
  if (request.method === 'POST' && /^\/ship\/desktop\/24680\/13579\/SHP\/exportorderhistory\?filetypes=1(?:%2C|,)2$/.test(request.url)) {
    const rowCount = scenario === 'high-volume' ? 10000 : 1;
    const mailingDate = ['missing-date', 'previous-preservation'].includes(scenario) ? '' : '20260601';
    return [
      '1',
      '1',
      liveManifestRow(mailingDate),
      '',
      '2',
      String(rowCount),
      ...Array.from({ length: rowCount }, (_, index) => liveManifestItemRow(index)),
      ''
    ].join('\n');
  }
  return null;
}

async function main() {
  const packageRoot = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'packages', 'linux-unpacked'));
  const scenario = String(process.argv[3] || 'populated');
  assert.ok(['empty', 'populated', 'high-volume', 'missing-date', 'previous-preservation', 'parser-v5'].includes(scenario), 'Unknown packaged Step 1 smoke scenario.');
  const { executablePath, resourcesPath, appPath } = resolvePackagedLayout(packageRoot);
  assert.ok(fs.statSync(executablePath, { throwIfNoEntry: false })?.isFile(), 'Packaged Electron executable is missing.');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-packaged-est-smoke-'));
  const server = http.createServer((request, response) => {
    const body = responseFor(request, scenario);
    if (body === null) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
      return;
    }
    const contentType = request.url === '/oauth2/token' || /\/pins\/[^/]+\/details/.test(request.url)
      ? 'application/json'
      : request.method === 'POST' ? 'text/plain' : 'application/xml';
    response.writeHead(200, { 'Content-Type': contentType });
    response.end(body);
  });

  try {
    const address = await listen(server);
    const dataDir = path.join(temporary, 'data');
    const trackingCsv = path.join(dataDir, 'tracking.csv');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const existingTracking = 'Tracking PIN\nSYNTHETIC-EXISTING\n';
    if (['empty', 'missing-date', 'previous-preservation'].includes(scenario)) fs.writeFileSync(trackingCsv, existingTracking, { mode: 0o600 });
    const resolution = resolveWorkerLaunch('estHistory', {
      appPath,
      resourcesPath,
      userDataPath: path.join(temporary, 'user-data'),
      executablePath,
      appImagePath: process.env.APPIMAGE || '',
      isPackaged: true,
      platform: process.platform
    });
    const launch = spawnResolvedWorker(resolution, {
      env: {
        NODE_ENV: 'test',
        CANADAPOST_MOCK_BASE_URL: `http://127.0.0.1:${address.port}`,
        CANADAPOST_SECRETS_STDIN: '1',
        DATA_DIR: dataDir,
        TRACKING_CSV: trackingCsv,
        EST_CUSTOMER_NUMBER: '24680',
        EST_FROM: '2026-06-01',
        EST_TO: '2026-06-02',
        EST_CATEGORY_GROUP: 'SHP',
        EST_MOBO: '-2',
        EST_FILETYPES: '2'
      },
      stdinJson: { username: 'synthetic-user', password: 'synthetic-passphrase' }
    });
    let stdout = '';
    let stderr = '';
    launch.child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    launch.child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    launch.child.stdin.end(JSON.stringify({ username: 'synthetic-user', password: 'synthetic-passphrase' }));
    const started = await launch.started;
    assert.strictEqual(started.ok, true, started.error?.message || 'Packaged EST worker failed to spawn.');
    const exit = await new Promise(resolve => launch.child.once('close', (code, signal) => resolve({ code, signal })));
    assert.strictEqual(exit.code, 0, `Packaged EST worker exited ${exit.code}: ${stderr.slice(0, 1000)}`);
    assert.ok(!/ENOTDIR/i.test(`${stdout}\n${stderr}`), 'Packaged EST worker produced ENOTDIR.');
    const events = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const complete = events.find(event => event.type === 'est_complete');
    if (scenario === 'empty') {
      assert.strictEqual(fs.readFileSync(trackingCsv, 'utf8'), existingTracking, 'Empty EST export replaced tracking.csv.');
      assert.strictEqual(complete?.outcome, 'EMPTY');
      assert.strictEqual(complete?.message, 'Completed — no EST orders found for the selected date range.');
      assert.strictEqual(complete?.trackingCsvPreserved, true);
    } else {
      assert.ok(fs.statSync(trackingCsv, { throwIfNoEntry: false })?.isFile(), 'Packaged EST worker did not create tracking.csv.');
      const optionalMetadataMissing = ['missing-date', 'previous-preservation'].includes(scenario);
      assert.strictEqual(complete?.outcome, optionalMetadataMissing ? 'IMPORTED_WITH_WARNINGS' : 'IMPORTED');
      const expected = scenario === 'high-volume' ? 10000 : 1;
      assert.strictEqual(complete?.imported, expected);
      assert.strictEqual(events.filter(event => event.type === 'est_imported_detail').length, expected);
      assert.ok(events.filter(event => event.type === 'est_import_progress').length <= Math.ceil(expected / 25) + 1, 'visible aggregate progress was too verbose');
      assert.ok(!events.some(event => event.type === 'est_imported'), 'legacy visible per-shipment event was emitted');
      assert.ok(!/SYN9\d{8}/.test(stdout), 'complete tracking number appeared in packaged Step 1 logs');
      const output = fs.readFileSync(trackingCsv, 'utf8');
      assert.match(output.split(/\r?\n/, 1)[0], /Shipment Date Source Field/);
      assert.match(output, /,DOM\.XP,MATNR – Article Number,est-import-v5:est-article-services-2015-v2:documented-article-number:numeric-zero-padding-normalized,/);
      if (optionalMetadataMissing) {
        assert.ok(events.some(event => event.type === 'est_quality_warning' && event.reasonCode === 'EST_IMPORT_OPTIONAL_METADATA_MISSING'));
        const importedRow = rowsAsObjects(output)[0];
        assert.strictEqual(importedRow['Tracking PIN'], '9990000000000000');
        assert.strictEqual(importedRow['Shipment Date'], '');
      } else {
        assert.match(output, /,2026-06-01,Mailing Date,est-import-v5:manifest:position-8:order-join,est-import-v5,/);
      }
      if (scenario === 'parser-v5') {
        const trackingResolution = resolveWorkerLaunch('tracking', {
          appPath, resourcesPath,
          userDataPath: path.join(temporary, 'user-data'), executablePath,
          appImagePath: process.env.APPIMAGE || '', isPackaged: true, platform: process.platform
        });
        const trackingLaunch = spawnResolvedWorker(trackingResolution, {
          env: {
            NODE_ENV: 'test', CANADAPOST_MOCK_BASE_URL: `http://127.0.0.1:${address.port}`,
            CANADAPOST_SECRETS_STDIN: '1', CANADAPOST_API_ENVIRONMENT: 'test',
            DATA_DIR: dataDir, TRACKING_CSV: trackingCsv,
            TRACKING_REQUEST_INTERVAL_MS: '3100', TRACKING_RATE_LIMIT_DISABLE_WAIT: '1'
          },
          stdinJson: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', environment: 'test' }
        });
        let trackingStdout = '';
        let trackingStderr = '';
        trackingLaunch.child.stdout.on('data', chunk => { trackingStdout += chunk.toString(); });
        trackingLaunch.child.stderr.on('data', chunk => { trackingStderr += chunk.toString(); });
        trackingLaunch.child.stdin.end(JSON.stringify({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', environment: 'test' }));
        const trackingStarted = await trackingLaunch.started;
        assert.strictEqual(trackingStarted.ok, true, trackingStarted.error?.message || 'Packaged parser-v5 tracking worker failed to spawn.');
        const trackingExit = await new Promise(resolve => trackingLaunch.child.once('close', (code, signal) => resolve({ code, signal })));
        assert.strictEqual(trackingExit.code, 0, `Packaged parser-v5 policy-input smoke exited ${trackingExit.code}: ${trackingStderr.slice(0, 1000)} ${trackingStdout.slice(0, 3000)}`);
        const trackingEvents = trackingStdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        assert.ok(trackingEvents.some(event => event.type === 'tracking_complete' && event.statePromoted === true));
        assert.ok(!trackingEvents.some(event => event.type === 'tracking_invariant_failure'));
        assert.ok(!trackingStdout.includes('POLICY_INPUT_SHIPMENT_DATE_MISSING'));
      }
    }
    process.stdout.write(`Packaged Step 1 ${scenario} synthetic smoke passed: worker=${path.relative(packageRoot, resolution.workerPath)}, cwd=private-user-data/worker-runtime, outcome=${complete.outcome}, ENOTDIR=false.\n`);
  } finally {
    await close(server).catch(() => {});
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`Packaged Step 1 synthetic smoke failed: ${error.message}\n`);
  process.exitCode = 1;
});
