'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const claimDb = require('../lib/claim-database');
const { classifyEligibility } = require('../lib/policy-engine');
const { parseTrackingJson } = require('../lib/tracking-json');
const { buildCanonicalShipment, buildClassificationInput } = require('../lib/normalized-shipment');
const { reusableConfirmedOnTime } = require('../lib/on-time-cache');
const step3Queue = require('../lib/step3-queue-service');
const privacy = require('../lib/privacy-deletion');

const settings = {
  sender: { name: 'Synthetic', address: '1 Synthetic', city: 'Ottawa', province: 'ON', postalCode: 'K1A0B1' },
  contact: { name: 'Synthetic', email: 'synthetic@example.invalid' }
};

function row(pin, overrides = {}) {
  return {
    'Tracking PIN': pin,
    'Shipment Date': '2026-06-01',
    'Service Code': 'DOM.XP',
    'Destination Postal Code': 'K1A0B1',
    'Reference #': `REF-${pin}`,
    ...overrides
  };
}

function canonical(pin, overrides = {}) {
  const deliveryDate = overrides.deliveryDate || '2026-06-03';
  const expectedDate = overrides.expectedDate || '2026-06-04';
  return buildCanonicalShipment({
    detail: parseTrackingJson({
      pin,
      activeExists: true,
      archiveExists: false,
      signatureImageExists: false,
      suppressSignature: false,
      serviceName: 'Xpresspost',
      expectedDeliveryDate: expectedDate,
      originalExpectedDeliveryDate: expectedDate,
      significantEvents: [{
        eventIdentifier: '1496', eventDescription: 'Delivered', eventDate: deliveryDate,
        eventTime: '10:00:00', eventTimeZone: 'EDT'
      }]
    }, pin),
    row: row(pin, overrides.row),
    trackingNumber: pin
  });
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-on-time-cache-'));
  const dbPath = path.join(root, 'database', 'app.sqlite');
  const pin = options.pin || 'SYNTHETIC-CACHE-1';
  const shipment = canonical(pin, options);
  const input = buildClassificationInput(shipment, settings);
  const classification = classifyEligibility(input, { asOf: '2026-06-10', classificationTimestamp: '2026-06-10T12:00:00Z' });
  if (options.classification) classification.classification = options.classification;
  const runId = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
  claimDb.promoteTrackingBatch(dbPath, [{ pin, canonicalShipment: shipment, rawEvents: [], classification, classificationInput: input }], { runId });
  claimDb.finishRun(dbPath, runId, options.runStatus || 'complete', { total: 1, success: 1 });
  if (options.storedInput) {
    const changed = { ...input, ...options.storedInput };
    claimDb.withDatabase(dbPath, db => {
      db.exec('DROP TRIGGER classification_records_no_update');
      db.prepare('UPDATE classification_records SET input_json = ? WHERE id = (SELECT current_classification_id FROM shipments WHERE tracking_number = ?)').run(JSON.stringify(changed), pin);
    });
  }
  return { root, dbPath, pin, runId, sourceRow: row(pin, options.currentRow), input, classification };
}

function withFixture(options, callback) {
  const data = fixture(options);
  try { callback(data); } finally { fs.rmSync(data.root, { recursive: true, force: true }); }
}

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

function stopServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function runTrackingWorker(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'get-tracking.js')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'test', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('close', code => resolve({
      code,
      stderr,
      events: stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    }));
  });
}

