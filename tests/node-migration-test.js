'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseXmlSecure } = require('../lib/secure-xml');
const { parseShipmentDetail, parseEstManifestItems, parseTrackingSoap } = require('../lib/canadapost-parsers');
const { normalizeTrackingEvents } = require('../lib/tracking-normalizer');
const { assertApiUrl } = require('../lib/canadapost-api');
const { trackingEndpoint, assertTrackingMode, ACCEPT } = require('../lib/tracking-client');
const { exportBlocks, isoDate, numeric, requiredEstFileTypes, dateVariants, extractOrderIds, analyzeExportResponse } = require('../scripts/import-est-history');
const { ymd, safeId } = require('../scripts/import-shipping-history');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const summary = parseTrackingSoap(fixture('tracking-summary.xml'), 'SYNTHETIC000001');
const detail = parseTrackingSoap(fixture('tracking-detail.xml'), 'SYNTHETIC000001');
assert.equal(summary.expectedDeliveryDate, '2026-06-03');
assert.equal(summary.actualDeliveryDate, '2026-06-05');
assert.equal(detail.events.length, 2);
const normalized = normalizeTrackingEvents(detail.events);
assert.equal(normalized.firstAttemptDate, '2026-06-04');
assert.equal(normalized.actualDeliveryDate, '2026-06-05');

const shipment = parseShipmentDetail(fixture('shipment-detail.xml'));
assert.deepStrictEqual(Object.fromEntries(['trackingPin', 'postalCode', 'reference', 'shipmentId', 'serviceCode', 'destinationCity', 'destinationProvince', 'shipmentDate'].map(key => [key, shipment[key]])), {
  trackingPin: 'SYNTHETIC000001', postalCode: 'K1A0B1', reference: 'ORDER-SYNTHETIC', shipmentId: 'SHIP-SYNTHETIC-1',
  serviceCode: 'DOM.XP', destinationCity: 'Ottawa', destinationProvince: 'ON', shipmentDate: '2026-06-01'
});
assert.equal(shipment.shipmentDateSourceField, 'mailing-date');
assert.equal(shipment.serviceCodeSourceField, 'service-code');

const estRows = parseEstManifestItems(fixture('est-manifest-items.csv'));
assert.deepStrictEqual(estRows.map(row => ({
  trackingPin: row.trackingPin, postalCode: row.postalCode, reference: row.reference,
  serviceCode: row.serviceCode, eventDate: row.eventDate,
  eventDescription: row.eventDescription, shipmentDate: row.shipmentDate
})), JSON.parse(fixture('legacy-est-expected.json')));

assert.throws(() => parseXmlSecure('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY unsafe SYSTEM "file:///etc/passwd">]><x>&unsafe;</x>'), /prohibited/i);
assert.throws(() => parseXmlSecure('<root><unclosed></root>'), /malformed/i);
assert.equal(trackingEndpoint('SYNTHETIC900001'), 'https://api-stg.canadapost-postescanada.ca/prod/devportal-portaildesdeveloppeurs/tracking/v1/pins/SYNTHETIC900001/details');
assert.equal(ACCEPT, 'application/json');
assert.equal(assertTrackingMode(), 'oauth2-json-tracking-current');
assert.throws(() => assertTrackingMode('legacy-basic-rest-v2'), /no automatic fallback/i);
assertApiUrl('https://api.canadapost-postescanada.ca/prod/devportal-portaildesdeveloppeurs/tracking/v1/pins/SYNTHETIC900001/details');
assert.throws(() => assertApiUrl('https://example.invalid/vis/soap/track'), /allowlist/);
assertApiUrl('http://127.0.0.1:32123/vis/track/pin/SYNTHETIC900001/detail', { allowMock: true });
assert.deepStrictEqual(exportBlocks('ManifestItems\n2\na,b\nc,d\n'), { ManifestItems: ['a,b', 'c,d'] });
assert.equal(isoDate('2026-06-01'), '2026-06-01');
assert.throws(() => isoDate('2026-02-30'), /valid calendar/i);
assert.deepStrictEqual(dateVariants('2026-07-01', '2026-07-26'), [
  { label: 'iso', from: '2026-07-01', to: '2026-07-26' },
  { label: 'yyyymmdd', from: '20260701', to: '20260726' }
]);
assert.deepStrictEqual(extractOrderIds(fixture('est-order-list-legacy.xml')).ids, ['ORDER-SYNTHETIC-001', 'ORDER-SYNTHETIC-002']);
assert.deepStrictEqual(extractOrderIds(fixture('est-order-list-legacy.txt')).ids, ['ORDER-SYNTHETIC-001', 'ORDER-SYNTHETIC-002']);
assert.equal(analyzeExportResponse(fixture('est-export-legacy.txt')).shipments.length, 1);
assert.equal(numeric('-2', 'MOBO'), '-2');
assert.equal(requiredEstFileTypes('2'), '1,2');
assert.equal(requiredEstFileTypes('3,2'), '1,2,3');
assert.equal(ymd('2026-06-01'), '20260601');
assert.equal(safeId('123456'), '123456');

console.log('Node migration and secure XML parity tests passed.');
