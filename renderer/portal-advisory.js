'use strict';

(() => {
  const STATES = Object.freeze({
    PORTAL_COMPATIBILITY_REQUIRED: Object.freeze({ id: 'notChecked', kind: 'warn' }),
    PORTAL_COMPATIBILITY_STALE: Object.freeze({ id: 'stale', kind: 'warn' }),
    PORTAL_COMPATIBILITY_FAILED: Object.freeze({ id: 'incompatible', kind: 'bad' }),
    PORTAL_COMPATIBILITY_WARNING: Object.freeze({ id: 'warning', kind: 'warn' })
  });

  function describe(gate = {}) {
    if (gate?.ok === true) return { id: 'compatible', kind: 'good', requiresOverride: false };
    const state = STATES[String(gate?.code || '')] || STATES.PORTAL_COMPATIBILITY_WARNING;
    return { ...state, requiresOverride: true };
  }

  window.PortalAdvisory = Object.freeze({ STATES, describe });
})();