withFixture({}, ({ root, dbPath, sourceRow, pin }) => {
  const beforeClassifications = claimDb.classificationHistory(dbPath, pin).length;
  const beforeEvents = claimDb.withDatabase(dbPath, db => Number(db.prepare('SELECT COUNT(*) AS n FROM tracking_events').get().n));
  const hit = reusableConfirmedOnTime(dbPath, sourceRow);
  assert(hit, 'authoritative matching ON_TIME must be reusable');
  assert.strictEqual(hit.actualDeliveryDate, '2026-06-03');
  assert.strictEqual(claimDb.classificationHistory(dbPath, pin).length, beforeClassifications, 'lookup must not duplicate classification history');
  assert.strictEqual(claimDb.withDatabase(dbPath, db => Number(db.prepare('SELECT COUNT(*) AS n FROM tracking_events').get().n)), beforeEvents, 'lookup must not duplicate tracking events');
  assert.strictEqual(reusableConfirmedOnTime(dbPath, sourceRow, { diagnosticMode: true }), null, 'diagnostic mode must ignore cache');
  assert.strictEqual(reusableConfirmedOnTime(dbPath, sourceRow, { structureExport: true }), null, 'diagnostic structure export must ignore cache');

  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'tracking.csv'), [
    'Tracking PIN,Shipment Date,Service Code,Destination Postal Code,Reference #',
    `${pin},2026-06-01,DOM.XP,K1A0B1,REF-${pin}`
  ].join('\n'));
  const currentRun = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
  const child = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'get-tracking.js')], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DATABASE_PATH: dbPath,
      TRACKING_RUN_ID: String(currentRun),
      CANADAPOST_TRACKING_CLIENT_ID: 'synthetic-client-id',
      CANADAPOST_TRACKING_CLIENT_SECRET: 'synthetic-client-secret',
      CANADAPOST_API_ENVIRONMENT: 'test'
    }
  });
  assert.strictEqual(child.status, 0, child.stderr || child.stdout);
  const events = child.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const cachedEvent = events.find(event => event.type === 'pin_on_time');
  const workloadEvent = events.find(event => event.type === 'tracking_workload');
  const summary = events.find(event => event.type === 'tracking_complete');
  assert.strictEqual(cachedEvent?.cached, true, 'cache hit must emit the normal green event with cached=true');
  assert.deepStrictEqual({ checked: summary.checked, onTime: summary.onTimeCount, cached: summary.cachedOnTimeCount, requests: summary.trackingApiRequestCount }, { checked: 1, onTime: 1, cached: 1, requests: 0 });
  assert.deepStrictEqual({ recent: workloadEvent.recentShipments, carried: workloadEvent.carryForwardShipments, skipped: workloadEvent.confirmedOnTimeSkipped }, { recent: 1, carried: 0, skipped: 1 });
  assert.strictEqual(events.some(event => event.type === 'tracking_protocol_stage' && ['tracking_request_sent', 'tracking_rate_limit_wait'].includes(event.stage)), false, 'cache hit must perform neither request nor limiter wait');
  assert.strictEqual(claimDb.classificationHistory(dbPath, pin).length, beforeClassifications, 'cache-hit run must not duplicate classification history');
  assert.strictEqual(claimDb.withDatabase(dbPath, db => Number(db.prepare('SELECT COUNT(*) AS n FROM tracking_events').get().n)), beforeEvents, 'cache-hit run must not duplicate tracking events');
});

for (const classification of ['LATE_CANDIDATE', 'REVIEW_REQUIRED', 'TRACKING_ERROR']) {
  withFixture({ classification }, ({ dbPath, sourceRow }) => {
    assert.strictEqual(reusableConfirmedOnTime(dbPath, sourceRow), null, `${classification} must never be cached`);
  });
}

withFixture({ deliveryDate: '2026-06-05', expectedDate: '2026-06-04', classification: 'ON_TIME' }, ({ dbPath, sourceRow }) => {
  assert.strictEqual(reusableConfirmedOnTime(dbPath, sourceRow), null, 'delivery after original standard must miss');
});

for (const storedInput of [
  { actualDeliveryDate: '', actualDeliveryAt: '' },
  { actualDeliveryEventCode: '' },
  { actualDeliveryProvenance: '' },
  { actualDeliveryClassificationSource: '' },
  { normalizedStatus: 'IN_TRANSIT' },
  { normalizedEvents: [] },
  { claimEvidence: [] }
]) {
  withFixture({ storedInput }, ({ dbPath, sourceRow }) => {
    assert.strictEqual(reusableConfirmedOnTime(dbPath, sourceRow), null, 'missing or undelivered authoritative evidence must miss');
  });
}

