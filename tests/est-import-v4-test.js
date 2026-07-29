'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EST_IMPORT_SCHEMA_VERSION,
  EST_EXPORT_SECTION_MAPPINGS,
  EST_FIELD_MAPPINGS,
  normalizeEstShipmentDate,
  parseManifestItemRows,
  parseEstExportBlocks,
  assessEstImportQuality
} = require('../lib/est-import-schema');
const { EST_ARTICLE_SERVICE_TABLE_VERSION, canonicalEstArticleService } = require('../lib/tracking-service');
const { rowsAsObjects } = require('../lib/csv');
const { writeTrackingCsvAtomic } = require('../lib/import-output');
const { analyzeExportResponse } = require('../scripts/import-est-history');
const { validateTrackingCsvPolicyDates } = require('../scripts/get-tracking');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

assert.strictEqual(EST_IMPORT_SCHEMA_VERSION, 'est-import-v5');
assert.strictEqual(EST_ARTICLE_SERVICE_TABLE_VERSION, 'est-article-services-2015-v2');
assert.strictEqual(EST_EXPORT_SECTION_MAPPINGS.manifest.filetype, '1');
assert.strictEqual(EST_EXPORT_SECTION_MAPPINGS.manifestItems.filetype, '2');
assert.strictEqual(EST_FIELD_MAPPINGS.manifest.shipmentDate.position, 8);
assert.strictEqual(EST_FIELD_MAPPINGS.manifestItems.serviceArticle.position, 2);
assert.strictEqual(EST_FIELD_MAPPINGS.manifestItems.trackingPin.position, 16);
assert.strictEqual(EST_FIELD_MAPPINGS.manifestItems.postalCode.position, 27);
assert.strictEqual(EST_FIELD_MAPPINGS.manifestItems.reference.position, 30);
assert.strictEqual(canonicalEstArticleService('000000000000000908'), 'DOM.XP');
assert.strictEqual(canonicalEstArticleService('000000000000000967'), 'DOM.EP');
assert.strictEqual(canonicalEstArticleService('000000000000001469'), 'DOM.PC');
assert.strictEqual(canonicalEstArticleService('000000000000009999'), '');

for (const [input, expected] of [
  ['2026-07-28', '2026-07-28'],
  ['20260728', '2026-07-28'],
  ['2026/7/28', '2026-07-28'],
  ['07/28/2026', '2026-07-28'],
  ['28/07/2026', '2026-07-28'],
  ['28-Jul-2026', '2026-07-28'],
  ['July 28, 2026', '2026-07-28'],
  ['2026-07-28T23:59:59-07:00', '2026-07-28']
]) assert.strictEqual(normalizeEstShipmentDate(input).value, expected, input);
assert.strictEqual(normalizeEstShipmentDate('2026-02-30').status, 'invalid');
assert.strictEqual(normalizeEstShipmentDate('').status, 'missing');

const manifest = Array(9).fill('');
manifest[0] = 'ORDER-SYNTHETIC';
manifest[7] = '20260727'; // Creation Date must never replace Mailing Date.
manifest[8] = '20260728';
const item = Array(38).fill('');
item[0] = 'ORDER-SYNTHETIC';
item[2] = '908';
item[16] = 'SYNTHETIC900001';
item[27] = 'K1A 0B1';
item[30] = 'ORDER-SYNTHETIC';
item[31] = '2026-07-29';
item[32] = 'Trace event';
const official = parseEstExportBlocks({ Manifest: [manifest.join(',')], ManifestItems: [item.join(',')] });
assert.strictEqual(official.shipments.length, 1);
assert.strictEqual(official.shipments[0].shipmentDate, '2026-07-28');
assert.strictEqual(official.shipments[0].serviceCode, 'DOM.XP');
assert.strictEqual(official.shipments[0].shipmentDateSourceField, 'Mailing Date');
assert.strictEqual(official.shipments[0].serviceCodeSourceField, 'MATNR – Article Number');
assert.match(official.shipments[0].shipmentDateProvenance, /position-8:order-join/);
assert.match(official.shipments[0].serviceCodeProvenance, /documented-article-number/);
assert.strictEqual(official.shipments[0].eventDate, '2026-07-29');

const structuralJson = JSON.stringify(official.diagnostic);
assert(!structuralJson.includes('SYNTHETIC900001'));
assert(!structuralJson.includes('ORDER-SYNTHETIC'));
assert(official.diagnostic.blocks.every(block => block.fields.every(field => Object.hasOwn(field, 'position') && Object.hasOwn(field, 'canonicalField'))));

const headeredLegacy = parseManifestItemRows([
  'Tracking Number,Postal Code,Customer Reference 1,Product Code,Ship Date',
  'SYNTHETIC900002,K1A0B1,REF-SYNTHETIC,DOM.EP,07/28/2026'
]).shipments[0];
assert.strictEqual(headeredLegacy.shipmentDate, '2026-07-28');
assert.strictEqual(headeredLegacy.serviceCode, 'DOM.EP');

const traceOnly = parseManifestItemRows([
  'Tracking PIN,Date Time Trace Inquiry Event,Description Significant Event',
  'SYNTHETIC900003,2026-07-28,Shipment created'
]).shipments[0];
assert.strictEqual(traceOnly.shipmentDate, '');
assert.strictEqual(traceOnly.shipmentDateStatus, 'missing');
assert.strictEqual(traceOnly.serviceCode, '');
assert.strictEqual(traceOnly.serviceCodeStatus, 'unavailable');

const noService = parseManifestItemRows([
  'Tracking PIN,Shipment Date',
  'SYNTHETIC900004,2026-07-28'
]).shipments[0];
assert.strictEqual(noService.serviceCodeStatus, 'unavailable');
assert.strictEqual(assessEstImportQuality([noService]).validRows, 1, 'API service fallback must remain permitted');

