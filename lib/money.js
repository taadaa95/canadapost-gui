'use strict';

/** @param {unknown} value @param {number} fractionDigits @returns {number} */
function parseDecimalToMinor(value, fractionDigits = 2) {
  const text = String(value ?? '').trim();
  const match = text.match(/^([0-9]+)(?:\.([0-9]+))?$/);
  if (!match) throw new Error('Enter a non-negative decimal amount.');
  const fraction = String(match[2] || '');
  if (fraction.length > fractionDigits) throw new Error(`Amount supports at most ${fractionDigits} decimal places.`);
  const factor = 10n ** BigInt(fractionDigits);
  const minor = BigInt(match[1]) * factor + BigInt(fraction.padEnd(fractionDigits, '0') || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount exceeds the supported limit.');
  return Number(minor);
}

/** @param {number} amountMinor @param {string} currency @param {string} locale @returns {string} */
function formatMinor(amountMinor, currency = 'CAD', locale = 'en-CA') {
  if (!Number.isSafeInteger(amountMinor)) throw new Error('Money must use integer minor units.');
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountMinor / 100);
}

module.exports = { parseDecimalToMinor, formatMinor };
