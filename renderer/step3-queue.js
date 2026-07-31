'use strict';

(function publish(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Step3Queue = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function isExecutable(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.executable === false) return false;
    if (item.executionState) return item.executionState === 'executable';
    return item.executable === true || !Object.prototype.hasOwnProperty.call(item, 'executable');
  }

  function createController() {
    let items = [];
    const selected = new Set();

    function itemById(recordId) {
      const id = Number(recordId);
      return items.find(item => Number(item.recordId) === id) || null;
    }

    function pruneSelection() {
      for (const id of [...selected]) {
        const item = itemById(id);
        if (!item || !isExecutable(item)) selected.delete(id);
      }
    }

    function load(nextItems, options = {}) {
      items = Array.isArray(nextItems) ? nextItems.filter(item => Number.isSafeInteger(Number(item?.recordId))) : [];
      selected.clear();
      const validIds = new Set(items.filter(isExecutable).map(item => Number(item.recordId)));
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
      for (const item of visible(filters)) {
        if (isExecutable(item)) selected.add(Number(item.recordId));
      }
      return snapshot();
    }

    function clear() {
      selected.clear();
      return snapshot();
    }

    function set(recordId, checked) {
      const id = Number(recordId);
      const item = itemById(id);
      if (!item || !isExecutable(item)) {
        selected.delete(id);
        return snapshot();
      }
      if (checked) selected.add(id);
      else selected.delete(id);
      return snapshot();
    }

    function selectedRecords() {
      pruneSelection();
      return items.filter(item => isExecutable(item) && selected.has(Number(item.recordId))).map(item => ({
        recordId: Number(item.recordId),
        evidenceHash: String(item.evidenceHash || '')
      }));
    }

    function snapshot() {
      pruneSelection();
      const executionCounts = {};
      for (const item of items) {
        const state = String(item.executionState || (isExecutable(item) ? 'executable' : 'otherwise_blocked'));
        executionCounts[state] = Number(executionCounts[state] || 0) + 1;
      }
      const executable = items.filter(isExecutable).length;
      return {
        total: items.length,
        executable,
        blocked: items.length - executable,
        selected: selected.size,
        selectedIds: [...selected],
        selectedRecords: selectedRecords(),
        executionCounts
      };
    }

    return {
      load,
      visible,
      selectVisible,
      clear,
      set,
      isExecutable,
      isSelected: recordId => selected.has(Number(recordId)),
      selectedRecords,
      snapshot
    };
  }

  return { createController, isExecutable };
});
