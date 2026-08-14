#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { request } = require('../lib/canadapost-api');
const { parseXmlSecure, findAll, scalar, escapeXml } = require('../lib/secure-xml');
const { parseCsv } = require('../lib/csv');
const { parseEstManifestItems } = require('../lib/canadapost-parsers');
const { parseManifestItemRows, parseEstExportBlocks, assessEstImportQuality } = require('../lib/est-import-schema');
const { readRuntimeSecrets } = require('../lib/runtime-secrets');
const { writeTrackingCsvAtomic } = require('../lib/import-output');
const {
  dateVariants,
  splitDateRange,
  resolveOrderRange,
  unresolvedRangeError,
  cancellationError,
  SEGMENT_STATES
} = require('../lib/est-order-ranges');
const { looksHtml, redactedText } = (() => {
  const errors = require('../lib/canadapost-errors');
  return { looksHtml: errors.looksHtml, redactedText: errors.redactText };
})();
const { redactedTracking } = require('../lib/tracking-client');

function emit(type, payload = {}) { process.stdout.write(`${JSON.stringify({ type, ...payload })}\n`); }
function increment(counter, name) { counter[name] = (counter[name] || 0) + 1; }
function requiredEstFileTypes(value = '1,2') {
  const text = String(value || '').trim();
  if (!/^\d+(?:,\d+)*$/.test(text)) throw new Error('EST file types must be numeric IDs.');
  const requested = text.split(',');
  return [...new Set(['1', '2', ...requested])].join(',');
}
function isoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('EST dates must use YYYY-MM-DD.');
  const parsed = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw new Error('EST dates must be valid calendar dates in YYYY-MM-DD format.');
  return text;
}
function numeric(value, label) { const text = String(value || '').trim(); if (!/^-?\d{1,30}$/.test(text)) throw new Error(`${label} must be numeric.`); return text; }
function uniqueScalars(parsed, names) { return [...new Set(names.flatMap(name => findAll(parsed, name).map(scalar)).map(value => value.trim()).filter(value => value && value.length <= 128 && !/^(?:true|false|null)$/i.test(value)))]; }
function leafScalars(value, output = []) {
  if (Array.isArray(value)) { for (const item of value) leafScalars(item, output); return output; }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) if (!key.startsWith('@_')) leafScalars(child, output);
    return output;
  }
  const text = String(value ?? '').trim(); if (text) output.push(text); return output;
}
function parseXmlOrThrow(body, label) {
  if (looksHtml(body, '')) throw Object.assign(new Error(`Unexpected HTML/login page returned for ${label}.`), { code: 'EST_UNEXPECTED_LOGIN_HTML' });
  try { return parseXmlSecure(body, label); }
  catch (error) { throw Object.assign(new Error(`Could not parse ${label}: ${redactedText(error.message)}`), { code: 'EST_PARSER_FAILURE' }); }
}
function numericLeafIds(body, label) {
  return [...new Set(leafScalars(parseXmlOrThrow(body, label)).flatMap(text => text.match(/\b\d+\b/g) || []))];
}
function extractOrderIds(body) {
  const text = String(body || '').trim();
  if (!text) return { ids: [], format: 'empty' };
  if (looksHtml(text, '')) throw Object.assign(new Error('Unexpected HTML/login page returned for EST order lookup.'), { code: 'EST_UNEXPECTED_LOGIN_HTML' });
  let values;
  let format;
  if (/^</.test(text)) {
    values = leafScalars(parseXmlOrThrow(text, 'EST order list'));
    format = 'xml';
  } else {
    values = text.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    format = 'text';
    if (values.some(value => !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))) {
      throw Object.assign(new Error('Downloaded EST order response had an unrecognized file format.'), { code: 'EST_ORDER_FORMAT_UNKNOWN' });
    }
  }
  const ids = [...new Set(values.filter(value => /^[A-Za-z0-9_.:-]{1,128}$/.test(value) && !/^(?:true|false|null)$/i.test(value)))];
  return { ids, format };
}
function exportBlocks(text) {
  return Object.fromEntries(exportSections(text).map(section => [section.name, section.rows]));
}

