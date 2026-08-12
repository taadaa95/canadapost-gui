'use strict';

(() => {
  const THEMES = Object.freeze(['system', 'dark', 'light', 'high-contrast']);
  const STEPS = Object.freeze([
    { id: 'local', readiness: ['dataDirectory', 'databaseHealth'], blocking: true },
    { id: 'storage', readiness: ['secureStorage'], blocking: true },
    { id: 'website', readiness: ['accountFields'], blocking: true },
    { id: 'api', readiness: ['apiCredentials'], blocking: true },
    { id: 'diagnostic', readiness: ['apiDiagnostic'], blocking: true },
    { id: 'sender', readiness: ['customerNumber', 'senderInformation', 'contactInformation'], blocking: true },
    { id: 'submission', readiness: ['browserAvailable', 'policyAvailable', 'safetyAcknowledged'], blocking: true },
    { id: 'external', readiness: [], blocking: false }
  ]);

  function normalizeTheme(value) {
    return THEMES.includes(String(value || '')) ? String(value) : 'system';
  }

  function readinessSummary(readiness = {}) {
    const steps = STEPS.map(step => ({
      ...step,
      ready: step.readiness.length === 0 ? null : step.readiness.every(key => readiness[key] === true)
    }));
    const blocking = steps.filter(step => step.blocking && step.ready !== true);
    return { steps, ready: blocking.length === 0, blockingCount: blocking.length };
  }

  window.Onboarding = Object.freeze({ THEMES, STEPS, normalizeTheme, readinessSummary });
})();
