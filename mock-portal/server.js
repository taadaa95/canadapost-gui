'use strict';

const http = require('http');
const { URL } = require('url');

const SCENARIOS = Object.freeze([
  'success', 'invalid-credentials', 'cookie-banner', 'verification-required',
  'duplicate', 'validation-error', 'ineligible', 'session-expired', 'redirect',
  'disallowed-origin', 'unexpected-new-tab', 'slow-page', 'network-failure',
  'server-error', 'changed-selector', 'ambiguous-submit', 'delayed-submit',
  'browser-crash', 'worker-crash'
]);

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function page(title, body, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
  <style>body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto}label{display:block;margin:12px 0}button,a,select,input{font:inherit;padding:8px}#cookie{border:2px solid #333;padding:12px}</style></head>
  <body><main><h1>${escapeHtml(title)}</h1>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

function scenarioFrom(url) {
  const scenario = String(url.searchParams.get('scenario') || 'success');
  return SCENARIOS.includes(scenario) ? scenario : 'success';
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(body);
}

function loginHtml(scenario) {
  if (scenario === 'verification-required') {
    return page('Manual verification required', '<p role="alert">Verify you are human. Complete the CAPTCHA manually.</p><div class="captcha" data-sitekey="local-qa-only">Local QA verification placeholder</div>');
  }
  const cookie = scenario === 'cookie-banner'
    ? '<aside id="cookie" role="dialog">Cookie preferences <button onclick="this.parentElement.remove()">Accept all</button></aside>'
    : '';
  return page('Local QA login', `${cookie}<form method="post" action="/login"><label>Username <input name="username" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><input type="hidden" name="scenario" value="${escapeHtml(scenario)}"><button type="submit">Sign in</button></form><p>This synthetic portal never contacts Canada Post.</p>`);
}

function supportHtml(scenario) {
  if (scenario === 'changed-selector') return page('Late package support', '<p>The expected ticket launcher is intentionally absent.</p>');
  const target = `/claim?scenario=${encodeURIComponent(scenario)}&stage=receiver`;
  if (scenario === 'unexpected-new-tab') {
    return page('Late package support', `<a id="ticket_open" target="_blank" href="${target}">Open a ticket</a>`);
  }
  if (scenario === 'disallowed-origin') {
    return page('Late package support', '<a id="ticket_open" href="https://example.invalid/blocked">Open a ticket</a>');
  }
  return page('Late package support', `<a id="ticket_open" href="${target}">Open a ticket</a>`);
}