function exportSections(text) {
  const lines = String(text || '').split(/\r\n|\n|\r/); const sections = []; let index = 0;
  while (index < lines.length) {
    const name = lines[index++].trim(); if (!name) continue;
    if (index >= lines.length || !/^\d+$/.test(lines[index].trim())) return [];
    const count = Number(lines[index++].trim());
    sections.push({ name, declaredRecordCount: count, rows: lines.slice(index, index + count) }); index += count;
    if (lines[index]?.trim() === '') index += 1;
  }
  return sections;
}

function lineEndingType(text) {
  const crlf = (String(text || '').match(/\r\n/g) || []).length;
  const withoutCrlf = String(text || '').replace(/\r\n/g, '');
  const lf = (withoutCrlf.match(/\n/g) || []).length;
  const cr = (withoutCrlf.match(/\r/g) || []).length;
  const kinds = [crlf && 'CRLF', lf && 'LF', cr && 'CR'].filter(Boolean);
  return { type: kinds.length > 1 ? 'mixed' : kinds[0] || 'none', counts: { CRLF: crlf, LF: lf, CR: cr } };
}

function delimiterCount(line, delimiter) {
  let count = 0; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"' && quoted && line[index + 1] === '"') index += 1;
    else if (line[index] === '"') quoted = !quoted;
    else if (!quoted && line[index] === delimiter) count += 1;
  }
  return count;
}

