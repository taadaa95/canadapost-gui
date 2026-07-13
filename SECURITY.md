# Security and privacy

This application processes account credentials, shipment identifiers, addresses, contact details, authenticated browser sessions, and claim evidence.

## Credentials

- Canada Post web and Developer API credentials use Electron `safeStorage` when a secure OS keyring backend is available.
- If no secure OS keyring is available, the app uses AES-256-GCM device-local encryption with a random 256-bit key stored separately under the per-user application-data directory.
- Device-local encryption depends on owner-only filesystem permissions and is weaker than a hardware-backed or OS-managed keyring. It is still substantially safer than plaintext persistence.
- Credentials are never returned to the renderer.
- Credentials and the device key are excluded from SQLite, source archives, backups, diagnostic ZIPs, and CSV exports.
- The password field is intentionally cleared after saving; the UI reports whether a reusable saved credential exists.
- Rotate credentials if an older project archive containing plaintext settings was shared.

## Application data

Mutable files live under Electron's per-user `userData` directory. The app applies restrictive file and directory permissions where the OS permits it.

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

Backups can contain customer and shipment information, claim history, and evidence. Store them securely. Passwords, API credentials, device keys, browser profiles, cookies, and sessions are excluded.

Diagnostic ZIPs redact configured sensitive values, credentials, email addresses, phone numbers, postal codes, and recognized tracking-number formats. Review a diagnostic archive before sharing it because no redaction system can guarantee detection of every free-form personal detail.

## Browser automation

- The embedded browser only permits Canada Post HTTPS domains.
- Its CDP endpoint is randomized and bound to loopback.
- CAPTCHA and verification challenges require manual completion; the app does not bypass them.

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

The latest Step 3 run is re-sanitized when included in a Diagnostic ZIP. Automated redaction cannot guarantee removal of every possible free-form personal detail, so users must review an archive before sharing it. Local detailed runs can contain more operational context than the shareable archive and should remain private.