withFixture({ currentRow: { 'Shipment Date': '2026-06-02' } }, ({ dbPath, sourceRow }) => {
  assert.strictEqual(reusableConfirmedOnTime(dbPath, sourceRow), null, 'changed shipment date must miss');
});
withFixture({ currentRow: { 'Service Code': 'DOM.EP' } }, ({ dbPath, sourceRow }) => {
  assert.strictEqual(reusableConfirmedOnTime(dbPath, sourceRow), null, 'conflicting authoritative service must miss');
});
for (const conflict of [
  { 'Destination Postal Code': 'H0H0H0' },
  { 'Reference #': 'MATERIAL-DIFFERENCE' }
]) {
  withFixture({ currentRow: conflict }, ({ dbPath, sourceRow }) => {
    assert.strictEqual(reusableConfirmedOnTime(dbPath, sourceRow), null, 'material shipment identity conflict must miss');
  });
}

withFixture({}, ({ dbPath, sourceRow }) => {
  claimDb.withDatabase(dbPath, db => {
    db.exec('DROP TRIGGER classification_records_no_update');
    db.prepare("UPDATE classification_records SET input_json = '{broken' WHERE id = (SELECT current_classification_id FROM shipments LIMIT 1)").run();
  });
  assert.strictEqual(reusableConfirmedOnTime(dbPath, sourceRow), null, 'corrupt JSON must fall back safely');
});

withFixture({}, ({ root, dbPath, sourceRow }) => {
  const backupPath = path.join(root, 'backup.sqlite');
  claimDb.withDatabase(dbPath, db => {
    db.exec('PRAGMA wal_checkpoint(FULL)');
  });
  fs.copyFileSync(dbPath, backupPath);
  assert(reusableConfirmedOnTime(backupPath, sourceRow), 'database backup/restore must preserve cache eligibility');
});

