'use strict';

const { parseCsv } = require('./csv');
const { canonicalServiceCode, canonicalEstArticleService, EST_ARTICLE_SERVICE_TABLE_VERSION } = require('./tracking-service');

const EST_IMPORT_SCHEMA_VERSION = 'est-import-v5';

const EST_EXPORT_SECTION_MAPPINGS = Object.freeze({
  // Live exportorderhistory responses use the numeric requested filetype as
  // the block name. Named aliases cover documented downloaded exports.
  manifest: Object.freeze({ filetype: '1', names: ['1', 'Manifest', 'Manifest.csv'] }),
  manifestItems: Object.freeze({ filetype: '2', names: ['2', 'ManifestItems', 'ManifestItems.csv'] })
});

// Canada Post, EST 2.0 Export File Specifications (April 2015). Positions are
// zero based. Header aliases are explicit so an unknown layout fails closed.
const EST_FIELD_MAPPINGS = Object.freeze({
  manifest: Object.freeze({
    orderId: Object.freeze({ position: 0, names: ['Order Id', 'Order ID'] }),
    shipmentDate: Object.freeze({ position: 8, names: ['Mailing Date', 'Shipment Date'] })
  }),
  manifestItems: Object.freeze({
    orderId: Object.freeze({ position: 0, names: ['Order Id', 'Order ID'] }),
    serviceArticle: Object.freeze({ position: 2, names: ['MATNR – Article Number', 'MATNR - Article Number', 'Article Number', 'Product Number'] }),
    serviceCode: Object.freeze({ position: null, names: ['Service Code', 'Product Code'] }),
    serviceDescription: Object.freeze({ position: null, names: ['Service Description', 'Product Description'] }),
    trackingPin: Object.freeze({ position: 16, names: ['Bar Code Id', 'Barcode Id', 'Barcode', 'Tracking PIN', 'Tracking Number', 'PIN'] }),
    postalCode: Object.freeze({ position: 27, names: ['Postal Zip Code', 'Postal Code', 'Zip Code', 'Destination Postal Code'] }),
    reference: Object.freeze({ position: 30, names: ['Imported Order ID', 'Imported Order Id', 'Item Ref #2', 'Item Reference 2', 'Reference #', 'Customer Reference 1'] }),
    traceEventAt: Object.freeze({ position: 31, names: ['Date Time Trace Inquiry Event'] }),
    traceEventDescription: Object.freeze({ position: 32, names: ['Description Significant Event'] }),
    // Supported headered CSV variants may carry the shipment date on each row.
    // The trace-inquiry event date above is intentionally excluded.
    shipmentDate: Object.freeze({ position: null, names: ['Shipment Date', 'Mailing Date', 'Ship Date', 'Date Shipped'] })
  }),
  shipmentXml: Object.freeze({
    shipmentDate: Object.freeze({ position: null, names: ['mailing-date', 'shipment-date'] }),
    serviceCode: Object.freeze({ position: null, names: ['service-code', 'product-code'] })
  })
});

function normalizeFieldName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function validTrackingPin(value) {
  const clean = String(value || '').replace(/\s+/g, '');
  return /^[A-Za-z0-9]{10,35}$/.test(clean) && /\d{6,}/.test(clean);
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateResult(value, status, format = '') {
  return { value, status, format };
}

function normalizeEstShipmentDate(input) {
  const value = String(input || '').trim();
  if (!value) return dateResult('', 'missing');
  let match;
  let year;
  let month;
  let day;
  let format;
  if ((match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/))) {
    [, year, month, day] = match;
    format = 'YYYY-MM-DD';
  } else if ((match = value.match(/^(\d{4})(\d{2})(\d{2})$/))) {
    [, year, month, day] = match;
    format = 'YYYYMMDD';
  } else if ((match = value.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/))) {
    [, year, month, day] = match;
    format = 'YYYY/M/D';
  } else if ((match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    year = match[3];
    if (first > 12 && second <= 12) {
      day = first; month = second; format = 'D/M/YYYY';
    } else {
      month = first; day = second; format = 'M/D/YYYY';
    }
  } else {
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    match = value.match(/^(\d{1,2})[ -]([A-Za-z]{3,9})[ ,-]+(\d{4})$/);
    if (match && months[match[2].slice(0, 3).toLowerCase()]) {
      day = match[1]; month = months[match[2].slice(0, 3).toLowerCase()]; year = match[3]; format = 'D-MMM-YYYY';
    } else {
      match = value.match(/^([A-Za-z]{3,9})[ -](\d{1,2}),?[ -](\d{4})$/);
      if (match && months[match[1].slice(0, 3).toLowerCase()]) {
        month = months[match[1].slice(0, 3).toLowerCase()]; day = match[2]; year = match[3]; format = 'MMM-D-YYYY';
      }
    }
  }
  year = Number(year); month = Number(month); day = Number(day);
  if (!year || !month || !day || !validDateParts(year, month, day)) return dateResult('', 'invalid');
  return dateResult(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, 'valid', format);
}

