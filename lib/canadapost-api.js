'use strict';

const { setTimeout: delay } = require('timers/promises');
const { CanadaPostServiceError, parseCanadaPostError } = require('./canadapost-errors');

const PRODUCTION_HOSTS = new Set([
  'api.canadapost-postescanada.ca',
  'api-stg.canadapost-postescanada.ca',
  'soa-gw.canadapost.ca',
  'ct.soa-gw.canadapost.ca',
  'ws.postescanada-canadapost.ca'
]);
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function assertApiUrl(value, { allowMock = false } = {}) {
  const url = new URL(String(value));
  const localMock = allowMock && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol);
  if (!localMock && (url.protocol !== 'https:' || !PRODUCTION_HOSTS.has(url.hostname))) throw new Error('Canada Post API URL is outside the explicit allowlist.');
  return url;
}

async function responseBodyLimited(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error('Canada Post response exceeds the configured size limit.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_RESPONSE_BYTES) throw new Error('Canada Post response exceeds the configured size limit.');
  let detectedEncoding = 'utf-8';
  let bom = 'none';
  let body;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    bom = 'utf-8'; body = buffer.subarray(3).toString('utf8');
  } else if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    detectedEncoding = 'utf-16le'; bom = 'utf-16le'; body = buffer.subarray(2).toString('utf16le');
  } else if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    detectedEncoding = 'utf-16be'; bom = 'utf-16be';
    const swapped = Buffer.from(buffer.subarray(2)); swapped.swap16(); body = swapped.toString('utf16le');
  } else {
    body = buffer.toString('utf8');
  }
  const magic = buffer[0] === 0x50 && buffer[1] === 0x4b ? 'zip'
    : buffer[0] === 0x1f && buffer[1] === 0x8b ? 'gzip'
      : 'none';
  return {
    body,
    metadata: {
      byteLength: buffer.length,
      detectedEncoding,
      bom,
      binaryMagic: magic,
      replacementCharacterCount: (body.match(/\ufffd/g) || []).length
    }
  };
}

function sanitizedRedirect(location, source) {
  if (!location) return { hostname: '', pathname: '/', appearsLogin: false, sameOrigin: false };
  try {
    const destination = new URL(String(location), source);
    const marker = `${destination.hostname} ${destination.pathname}`.toLowerCase();
    return {
      hostname: destination.hostname,
      pathname: destination.pathname || '/',
      appearsLogin: /(?:login|signin|sign-in|sso|oauth|authenticate|account)/.test(marker),
      sameOrigin: destination.origin === source.origin
    };
  } catch (_) {
    return { hostname: '', pathname: '/', appearsLogin: false, sameOrigin: false };
  }
}

async function request({
  url,
  method = 'GET',
  accept,
  acceptLanguage = 'en-CA',
  contentType = '',
  body = undefined,
  username,
  password,
  bearerToken,
  clientId,
  clientSecret,
  sensitiveValues = [],
  timeoutMs = 30000,
  retries = 0,
  allowMock = false,
  signal,
  headers = {},
  endpointFamily = 'unknown',
  protocol = 'REST',
  environment = 'production',
  apiVersion = '',
  scope = '',
  diagnosticStage = 'resource'
}) {
  const target = assertApiUrl(url, { allowMock });
  if (bearerToken && (username || password)) throw new Error('Canada Post request cannot mix Bearer and Basic authentication.');
  const basicAuthorization = username || password
    ? Buffer.from(`${String(username || '')}:${String(password || '')}`).toString('base64')
    : '';
  const secrets = [username, password, bearerToken, clientId, clientSecret, ...sensitiveValues].filter(Boolean);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeout = AbortSignal.timeout(Math.max(1000, Math.min(120000, Number(timeoutMs || 30000))));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(target, {
        method,
        headers: {
          Accept: accept || 'application/json',
          ...(acceptLanguage ? { 'Accept-Language': acceptLanguage } : {}),
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
          ...(basicAuthorization ? { Authorization: `Basic ${basicAuthorization}` } : {}),
          ...(clientId ? { 'X-IBM-Client-Id': clientId } : {}),
          ...(clientSecret ? { 'X-IBM-Client-Secret': clientSecret } : {}),
          ...(contentType ? { 'Content-Type': contentType } : {}),
          ...Object.fromEntries(Object.entries(headers).filter(([key]) => !/^(?:authorization|x-ibm-client-id|x-ibm-client-secret)$/i.test(key)))
        },
        body,
        signal: combined,
        redirect: 'manual'
      });
      const decodedResponse = await responseBodyLimited(response);
      const responseBody = decodedResponse.body;
      if (REDIRECT_STATUSES.has(response.status)) {
        const redirect = sanitizedRedirect(response.headers.get('location'), target);
        throw new CanadaPostServiceError(parseCanadaPostError({
          status: response.status,
          headers: response.headers,
          body: responseBody,
          endpointFamily,
          protocol,
          sensitiveValues: secrets,
          requestMethod: method,
          responseHostname: target.hostname,
          environment,
          redirect,
          apiVersion,
          scope,
          diagnosticStage
        }));
      }
      if (!response.ok) {
        const error = new CanadaPostServiceError(parseCanadaPostError({
          status: response.status,
          headers: response.headers,
          body: responseBody,
          endpointFamily,
          protocol,
          sensitiveValues: secrets,
          requestMethod: method,
          responseHostname: (() => { try { return new URL(response.url || target).hostname; } catch (_) { return target.hostname; } })(),
          environment,
          apiVersion,
          scope,
          diagnosticStage
        }));
        if (response.status < 500 || attempt === retries) throw error;
        lastError = error;
      } else {
        return {
          status: response.status, headers: response.headers, body: responseBody,
          bodyMetadata: {
            ...decodedResponse.metadata,
            contentType: String(response.headers.get('content-type') || '').slice(0, 128),
            contentEncoding: String(response.headers.get('content-encoding') || 'identity').slice(0, 64),
            transferEncoding: String(response.headers.get('transfer-encoding') || '').slice(0, 64)
          },
          responseHostname: target.hostname, environment, requestMethod: method
        };
      }
    } catch (error) {
      lastError = error;
      if (error.status && error.status < 500) throw error;
      if (attempt === retries) throw error;
    }
    await delay(Math.min(2000, 250 * (2 ** attempt)), undefined, { signal }).catch(() => {});
  }
  throw lastError || new Error('Canada Post request failed.');
}

module.exports = { PRODUCTION_HOSTS, MAX_RESPONSE_BYTES, REDIRECT_STATUSES, assertApiUrl, sanitizedRedirect, request };
