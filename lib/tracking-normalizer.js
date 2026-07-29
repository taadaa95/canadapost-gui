'use strict';

const { normalizeDate } = require('./business-calendar');
const { sha256Canonical } = require('./canonical-json');

const EVENT_TYPES = Object.freeze({
  EXPECTED_DELIVERY: 'EXPECTED_DELIVERY',
  FIRST_DELIVERY_ATTEMPT: 'FIRST_DELIVERY_ATTEMPT',
  ADDRESS_DELIVERY_ATTEMPT: 'ADDRESS_DELIVERY_ATTEMPT',
  SUCCESSFUL_DELIVERY: 'SUCCESSFUL_DELIVERY',
  DELIVERY_TO_POST_OFFICE: 'DELIVERY_TO_POST_OFFICE',
  NOTICE_CARD: 'NOTICE_CARD',
  RECIPIENT_UNAVAILABLE: 'RECIPIENT_UNAVAILABLE',
  ADDRESS_PROBLEM: 'ADDRESS_PROBLEM',
  CUSTOMS_DELAY: 'CUSTOMS_DELAY',
  WEATHER_DISRUPTION: 'WEATHER_DISRUPTION',
  OPERATIONAL_DISRUPTION: 'OPERATIONAL_DISRUPTION',
  LABOUR_DISRUPTION: 'LABOUR_DISRUPTION',
  SENDER_CAUSED_DELAY: 'SENDER_CAUSED_DELAY',
  DELIVERY_STANDARD_ADJUSTMENT: 'DELIVERY_STANDARD_ADJUSTMENT',
  RETURN_TO_SENDER: 'RETURN_TO_SENDER',
  ELECTRONIC_INFORMATION: 'ELECTRONIC_INFORMATION',
  ACCEPTED: 'ACCEPTED',
  ITEM_PROCESSED: 'ITEM_PROCESSED',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  AVAILABLE_FOR_PICKUP: 'AVAILABLE_FOR_PICKUP',
  PICKED_UP: 'PICKED_UP',
  SIGNATURE_AVAILABLE: 'SIGNATURE_AVAILABLE',
  UNKNOWN: 'UNKNOWN'
});

const DELIVERY_STATES = Object.freeze({
  DELIVERED: 'DELIVERED',
  DELIVERY_ATTEMPTED_NOT_DELIVERED: 'DELIVERY_ATTEMPTED_NOT_DELIVERED',
  IN_TRANSIT: 'IN_TRANSIT',
  NO_DELIVERY_EVIDENCE: 'NO_DELIVERY_EVIDENCE'
});

// Events 1496 (delivered) and 20 (signature image) appear in the official Tracking Details OpenAPI example.
// The operator's authorized value-free production semantic report also confirmed 1442 as the successful-delivery
// event for the inspected shipment. No meaning is guessed for other identifiers merely observed in the structure.
const DOCUMENTED_EVENT_CODES = Object.freeze({
  '1442': EVENT_TYPES.SUCCESSFUL_DELIVERY,
  '1496': EVENT_TYPES.SUCCESSFUL_DELIVERY,
  '20': EVENT_TYPES.SIGNATURE_AVAILABLE
});

