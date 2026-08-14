#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { request } = require('../lib/canadapost-api');
const { parseLinks, parseShipmentDetail } = require('../lib/canadapost-parsers');
const { parseXmlSecure, firstText } = require('../lib/secure-xml');
const { readRuntimeSecrets } = require('../lib/runtime-secrets');
const { writeTrackingCsvAtomic } = require('../lib/import-output');
const { assessEstImportQuality } = require('../lib/est-import-schema');

function emit(type, payload = {}) { process.stdout.write(`${JSON.stringify({ type, ...payload })}\n`); }
function ymd(value) { const text = String(value || '').replace(/-/g, ''); if (!/^\d{8}$/.test(text)) throw new Error('History dates must use YYYY-MM-DD.'); return text; }
function safeId(value) { const text = String(value || '').trim(); if (!/^\d{1,30}$/.test(text)) throw new Error('Customer and MOBO identifiers must be numeric.'); return text; }
function idFromUrl(value, segment) { const parts = new URL(value).pathname.split('/').filter(Boolean); const index = parts.lastIndexOf(segment); return index >= 0 ? parts[index + 1] || '' : parts.at(-1) || ''; }

async function main() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const outputFile = path.resolve(process.env.TRACKING_CSV || path.join(dataDir, 'tracking.csv'));
  const customer = safeId(process.env.HISTORY_CUSTOMER_NUMBER);
  const from = ymd(process.env.HISTORY_FROM);
  const to = ymd(process.env.HISTORY_TO);
  if (from > to) throw new Error('History start date must not be after end date.');
  const credentials = await readRuntimeSecrets();
  if (!credentials.username || !credentials.password) throw new Error('Missing protected Canada Post Developer API credentials.');
  const mockBase = String(process.env.CANADAPOST_MOCK_BASE_URL || '').replace(/\/$/, '');
  const base = mockBase || 'https://soa-gw.canadapost.ca';
  const allowMock = Boolean(mockBase) && process.env.NODE_ENV === 'test';
  const getXml = async (url, accept) => (await request({
    url, accept,
    username: credentials.username,
    password: credentials.password,
    sensitiveValues: [customer],
    allowMock,
    retries: 2
  })).body;
  let mobos = [];
  if (String(process.env.HISTORY_AUTO_MOBO || 'true') === 'true') {
    try {
      const customerXml = await getXml(`${base}/rs/customer/${encodeURIComponent(customer)}`, 'application/vnd.cpc.customer+xml');
      mobos = parseLinks(customerXml, 'customer information').filter(link => /mailedby|mobo/i.test(link.rel)).map(link => idFromUrl(link.href, 'mobo')).filter(value => /^\d+$/.test(value));
    } catch (error) { emit('history_warning', { message: `MOBO discovery failed; using the mailed-by customer only. ${error.message}` }); }
  } else mobos = [safeId(process.env.HISTORY_MOBO)];
  if (!mobos.length) mobos = [customer];
  mobos = [...new Set(mobos)];
  emit('history_start', { from, to, moboCount: mobos.length });
  const shipments = [];
  const seen = new Set();
  let warnings = 0;
  for (const mobo of mobos) {
    if (process.env.STOP_FILE && fs.existsSync(process.env.STOP_FILE)) break;
    try {
      const listXml = await getXml(`${base}/rs/${encodeURIComponent(customer)}/${encodeURIComponent(mobo)}/manifest?start=${from}&end=${to}`, 'application/vnd.cpc.manifest-v8+xml');
      const manifests = parseLinks(listXml, 'manifest list').filter(link => /^manifest$/i.test(link.rel));
      emit('history_manifest_list', { count: manifests.length });
      for (const manifestLink of manifests) {
        const manifestId = idFromUrl(manifestLink.href, 'manifest');
        const manifestXml = await getXml(manifestLink.href, manifestLink.mediaType || 'application/vnd.cpc.manifest-v8+xml');
        const poNumber = firstText(parseXmlSecure(manifestXml, 'manifest'), 'po-number');
        const shipmentLists = parseLinks(manifestXml, 'manifest').filter(link => /manifestshipments/i.test(link.rel));
        for (const shipmentList of shipmentLists) {
          const shipmentListXml = await getXml(shipmentList.href, shipmentList.mediaType || 'application/vnd.cpc.shipment-v8+xml');
          const shipmentLinks = parseLinks(shipmentListXml, 'manifest shipments').filter(link => /^shipment$/i.test(link.rel));
          for (const shipmentLink of shipmentLinks) {
            if (process.env.STOP_FILE && fs.existsSync(process.env.STOP_FILE)) break;
            try {
              const shipmentId = idFromUrl(shipmentLink.href, 'shipment');
              const shipmentXml = await getXml(shipmentLink.href, shipmentLink.mediaType || 'application/vnd.cpc.shipment-v8+xml');
              const detailLink = parseLinks(shipmentXml, 'shipment').find(link => /^details$/i.test(link.rel));
              const detailXml = await getXml(detailLink?.href || `${shipmentLink.href.replace(/\/$/, '')}/details`, detailLink?.mediaType || 'application/vnd.cpc.shipment-v8+xml');
              const detail = parseShipmentDetail(detailXml, { shipmentId });
              if (!detail.trackingPin || seen.has(detail.trackingPin)) continue;
              seen.add(detail.trackingPin);
              shipments.push({ ...detail, manifestId, poNumber, source: 'manifest', mobo });
              emit('history_imported', { pin: detail.trackingPin, current: shipments.length });
            } catch (error) { warnings += 1; emit('history_warning', { message: `A shipment could not be imported: ${error.message}` }); }
          }
        }
      }
    } catch (error) { warnings += 1; emit('history_warning', { message: `Manifest lookup failed for one customer context: ${error.message}` }); }
  }
  if (!shipments.length) { emit('history_complete', { imported: 0, warnings, trackingCsv: outputFile }); process.exitCode = 2; return; }
  const quality = assessEstImportQuality(shipments);
  if (quality.systemicDateFailure) throw Object.assign(new Error('Shipment-history import failed its Shipment Date quality gate; the previous tracking.csv was preserved.'), { code: 'EST_EXPORT_SHIPMENT_DATE_SCHEMA_FAILURE' });
  if (!quality.promotableRows.length) throw Object.assign(new Error('Shipment-history import had no complete rows; the previous tracking.csv was preserved.'), { code: 'EST_IMPORT_QUALITY_GATE_FAILED' });
  if (quality.incompleteRows) emit('history_warning', { reasonCode: 'EST_IMPORT_INCOMPLETE_ROWS', totalRows: quality.totalRows, incompleteRows: quality.incompleteRows, message: 'Incomplete history rows were excluded from the promoted import.' });
  const written = writeTrackingCsvAtomic(outputFile, quality.promotableRows, { dataDir, backupLabel: 'history-import' });
  if (written.backupPath) emit('history_backup', { path: written.backupPath });
  emit('history_complete', { outcome: quality.incompleteRows ? 'IMPORTED_INCOMPLETE' : 'IMPORTED', imported: quality.promotableRows.length, excluded: quality.incompleteRows, warnings, trackingCsv: outputFile });
}

if (require.main === module) main().catch(error => { emit('error', { message: error.message, reasonCode: error.code || 'HISTORY_IMPORT_FAILED', trackingCsvPreserved: true }); process.exitCode = 1; });
module.exports = { main, ymd, safeId, idFromUrl };
