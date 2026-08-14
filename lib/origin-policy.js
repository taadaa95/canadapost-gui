'use strict';

function mockOrigin(env = process.env) {
  if (String(env.NODE_ENV || '') !== 'test') return '';
  try {
    const parsed = new URL(String(env.MOCK_PORTAL_ORIGIN || ''));
    if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) return '';
    return parsed.origin;
  } catch (_) { return ''; }
}

function isAllowedCanadaPostUrl(value, env = process.env) {
  try {
    const parsed = new URL(String(value));
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === 'https:' && (host === 'canadapost-postescanada.ca' || host.endsWith('.canadapost-postescanada.ca'))) return true;
    const mock = mockOrigin(env);
    return Boolean(mock && parsed.origin === mock);
  } catch (_) { return false; }
}

function portalUrl(productionUrl, pathname, env = process.env) {
  const mock = mockOrigin(env);
  return mock ? new URL(pathname, `${mock}/`).toString() : productionUrl;
}

module.exports = { mockOrigin, isAllowedCanadaPostUrl, portalUrl };