function mappingIndex(header, mapping) {
  const normalized = header.map(normalizeFieldName);
  const candidates = mapping.names.map(normalizeFieldName);
  return normalized.findIndex(name => candidates.includes(name));
}

function headerFor(rows, family) {
  if (!rows.length) return { header: [], data: [], headered: false };
  const mappings = EST_FIELD_MAPPINGS[family];
  const required = family === 'manifest' ? mappings.orderId : mappings.trackingPin;
  const index = rows.findIndex(row => mappingIndex(row, required) >= 0);
  return index >= 0
    ? { header: rows[index].map(value => String(value || '').trim()), data: rows.slice(index + 1), headered: true }
    : { header: [], data: rows, headered: false };
}

function resolvedIndex(header, mapping, headered) {
  const position = headered ? mappingIndex(header, mapping) : mapping.position;
  return { position: Number.isInteger(position) ? position : -1, sourceName: headered && position >= 0 ? header[position] : (position >= 0 ? mapping.names[0] : '') };
}

function normalizeServiceEvidence({ directCode = '', articleNumber = '', description = '', sourceField = '' } = {}) {
  const directRaw = String(directCode || '').trim();
  const articleRaw = String(articleNumber || '').trim();
  const descriptionRaw = String(description || '').trim();
  const serviceCode = canonicalServiceCode(directRaw)
    || canonicalEstArticleService(articleRaw)
    || canonicalServiceCode(descriptionRaw);
  const supplied = Boolean(directRaw || articleRaw || descriptionRaw);
  let provenance = 'est_service_explicitly_unavailable';
  if (canonicalServiceCode(directRaw)) provenance = `${EST_IMPORT_SCHEMA_VERSION}:canonical-service-code`;
  else if (canonicalEstArticleService(articleRaw)) {
    const padding = /^0+\d+$/.test(articleRaw) ? ':numeric-zero-padding-normalized' : '';
    provenance = `${EST_IMPORT_SCHEMA_VERSION}:${EST_ARTICLE_SERVICE_TABLE_VERSION}:documented-article-number${padding}`;
  }
  else if (canonicalServiceCode(descriptionRaw)) provenance = `${EST_IMPORT_SCHEMA_VERSION}:authoritative-service-description`;
  return { serviceCode, status: serviceCode ? 'valid' : supplied ? 'invalid' : 'unavailable', sourceField: sourceField || 'unavailable', provenance };
}