function claimHtml(url, scenario) {
  const stage = String(url.searchParams.get('stage') || 'receiver');
  const next = nextStage => `/claim?scenario=${encodeURIComponent(scenario)}&stage=${nextStage}`;
  if (scenario === 'session-expired') return loginHtml('success');
  if (stage === 'receiver') return page('Create a service ticket', `<form method="get" action="/claim"><input type="hidden" name="scenario" value="${escapeHtml(scenario)}"><input type="hidden" name="stage" value="reference"><label>Receiver's country <select name="receiverCountry"><option value="CA">Canada</option></select></label><label>Receiver's postal code <input id="CreateTicket:receiverPostalCode" name="receiverPostalCode"></label><label>Tracking number <input id="CreateTicket:ZZ_KEYDOC" name="tracking"></label><button type="submit">Continue</button></form>`);
  if (stage === 'reference') return page('Reference details', `<form method="get" action="/claim"><input type="hidden" name="scenario" value="${escapeHtml(scenario)}"><input type="hidden" name="stage" value="sender"><label>Reference Number 1 <input name="referenceNumber"></label><button type="submit">Continue</button></form>`);
  if (stage === 'sender') return page('Sender and contact', `<form method="get" action="/claim"><input type="hidden" name="scenario" value="${escapeHtml(scenario)}"><input type="hidden" name="stage" value="review"><label>Street Number <input id="claimAddressAndContacts:userAddress:streetNumber" name="streetNumber"></label><label>Street Name <select name="streetName"><option>Example Street</option><option>Rue Exemple</option></select></label><label>City <input name="city"></label><label>Postal code <input name="senderPostalCode"></label><label>Main contact <input name="contactName"></label><label>Email <input name="email"></label><button type="submit">Continue</button></form>`);
  if (stage === 'review') return page('Review ticket', `<form method="get" action="/claim"><input type="hidden" name="scenario" value="${escapeHtml(scenario)}"><input type="hidden" name="stage" value="final"><button type="submit">Continue</button></form>`);
  if (stage === 'final') {
    const script = `document.querySelector('button').addEventListener('click',event=>{event.preventDefault();location.href='${next('outcome')}';});`;
    return page('Final review', '<button type="button">Create Ticket</button>', script);
  }
  const outcomes = {
    success: 'Your request was submitted. Confirmation number: QA-12345',
    duplicate: 'An inquiry or refund request already exists for this tracking number.',
    'validation-error': 'We could not process this request because required information is invalid.',
    ineligible: 'This package is not eligible for a late-delivery refund.',
    'ambiguous-submit': 'Thank you. Your request is being processed.',
    'worker-crash': 'Synthetic worker crash checkpoint reached.',
    'browser-crash': 'Synthetic browser crash checkpoint reached.'
  };
  if (scenario === 'delayed-submit') {
    return page('Processing', '<p id="result">Processing your request…</p>', `setTimeout(()=>{document.getElementById('result').textContent='Your request was submitted. Confirmation number: QA-DELAY-123';},1200);`);
  }
  return page('Ticket outcome', `<p role="status">${escapeHtml(outcomes[scenario] || outcomes.success)}</p>`);
}

function createMockPortal({ host = '127.0.0.1', port = 0 } = {}) {
  let origin = '';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', origin || `http://${host}`);
    const scenario = scenarioFrom(url);

    if (scenario === 'network-failure') return request.socket.destroy();
    if (scenario === 'server-error') return send(response, 503, page('Service unavailable', '<p role="alert">Synthetic server error.</p>'));
    if (scenario === 'slow-page') return setTimeout(() => send(response, 200, supportHtml(scenario)), 1500);
    if (scenario === 'redirect') return send(response, 302, '', { location: `/cpc/en/support/kb/claims/late-packages.page?scenario=success` });

    if (url.pathname === '/' || url.pathname === '/login') {
      if (request.method === 'POST') {
        let body = '';
        request.on('data', chunk => { body += chunk.toString().slice(0, 8192); });
        request.on('end', () => {
          const values = new URLSearchParams(body);
          if (values.get('scenario') === 'invalid-credentials') return send(response, 401, page('Login failed', '<p role="alert">Invalid credentials.</p>'));
          return send(response, 302, '', { location: `/cpc/en/support/kb/claims/late-packages.page?scenario=${encodeURIComponent(values.get('scenario') || scenario)}` });
        });
        return;
      }
      return send(response, 200, loginHtml(scenario));
    }
    if (url.pathname === '/cpc/en/support/kb/claims/late-packages.page') return send(response, 200, supportHtml(scenario));
    if (url.pathname === '/claim') return send(response, 200, claimHtml(url, scenario));
    return send(response, 404, page('Not found', '<p>Synthetic route not found.</p>'));
  });

  return {
    scenarios: SCENARIOS,
    async start() {
      await new Promise((resolve, reject) => server.listen(port, host, error => error ? reject(error) : resolve()));
      const address = server.address();
      origin = `http://${host}:${address.port}`;
      return origin;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

module.exports = { SCENARIOS, createMockPortal };

if (require.main === module) {
  const portal = createMockPortal({ port: Number(process.env.MOCK_PORTAL_PORT || 0) });
  portal.start().then(origin => process.stdout.write(`${origin}\n`));
}
