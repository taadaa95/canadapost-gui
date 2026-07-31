'use strict';

function trackingNumberFromRow(row = {}) {
  return String(row['Tracking PIN'] || row['Tracking Number'] || row.PIN || row.Tracking || '').replace(/\s+/g, '');
}

function firstUsableRow(rows = []) {
  const index = rows.findIndex(row => Boolean(trackingNumberFromRow(row)));
  return index < 0 ? null : index + 1;
}

function validateRow(rows = [], value) {
  const row = Number(value);
  if (!Number.isSafeInteger(row) || row < 1 || row > rows.length || !trackingNumberFromRow(rows[row - 1])) {
    const error = new Error('Choose a valid tracking.csv row that contains an authorized tracking number.');
    error.code = 'TRACKING_DIAGNOSTIC_ROW_INVALID';
    throw error;
  }
  return { row, rowCount: rows.length };
}

module.exports = { trackingNumberFromRow, firstUsableRow, validateRow };