withFixture({}, ({ root, dbPath, sourceRow, pin }) => {
  const ownedData = path.join(root, 'owned-data');
  const ownedLogs = path.join(root, 'owned-logs');
  fs.mkdirSync(ownedData, { recursive: true });
  fs.mkdirSync(ownedLogs, { recursive: true });
  assert(reusableConfirmedOnTime(dbPath, sourceRow));
  privacy.deleteData({
    dbPath,
    scope: { trackingNumbers: [pin] },
    locale: 'en-CA',
    confirmed: true,
    typedPhrase: privacy.CONFIRMATION_PHRASES['en-CA'].selected,
    applicationVersion: '0.4.1',
    ownedRoots: [ownedData, ownedLogs],
    transactionRoot: path.join(root, 'privacy-transactions'),
    receiptDirectory: path.join(root, 'privacy-receipts')
  });
  assert.strictEqual(reusableConfirmedOnTime(dbPath, sourceRow), null, 'normal privacy deletion must remove the underlying cached classification');
});

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-on-time-mixed-'));
  const dbPath = path.join(root, 'database', 'app.sqlite');
  try {
    const runId = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
    const items = [];
    const rows = [];
    for (let index = 0; index < 100; index += 1) {
      const pin = `SYNTHETIC-MIX-${String(index).padStart(3, '0')}`;
      const sourceRow = row(pin);
      rows.push(sourceRow);
      if (index < 80) {
        const shipment = canonical(pin);
        const input = buildClassificationInput(shipment, settings);
        items.push({ pin, canonicalShipment: shipment, rawEvents: [], classification: classifyEligibility(input), classificationInput: input });
      }
    }
    claimDb.promoteTrackingBatch(dbPath, items, { runId });
    claimDb.finishRun(dbPath, runId, 'complete', { total: 80, success: 80 });
    const cached = rows.filter(sourceRow => reusableConfirmedOnTime(dbPath, sourceRow)).length;
    const apiRequests = rows.length - cached;
    assert.deepStrictEqual({ total: rows.length, cached, apiRequests }, { total: 100, cached: 80, apiRequests: 20 });

    const nextRun = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
    claimDb.finishRun(dbPath, nextRun, 'complete', { total: 80, success: 80 }, { statePromoted: true, cachedOnTimeCount: 80 });
    const preview = step3Queue.previewCandidates(dbPath);
    assert.strictEqual(preview.count, 0, 'cached ON_TIME rows must never enter Step 3');
    assert.strictEqual(claimDb.latestTrackingRun(dbPath).promoted_at !== null, true, 'an all-cache authoritative run must remain promoted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testActualMixedRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-on-time-actual-mixed-'));
  const dataDir = path.join(root, 'data');
  const dbPath = path.join(root, 'database', 'app.sqlite');
  fs.mkdirSync(dataDir, { recursive: true });
  let server;
  try {
    const priorRun = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
    const stored = [];
    const rows = [];
    for (let index = 0; index < 100; index += 1) {
      const pin = `990000000000${String(index).padStart(4, '0')}`;
      rows.push(row(pin));
      if (index < 80) {
        const shipment = canonical(pin);
        const input = buildClassificationInput(shipment, settings);
        stored.push({ pin, canonicalShipment: shipment, rawEvents: [], classification: classifyEligibility(input), classificationInput: input });
      }
    }
    claimDb.promoteTrackingBatch(dbPath, stored, { runId: priorRun });
    claimDb.finishRun(dbPath, priorRun, 'complete', { total: 80, success: 80 });
    fs.writeFileSync(path.join(dataDir, 'tracking.csv'), [
      'Tracking PIN,Shipment Date,Service Code,Destination Postal Code,Reference #',
      ...rows.map(item => `${item['Tracking PIN']},${item['Shipment Date']},${item['Service Code']},${item['Destination Postal Code']},${item['Reference #']}`)
    ].join('\n'));

    let resourceRequests = 0;
    const mock = await startServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/oauth2/token') {
        response.end(JSON.stringify({ token_type: 'Bearer', access_token: 'synthetic-token', expires_in: 3600, scope: 'merchant' }));
        return;
      }
      resourceRequests += 1;
      const pin = decodeURIComponent(request.url.split('/')[2]);
      response.end(JSON.stringify({
        pin,
        activeExists: true,
        archiveExists: false,
        signatureImageExists: false,
        suppressSignature: false,
        serviceName: 'Xpresspost',
        expectedDeliveryDate: '2026-06-04',
        originalExpectedDeliveryDate: '2026-06-04',
        significantEvents: [{
          eventIdentifier: '1496', eventDescription: 'Delivered', eventDate: '2026-06-03',
          eventTime: '10:00:00', eventTimeZone: 'EDT'
        }]
      }));
    });
    server = mock.server;
    const currentRun = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
    const result = await runTrackingWorker({
      CANADAPOST_MOCK_BASE_URL: mock.baseUrl,
      CANADAPOST_TRACKING_CLIENT_ID: 'synthetic-client-id',
      CANADAPOST_TRACKING_CLIENT_SECRET: 'synthetic-client-secret',
      CANADAPOST_API_ENVIRONMENT: 'test',
      TRACKING_RATE_LIMIT_DISABLE_WAIT: '1',
      TRACKING_REQUEST_INTERVAL_MS: '3100',
      DATA_DIR: dataDir,
      DATABASE_PATH: dbPath,
      TRACKING_RUN_ID: String(currentRun)
    });
    assert.strictEqual(result.code, 0, result.stderr || JSON.stringify(result.events.slice(-5)));
    const summary = result.events.find(event => event.type === 'tracking_complete');
    assert.deepStrictEqual({
      total: summary.total,
      checked: summary.checked,
      onTime: summary.onTimeCount,
      cached: summary.cachedOnTimeCount,
      requests: summary.trackingApiRequestCount,
      terminal: summary.primaryCategoryTotal,
      reconciled: summary.countersReconciled,
      resourceRequests
    }, { total: 100, checked: 100, onTime: 100, cached: 80, requests: 20, terminal: 100, reconciled: true, resourceRequests: 20 });
    assert.strictEqual(result.events.filter(event => event.type === 'pin_on_time' && event.cached === true).length, 80);
    assert.strictEqual(result.events.filter(event => event.type === 'tracking_progress').at(-1)?.current, 100);
    assert.strictEqual(claimDb.withDatabase(dbPath, db => Number(db.prepare('SELECT COUNT(*) AS n FROM classification_records').get().n)), 100, 'only the 20 network classifications may extend immutable history');
    claimDb.finishRun(dbPath, currentRun, 'complete', { total: 100, success: 100 }, summary);
    assert.strictEqual(step3Queue.previewCandidates(dbPath).count, 0, 'mixed cached ON_TIME rows must not enter Step 3');
  } finally {
    if (server) await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

testActualMixedRun()
  .then(() => process.stdout.write('Authoritative on-time cache tests passed with an actual 80 cached + 20 API-request run.\n'))
  .catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
