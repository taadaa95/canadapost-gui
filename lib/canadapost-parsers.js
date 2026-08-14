'use strict';

const { parseXmlSecure, findAll, firstText, scalar } = require('./secure-xml');
const { normalizeDate } = require('./business-calendar');
const {
  EST_IMPORT_SCHEMA_VERSION,
  normalizeEstShipmentDate,
  normalizeServiceEvidence,
  parseManifestItemRows
} = require('./est-import-schema');

function valueFor(node, name) {
  const values = findAll(node, name);
  return values.map(scalar).find(Boolean) || '';
}

function parseLinks(xml, label = 'Canada Post XML') {
  const parsed = parseXmlSecure(xml, label);
  return findAll(parsed, 'link').flatMap(link => {
    if (!link || typeof link !== 'object') return [];
    const rel = String(link['@_rel'] || valueFor(link, 'rel') || '').trim();
    const href = String(link['@_href'] || valueFor(link, 'href') || '').trim();
    const mediaType = String(link['@_media-type'] || link['@_mediaType'] || valueFor(link, 'media-type') || '').trim();
    return rel && href ? [{ rel, href, mediaType }] : [];
  });
}

function parseShipmentDetail(xml, fallback = {}) {
  const parsed = parseXmlSecure(xml, 'shipment details');
  const mailingDate = firstText(parsed, 'mailing-date');
  const shipmentDateRaw = mailingDate || firstText(parsed, 'shipment-date');
  const date = normalizeEstShipmentDate(shipmentDateRaw);
  const rawService = firstText(parsed, ['service-code', 'product-code']) || fallback.serviceCode || '';
  const service = normalizeServiceEvidence({ directCode: rawService, sourceField: rawService ? (firstText(parsed, 'service-code') ? 'service-code' : 'product-code') : '' });
  return {
    trackingPin: firstText(parsed, ['tracking-pin', 'pin']) || fallback.trackingPin || '',
    postalCode: firstText(parsed, ['postal-zip-code', 'destination-postal-id']).replace(/\s+/g, '').toUpperCase(),
    reference: firstText(parsed, ['customer-ref-1', 'customer-request-id']) || fallback.reference || fallback.shipmentId || '',
    shipmentId: firstText(parsed, 'shipment-id') || fallback.shipmentId || '',
    serviceCode: service.serviceCode,
    destinationCity: firstText(parsed, 'city'),
    destinationProvince: firstText(parsed, ['prov-state', 'province']),
    shipmentDate: date.value,
    shipmentDateStatus: date.status,
    shipmentDateSourceField: mailingDate ? 'mailing-date' : shipmentDateRaw ? 'shipment-date' : 'unavailable',
    shipmentDateProvenance: `${EST_IMPORT_SCHEMA_VERSION}:shipment-xml`,
    serviceCodeStatus: service.status,
    serviceCodeSourceField: service.sourceField,
    serviceCodeProvenance: service.provenance,
    importSchemaVersion: EST_IMPORT_SCHEMA_VERSION
  };
}

function looksPin(value) { const clean = String(value || '').replace(/\s+/g, ''); return /^[a-z0-9]{10,35}$/i.test(clean) && /\d{6,}/.test(clean); }
function looksPostal(value) { return /^(?:[a-z]\d[a-z]\d[a-z]\d|\d{5}(?:\d{4})?)$/i.test(String(value || '').replace(/\s+/g, '')); }

function parseEstManifestItems(text) {
  return parseManifestItemRows(String(text || '').split(/\r?\n/)).shipments;
}

function parseTrackingSoap(xml, pin) {
  const parsed = parseXmlSecure(xml, 'tracking SOAP response');
  const faults = findAll(parsed, 'faultstring').map(scalar).filter(Boolean);
  if (faults.length) throw new Error(`Canada Post tracking SOAP fault: ${faults[0].slice(0, 500)}`);
  const summaries = findAll(parsed, 'pin-summary');
  const summary = summaries.find(item => firstText(item, 'pin') === pin) || summaries[0] || {};
  const occurrences = [
    ...findAll(parsed, 'occurrence'),
    ...findAll(parsed, 'item').filter(value => firstText(value, ['event-identifier', 'event-id', 'event-code']))
  ].flatMap(value => Array.isArray(value) ? value : [value]);
  return {
    pin: firstText(summary, 'pin') || pin,
    expectedDeliveryDate: normalizeDate(firstText(summary, 'expected-delivery-date') || firstText(parsed, 'expected-delivery-date')),
    actualDeliveryDate: normalizeDate(firstText(summary, 'actual-delivery-date')),
    eventDescription: firstText(summary, 'event-description'),
    serviceName: firstText(summary, 'service-name') || firstText(parsed, 'service-name'),
    postalCode: firstText(summary, 'destination-postal-id'),
    reference: firstText(summary, 'customer-ref-1'),
    events: occurrences.map(event => ({
      code: firstText(event, ['event-identifier', 'event-id', 'event-code']),
      description: firstText(event, 'event-description'),
      timestamp: firstText(event, ['event-date-time']) || [firstText(event, 'event-date'), firstText(event, 'event-time')].filter(Boolean).join('T'),
      eventDate: firstText(event, 'event-date')
    }))
  };
}

module.exports = { parseLinks, parseShipmentDetail, parseEstManifestItems, parseTrackingSoap, looksPin, looksPostal };
