'use strict';

(function publish(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PrivacyDataManagement = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const COUNT_KEYS = Object.freeze([
    'shipments', 'trackingChecks', 'classificationRecords', 'claimAttempts',
    'reconciliationRecords', 'financialEntries', 'evidenceFiles', 'screenshots', 'generatedExports'
  ]);

  function parseTrackingNumbers(value) {
    return [...new Set(String(value || '').split(/[\s,;]+/).map(item => item.trim().toUpperCase()).filter(Boolean))].slice(0, 10000);
  }

  function scopeFromElements(elements) {
    return {
      trackingNumbers: parseTrackingNumbers(elements.trackingNumbers?.value),
      dateFrom: String(elements.dateFrom?.value || ''),
      dateTo: String(elements.dateTo?.value || ''),
      allRecords: elements.allRecords?.checked === true
    };
  }

  function renderCounts(container, counts, translate) {
    container.textContent = '';
    for (const key of COUNT_KEYS) {
      const row = container.ownerDocument.createElement('div');
      row.className = 'privacy-preview-count';
      const label = container.ownerDocument.createElement('span');
      label.textContent = translate(`privacy.count.${key}`);
      const value = container.ownerDocument.createElement('strong');
      value.textContent = String(Number(counts?.[key] || 0));
      row.append(label, value);
      container.appendChild(row);
    }
  }

  return { COUNT_KEYS, parseTrackingNumbers, scopeFromElements, renderCounts };
});
