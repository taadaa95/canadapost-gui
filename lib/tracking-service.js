'use strict';

const policy = require('../config/policy-rules.json');

const SERVICE_ALIASES = Object.freeze({
  'DOM.PC': ['priority', 'priorite', 'priorité'],
  'DOM.XP': ['xpresspost', 'xpresspost certifie', 'xpresspost certifié'],
  'DOM.EP': ['expedited parcel', 'colis acceleres', 'colis accélérés', 'colis accelere', 'colis accéléré'],
  'DOM.RP': ['regular parcel', 'colis standard'],
  'USA.XP': ['xpresspost usa', 'xpresspost etats-unis', 'xpresspost états-unis'],
  'USA.EP': ['expedited parcel usa', 'colis acceleres etats-unis', 'colis accélérés états-unis'],
  'USA.TP': ['tracked packet usa', 'petit paquet repérable états-unis', 'petit paquet reperable etats-unis'],
  'INT.XP': ['xpresspost international'],
  'INT.PW': ['priority worldwide', 'priorite mondial', 'priorité mondial']
});

const EST_ARTICLE_SERVICE_TABLE_VERSION = 'est-article-services-2015-v2';
// Canada Post EST 2.0 Export File Specifications, Appendix C (April 2015).
const EST_ARTICLE_SERVICE_CODES = Object.freeze({
  '908': 'DOM.XP',
  '926': 'DOM.XP',
  '8401': 'DOM.XP.CERT',
  '966': 'DOM.RP',
  '967': 'DOM.EP',
  '1469': 'DOM.PC',
  '1654': 'DOM.PC',
  '6210': 'INT.XP',
  '1917': 'USA.XP',
  '2125': 'USA.XP',
  '6470': 'USA.EP',
  '1123': 'USA.SP.AIR',
  '1124': 'USA.SP.SURF',
  '9610': 'INT.SP.AIR',
  '9611': 'INT.SP.SURF',
  '985': 'INT.IP.AIR',
  '984': 'INT.IP.SURF'
});

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

const LOOKUP = new Map();
for (const [code, aliases] of Object.entries(SERVICE_ALIASES)) {
  LOOKUP.set(normalizeLabel(code), code);
  for (const alias of aliases) LOOKUP.set(normalizeLabel(alias), code);
  const officialName = policy.services?.[code]?.name;
  if (officialName) LOOKUP.set(normalizeLabel(officialName), code);
}

function canonicalServiceCode(value) {
  const direct = String(value || '').trim().toUpperCase();
  if (Object.hasOwn(policy.services || {}, direct)) return direct;
  return LOOKUP.get(normalizeLabel(value)) || '';
}

function canonicalEstArticleService(value) {
  const raw = String(value || '').trim();
  // Live EST filetype 2 exports SAP MATNR values as fixed-width, zero-padded
  // decimal article numbers. Appendix C publishes the equivalent unpadded
  // article numbers. Leading zero removal is limited to an all-decimal MATNR;
  // no other numeric or descriptive inference is performed.
  const article = /^\d+$/.test(raw) ? raw.replace(/^0+(?=\d)/, '') : raw;
  return EST_ARTICLE_SERVICE_CODES[article] || '';
}

function resolveTrackingService({ apiServiceName = '', apiAlternateServiceName = '', estServiceCode = '' } = {}) {
  for (const raw of [apiServiceName, apiAlternateServiceName]) {
    const code = canonicalServiceCode(raw);
    if (code) {
      return {
        serviceValue: String(raw).trim(),
        serviceCode: code,
        normalizedService: policy.services[code].name,
        source: 'tracking_api',
        recognized: true
      };
    }
  }
  const imported = canonicalServiceCode(estServiceCode);
  if (imported) {
    return {
      serviceValue: String(estServiceCode).trim(),
      serviceCode: imported,
      normalizedService: policy.services[imported].name,
      source: 'est_import',
      recognized: true
    };
  }
  return {
    serviceValue: '',
    serviceCode: '',
    normalizedService: '',
    source: 'unknown',
    recognized: false
  };
}

module.exports = { SERVICE_ALIASES, EST_ARTICLE_SERVICE_TABLE_VERSION, EST_ARTICLE_SERVICE_CODES, canonicalServiceCode, canonicalEstArticleService, resolveTrackingService };
