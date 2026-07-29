'use strict';

const SENSITIVE = /(?:pin|tracking|name|address|postal|location|site|province|signature|reference|customer|description|token|credential|secret)/i;
const SAFE_ENUM_PATH = /(?:\.eventIdentifier|\.deliveryOption|\.(?:activeExists|archiveExists|signatureImageExists|suppressSignature))$/;
const ROOT_FIELDS = new Set([
  'pin', 'activeExists', 'archiveExists', 'signatureImageExists', 'suppressSignature',
  'changedExpectedDate', 'expectedDeliveryDate', 'changedExpectedDeliveryReason',
  'destinationPostalId', 'originalPin', 'serviceName', 'serviceName2', 'customerRef1',
  'customerRef2', 'returnPin', 'deliveryOptions', 'significantEvents'
]);
const EVENT_FIELDS = new Set([
  'eventIdentifier', 'eventDate', 'eventTime', 'eventTimeZone', 'eventDescription',
  'eventSite', 'eventProvince', 'eventRetailLocationId', 'eventRetailName'
]);
const OPTION_FIELDS = new Set(['deliveryOption', 'deliveryOptionDescription']);

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function recognizedPath(path) {
  if (path === '$' || path === '$.significantEvents[*]' || path === '$.deliveryOptions[*]') return true;
  const root = /^\$\.([A-Za-z0-9_]+)$/.exec(path);
  if (root) return ROOT_FIELDS.has(root[1]);
  const event = /^\$\.significantEvents\[\*\]\.([A-Za-z0-9_]+)$/.exec(path);
  if (event) return EVENT_FIELDS.has(event[1]);
  const option = /^\$\.deliveryOptions\[\*\]\.([A-Za-z0-9_]+)$/.exec(path);
  return Boolean(option && OPTION_FIELDS.has(option[1]));
}

function structuralPath(path) { return path.replace(/\[\d+\]/g, '[*]'); }

function safeEnum(path, value) {
  if (SENSITIVE.test(path) || !SAFE_ENUM_PATH.test(path)) return undefined;
  if (typeof value === 'boolean') return value;
  const text = String(value || '');
  return /^[A-Za-z0-9_.-]{1,32}$/.test(text) ? text : undefined;
}

function buildSanitizedStructure(payload, options = {}) {
  const entries = [];
  const seen = new Set();
  const byKey = new Map();
  const visit = (value, path, depth) => {
    if (depth > 12 || entries.length >= 2000) return;
    const canonicalPath = structuralPath(path);
    const key = `${canonicalPath}|${valueType(value)}`;
    if (!seen.has(key)) {
      seen.add(key);
      const entry = { path: canonicalPath, type: valueType(value), recognized: recognizedPath(canonicalPath) };
      if (Array.isArray(value)) entry.arrayLength = value.length;
      const enumValue = safeEnum(canonicalPath, value);
      if (enumValue !== undefined) entry.enumValues = [enumValue];
      entries.push(entry);
      byKey.set(key, entry);
    } else {
      const enumValue = safeEnum(canonicalPath, value);
      const entry = byKey.get(key);
      if (entry && enumValue !== undefined && !(entry.enumValues || []).includes(enumValue)) {
        entry.enumValues = [...(entry.enumValues || []), enumValue].slice(0, 100);
      }
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
    } else if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) visit(child, `${path}.${name}`, depth + 1);
    }
  };
  visit(payload, '$', 0);
  const timestampFields = [...new Set(entries.filter(item => /(?:Date|Time|Timestamp)$/i.test(item.path)).map(item => item.path))];
  const eventCodeFields = [...new Set(entries.filter(item => /event(?:Identifier|Code)$/i.test(item.path)).map(item => item.path))];
  const serviceFields = [...new Set(entries.filter(item => /service/i.test(item.path)).map(item => item.path))];
  const statusFields = [...new Set(entries.filter(item => /(?:status|activeExists|archiveExists)$/i.test(item.path)).map(item => item.path))];
  return {
    format: 'canada-post-tracking-sanitized-structure-v1',
    generatedAt: new Date().toISOString(),
    apiVersion: String(options.apiVersion || ''),
    responseShape: String(options.responseShape || 'official_direct_object'),
    entries,
    timestampFields,
    eventCodeFields,
    serviceFields,
    statusFields,
    recognizedPaths: entries.filter(item => item.recognized).map(item => item.path),
    unrecognizedPaths: entries.filter(item => !item.recognized).map(item => item.path),
    schemaValidationErrors: (options.validationErrors || []).map(value => String(value).slice(0, 500))
  };
}

module.exports = { buildSanitizedStructure, recognizedPath };
