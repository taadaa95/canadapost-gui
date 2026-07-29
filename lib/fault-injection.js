'use strict';

const POINTS = Object.freeze([
  'before_navigation', 'after_navigation', 'after_tracking_entry', 'after_form_completion',
  'before_final_submission', 'immediately_after_submission', 'before_confirmation_capture',
  'during_evidence_write', 'during_database_write', 'during_process_termination'
]);

/** @param {string} name @param {Record<string, string | undefined>} env @returns {false} */
function faultPoint(name, env = process.env) {
  if (!POINTS.includes(name)) throw new Error(`Unknown fault-injection point: ${name}`);
  if (env.NODE_ENV !== 'test' || env.CPCR_FAULT_POINT !== name) return false;
  const error = /** @type {Error & {code: string, faultPoint: string}} */ (new Error(`Synthetic fault injected at ${name}.`));
  error.code = 'SYNTHETIC_FAULT';
  error.faultPoint = name;
  throw error;
}

module.exports = { POINTS, faultPoint };
