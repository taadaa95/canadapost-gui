'use strict';

const RUNTIME_TRACKING_ENVIRONMENT = 'production';

function runtimeTrackingEnvironment() {
  return RUNTIME_TRACKING_ENVIRONMENT;
}

function legacyTrackingEnvironmentNeedsNormalization(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized !== '' && normalized !== RUNTIME_TRACKING_ENVIRONMENT;
}

module.exports = {
  RUNTIME_TRACKING_ENVIRONMENT,
  runtimeTrackingEnvironment,
  legacyTrackingEnvironmentNeedsNormalization
};