const PATTERNS = [
  [EVENT_TYPES.RETURN_TO_SENDER, /return(?:ed)? to sender|renvoy[ée] (?:à|a) l['’]exp[ée]diteur/i],
  [EVENT_TYPES.LABOUR_DISRUPTION, /labou?r disruption|strike|gr[èe]ve|conflit de travail/i],
  [EVENT_TYPES.CUSTOMS_DELAY, /customs|douane|d[ée]douanement|regulatory authorit/i],
  [EVENT_TYPES.WEATHER_DISRUPTION, /weather|storm|snow|flood|m[ée]t[ée]o|temp[êe]te|inondation/i],
  [EVENT_TYPES.DELIVERY_TO_POST_OFFICE, /deliver(?:ed|y) to (?:the )?post office|livr[ée](?:e)? au bureau de poste/i],
  [EVENT_TYPES.ADDRESS_DELIVERY_ATTEMPT, /(?:delivery attempt|attempted delivery|unable to deliver|could not deliver).{0,80}address|address.{0,80}(?:delivery attempt|attempted delivery|unable to deliver|could not deliver)|(?:tentative de livraison|impossible de livrer).{0,80}adresse|adresse.{0,80}(?:tentative de livraison|impossible de livrer)/i],
  [EVENT_TYPES.ADDRESS_PROBLEM, /address.*(?:incorrect|incomplete|problem)|adresse.*(?:incorrecte|incompl[èe]te|probl[èe]me)/i],
  [EVENT_TYPES.SENDER_CAUSED_DELAY, /sender.*(?:request|error|instruction)|exp[ée]diteur.*(?:demande|erreur|instruction)/i],
  [EVENT_TYPES.DELIVERY_STANDARD_ADJUSTMENT, /delivery standard.*(?:adjust|chang)|date.*livraison.*(?:modifi|rajust)/i],
  [EVENT_TYPES.NOTICE_CARD, /delivery notice card|notice card|avis (?:de|du) livraison|carte d['’]avis/i],
  [EVENT_TYPES.RECIPIENT_UNAVAILABLE, /recipient.*(?:unavailable|not available)|no one available|destinataire.*absent|personne.*(?:n['’]est )?disponible/i],
  [EVENT_TYPES.FIRST_DELIVERY_ATTEMPT, /first delivery attempt|delivery attempt(?:ed)?|attempted delivery|premi[èe]re tentative de livraison|tentative de livraison/i],
  [EVENT_TYPES.SUCCESSFUL_DELIVERY, /\b(?:successfully )?delivered\b|livr[ée]e?(?:\s|$)|community mailbox|parcel locker|recipient['’]?s side door|bo[iî]te communautaire|casier [àa] colis/i],
  [EVENT_TYPES.OUT_FOR_DELIVERY, /out for delivery|en cours de livraison/i],
  [EVENT_TYPES.AVAILABLE_FOR_PICKUP, /available for pickup|available for pick-up|pr[êe]t [àa] [êe]tre ramass[ée]|disponible.*ramassage/i],
  [EVENT_TYPES.PICKED_UP, /picked up by|shipment picked up|ramass[ée] par|envoi ramass[ée]/i],
  [EVENT_TYPES.ELECTRONIC_INFORMATION, /electronic information submitted|shipping information electronically submitted|renseignements [ée]lectroniques.*(?:re[çc]us|soumis)/i],
  [EVENT_TYPES.ACCEPTED, /item accepted|accepted at (?:the )?post office|international item mailed|article accept[ée]|article d[ée]pos[ée]/i],
  [EVENT_TYPES.ITEM_PROCESSED, /item processed|article trait[ée]/i],
  [EVENT_TYPES.IN_TRANSIT, /in transit|item in transit|en transit/i],
  [EVENT_TYPES.SIGNATURE_AVAILABLE, /signature (?:image )?(?:recorded|available)|image de la signature/i],
  [EVENT_TYPES.OPERATIONAL_DISRUPTION, /operational delay|transportation delay|flight|ferry|power outage|retard op[ée]rationnel|retard.*transport/i]
];

function eventTimestamp(raw = {}) {
  const explicit = String(raw.timestamp || raw.eventDateTime || raw['event-date-time'] || raw.dateTime || '').trim();
  if (explicit) return explicit;
  const date = normalizeDate(raw.eventDate || raw['event-date'] || raw.date || '');
  const time = String(raw.eventTime || raw['event-time'] || '').trim();
  const zone = String(raw.eventTimeZone || raw['event-time-zone'] || '').trim();
  if (date && time && /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(time)) {
    const namedOffsets = {
      NST: '-03:30', NDT: '-02:30', AST: '-04:00', ADT: '-03:00',
      EST: '-05:00', EDT: '-04:00', CST: '-06:00', CDT: '-05:00',
      MST: '-07:00', MDT: '-06:00', PST: '-08:00', PDT: '-07:00'
    };
    const offset = /^(?:Z|[+-]\d{2}:?\d{2})$/.test(zone) ? zone : namedOffsets[zone.toUpperCase()];
    if (offset) return `${date}T${time}${offset}`;
  }
  return date;
}

function eventDescription(raw = {}) {
  return String(raw.description || raw.eventDescription || raw['event-description'] || raw.status || raw.name || '').trim();
}

function normalizeTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) return { timestamp: '', date: '', precision: 'missing' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { timestamp: `${text}T12:00:00.000Z`, date: text, precision: 'date' };
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return { timestamp: '', date: '', precision: 'invalid' };
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { timestamp: date.toISOString(), date: `${byType.year}-${byType.month}-${byType.day}`, precision: 'instant' };
}

function classifyEvent(raw = {}) {
  const explicit = String(raw.normalizedType || raw.type || '').toUpperCase();
  if (Object.values(EVENT_TYPES).includes(explicit)) return explicit;
  if (raw.expectedDeliveryDate || raw['expected-delivery-date']) return EVENT_TYPES.EXPECTED_DELIVERY;
  const code = String(raw.code || raw.eventCode || raw.eventIdentifier || raw['event-code'] || '').trim();
  if (DOCUMENTED_EVENT_CODES[code]) return DOCUMENTED_EVENT_CODES[code];
  const description = eventDescription(raw);
  const unsuccessfulDeliveryWording = /\bnot\s+delivered\b|\bunable\s+to\s+deliver\b|\bdelivery\s+attempt\b/i.test(description);
  for (const [type, pattern] of PATTERNS) {
    if (type === EVENT_TYPES.SUCCESSFUL_DELIVERY && unsuccessfulDeliveryWording) continue;
    if (pattern.test(description)) return type;
  }
  return EVENT_TYPES.UNKNOWN;
}

function normalizeTrackingEvents(rawEvents = []) {
  if (!Array.isArray(rawEvents)) throw new TypeError('Tracking events must be an array.');
  const normalized = rawEvents.map((raw, index) => {
    const timing = normalizeTimestamp(eventTimestamp(raw));
    const sourceDate = normalizeDate(raw.eventDate || raw['event-date'] || raw.date || '');
    const type = classifyEvent(raw);
    const expectedDate = normalizeDate(raw.expectedDeliveryDate || raw['expected-delivery-date'] || (type === EVENT_TYPES.EXPECTED_DELIVERY ? timing.date : ''));
    return {
      sourceIndex: index,
      sourceCode: String(raw.code || raw.eventCode || raw.eventIdentifier || raw['event-code'] || '').trim().slice(0, 128),
      description: eventDescription(raw).slice(0, 1024),
      type,
      timestamp: timing.timestamp,
      date: sourceDate || timing.date,
      timestampPrecision: timing.precision,
      eventTime: String(raw.eventTime || raw['event-time'] || '').trim().slice(0, 32),
      eventTimeZone: String(raw.eventTimeZone || raw['event-time-zone'] || '').trim().slice(0, 64),
      localTimestamp: (sourceDate || timing.date) && String(raw.eventTime || raw['event-time'] || '').trim()
        ? `${sourceDate || timing.date}T${String(raw.eventTime || raw['event-time']).trim().slice(0, 32)}`
        : '',
      eventLocation: String(raw.eventSite || raw.eventLocation || raw['event-site'] || '').trim().slice(0, 256),
      eventProvince: String(raw.eventProvince || raw['event-province'] || '').trim().slice(0, 32),
      eventRetailLocationId: String(raw.eventRetailLocationId || '').trim().slice(0, 128),
      eventRetailName: String(raw.eventRetailName || '').trim().slice(0, 256),
      expectedDeliveryDate: expectedDate,
      expectedDateSource: String(raw.expectedDateSource || '').trim().slice(0, 128),
      revisedExpectedReason: String(raw.revisedReason || '').trim().slice(0, 500),
      revisedExpectedDelivery: raw.revised === true,
      explicitlyFirstAttempt: raw.isFirstAttempt === true || raw.firstAttempt === true,
      classificationSource: DOCUMENTED_EVENT_CODES[String(raw.code || raw.eventCode || raw.eventIdentifier || raw['event-code'] || '').trim()]
        ? 'documented_event_code'
        : (Object.values(EVENT_TYPES).includes(String(raw.normalizedType || raw.type || '').toUpperCase()) ? 'explicit_normalized_type' : (type === EVENT_TYPES.UNKNOWN ? 'unrecognized' : 'description_match')),
      rawHash: sha256Canonical(raw)
    };
  });

  const deduped = [];
  const seen = new Set();
  for (const event of normalized) {
    const key = [event.sourceCode, event.description.toLowerCase(), event.timestamp, event.localTimestamp, event.eventTimeZone, event.expectedDeliveryDate].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  const orderingValue = event => event.timestampPrecision === 'instant'
    ? event.timestamp
    : (event.localTimestamp || event.timestamp || '9999');
  deduped.sort((a, b) => orderingValue(a).localeCompare(orderingValue(b)) || a.sourceIndex - b.sourceIndex);

  const firstAttemptCandidates = deduped.filter(event =>
    event.explicitlyFirstAttempt || [
      EVENT_TYPES.FIRST_DELIVERY_ATTEMPT,
      EVENT_TYPES.ADDRESS_DELIVERY_ATTEMPT,
      EVENT_TYPES.NOTICE_CARD,
      EVENT_TYPES.RECIPIENT_UNAVAILABLE,
      EVENT_TYPES.SUCCESSFUL_DELIVERY
    ].includes(event.type)
  ).filter(event => event.date);
  const deliveredCandidates = deduped.filter(event => event.type === EVENT_TYPES.SUCCESSFUL_DELIVERY && event.date);
  const expectedEvents = deduped.filter(event => event.expectedDeliveryDate);
  const originalExpectedCandidates = expectedEvents.filter(event => !event.revisedExpectedDelivery).map(event => event.expectedDeliveryDate);
  const revisedExpectedCandidates = expectedEvents.filter(event => event.revisedExpectedDelivery).map(event => event.expectedDeliveryDate);
  const expectedCandidates = originalExpectedCandidates.length ? originalExpectedCandidates : revisedExpectedCandidates;
  const uniqueExpected = [...new Set(expectedCandidates)];
  const conflictCodes = [];
  if ([...new Set(originalExpectedCandidates)].length > 1 || [...new Set(revisedExpectedCandidates)].length > 1) conflictCodes.push('CONFLICTING_EXPECTED_DATES');
  if (deduped.some(event => event.timestampPrecision === 'invalid')) conflictCodes.push('INVALID_EVENT_TIMESTAMP');

  const exclusionSignals = [];
  const mapping = {
    [EVENT_TYPES.RETURN_TO_SENDER]: 'RETURN_TO_SENDER',
    [EVENT_TYPES.SENDER_CAUSED_DELAY]: 'SENDER_CAUSED_DELAY',
    [EVENT_TYPES.ADDRESS_PROBLEM]: 'ADDRESS_PROBLEM',
    [EVENT_TYPES.CUSTOMS_DELAY]: 'CUSTOMS_DELAY_POSSIBLE',
    [EVENT_TYPES.WEATHER_DISRUPTION]: 'WEATHER_DISRUPTION',
    [EVENT_TYPES.OPERATIONAL_DISRUPTION]: 'OPERATIONAL_DISRUPTION',
    [EVENT_TYPES.LABOUR_DISRUPTION]: 'LABOUR_DISRUPTION',
    [EVENT_TYPES.DELIVERY_STANDARD_ADJUSTMENT]: 'DELIVERY_STANDARD_ADJUSTMENT'
  };
  for (const event of deduped) {
    if (mapping[event.type] && !exclusionSignals.includes(mapping[event.type])) exclusionSignals.push(mapping[event.type]);
  }

  const firstAttempt = firstAttemptCandidates[0] || null;
  const actualDelivery = deliveredCandidates[0] || null;
  const uniqueOriginalExpected = [...new Set(originalExpectedCandidates)];
  const uniqueRevisedExpected = [...new Set(revisedExpectedCandidates)];
  const selectedExpectedSource = uniqueOriginalExpected.length === 1
    ? 'tracking_api.expectedDeliveryDate'
    : (uniqueRevisedExpected.length === 1 ? 'tracking_api.changedExpectedDate' : '');
  const expectedDeliverySelectionReason = uniqueOriginalExpected.length === 1
    ? 'Original Tracking API expectedDeliveryDate selected as the Delivery Standard; changedExpectedDate retained separately.'
    : (uniqueRevisedExpected.length === 1
        ? 'Original expectedDeliveryDate was unavailable; changedExpectedDate used as the only API-provided estimate.'
        : (expectedEvents.length ? 'Expected-date evidence was contradictory and no date was selected.' : 'No expected-delivery date was returned by the Tracking API.'));
  const sameDeliveryEvent = Boolean(firstAttempt && actualDelivery && firstAttempt.rawHash === actualDelivery.rawHash);
  const evidenceTimestamp = event => event
    ? (event.timestampPrecision === 'instant' ? event.timestamp : (event.localTimestamp || event.timestamp || ''))
    : '';
  const evidenceConfidence = event => {
    if (!event) return '';
    if (event.classificationSource === 'documented_event_code') return 'high_documented_identifier';
    if (event.explicitlyFirstAttempt) return 'high_explicit_attempt_marker';
    if (event.classificationSource === 'explicit_normalized_type') return 'high_explicit_category';
    if (event.classificationSource === 'description_match') return 'bounded_description_mapping';
    return 'unknown';
  };

  return {
    version: 'tracking-normalizer-v4',
    rawEventCount: rawEvents.length,
    normalizedEventCount: deduped.length,
    events: deduped,
    expectedDeliveryDate: uniqueExpected.length === 1 ? uniqueExpected[0] : '',
    expectedDeliverySource: selectedExpectedSource,
    expectedDeliverySelectionReason,
    originalExpectedDeliveryDate: uniqueOriginalExpected.length === 1 ? uniqueOriginalExpected[0] : '',
    revisedExpectedDeliveryDate: uniqueRevisedExpected.length === 1 ? uniqueRevisedExpected[0] : '',
    revisedExpectedDeliveryReason: expectedEvents.find(event => event.revisedExpectedDelivery)?.revisedExpectedReason || '',
    firstAttemptDate: firstAttempt?.date || '',
    firstAttemptTimestamp: evidenceTimestamp(firstAttempt),
    firstAttemptSourceEventCode: firstAttempt?.sourceCode || '',
    firstAttemptSourceCategory: firstAttempt?.type || '',
    firstAttemptClassificationSource: firstAttempt?.classificationSource || '',
    firstAttemptConfidence: evidenceConfidence(firstAttempt),
    firstAttemptProvenance: firstAttempt ? 'tracking_api_significant_event' : '',
    firstAttemptDescription: firstAttempt?.description || '',
    actualDeliveryDate: actualDelivery?.date || '',
    actualDeliveryTimestamp: evidenceTimestamp(actualDelivery),
    actualDeliverySourceEventCode: actualDelivery?.sourceCode || '',
    actualDeliverySourceCategory: actualDelivery?.type || '',
    actualDeliveryConfidence: evidenceConfidence(actualDelivery),
    actualDeliveryProvenance: actualDelivery ? 'tracking_api_significant_event' : '',
    actualDeliveryDescription: actualDelivery?.description || '',
    actualDeliveryClassificationSource: actualDelivery?.classificationSource || '',
    firstAttemptAndActualDeliverySameEvent: sameDeliveryEvent,
    sharedSuccessfulDeliveryEvent: sameDeliveryEvent && firstAttempt?.type === EVENT_TYPES.SUCCESSFUL_DELIVERY,
    conflictCodes,
    exclusionSignals,
    unknownEventCount: deduped.filter(event => event.type === EVENT_TYPES.UNKNOWN).length,
    inputHash: sha256Canonical(rawEvents)
  };
}

function deriveDeliveryStatus(normalization = {}, options = {}) {
  const events = Array.isArray(normalization.events) ? normalization.events : [];
  let state = DELIVERY_STATES.NO_DELIVERY_EVIDENCE;
  if (normalization.actualDeliveryDate || normalization.actualDeliveryTimestamp) {
    state = DELIVERY_STATES.DELIVERED;
  } else if (normalization.firstAttemptDate || normalization.firstAttemptTimestamp) {
    state = DELIVERY_STATES.DELIVERY_ATTEMPTED_NOT_DELIVERED;
  } else if (events.some(event => [
    EVENT_TYPES.ELECTRONIC_INFORMATION,
    EVENT_TYPES.ACCEPTED,
    EVENT_TYPES.ITEM_PROCESSED,
    EVENT_TYPES.IN_TRANSIT,
    EVENT_TYPES.OUT_FOR_DELIVERY,
    EVENT_TYPES.AVAILABLE_FOR_PICKUP,
    EVENT_TYPES.PICKED_UP,
    EVENT_TYPES.DELIVERY_TO_POST_OFFICE
  ].includes(event.type))) {
    state = DELIVERY_STATES.IN_TRANSIT;
  }
  const expectedDate = normalizeDate(options.expectedDeliveryDate || normalization.expectedDeliveryDate);
  const asOf = normalizeDate(options.asOf || new Date().toISOString());
  const overdue = state !== DELIVERY_STATES.DELIVERED && Boolean(expectedDate && asOf && expectedDate < asOf);
  const labels = {
    [DELIVERY_STATES.DELIVERED]: 'Delivered',
    [DELIVERY_STATES.DELIVERY_ATTEMPTED_NOT_DELIVERED]: 'Delivery attempted but not delivered',
    [DELIVERY_STATES.IN_TRANSIT]: 'In transit',
    [DELIVERY_STATES.NO_DELIVERY_EVIDENCE]: 'No delivery evidence'
  };
  return { state, label: labels[state], overdue };
}

module.exports = {
  EVENT_TYPES,
  DELIVERY_STATES,
  DOCUMENTED_EVENT_CODES,
  normalizeTimestamp,
  classifyEvent,
  normalizeTrackingEvents,
  deriveDeliveryStatus
};
