'use strict';

const fs = require('fs');
const path = require('path');
const { stringifyCsv } = require('./csv');
const { EST_IMPORT_SCHEMA_VERSION, assessEstImportQuality } = require('./est-import-schema');

const TRACKING_HEADERS = [
  'Tracking PIN', 'Destination Postal Code', 'Reference #', 'Shipment ID', 'Manifest ID', 'PO Number',
  'Service Code', 'Service Code Source Field', 'Service Code Provenance',
  'Destination City', 'Destination Province',
  'Shipment Date', 'Shipment Date Source Field', 'Shipment Date Provenance',
  'Import Schema Version', 'Source', 'MOBO'
];

function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function writeTrackingCsvAtomic(outputFile, shipments, { dataDir, backupLabel = 'import' } = {}) {
  if (!Array.isArray(shipments) || !shipments.length) throw new Error('No shipment rows were available to write.');
  const quality = assessEstImportQuality(shipments);
  if (quality.incompleteRows) {
    const error = new Error(`Tracking import quality gate rejected ${quality.incompleteRows} incomplete row(s); the previous tracking.csv was preserved.`);
    error.code = quality.systemicDateFailure ? 'EST_EXPORT_SHIPMENT_DATE_SCHEMA_FAILURE' : 'EST_IMPORT_QUALITY_GATE_FAILED';
    error.quality = { ...quality, promotableRows: undefined };
    throw error;
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  let backupPath = '';
  if (fs.existsSync(outputFile)) {
    backupPath = path.join(dataDir || path.dirname(outputFile), `tracking-backup-before-${backupLabel}-${timestamp()}.csv`);
    fs.copyFileSync(outputFile, backupPath);
    try { fs.chmodSync(backupPath, 0o600); } catch (_) {}
  }
  const rows = shipments.map(item => ({
    'Tracking PIN': item.trackingPin,
    'Destination Postal Code': item.postalCode,
    'Reference #': item.reference,
    'Shipment ID': item.shipmentId,
    'Manifest ID': item.manifestId,
    'PO Number': item.poNumber,
    'Service Code': item.serviceCode,
    'Service Code Source Field': item.serviceCodeSourceField,
    'Service Code Provenance': item.serviceCodeProvenance,
    'Destination City': item.destinationCity,
    'Destination Province': item.destinationProvince,
    'Shipment Date': item.shipmentDate,
    'Shipment Date Source Field': item.shipmentDateSourceField,
    'Shipment Date Provenance': item.shipmentDateProvenance,
    'Import Schema Version': item.importSchemaVersion || EST_IMPORT_SCHEMA_VERSION,
    Source: item.source,
    MOBO: item.mobo
  }));
  const temporary = `${outputFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, stringifyCsv(TRACKING_HEADERS, rows), { mode: 0o600 });
  fs.renameSync(temporary, outputFile);
  return { outputFile, backupPath, count: shipments.length };
}

module.exports = { TRACKING_HEADERS, writeTrackingCsvAtomic };
