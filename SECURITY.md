# Security and privacy

This application processes account credentials, shipment identifiers, addresses, contact details, authenticated browser sessions, and claim evidence.

## Credentials

- Canada Post web credentials, deprecated legacy Developer Program credentials, and current Tracking API client ID/secret use Electron `safeStorage` when a secure OS keyring backend is available.
- If no secure OS keyring is available, the app uses AES-256-GCM device-local encryption with a random 256-bit key stored separately under the per-user application-data directory.
- Device-local encryption depends on owner-only filesystem permissions and is weaker than a hardware-backed or OS-managed keyring. It is still substantially safer than plaintext persistence.
- Credentials are never returned to the renderer.
- The website/EST password, legacy API username/password, and current Tracking client ID/secret are distinct encrypted fields. The application never copies one credential family into another.
- OAuth access tokens exist only in Step 2 worker memory. They are refreshed before expiry, invalidated after authentication failure, cleared on worker shutdown, and never written to configuration, logs, SQLite, backups or diagnostic archives.
- Successful Tracking response bodies are parsed in memory and then dropped. Optional structural exports contain paths, types, array lengths, safe event codes and validation results only; they omit response values for shipment/customer/location/reference/description fields.
- Credentials and the device key are excluded from SQLite, source archives, backups, diagnostic ZIPs, and CSV exports.
- The password field is intentionally cleared after saving; the UI reports whether a reusable saved credential exists.
- Rotate credentials if an older project archive containing plaintext settings was shared.

## Tracking API transport

Current Tracking requests are serialized at concurrency one through a cancellation-aware limiter. The configurable interval has a 3,100 ms hard floor and default plus 0–100 ms positive jitter, honors valid `Retry-After`, and bounds transient gateway retries. Rate/backoff telemetry contains status, delay and retry source only. It never carries the request URL, PIN, client credentials, token or authorization header.

Classification output is run-scoped and fail-closed. CSV promotion has rollback buffers and SQLite promotion is a single transaction linked to its run. Incomplete or discarded runs cannot feed Step 3; immutable completed classification history is retained.

- Current Step 2 sends OAuth client credentials only to the selected Canada Post token endpoint and sends the resulting Bearer token only to the matching Tracking gateway.
- The HTTP layer uses manual redirect handling. It never follows 301, 302, 303, 307 or 308 responses, so credentials and Bearer tokens cannot be forwarded through redirects.
- Diagnostics retain only safe status, hostname, query-free pathname, content type, public API version/scope, bounded application error fields and request/correlation identifiers. They exclude authorization headers, tokens, client credentials, response bodies, cookies and complete tracking identifiers.
- The deprecated Basic/XML client is isolated and disabled. The public-beta path has no automatic fallback from OAuth/JSON.

## Application data

Mutable files live under Electron's per-user `userData` directory. The app applies restrictive file and directory permissions where the OS permits it.

The packaged migration-test override is an operator-only environment guard, not renderer IPC or a normal setting. Both `CANADA_POST_CLAIM_RUNNER_USER_DATA_DIR` and the exact confirmation phrase are required. The production bootstrap retains the original default path for comparison, resolves the override before storage imports, rejects ownership, permission, symlink, containment, repository, default-profile, ASAR, AppImage, mount, and resources hazards, and centrally checks every application-owned mutable path. Isolated mode never performs repository legacy-data import or copy-back to the default profile. A prominent banner/title identify the mode; main-process policy disables live submission/browser, update, restore, and external diagnostic/export/publishing actions.

SQLite stores operational history only:

- shipments and tracking checks;
- workflow runs;
- claim attempts and reconciliation;
- evidence file paths and hashes.

Screenshots and page text remain separate files under the private data directory.

## Duplicate-claim protection

- Submitted and duplicate outcomes are terminal.
- Unknown or interrupted outcomes require reconciliation.
- Retry-exhausted failures require explicit approval.
- Do not delete the database to force a retry.

## Backups and diagnostics

New backups use a versioned scrypt/AES-256-GCM authenticated format and can contain customer and shipment information, claim history, and evidence. Passwords are never persisted. Restore enforces authentication, checksums, archive resource/path limits, database integrity and rollback copies. Legacy plaintext ZIP restore remains available with an explicit warning. Passwords, API credentials, device keys, browser profiles, cookies, and sessions are excluded.

Shareable diagnostic ZIPs exclude free-form log, history-message, and Step 3 trace text. They retain only bounded metadata and masked identifiers for opted-in components. Review every archive before sharing.

## Browser automation

- The embedded `WebContentsView` only permits Canada Post HTTPS domains. An exact loopback mock origin is allowed only when `NODE_ENV=test`.
- Its CDP endpoint is randomized and bound to loopback.
- CAPTCHA and verification challenges require manual completion; the app does not bypass them.
- The main renderer is sandboxed with context isolation and Node integration disabled. Arbitrary renderer window opens are denied.

See `docs/THREAT_MODEL.md`, `docs/PRIVACY_AND_RETENTION.md`, and `docs/INCIDENT_RESPONSE.md`.

## Step 3 browser isolation (v0.3.2)

The integrated browser uses a persistent, sandboxed Electron partition restricted to Canada Post HTTPS hosts. Permission requests, downloads, embedded webviews, insecure content and external main-frame navigation are blocked. A per-session target token prevents Playwright from attaching to the wrong Electron page. Worker credentials are delivered through stdin and are not placed in child-process environment variables.

Final claim submission is deliberately conservative: the Create Ticket action is never retried after an uncertain click, rendered visible text is the only result-classification source, and a real Canada Post ticket/confirmation number is required before a claim is recorded as submitted.


## Detailed Step 3 diagnostic privacy (v0.3.4)

Step 3 diagnostics use owner-only directories and files where supported. The logger records control metadata, timing, state transitions, frame and navigation structure, network failure metadata, visible-text samples, and error stacks to support debugging.

The logger does not intentionally record:

- passwords or API credentials;
- cookies, authorization headers, or browser-session tokens;
- values entered into login or claim form fields;
- full tracking numbers;
- screenshots in the shareable Diagnostic ZIP.

Configured secrets and personal fields are added to the redaction set before form automation starts. Tracking numbers are masked, URLs lose query strings and fragments, and common email, phone, postal-code, address, credential, and session patterns are redacted. Page-state control records include only whether a value is present and its length, not the value.

The latest Step 3 run contributes a metadata-only file inventory when included in a Diagnostic ZIP; filenames and file contents are excluded. Local detailed runs can contain operational context that the shareable archive intentionally omits and should remain private.

## Live submission authorization (v0.4.0-beta.1)

The renderer cannot start a live Step 3 worker with only a button click. The main process validates all submission options, requires a non-empty selected queue, snapshots that queue into a private run-specific CSV, enforces built-in-browser mode, and rejects live mode unless the renderer supplies an explicit acknowledgement produced by the live-submission confirmation dialog. This is a defense-in-depth control, not a substitute for reviewing the queue.

Canary mode limits the worker to the first selected claim. It does not automatically approve or continue the remaining queue.
