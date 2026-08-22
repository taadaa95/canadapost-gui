'use strict';

const { parseXmlSecure, findAll, scalar } = require('./secure-xml');

const TRACKING_LIKE = /\b(?=[A-Z0-9]{10,35}\b)(?=[A-Z0-9]*\d{6})[A-Z0-9]+\b/gi;

function safeHeader(headers, names) {
  for (const name of names) {
    const value = headers?.get?.(name);
    if (value) return String(value).slice(0, 128).replace(/[^A-Za-z0-9._:-]/g, '');
  }
  return '';
}

function authenticationScheme(headers) {
  const value = String(headers?.get?.('www-authenticate') || '').trim();
  return (/^([A-Za-z][A-Za-z0-9_-]*)/.exec(value) || [])[1] || '';
}

function retryAfterSeconds(headers) {
  const raw = String(headers?.get?.('retry-after') || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Math.min(86400, Number(raw));
  const time = Date.parse(raw);
  return Number.isFinite(time) ? Math.max(0, Math.min(86400, Math.ceil((time - Date.now()) / 1000))) : null;
}

function retryAfterRaw(headers) {
  const raw = String(headers?.get?.('retry-after') || '').trim();
  return /^\d+(?:\.\d+)?$/.test(raw) || Number.isFinite(Date.parse(raw)) ? raw.slice(0, 128) : '';
}

function redactText(value, sensitiveValues = []) {
  let text = String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
  text = text.replace(TRACKING_LIKE, '[REDACTED_ID]');
  text = text.replace(/(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, match => `${match.split(/\s+/, 1)[0]} [REDACTED]`);
  text = text.replace(/https?:\/\/[^\s]+/gi, raw => {
    try { const parsed = new URL(raw); return `${parsed.origin}${parsed.pathname}`; } catch (_) { return '[REDACTED_URL]'; }
  });
  for (const sensitive of sensitiveValues) {
    const token = String(sensitive || '');
    if (token.length >= 3) text = text.split(token).join('[REDACTED]');
  }
  return text;
}

function looksHtml(body, contentType = '') {
  return /text\/html|application\/xhtml\+xml/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(String(body || ''));
}

function htmlPageClassification(body, { status = 0, hostname = '' } = {}) {
  const source = String(body || '').slice(0, 256 * 1024);
  const title = ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const combined = `${title} ${source}`.toLowerCase();
  const formActions = [...source.matchAll(/<form\b[^>]*\baction\s*=\s*["']?([^"'\s>]+)/gi)].map(match => match[1].toLowerCase()).join(' ');
  const host = String(hostname || '').toLowerCase();
  let classification = 'unknown_html';
  if (/\b(?:sign[ -]?in|log[ -]?in|sso|oauth|authenticate|account\/login)\b/.test(`${combined} ${formActions} ${host}`) || /type\s*=\s*["']password/.test(combined)) classification = 'login_sso';
  else if (Number(status) === 403 || /\b(?:access denied|forbidden|not authorized|permission denied)\b/.test(combined)) classification = 'access_denied';
  else if (/\b(?:web application firewall|request rejected|security incident|cloudflare|akamai|incapsula|gateway error|bad gateway)\b/.test(combined)) classification = 'gateway_waf';
  else if (/\b(?:scheduled maintenance|under maintenance|temporarily unavailable|service unavailable|maintenance window)\b/.test(combined)) classification = 'maintenance';
  else if (/canada post|postes canada|canadapost-postescanada\.ca/.test(`${combined} ${host}`)) classification = 'generic_canada_post';
  return { classification, bodyFingerprint: `html:${classification}${title ? ':title-present' : ':no-title'}${formActions ? ':form-action-present' : ''}` };
}

function xmlErrorFields(body) {
  try {
    const parsed = parseXmlSecure(String(body || ''), 'Canada Post error response');
    const containers = [...findAll(parsed, 'messages'), ...findAll(parsed, 'Fault'), ...findAll(parsed, 'fault')];
    if (!containers.length) return { applicationCode: '', message: '' };
    const first = names => names.flatMap(name => containers.flatMap(container => findAll(container, name).map(scalar))).map(value => String(value).trim()).find(Boolean) || '';
    return { applicationCode: first(['code', 'id', 'faultcode']), message: first(['description', 'faultstring', 'message', 'reason']) };
  } catch (_) {
    return { applicationCode: '', message: '' };
  }
}

function jsonErrorFields(body) {
  try {
    const value = JSON.parse(String(body || ''));
    const payload = Array.isArray(value) ? value[0] : value;
    if (!payload || typeof payload !== 'object') return { applicationCode: '', message: '' };
    const firstError = Array.isArray(payload.errors) ? payload.errors[0] : null;
    return {
      applicationCode: String(firstError?.errorCode || payload.errorCode || payload.error || payload.httpCode || '').trim(),
      message: String(firstError?.message || payload.detail || payload.message || payload.error_description || payload.moreInformation || payload.httpMessage || '').trim()
    };
  } catch (_) {
    return { applicationCode: '', message: '' };
  }
}

function classify({ status, applicationCode, rawMessage, htmlClassification, redirect, diagnosticStage }) {
  const code = String(applicationCode || '').toUpperCase();
  const text = String(rawMessage || '').toLowerCase();
  if (code === 'SERVER' && /rejected\s+by\s+slm\s+monitor/.test(text)) return 'slm_throttle';
  if ([502, 503, 504].includes(status)) return status === 504 ? 'gateway_timeout' : 'transient_gateway';
  if (status === 500) return 'server';
  if (status === 429) return 'rate_limit';
  if (status === 401) return diagnosticStage === 'token' ? 'token_authentication' : 'resource_authentication';
  if (status === 403 && /scope/.test(text)) return 'incorrect_scope';
  if (status === 403 && /product|subscription|permission|access/.test(text)) return 'product_permission';
  if (status === 403) return 'resource_authorization';
  if (status === 404 || code === '004' || /no\s+pin\s+history|not\s+found/.test(text)) return 'shipment_not_found';
  if (redirect) return 'redirect';
  if (htmlClassification === 'login_sso' || htmlClassification === 'access_denied') return 'authentication_page';
  if (htmlClassification) return 'unexpected_html';
  if (code === 'SERVER' || /schema|validation|malformed|unexpected/.test(text)) return 'schema';
  if (status >= 400) return 'request';
  return applicationCode || rawMessage ? 'application' : 'none';
}

function actionableMessage({ status, category, diagnosticStage, endpointFamily, htmlClassification, redirect, fallback }) {
  if (category === 'slm_throttle') return 'Canada Post SLM Monitor rejected the tracking request. Wait at least 60 seconds before retrying.';
  if (status === 504) return 'Canada Post API gateway timed out (HTTP 504).';
  if (status === 502) return 'Canada Post API gateway returned HTTP 502.';
  if (status === 503) return 'Canada Post API service is temporarily unavailable (HTTP 503).';
  if (status === 500) return 'Canada Post Tracking API returned HTTP 500.';
  if (status === 429) return 'Canada Post rate-limited the Tracking API request (HTTP 429). Wait before deliberately retrying.';
  if (status === 401 && diagnosticStage === 'token') return 'Canada Post rejected the OAuth token request (HTTP 401). Verify the current Developer Portal API key and API secret for the selected environment.';
  if (status === 401 && endpointFamily === 'est-desktop-history') return 'Canada Post rejected the saved website username or password. Re-enter your website credentials in Settings and try again.';
  if (status === 401) return 'Canada Post Tracking API rejected the Bearer token (HTTP 401).';
  if (category === 'incorrect_scope') return 'Canada Post rejected the request because the required merchant scope was not granted.';
  if (category === 'product_permission') return 'The Developer Portal app does not appear to have access to the Tracking API product.';
  if (status === 403) return 'Canada Post Tracking API denied access (HTTP 403). Verify Tracking product access and the selected environment.';
  if (redirect?.appearsLogin) return 'Canada Post redirected the API request to a login page. The redirect was not followed.';
  if (redirect) return 'The Canada Post API endpoint redirected unexpectedly. The redirect was not followed.';
  if (htmlClassification === 'login_sso') return 'Canada Post returned an account login or SSO page instead of API JSON.';
  if (htmlClassification === 'access_denied') return 'Canada Post returned an HTML access-denied page.';
  if (htmlClassification === 'gateway_waf') return 'Canada Post returned an HTML gateway or WAF response.';
  if (htmlClassification === 'maintenance') return 'Canada Post returned an HTML maintenance response.';
  if (htmlClassification === 'generic_canada_post') return 'Canada Post returned a website page instead of API JSON.';
  if (htmlClassification === 'unknown_html') return 'Canada Post returned unrecognized HTML instead of API JSON.';
  return fallback;
}

function parseCanadaPostError(options = {}) {
  const {
    status = 0, headers, body = '', endpointFamily = 'unknown', protocol = 'unknown', sensitiveValues = [],
    requestMethod = 'GET', responseHostname = '', environment = 'production', redirect = null,
    apiVersion = '', scope = '', diagnosticStage = 'resource'
  } = options;
  const numericStatus = Number(status || 0);
  const contentType = String(headers?.get?.('content-type') || '').slice(0, 128);
  const html = looksHtml(body, contentType);
  const htmlInfo = html ? htmlPageClassification(body, { status: numericStatus, hostname: responseHostname }) : null;
  const jsonFields = /json/i.test(contentType) || /^\s*[\[{]/.test(String(body || '')) ? jsonErrorFields(body) : { applicationCode: '', message: '' };
  const xmlFields = !jsonFields.applicationCode && !jsonFields.message && !html ? xmlErrorFields(body) : { applicationCode: '', message: '' };
  const fields = jsonFields.applicationCode || jsonFields.message ? jsonFields : xmlFields;
  const category = classify({ status: numericStatus, applicationCode: fields.applicationCode, rawMessage: fields.message, htmlClassification: htmlInfo?.classification || '', redirect, diagnosticStage });
  const fallback = fields.message || (numericStatus >= 400 ? `Canada Post service returned HTTP ${numericStatus}.` : '');
  const message = redactText(actionableMessage({ status: numericStatus, category, diagnosticStage, endpointFamily, htmlClassification: htmlInfo?.classification || '', redirect, fallback }), sensitiveValues);
  const diagnostic = {
    status: numericStatus,
    tokenHttpStatus: diagnosticStage === 'token' ? numericStatus : 0,
    resourceHttpStatus: diagnosticStage === 'resource' ? numericStatus : 0,
    contentType,
    applicationCode: redactText(fields.applicationCode, sensitiveValues).slice(0, 128),
    message,
    requestId: safeHeader(headers, ['x-correlation-id', 'x-request-id', 'request-id', 'correlation-id']),
    endpointFamily: String(endpointFamily || 'unknown').slice(0, 128),
    protocol: String(protocol || 'unknown').slice(0, 32),
    environment: String(environment || 'production').slice(0, 32),
    apiVersion: String(apiVersion || '').slice(0, 32),
    scope: String(scope || '').slice(0, 64),
    requestMethod: String(requestMethod || 'GET').toUpperCase().slice(0, 16),
    responseHostname: String(responseHostname || '').toLowerCase().slice(0, 253),
    redirectStatus: redirect ? numericStatus : 0,
    redirectDestination: redirect ? {
      hostname: String(redirect.hostname || '').toLowerCase().slice(0, 253),
      pathname: String(redirect.pathname || '/').split(/[?#]/, 1)[0].slice(0, 512),
      appearsLogin: Boolean(redirect.appearsLogin)
    } : null,
    wwwAuthenticateScheme: authenticationScheme(headers),
    htmlClassification: htmlInfo?.classification || '',
    bodyFingerprint: htmlInfo?.bodyFingerprint || (jsonFields.applicationCode || jsonFields.message ? 'json:application-error' : (xmlFields.applicationCode || xmlFields.message ? 'xml:application-error' : 'none')),
    retryAfterSeconds: retryAfterSeconds(headers),
    retryAfterRaw: retryAfterRaw(headers),
    category,
    systemic: !['none', 'shipment_not_found'].includes(category)
  };
  diagnostic.fingerprint = [diagnostic.endpointFamily, diagnostic.environment, diagnostic.apiVersion, diagnostic.protocol, diagnostic.category, diagnostic.status, diagnostic.applicationCode, diagnostic.htmlClassification, diagnostic.redirectDestination?.hostname || '', diagnostic.redirectDestination?.pathname || ''].join('|');
  return diagnostic;
}

class CanadaPostServiceError extends Error {
  constructor(diagnostic) {
    super(diagnostic.message || 'Canada Post service request failed.');
    this.name = 'CanadaPostServiceError';
    this.code = diagnostic.applicationCode || `HTTP_${diagnostic.status || 0}`;
    this.diagnostic = diagnostic;
    this.status = diagnostic.status;
  }
}

function applicationErrorFromResponse(response, options = {}) {
  const diagnostic = parseCanadaPostError({ status: response.status, headers: response.headers, body: response.body, ...options });
  return diagnostic.category === 'none' ? null : new CanadaPostServiceError(diagnostic);
}

module.exports = {
  CanadaPostServiceError,
  redactText,
  looksHtml,
  htmlPageClassification,
  parseCanadaPostError,
  applicationErrorFromResponse
};