const complete = { ...noService, trackingPin: 'SYNTHETIC900005' };
const partial = assessEstImportQuality([complete, { ...complete, trackingPin: 'SYNTHETIC900006' }, traceOnly]);
assert.strictEqual(partial.systemicDateFailure, false);
assert.strictEqual(partial.incompleteRows, 0);
assert.strictEqual(partial.promotableRows.length, 3);
assert.strictEqual(partial.optionalMetadataWarnings, 3);
const allMissing = assessEstImportQuality([traceOnly, { ...traceOnly, trackingPin: 'SYNTHETIC900007' }]);
assert.strictEqual(allMissing.systemicDateFailure, true);
assert.strictEqual(allMissing.promotableRows.length, 2, 'missing optional Shipment Date must not exclude valid tracking PINs');
assert.strictEqual(validateTrackingCsvPolicyDates([{ 'Tracking PIN': 'SYNTHETIC900003', 'Shipment Date': '' }]).missingShipmentDate, 1);
assert.strictEqual(validateTrackingCsvPolicyDates([{ 'Tracking PIN': 'SYNTHETIC900003', 'Shipment Date': '2026-02-30' }]).invalidShipmentDate, 1);
assert.strictEqual(validateTrackingCsvPolicyDates([{ 'Tracking PIN': 'SYNTHETIC900003', 'Shipment Date': '2026-07-28' }]).totalRows, 1);

const analyzed = analyzeExportResponse(fixture('est-export-legacy.txt'));
assert.strictEqual(analyzed.shipments[0].shipmentDate, '2026-06-01');
assert.strictEqual(analyzed.shipments[0].serviceCode, 'DOM.XP');
assert.strictEqual(analyzed.quality.incompleteRows, 0);

const liveShape = analyzeExportResponse(fixture('est-live-numeric-blocks-sanitized.txt'));
assert.strictEqual(liveShape.format, 'est-blocks');
assert.deepStrictEqual(liveShape.blockNames, ['1', '2']);
assert.strictEqual(liveShape.shipments.length, 3);
assert.deepStrictEqual(liveShape.shipments.map(row => row.shipmentDate), ['2026-07-28', '2026-07-28', '2026-07-29']);
assert.deepStrictEqual(liveShape.shipments.map(row => row.serviceCode), ['DOM.XP', 'DOM.EP', 'DOM.PC']);
assert.ok(liveShape.shipments.every(row => row.importSchemaVersion === EST_IMPORT_SCHEMA_VERSION));
assert.ok(liveShape.shipments.every(row => row.serviceCodeProvenance.includes('numeric-zero-padding-normalized')));
assert.strictEqual(liveShape.structuralDiagnostic.transport.manifestReturned, true);
assert.strictEqual(liveShape.structuralDiagnostic.transport.manifestItemsReturned, true);
assert.strictEqual(liveShape.structuralDiagnostic.transport.sectionsInOneResponse, true);
assert.strictEqual(liveShape.structuralDiagnostic.parser.join.exactJoinMatchCount, 3);
assert.strictEqual(liveShape.structuralDiagnostic.parser.join.unmatchedManifestCount, 0);
assert.strictEqual(liveShape.structuralDiagnostic.parser.join.unmatchedManifestItemsCount, 0);
assert.strictEqual(liveShape.quality.incompleteRows, 0);
assert(!JSON.stringify(liveShape.structuralDiagnostic).includes('9990000000000001'));

const liveLines = fixture('est-live-numeric-blocks-sanitized.txt').split(/\r?\n/);
const invalidPinShape = ['1', '1', liveLines[2], '', '2', '1', liveLines[7].replace('9990000000000001', 'INVALID'), ''].join('\n');
assert.throws(
  () => analyzeExportResponse(invalidPinShape),
  error => error.code === 'EST_EXPORT_ZERO_ROWS'
    && /1 item records parsed; 1 Manifest joins; 0 valid tracking PINs; 1 valid Manifest shipment dates; 1 rejected for TRACKING_PIN_INVALID/.test(error.message)
    && !error.message.includes('1001')
);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-est-quality-'));
try {
  const output = path.join(temporary, 'tracking.csv');
  const sentinel = 'previous valid tracking output\n';
  fs.writeFileSync(output, sentinel, { mode: 0o600 });
  const permissive = writeTrackingCsvAtomic(output, [traceOnly], { dataDir: temporary });
  assert.strictEqual(permissive.count, 1);
  const permissiveRow = rowsAsObjects(fs.readFileSync(output, 'utf8'))[0];
  assert.strictEqual(permissiveRow['Tracking PIN'], 'SYNTHETIC900003');
  assert.strictEqual(permissiveRow['Shipment Date'], '');
  assert.strictEqual(permissiveRow['Service Code'], '');

  writeTrackingCsvAtomic(output, [noService], { dataDir: temporary });
  const row = rowsAsObjects(fs.readFileSync(output, 'utf8'))[0];
  assert.strictEqual(row['Shipment Date'], '2026-07-28');
  assert.strictEqual(row['Shipment Date Source Field'], 'Shipment Date');
  assert.match(row['Shipment Date Provenance'], /manifest-items:header/);
  assert.strictEqual(row['Service Code'], '');
  assert.strictEqual(row['Service Code Provenance'], 'est_service_explicitly_unavailable');
  assert.strictEqual(row['Import Schema Version'], EST_IMPORT_SCHEMA_VERSION);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('EST parser-v5 live-shape mapping, normalization, structural diagnostics and quality-gate tests passed.');
