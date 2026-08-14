'use strict';

(function publish(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.RendererSharedContext = api;
    root.RendererContext = api.createSharedContext();
  }
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function createSharedContext(initialState = {}) {
    const listeners = new Map();
    const state = { ...initialState };
    const events = Object.freeze({
      on(type, listener) {
        if (typeof listener !== 'function') throw new TypeError('Renderer event listener must be a function.');
        const bucket = listeners.get(type) || new Set();
        bucket.add(listener);
        listeners.set(type, bucket);
        return () => bucket.delete(listener);
      },
      emit(type, payload) {
        for (const listener of listeners.get(type) || []) listener(payload);
      },
      clear(type) {
        if (type) listeners.delete(type);
        else listeners.clear();
      }
    });
    return Object.freeze({ state, events });
  }

  return { createSharedContext };
});
