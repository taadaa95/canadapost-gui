'use strict';

(function publish(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Step3Queue = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function createController() {
    let items = [];
    const selected = new Set();

    function load(nextItems, options = {}) {
      items = Array.isArray(nextItems) ? nextItems.filter(item => Number.isSafeInteger(Number(item?.recordId))) : [];
      selected.clear();
      const validIds = new Set(items.map(item => Number(item.recordId)));
      for (const id of options.persistedSelection || []) {
        const parsed = Number(id);
        if (validIds.has(parsed)) selected.add(parsed);
      }
      return snapshot();
    }

    function visible(filters = {}) {
      const search = String(filters.search || '').trim().toLowerCase();
      const service = String(filters.service || 'all');
      const urgency = String(filters.urgency || 'all');
      const dateFrom = String(filters.dateFrom || '');
      const dateTo = String(filters.dateTo || '');
      return items.filter(item => {
        if (search && !`${item.trackingNumber || ''} ${item.referenceNumber || ''}`.toLowerCase().includes(search)) return false;
        if (service !== 'all' && item.serviceCode !== service) return false;
        if (urgency === 'urgent' && item.deadlineState !== 'urgent') return false;
        if (urgency === 'expired' && item.deadlineState !== 'expired') return false;
        if (urgency === 'unavailable' && !['unavailable', 'policy_review_required'].includes(item.deadlineState)) return false;
        if (dateFrom && (!item.deadline || item.deadline < dateFrom)) return false;
        if (dateTo && (!item.deadline || item.deadline > dateTo)) return false;
        return true;
      }).sort((left, right) => String(left.deadline || '9999').localeCompare(String(right.deadline || '9999')) || Number(left.recordId) - Number(right.recordId));
    }

    function selectVisible(filters = {}) {
      for (const item of visible(filters)) selected.add(Number(item.recordId));
      return snapshot();
    }

    function clear() {
      selected.clear();
      return snapshot();
    }

    function set(recordId, checked) {
      const id = Number(recordId);
      if (!items.some(item => Number(item.recordId) === id)) return snapshot();
      if (checked) selected.add(id);
      else selected.delete(id);
      return snapshot();
    }

    function selectedRecords() {
      return items.filter(item => selected.has(Number(item.recordId))).map(item => ({
        recordId: Number(item.recordId),
        evidenceHash: String(item.evidenceHash || '')
      }));
    }

    function snapshot() {
      return { total: items.length, selected: selected.size, selectedIds: [...selected], selectedRecords: selectedRecords() };
    }

    return {
      load,
      visible,
      selectVisible,
      clear,
      set,
      isSelected: recordId => selected.has(Number(recordId)),
      selectedRecords,
      snapshot
    };
  }

  return { createController };
});
