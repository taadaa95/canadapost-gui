'use strict';

const calendar = require('../config/holiday-calendar.json');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (DATE_PATTERN.test(text)) {
    const date = new Date(`${text}T12:00:00Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? '' : text;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function shiftDate(date, days) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function calendarCoverage(date) {
  const normalized = normalizeDate(date);
  return Boolean(normalized && normalized >= calendar.coverageFrom && normalized <= calendar.coverageThrough);
}

function holidayFor(date, region = '') {
  const normalized = normalizeDate(date);
  const cleanRegion = String(region || '').trim().toUpperCase();
  const matches = calendar.holidays.filter(item => item.date === normalized);
  const national = matches.find(item => item.regions.includes('ALL'));
  if (national) return { ...national, ambiguous: false };
  if (!matches.length) return null;
  if (!cleanRegion) return { date: normalized, name: matches.map(item => item.name).join('; '), regions: matches.flatMap(item => item.regions), ambiguous: true };
  const regional = matches.find(item => item.regions.includes(cleanRegion));
  return regional ? { ...regional, ambiguous: false } : null;
}

function businessDayStatus(date, region = '') {
  const normalized = normalizeDate(date);
  if (!normalized) return { businessDay: false, covered: false, ambiguous: false, reason: 'INVALID_DATE' };
  if (!calendarCoverage(normalized)) return { businessDay: false, covered: false, ambiguous: false, reason: 'CALENDAR_OUT_OF_COVERAGE' };
  const day = new Date(`${normalized}T12:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) return { businessDay: false, covered: true, ambiguous: false, reason: 'WEEKEND' };
  const holiday = holidayFor(normalized, region);
  if (holiday?.ambiguous) return { businessDay: false, covered: true, ambiguous: true, reason: 'REGIONAL_HOLIDAY_AMBIGUOUS', holiday };
  if (holiday) return { businessDay: false, covered: true, ambiguous: false, reason: 'HOLIDAY', holiday };
  return { businessDay: true, covered: true, ambiguous: false, reason: 'BUSINESS_DAY' };
}

function walkBusinessDays(startDate, count, region = '') {
  const start = normalizeDate(startDate);
  if (!start || !Number.isInteger(count) || count < 0) return { ok: false, reason: 'INVALID_ARGUMENT' };
  let current = start;
  let remaining = count;
  let ambiguous = false;
  const holidays = [];
  while (remaining > 0) {
    current = shiftDate(current, 1);
    const status = businessDayStatus(current, region);
    if (!status.covered) return { ok: false, reason: status.reason, date: current };
    if (status.ambiguous) ambiguous = true;
    if (status.holiday) holidays.push(status.holiday);
    if (status.businessDay) remaining -= 1;
  }
  return { ok: true, date: current, ambiguous, holidays };
}

function countBusinessDaysAfter(startDate, endDate, region = '') {
  const start = normalizeDate(startDate);
  const end = normalizeDate(endDate);
  if (!start || !end) return { ok: false, reason: 'INVALID_DATE' };
  if (end <= start) return { ok: true, days: 0, ambiguous: false, holidays: [] };
  let current = start;
  let days = 0;
  let ambiguous = false;
  const holidays = [];
  while (current < end) {
    current = shiftDate(current, 1);
    const status = businessDayStatus(current, region);
    if (!status.covered) return { ok: false, reason: status.reason, date: current };
    if (status.ambiguous) ambiguous = true;
    if (status.holiday) holidays.push(status.holiday);
    if (status.businessDay) days += 1;
  }
  return { ok: true, days, ambiguous, holidays };
}

module.exports = { calendar, normalizeDate, shiftDate, calendarCoverage, holidayFor, businessDayStatus, walkBusinessDays, countBusinessDaysAfter };