function delimitedStructure(lines) {
  const samples = lines.filter(line => String(line).trim()).slice(0, 50);
  const candidates = [{ value: ',', name: 'comma' }, { value: '\t', name: 'tab' }, { value: ';', name: 'semicolon' }, { value: '|', name: 'pipe' }]
    .map(item => ({ ...item, separators: samples.reduce((sum, line) => sum + delimiterCount(line, item.value), 0) }))
    .sort((a, b) => b.separators - a.separators);
  const delimiter = candidates[0]?.separators ? candidates[0] : { name: 'undetected', separators: 0 };
  const records = delimiter.name === 'comma' ? parseCsv(`${lines.join('\n')}\n`) : [];
  const columnCountHistogram = {};
  for (const record of records) increment(columnCountHistogram, String(record.length));
  const quotedRecords = samples.filter(line => /"/.test(line)).length;
  return {
    delimiter: delimiter.name,
    delimiterSeparatorCount: delimiter.separators,
    quoting: quotedRecords === 0 ? 'none' : quotedRecords === samples.length ? 'all_sampled_records' : 'some_sampled_records',
    logicalRecordCount: records.length,
    columnCountHistogram
  };
}

function safeSectionName(name) {
  return String(name || '').replace(/[^A-Za-z0-9_. -]+/g, '').slice(0, 64);
}

function looksBase64(value) {
  const compact = String(value || '').replace(/\s+/g, '');
  return compact.length >= 32 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function decodeTextBuffer(buffer) {
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return { text: zlib.gunzipSync(buffer).toString('utf8'), compression: 'gzip' };
  return { text: buffer.toString('utf8'), compression: 'none' };
}

function unwrapExportEnvelope(input) {
  const original = String(input || '');
  const trimmed = original.trim();
  const wrapping = { xml: false, base64: false, compression: 'none', escapedText: false, candidatePayloadCount: 0 };
  if (!trimmed.startsWith('<')) return { text: original, wrapping, payloadType: exportSections(original).length ? 'est-block-text' : 'text' };
  wrapping.xml = true;
  let parsed;
  try { parsed = parseXmlSecure(trimmed, 'EST export envelope'); }
  catch (_) { return { text: original, wrapping, payloadType: 'xml-unparsed' }; }
  const candidates = leafScalars(parsed).filter(value => value.length >= 4);
  wrapping.candidatePayloadCount = candidates.length;
  for (const candidate of candidates) {
    if (exportSections(candidate).length || /(?:manifestitems|barcode\s*id|tracking\s*(?:pin|number))/i.test(candidate)) {
      wrapping.escapedText = /&(?:quot|lt|gt|amp);/i.test(trimmed);
      return { text: candidate, wrapping, payloadType: 'xml-wrapped-text' };
    }
    if (looksBase64(candidate)) {
      try {
        const decoded = decodeTextBuffer(Buffer.from(candidate.replace(/\s+/g, ''), 'base64'));
        if (exportSections(decoded.text).length || /(?:manifestitems|barcode\s*id|tracking\s*(?:pin|number))/i.test(decoded.text)) {
          wrapping.base64 = true; wrapping.compression = decoded.compression;
          return { text: decoded.text, wrapping, payloadType: 'xml-wrapped-encoded-text' };
        }
      } catch (_) {}
    }
  }
  return { text: original, wrapping, payloadType: 'xml-envelope-no-export-payload' };
}

function transportStructure(body, bodyMetadata = {}) {
  const envelope = unwrapExportEnvelope(body);
  const sections = exportSections(envelope.text);
  const sectionReports = sections.map(section => ({
    name: safeSectionName(section.name), declaredRecordCount: section.declaredRecordCount,
    physicalRecordCount: section.rows.length, ...delimitedStructure(section.rows)
  }));
  const rawNames = sectionReports.map(section => section.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const manifestReturned = rawNames.some(name => name === '1' || (name.startsWith('manifest') && !name.startsWith('manifestitems')));
  const manifestItemsReturned = rawNames.some(name => name === '2' || (name.startsWith('manifestitems') && !name.startsWith('manifestitemsaddons') && !name.startsWith('manifestitemscustoms')));
  return {
    payloadType: envelope.payloadType,
    body: {
      detectedEncoding: bodyMetadata.detectedEncoding || 'utf-8-unknown',
      bom: bodyMetadata.bom || 'unknown',
      contentType: bodyMetadata.contentType || '', contentEncoding: bodyMetadata.contentEncoding || 'unknown',
      transferEncoding: bodyMetadata.transferEncoding || '', binaryMagic: bodyMetadata.binaryMagic || 'unknown',
      byteLength: Number(bodyMetadata.byteLength || Buffer.byteLength(String(body || ''))),
      replacementCharacterCount: Number(bodyMetadata.replacementCharacterCount || 0),
      lineEndings: lineEndingType(envelope.text)
    },
    wrapping: envelope.wrapping,
    manifestReturned,
    manifestItemsReturned,
    sectionsInOneResponse: manifestReturned && manifestItemsReturned,
    totalPhysicalRecords: sectionReports.reduce((sum, section) => sum + section.physicalRecordCount, 0),
    sections: sectionReports
  };
}

function zeroRowsMessage(diagnostic) {
  const blocks = parserBlocks(diagnostic);
  const manifest = blocks.find(block => block.blockType === 'Manifest') || {};
  const items = blocks.find(block => block.blockType === 'ManifestItems') || {};
  const rejections = Object.entries(items.rejectionCounts || {}).sort((a, b) => b[1] - a[1]);
  const primary = rejections.length ? `${rejections[0][1]} rejected for ${rejections[0][0]}` : 'no mapped item records were accepted';
  return `EST import rejected: ${Number(items.rowCount || 0)} item records parsed; ${Number(diagnostic?.join?.exactJoinMatchCount || 0)} Manifest joins; ${Number(items.validTrackingPinCount || 0)} valid tracking PINs; ${Number(manifest.validNormalizedShipmentDateCount || 0)} valid Manifest shipment dates; ${primary}.`;
}

function parserBlocks(diagnostic = {}) {
  return Array.isArray(diagnostic.blocks) ? diagnostic.blocks : [diagnostic].filter(item => item.blockType);
}

function aggregateStructure(total, report) {
  const parser = report?.parser || {};
  const manifest = parserBlocks(parser).find(block => block.blockType === 'Manifest') || {};
  const items = parserBlocks(parser).find(block => block.blockType === 'ManifestItems') || {};
  const add = (name, value) => { total[name] = Number(total[name] || 0) + Number(value || 0); };
  add('manifestRecordCount', manifest.rowCount);
  add('manifestItemsRecordCount', items.rowCount);
  add('candidateManifestOrderIdCount', manifest.candidateOrderIdCount);
  add('candidateManifestItemsOrderIdCount', items.candidateOrderIdCount);
  add('exactJoinMatchCount', parser.join?.exactJoinMatchCount || items.exactJoinMatchCount);
  add('unmatchedManifestCount', parser.join?.unmatchedManifestCount);
  add('unmatchedManifestItemsCount', parser.join?.unmatchedManifestItemsCount);
  add('candidateTrackingPinCount', items.candidateTrackingPinCount);
  add('validTrackingPinCount', items.validTrackingPinCount);
  add('candidateShipmentDateCount', manifest.candidateShipmentDateCount || items.candidateShipmentDateCount);
  add('validNormalizedShipmentDateCount', manifest.validNormalizedShipmentDateCount || items.validNormalizedShipmentDateCount);
  add('candidateArticleServiceCount', items.candidateArticleServiceCount);
  add('recognizedServiceCount', items.recognizedServiceCount);
  add('recognizedServiceAfterNumericPaddingNormalizationCount', items.recognizedServiceAfterNumericPaddingNormalizationCount);
  add('acceptedCanonicalRowCount', items.acceptedCanonicalRowCount);
  for (const [reason, count] of Object.entries(items.rejectionCounts || {})) {
    total.rejectionCounts[reason] = Number(total.rejectionCounts[reason] || 0) + Number(count || 0);
  }
  return total;
}

function analyzeExportResponse(text, { parser = parseEstManifestItems, allowZero = false, bodyMetadata = {} } = {}) {
  const body = String(text || '');
  if (looksHtml(body, '')) throw Object.assign(new Error('Unexpected HTML/login page returned instead of the EST export.'), { code: 'EST_UNEXPECTED_LOGIN_HTML' });
  if (body.startsWith('PK\x03\x04')) throw Object.assign(new Error('Downloaded EST export archive format is not supported.'), { code: 'EST_EXPORT_ARCHIVE_UNKNOWN' });
  const envelope = unwrapExportEnvelope(body);
  const decodedBody = envelope.text;
  const blocks = exportBlocks(decodedBody);
  let format = 'est-blocks';
  let parsed;
  if (!Object.keys(blocks).length) {
    if (!/barcode\s*id|tracking\s*(?:pin|number)|postal\s*(?:zip\s*)?code/i.test(decodedBody)) {
      throw Object.assign(new Error('Downloaded EST export had an unrecognized file format.'), { code: 'EST_EXPORT_FORMAT_UNKNOWN' });
    }
    format = 'manifest-items-csv';
    parsed = parser === parseEstManifestItems
      ? parseManifestItemRows(decodedBody.split(/\r\n|\n|\r/))
      : { shipments: parser(decodedBody), diagnostic: { schemaVersion: 'custom-parser', blocks: [] } };
  } else {
    parsed = parser === parseEstManifestItems
      ? parseEstExportBlocks(blocks)
      : { shipments: parser(Object.entries(blocks).filter(([name]) => /manifestitems/i.test(name)).flatMap(([, rows]) => rows).join('\n')), diagnostic: { schemaVersion: 'custom-parser', blocks: [] } };
  }
  let shipments;
  try { shipments = parsed.shipments; }
  catch (error) { throw Object.assign(new Error(`EST export parser failed: ${redactedText(error.message)}`), { code: 'EST_EXPORT_PARSE_FAILED' }); }
  const structure = transportStructure(body, bodyMetadata);
  if (!shipments.length && !allowZero) {
    const error = new Error(zeroRowsMessage(parsed.diagnostic));
    error.code = 'EST_EXPORT_ZERO_ROWS';
    error.structuralDiagnostic = { transport: structure, parser: parsed.diagnostic };
    throw error;
  }
  const quality = assessEstImportQuality(shipments);
  return { shipments, quality: { ...quality, promotableRows: undefined }, format, structuralDiagnostic: { transport: structure, parser: parsed.diagnostic }, blockNames: Object.keys(blocks).map(safeSectionName), byteLength: Buffer.byteLength(body) };
}

async function main() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const outputFile = path.resolve(process.env.TRACKING_CSV || path.join(dataDir, 'tracking.csv'));
  const exportDir = path.join(dataDir, 'est-export');
  fs.mkdirSync(exportDir, { recursive: true, mode: 0o700 });
  const customer = numeric(process.env.EST_CUSTOMER_NUMBER, 'EST customer number');
  const requestedFrom = isoDate(process.env.EST_FROM);
  const requestedTo = isoDate(process.env.EST_TO);
  const segments = splitDateRange(requestedFrom, requestedTo);
  const category = String(process.env.EST_CATEGORY_GROUP || 'SHP').toUpperCase(); if (!['SHP', 'OSS'].includes(category)) throw new Error('EST category group must be SHP or OSS.');
  const mobo = numeric(process.env.EST_MOBO || '-2', 'EST MOBO');
  const fileTypes = requiredEstFileTypes(process.env.EST_FILETYPES || '1,2');
  const structureDiagnosticOnly = process.env.EST_STRUCTURE_DIAGNOSTIC_ONLY === '1';
  const diagnosticFileTypes = structureDiagnosticOnly && process.env.EST_DIAGNOSTIC_FILETYPE_MATRIX !== '0'
    ? ['1', '2', '1,2']
    : [fileTypes];
  const credentials = await readRuntimeSecrets(); if (!credentials.username || !credentials.password) throw new Error('Missing protected Canada Post web credentials.');
  const mockBase = String(process.env.CANADAPOST_MOCK_BASE_URL || '').replace(/\/$/, ''); const origin = mockBase || 'https://ws.postescanada-canadapost.ca'; const allowMock = Boolean(mockBase) && process.env.NODE_ENV === 'test';
  const call = async (method, url, accept, body, contentType) => request({
    method, url, accept, body, contentType,
    username: credentials.username,
    password: credentials.password,
    sensitiveValues: [customer, mobo],
    allowMock,
    retries: method === 'GET' ? 2 : 0
  });
  const shouldStop = () => Boolean(process.env.STOP_FILE && fs.existsSync(process.env.STOP_FILE));
  const assertNotStopped = () => { if (shouldStop()) throw cancellationError(); };
  const connect = await call('GET', `${origin}/dop/connect`, 'application/vnd.cpc.dop-v1+xml');
  parseXmlOrThrow(connect.body, 'EST connection response');
  emit('est_connect', { status: connect.status, responseType: 'xml', byteLength: Buffer.byteLength(connect.body) });
  let workgroups = [];
  if (process.env.EST_WORKGROUP) workgroups = [numeric(process.env.EST_WORKGROUP, 'EST workgroup')];
  else {
    try {
      const response = await call('GET', `${origin}/dop/${customer}/workgroup/customerNumber/${customer}`, 'application/vnd.cpc.dop-v1+xml');
      const parsed = parseXmlOrThrow(response.body, 'EST workgroups');
      workgroups = [...new Set([
        ...uniqueScalars(parsed, ['workgroup-id', 'workgroup', 'id', 'string']),
        ...numericLeafIds(response.body, 'EST workgroups')
      ].filter(value => /^\d+$/.test(value)))];
      emit('est_workgroups', { count: workgroups.length, mode: 'auto', responseType: 'xml', byteLength: Buffer.byteLength(response.body) });
    } catch (error) {
      if (error.code === 'EST_UNEXPECTED_LOGIN_HTML') throw error;
      emit('est_warning', { message: `Workgroup discovery failed; using the customer number. ${error.message}` });
    }
  }
  if (!workgroups.length) workgroups = [customer];
  if (segments.length > 1) emit('est_range_segmented', {
    segmentCount: segments.length,
    message: `Shipment History range will be checked in ${segments.length} date segments.`
  });
  const resolvedWorkgroups = [];
  let adaptiveSplitLogged = false;
  for (let workgroupIndex = 0; workgroupIndex < workgroups.length; workgroupIndex += 1) {
    const workgroup = workgroups[workgroupIndex];
    const orderIds = new Set();
    for (const segment of segments) {
      const result = await resolveOrderRange({
        segment,
        shouldStop,
        lookup: dates => call('GET', `${origin}/ship/desktop/${customer}/${workgroup}/${category}/order/${dates.from}/${dates.to}/${mobo}`, 'application/vnd.cpc.ship-v1+xml'),
        parseOrders: response => extractOrderIds(response.body),
        onAdaptiveSplit: () => {
          if (adaptiveSplitLogged) return;
          adaptiveSplitLogged = true;
          emit('est_range_adaptive_split', {
            message: 'Canada Post rejected a broad history range; retrying it in smaller date segments.'
          });
        }
      });
      if (result.state === SEGMENT_STATES.FAILURE) {
        throw unresolvedRangeError(result, { workgroupOrdinal: workgroupIndex + 1 });
      }
      for (const orderId of result.orderIds) orderIds.add(orderId);
      if (segments.length === 1 && result.state !== SEGMENT_STATES.SPLIT_AND_RESOLVED) {
        emit('est_orders', {
          count: result.orderIds.length,
          dateFormat: result.dateFormat,
          responseType: result.responseType,
          byteLength: Buffer.byteLength(result.response?.body || '')
        });
      }
    }
    if (segments.length > 1 || adaptiveSplitLogged) emit('est_orders', {
      count: orderIds.size,
      dateFormat: 'segmented',
      responseType: 'aggregated'
    });
    resolvedWorkgroups.push({ workgroup, workgroupIndex, orderIds: [...orderIds] });
  }

  assertNotStopped();
  const all = []; const seen = new Set(); let totalOrders = 0; let exports = 0;
  const structuralTotals = { requests: 0, rejectionCounts: {} };
  const filetypeResults = Object.fromEntries(diagnosticFileTypes.map(combination => [combination, { requests: 0, manifestResponses: 0, manifestItemsResponses: 0, combinedResponses: 0 }]));
  for (const { workgroup, workgroupIndex, orderIds } of resolvedWorkgroups) {
    assertNotStopped();
    totalOrders += orderIds.length;
    for (let offset = 0; offset < orderIds.length; offset += 200) {
      assertNotStopped();
      const chunk = orderIds.slice(offset, offset + 200);
      const body = `<?xml version="1.0" encoding="UTF-8"?><list>${chunk.map(id => `<string>${escapeXml(id)}</string>`).join('')}</list>`;
      for (const requestedFileTypes of diagnosticFileTypes) {
        const response = await call('POST', `${origin}/ship/desktop/${customer}/${workgroup}/${category}/exportorderhistory?filetypes=${encodeURIComponent(requestedFileTypes)}`, 'application/vnd.cpc.ship-v1+text', body, 'application/vnd.cpc.ship-v1+xml');
        exports += 1;
        structuralTotals.requests += 1;
        let analysis;
        try {
          analysis = analyzeExportResponse(response.body, { bodyMetadata: response.bodyMetadata, allowZero: structureDiagnosticOnly });
        } catch (error) {
          if (error.structuralDiagnostic) emit('est_export_diagnostic', {
            recognized: true, workgroupOrdinal: workgroupIndex + 1, requestedFileTypes,
            httpStatus: response.status, payloadType: error.structuralDiagnostic.transport?.payloadType || 'unknown',
            structure: error.structuralDiagnostic, rejected: true, message: error.message
          });
          throw error;
        }
        const transport = analysis.structuralDiagnostic.transport;
        const combination = filetypeResults[requestedFileTypes];
        combination.requests += 1;
        if (transport.manifestReturned) combination.manifestResponses += 1;
        if (transport.manifestItemsReturned) combination.manifestItemsResponses += 1;
        if (transport.sectionsInOneResponse) combination.combinedResponses += 1;
        aggregateStructure(structuralTotals, analysis.structuralDiagnostic);
        emit('est_export_diagnostic', {
          recognized: true, workgroupOrdinal: workgroupIndex + 1, requestedFileTypes,
          chunkOrdinal: Math.floor(offset / 200) + 1, orderCount: chunk.length,
          httpStatus: response.status, responsePayloadType: transport.payloadType,
          format: analysis.format, blockNames: analysis.blockNames, byteLength: analysis.byteLength,
          parsedRows: analysis.shipments.length, structure: analysis.structuralDiagnostic, quality: analysis.quality
        });
        if (structureDiagnosticOnly) continue;
        for (const item of analysis.shipments) {
          if (seen.has(item.trackingPin)) continue; seen.add(item.trackingPin);
          all.push({ ...item, shipmentId: '', manifestId: '', poNumber: '', destinationCity: '', destinationProvince: '', source: 'EST Desktop exportorderhistory', mobo });
        }
      }
    }
  }
  if (totalOrders === 0) {
    emit('est_complete', { outcome: 'EMPTY', reasonCode: 'EST_NO_ORDERS', message: 'Completed — no EST orders found for the selected date range.', imported: 0, orders: 0, exports: 0, trackingCsvPreserved: true });
    return;
  }
  if (structureDiagnosticOnly) {
    const combinedAvailable = Object.values(filetypeResults).some(result => result.combinedResponses > 0);
    const manifestSeparate = filetypeResults['1']?.manifestResponses > 0;
    const itemsSeparate = filetypeResults['2']?.manifestItemsResponses > 0;
    emit('est_structure_complete', {
      outcome: 'DIAGNOSTIC_ONLY', stateModified: false, trackingCsvPreserved: true,
      workgroupCount: workgroups.length, orders: totalOrders, exports,
      filetypeResults, combinedResponseAvailable: combinedAvailable,
      separateRequestsRequired: !combinedAvailable && manifestSeparate && itemsSeparate,
      totals: structuralTotals
    });
    return;
  }
  if (!all.length) throw Object.assign(new Error('EST returned orders, but no usable tracking rows were parsed.'), { code: 'EST_ORDERS_WITHOUT_TRACKING_ROWS' });
  const quality = assessEstImportQuality(all);
  if (!quality.promotableRows.length) throw Object.assign(new Error('EST import quality gate found no rows with a valid Tracking PIN; the previous tracking.csv was preserved.'), { code: 'EST_IMPORT_QUALITY_GATE_FAILED' });
  if (quality.optionalMetadataWarnings || quality.incompleteRows) emit('est_quality_warning', {
    reasonCode: 'EST_IMPORT_OPTIONAL_METADATA_MISSING',
    totalRows: quality.totalRows,
    incompleteRows: quality.incompleteRows,
    optionalMetadataWarnings: quality.optionalMetadataWarnings,
    missingShipmentDate: quality.missingShipmentDate,
    invalidShipmentDate: quality.invalidShipmentDate,
    unavailableService: quality.unavailableService,
    invalidService: quality.invalidService,
    message: `${quality.optionalMetadataWarnings} row(s) have missing or invalid optional Shipment Date/Service Code enrichment. Rows with valid Tracking PINs were retained.`
  });
  const promotable = quality.promotableRows;
  for (let index = 0; index < promotable.length; index += 1) {
    emit('est_imported_detail', { detailLevel: 'shipment', pin: redactedTracking(promotable[index].trackingPin), current: index + 1 });
    if (index === 0 || (index + 1) % 25 === 0) emit('est_import_progress', { current: index + 1, interval: 25 });
  }
  const written = writeTrackingCsvAtomic(outputFile, promotable, { dataDir, backupLabel: 'est-history-import' });
  if (promotable.length % 25 !== 0) emit('est_import_progress', { current: promotable.length, interval: 25, final: true });
  if (written.backupPath) emit('est_backup', { path: written.backupPath });
  emit('est_complete', { outcome: quality.optionalMetadataWarnings ? 'IMPORTED_WITH_WARNINGS' : 'IMPORTED', reasonCode: quality.optionalMetadataWarnings ? 'EST_ORDERS_IMPORTED_WITH_OPTIONAL_METADATA_WARNINGS' : 'EST_ORDERS_IMPORTED', message: quality.optionalMetadataWarnings ? 'EST Desktop history export completed. Rows with valid Tracking PINs were retained and optional metadata warnings were reported.' : 'EST Desktop history export complete.', imported: promotable.length, excluded: quality.incompleteRows, optionalMetadataWarnings: quality.optionalMetadataWarnings, orders: totalOrders, exports, trackingCsvPreserved: false });
}

if (require.main === module) main().catch(error => { emit('error', { message: error.message, reasonCode: error.code || 'EST_IMPORT_FAILED', diagnostic: error.diagnostic, trackingCsvPreserved: true }); process.exitCode = 1; });
module.exports = { main, isoDate, numeric, requiredEstFileTypes, dateVariants, leafScalars, numericLeafIds, extractOrderIds, exportBlocks, analyzeExportResponse };