function safeFieldName(value) {
  return String(value || '').replace(/[^A-Za-z0-9 #_()./\u2013-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 96);
}

function structuralType(value) {
  const text = String(value || '').trim();
  if (!text) return 'empty';
  if (/^\d+$/.test(text)) return 'digits';
  if (/^\d{4}[-/]?\d{2}[-/]?\d{2}(?:[T ].*)?$/.test(text)) return 'date_like';
  if (/^[A-Za-z0-9]+$/.test(text)) return 'alphanumeric';
  return 'text';
}

function structuralFields(header, family, headered, rows) {
  const mappings = EST_FIELD_MAPPINGS[family];
  const width = headered ? header.length : Math.max(0, ...rows.map(row => row.length));
  return Array.from({ length: width }, (_, position) => {
    const entry = Object.entries(mappings).find(([, mapping]) => (headered ? mappingIndex(header, mapping) : mapping.position) === position);
    const types = {};
    let presenceCount = 0;
    for (const row of rows) {
      const value = row[position] ?? '';
      const type = structuralType(value);
      types[type] = (types[type] || 0) + 1;
      if (String(value).trim()) presenceCount += 1;
    }
    return {
      position,
      sourceFieldName: safeFieldName(headered ? header[position] : entry?.[1].names[0] || `Unmapped position ${position}`),
      types,
      presenceCount,
      canonicalField: entry?.[0] || '',
      mappingResult: entry ? 'mapped' : 'unmapped'
    };
  });
}

function parseLines(lines) {
  return parseCsv(`${(lines || []).join('\n')}\n`).filter(row => row.some(value => String(value).trim()));
}

function increment(counter, name) { counter[name] = (counter[name] || 0) + 1; }

function numericJoinKey(value) {
  const text = String(value || '').trim();
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : '';
}

function parseManifestRows(lines) {
  const rows = parseLines(lines);
  const shape = headerFor(rows, 'manifest');
  const order = resolvedIndex(shape.header, EST_FIELD_MAPPINGS.manifest.orderId, shape.headered);
  const shipmentDate = resolvedIndex(shape.header, EST_FIELD_MAPPINGS.manifest.shipmentDate, shape.headered);
  const byOrder = new Map();
  const orderRecordCounts = new Map();
  const counts = { valid: 0, invalid: 0, missing: 0 };
  let candidateOrderIdCount = 0;
  let candidateShipmentDateCount = 0;
  for (const fields of shape.data) {
    const key = order.position >= 0 ? String(fields[order.position] || '').trim() : '';
    const rawDate = shipmentDate.position >= 0 ? fields[shipmentDate.position] : '';
    const normalized = normalizeEstShipmentDate(rawDate);
    if (key) candidateOrderIdCount += 1;
    if (String(rawDate || '').trim()) candidateShipmentDateCount += 1;
    counts[normalized.status] += 1;
    if (key) {
      orderRecordCounts.set(key, (orderRecordCounts.get(key) || 0) + 1);
      const evidence = {
        ...normalized,
        sourceField: safeFieldName(shipmentDate.sourceName || 'Mailing Date'),
        provenance: `${EST_IMPORT_SCHEMA_VERSION}:manifest:${shape.headered ? 'header' : `position-${shipmentDate.position}`}:order-join`
      };
      const existing = byOrder.get(key);
      if (!existing || (existing.status !== 'valid' && evidence.status === 'valid')) byOrder.set(key, evidence);
    }
  }
  return {
    byOrder,
    orderRecordCounts,
    diagnostic: {
      blockType: 'Manifest', rowCount: shape.data.length, headered: shape.headered,
      fields: structuralFields(shape.header, 'manifest', shape.headered, shape.data),
      candidateOrderIdCount, uniqueOrderIdCount: byOrder.size,
      multipleRowsPerOrderCount: [...orderRecordCounts.values()].filter(count => count > 1).length,
      candidateShipmentDateCount, validNormalizedShipmentDateCount: counts.valid,
      shipmentDate: counts
    }
  };
}

function parseManifestItemRows(lines, manifestByOrder = new Map()) {
  const rows = parseLines(lines);
  const shape = headerFor(rows, 'manifestItems');
  const mappings = EST_FIELD_MAPPINGS.manifestItems;
  const indices = Object.fromEntries(Object.entries(mappings).map(([name, mapping]) => [name, resolvedIndex(shape.header, mapping, shape.headered)]));
  const output = [];
  const seen = new Set();
  const counts = { shipmentDate: { valid: 0, invalid: 0, missing: 0 }, serviceCode: { valid: 0, invalid: 0, unavailable: 0 } };
  const rejectionCounts = {};
  const orderKeys = [];
  let candidateOrderIdCount = 0;
  let exactJoinMatchCount = 0;
  let candidateTrackingPinCount = 0;
  let validTrackingPinCount = 0;
  let candidateShipmentDateCount = 0;
  let candidateArticleServiceCount = 0;
  let recognizedServiceCount = 0;
  let recognizedServiceAfterNumericPaddingNormalizationCount = 0;
  for (const fields of shape.data) {
    const get = name => indices[name].position >= 0 ? String(fields[indices[name].position] || '').trim() : '';
    const orderId = get('orderId');
    orderKeys.push(orderId);
    if (orderId) candidateOrderIdCount += 1;
    else increment(rejectionCounts, 'MANIFEST_ITEM_ORDER_ID_MISSING');
    const inlineDate = normalizeEstShipmentDate(get('shipmentDate'));
    const manifestDate = manifestByOrder.get(orderId);
    if (manifestDate) exactJoinMatchCount += 1;
    else if (manifestByOrder.size) increment(rejectionCounts, 'MANIFEST_EXACT_JOIN_NOT_FOUND');
    const date = manifestDate || (inlineDate.status === 'valid' || inlineDate.status === 'invalid' ? {
      ...inlineDate,
      sourceField: safeFieldName(indices.shipmentDate.sourceName),
      provenance: `${EST_IMPORT_SCHEMA_VERSION}:manifest-items:header`
    } : { ...inlineDate, sourceField: 'unavailable', provenance: `${EST_IMPORT_SCHEMA_VERSION}:shipment-date-unavailable` });
    const service = normalizeServiceEvidence({
      directCode: get('serviceCode'),
      articleNumber: get('serviceArticle'),
      description: get('serviceDescription'),
      sourceField: indices.serviceCode.position >= 0 ? indices.serviceCode.sourceName : indices.serviceArticle.position >= 0 ? indices.serviceArticle.sourceName : indices.serviceDescription.sourceName
    });
    const pinRaw = get('trackingPin');
    const pin = pinRaw.replace(/\s+/g, '').toUpperCase();
    const articleOrService = get('serviceCode') || get('serviceArticle') || get('serviceDescription');
    if (pinRaw) candidateTrackingPinCount += 1;
    else increment(rejectionCounts, 'TRACKING_PIN_MISSING');
    if (validTrackingPin(pin)) validTrackingPinCount += 1;
    else increment(rejectionCounts, 'TRACKING_PIN_INVALID');
    if (date.status !== 'missing') candidateShipmentDateCount += 1;
    if (articleOrService) candidateArticleServiceCount += 1;
    if (service.status === 'valid') recognizedServiceCount += 1;
    const numericArticle = get('serviceArticle');
    if (/^0+\d+$/.test(numericArticle) && canonicalEstArticleService(numericArticle.replace(/^0+(?=\d)/, ''))) {
      recognizedServiceAfterNumericPaddingNormalizationCount += 1;
    }
    counts.shipmentDate[date.status] += 1;
    counts.serviceCode[service.status] += 1;
    if (date.status === 'missing') increment(rejectionCounts, 'AUTHORITATIVE_SHIPMENT_DATE_MISSING');
    if (date.status === 'invalid') increment(rejectionCounts, 'AUTHORITATIVE_SHIPMENT_DATE_INVALID');
    if (service.status === 'invalid') increment(rejectionCounts, 'SERVICE_ARTICLE_UNRECOGNIZED');
    if (!validTrackingPin(pin)) continue;
    if (seen.has(pin)) { increment(rejectionCounts, 'TRACKING_PIN_DUPLICATE'); continue; }
    seen.add(pin);
    output.push({
      trackingPin: pin,
      postalCode: get('postalCode').replace(/\s+/g, '').toUpperCase(),
      reference: get('reference'),
      serviceCode: service.serviceCode,
      eventDate: get('traceEventAt'),
      eventDescription: get('traceEventDescription'),
      shipmentDate: date.value,
      shipmentDateStatus: date.status,
      shipmentDateSourceField: date.sourceField,
      shipmentDateProvenance: date.provenance,
      serviceCodeStatus: service.status,
      serviceCodeSourceField: safeFieldName(service.sourceField),
      serviceCodeProvenance: service.provenance,
      importSchemaVersion: EST_IMPORT_SCHEMA_VERSION
    });
  }
  return {
    shipments: output,
    orderKeys,
    diagnostic: {
      blockType: 'ManifestItems', rowCount: shape.data.length, headered: shape.headered,
      fields: structuralFields(shape.header, 'manifestItems', shape.headered, shape.data),
      candidateOrderIdCount, exactJoinMatchCount,
      candidateTrackingPinCount, validTrackingPinCount,
      candidateShipmentDateCount, validNormalizedShipmentDateCount: counts.shipmentDate.valid,
      candidateArticleServiceCount, recognizedServiceCount,
      recognizedServiceAfterNumericPaddingNormalizationCount,
      acceptedCanonicalRowCount: output.length,
      rejectionCounts,
      counts
    }
  };
}

function isBlock(name, type) {
  const normalized = normalizeFieldName(name);
  // The live EST export names sections with the requested numeric filetype:
  // filetype 1 is Manifest and filetype 2 is ManifestItems. Named sections are
  // retained for documented/legacy fixtures. No unidentified numeric section
  // is treated as a known record family.
  if (type === 'manifestItems') return EST_EXPORT_SECTION_MAPPINGS.manifestItems.names.map(normalizeFieldName).includes(normalized) || (normalized.startsWith('manifestitems') && !normalized.startsWith('manifestitemsaddons') && !normalized.startsWith('manifestitemscustoms') && !normalized.startsWith('manifestitemsgoods'));
  return EST_EXPORT_SECTION_MAPPINGS.manifest.names.map(normalizeFieldName).includes(normalized) || (normalized.startsWith('manifest') && !normalized.startsWith('manifestitems'));
}

function parseEstExportBlocks(blocks) {
  const manifestLines = Object.entries(blocks).filter(([name]) => isBlock(name, 'manifest')).flatMap(([, rows]) => rows);
  const itemLines = Object.entries(blocks).filter(([name]) => isBlock(name, 'manifestItems')).flatMap(([, rows]) => rows);
  const manifest = parseManifestRows(manifestLines);
  const items = parseManifestItemRows(itemLines, manifest.byOrder);
  const itemKeys = new Set(items.orderKeys.filter(Boolean));
  const manifestKeys = new Set(manifest.byOrder.keys());
  const numericManifestKeys = new Set([...manifestKeys].map(numericJoinKey).filter(Boolean));
  const unmatchedItemKeys = [...itemKeys].filter(key => !manifestKeys.has(key));
  const join = {
    exactJoinMatchCount: items.diagnostic.exactJoinMatchCount,
    unmatchedManifestCount: [...manifestKeys].filter(key => !itemKeys.has(key)).length,
    unmatchedManifestItemsCount: items.orderKeys.filter(key => key && !manifestKeys.has(key)).length,
    numericNormalizedPotentialMatchCount: unmatchedItemKeys.filter(key => numericManifestKeys.has(numericJoinKey(key))).length,
    multipleManifestRowsPerOrderCount: manifest.diagnostic.multipleRowsPerOrderCount
  };
  return { shipments: items.shipments, diagnostic: { schemaVersion: EST_IMPORT_SCHEMA_VERSION, join, blocks: [manifest.diagnostic, items.diagnostic] } };
}

function assessEstImportQuality(shipments) {
  const rows = Array.isArray(shipments) ? shipments : [];
  const totalRows = rows.length;
  const missingShipmentDate = rows.filter(row => row.shipmentDateStatus === 'missing' || (!row.shipmentDate && row.shipmentDateStatus !== 'invalid')).length;
  const invalidShipmentDate = rows.filter(row => row.shipmentDateStatus === 'invalid').length;
  const unavailableService = rows.filter(row => row.serviceCodeStatus === 'unavailable').length;
  const invalidService = rows.filter(row => row.serviceCodeStatus === 'invalid').length;
  const missingProvenance = rows.filter(row => !row.shipmentDateProvenance || !row.serviceCodeProvenance || row.importSchemaVersion !== EST_IMPORT_SCHEMA_VERSION).length;
  // Tracking PIN is the only discovery field required by the operational
  // workflow. Shipment date, service and their provenance remain enrichment;
  // their absence is reported without excluding an otherwise usable row.
  const incompleteRows = rows.filter(row => !row.trackingPin);
  const optionalMetadataWarnings = rows.filter(row =>
    !row.shipmentDate || row.shipmentDateStatus !== 'valid'
    || !row.serviceCode || row.serviceCodeStatus !== 'valid'
    || !row.shipmentDateProvenance || !row.serviceCodeProvenance
  ).length;
  const dateFailureCount = missingShipmentDate + invalidShipmentDate;
  const systemicDateFailure = totalRows > 0 && dateFailureCount / totalRows >= 0.5;
  const incompleteSet = new Set(incompleteRows);
  return {
    schemaVersion: EST_IMPORT_SCHEMA_VERSION,
    totalRows,
    validRows: totalRows - incompleteRows.length,
    incompleteRows: incompleteRows.length,
    missingShipmentDate,
    invalidShipmentDate,
    unavailableService,
    invalidService,
    missingProvenance,
    optionalMetadataWarnings,
    systemicDateFailure,
    promotableRows: rows.filter(row => !incompleteSet.has(row))
  };
}

module.exports = {
  EST_IMPORT_SCHEMA_VERSION,
  EST_EXPORT_SECTION_MAPPINGS,
  EST_FIELD_MAPPINGS,
  normalizeFieldName,
  validTrackingPin,
  normalizeEstShipmentDate,
  normalizeServiceEvidence,
  parseManifestRows,
  parseManifestItemRows,
  parseEstExportBlocks,
  assessEstImportQuality
};
