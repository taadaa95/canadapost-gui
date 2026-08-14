'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SEGMENT_DAYS = 30;

const SEGMENT_STATES = Object.freeze({
  SUCCESS_WITH_ORDERS: 'SUCCESS_WITH_ORDERS',
  SUCCESS_EMPTY: 'SUCCESS_EMPTY',
  SPLIT_AND_RESOLVED: 'SPLIT_AND_RESOLVED',
  FAILURE: 'FAILURE'
});

function parseCalendarDate(value) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error('EST dates must use YYYY-MM-DD.');
  const milliseconds = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const parsed = new Date(milliseconds);
  if (
    parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() !== Number(match[2]) - 1
    || parsed.getUTCDate() !== Number(match[3])
  ) throw new Error('EST dates must be valid calendar dates in YYYY-MM-DD format.');
  return { text, milliseconds };
}

function formatCalendarDate(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function addCalendarDays(value, days) {
  return formatCalendarDate(parseCalendarDate(value).milliseconds + (Number(days) * DAY_MS));
}

function dateSpanDays(from, to) {
  const start = parseCalendarDate(from);
  const end = parseCalendarDate(to);
  if (start.milliseconds > end.milliseconds) throw new Error('EST start date must not be after end date.');
  return Math.round((end.milliseconds - start.milliseconds) / DAY_MS) + 1;
}

function splitDateRange(from, to, maxDays = DEFAULT_MAX_SEGMENT_DAYS) {
  const segmentDays = Number(maxDays);
  if (!Number.isInteger(segmentDays) || segmentDays < 1) throw new Error('EST maximum segment length must be a positive integer.');
  const totalDays = dateSpanDays(from, to);
  const segments = [];
  for (let offset = 0; offset < totalDays; offset += segmentDays) {
    const segmentFrom = addCalendarDays(from, offset);
    const length = Math.min(segmentDays, totalDays - offset);
    segments.push({ from: segmentFrom, to: addCalendarDays(segmentFrom, length - 1) });
  }
  return segments;
}

function bisectDateRange(from, to) {
  const days = dateSpanDays(from, to);
  if (days < 2) throw new Error('A one-day EST range cannot be split.');
  const firstDays = Math.ceil(days / 2);
  const secondFrom = addCalendarDays(from, firstDays);
  return [
    { from, to: addCalendarDays(from, firstDays - 1) },
    { from: secondFrom, to }
  ];
}

function dateVariants(from, to) {
  dateSpanDays(from, to);
  return [
    { label: 'iso', from, to },
    { label: 'yyyymmdd', from: from.replace(/-/g, ''), to: to.replace(/-/g, '') }
  ];
}

function compactDiagnostic(error) {
  return {
    status: Number(error?.status || error?.diagnostic?.status || 0),
    applicationCode: String(error?.diagnostic?.applicationCode || error?.code || '').slice(0, 128),
    message: String(error?.diagnostic?.message || error?.message || '').slice(0, 1000),
    category: String(error?.diagnostic?.category || '').slice(0, 128)
  };
}

function cancellationError() {
  return Object.assign(new Error('Shipment History import was stopped; the previous tracking.csv was preserved.'), {
    code: 'EST_IMPORT_STOPPED'
  });
}

function assertNotStopped(shouldStop) {
  if (shouldStop?.()) throw cancellationError();
}

async function lookupOrdersForSegment({ segment, lookup, parseOrders, shouldStop }) {
  const attempts = [];
  let successfulEmpty = null;
  for (const dates of dateVariants(segment.from, segment.to)) {
    assertNotStopped(shouldStop);
    try {
      const response = await lookup(dates);
      const parsed = parseOrders(response);
      const success = {
        dateFormat: dates.label,
        response,
        responseType: parsed.format,
        orderIds: [...new Set(parsed.ids)]
      };
      attempts.push({ dateFormat: dates.label, success: true, status: Number(response?.status || 0) });
      if (success.orderIds.length) {
        return { state: SEGMENT_STATES.SUCCESS_WITH_ORDERS, segment, ...success, attempts };
      }
      successfulEmpty ||= success;
    } catch (error) {
      attempts.push({ dateFormat: dates.label, success: false, error: compactDiagnostic(error) });
    }
  }
  if (successfulEmpty) {
    return { state: SEGMENT_STATES.SUCCESS_EMPTY, segment, ...successfulEmpty, orderIds: [], attempts };
  }
  return {
    state: SEGMENT_STATES.FAILURE,
    segment,
    orderIds: [],
    attempts,
    allAttemptsConflict: attempts.length > 0 && attempts.every(attempt => !attempt.success && attempt.error.status === 409),
    adaptiveSplitAttempted: false
  };
}

async function resolveOrderRange(options) {
  assertNotStopped(options.shouldStop);
  const direct = await lookupOrdersForSegment(options);
  if (direct.state !== SEGMENT_STATES.FAILURE) return direct;
  if (!direct.allAttemptsConflict || dateSpanDays(options.segment.from, options.segment.to) === 1) return direct;

  options.onAdaptiveSplit?.(options.segment);
  const children = [];
  for (const segment of bisectDateRange(options.segment.from, options.segment.to)) {
    const child = await resolveOrderRange({ ...options, segment });
    children.push(child);
    if (child.state === SEGMENT_STATES.FAILURE) {
      return { ...child, adaptiveSplitAttempted: true, parentSegment: options.segment, children };
    }
  }
  return {
    state: SEGMENT_STATES.SPLIT_AND_RESOLVED,
    segment: options.segment,
    orderIds: [...new Set(children.flatMap(child => child.orderIds))],
    children,
    adaptiveSplitAttempted: true
  };
}

function unresolvedRangeError(result, { workgroupOrdinal }) {
  const lastFailure = [...(result.attempts || [])].reverse().find(attempt => !attempt.success)?.error || {};
  const error = new Error('Canada Post could not return Shipment History for part of the selected date range. The previous tracking.csv was preserved.');
  error.code = 'EST_ORDER_RANGE_UNRESOLVED';
  error.diagnostic = {
    status: Number(lastFailure.status || 0),
    applicationCode: String(lastFailure.applicationCode || '').slice(0, 128),
    message: String(lastFailure.message || '').slice(0, 1000),
    category: String(lastFailure.category || '').slice(0, 128),
    failedDateSpan: { from: result.segment.from, to: result.segment.to },
    workgroupOrdinal: Number(workgroupOrdinal),
    adaptiveSplitAttempted: Boolean(result.adaptiveSplitAttempted)
  };
  return error;
}

module.exports = {
  DEFAULT_MAX_SEGMENT_DAYS,
  SEGMENT_STATES,
  addCalendarDays,
  dateSpanDays,
  splitDateRange,
  bisectDateRange,
  dateVariants,
  lookupOrdersForSegment,
  resolveOrderRange,
  unresolvedRangeError,
  cancellationError
};
