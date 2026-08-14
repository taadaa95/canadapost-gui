'use strict';

const { addCalendarDays } = require('./est-order-ranges');

const ROLLING_SHIPMENT_HISTORY_DAYS = 35;
const BUSINESS_TIME_ZONE = 'America/Toronto';

function calendarDateInTimeZone(now = new Date(), timeZone = BUSINESS_TIME_ZONE) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error('Shipment History run time is invalid.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function rollingShipmentHistoryRange(now = new Date()) {
  const to = calendarDateInTimeZone(now);
  return Object.freeze({
    from: addCalendarDays(to, -(ROLLING_SHIPMENT_HISTORY_DAYS - 1)),
    to,
    inclusiveDays: ROLLING_SHIPMENT_HISTORY_DAYS
  });
}

function shipmentHistoryRangeForRun({ now = new Date(), testMode = false, override = {} } = {}) {
  if (testMode && /^\d{4}-\d{2}-\d{2}$/.test(String(override.from || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(override.to || ''))) {
    return Object.freeze({ from: String(override.from), to: String(override.to), inclusiveDays: null, testOverride: true });
  }
  return rollingShipmentHistoryRange(now);
}

module.exports = {
  ROLLING_SHIPMENT_HISTORY_DAYS,
  BUSINESS_TIME_ZONE,
  calendarDateInTimeZone,
  rollingShipmentHistoryRange,
  shipmentHistoryRangeForRun
};
