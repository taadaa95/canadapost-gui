# Canada Post Claim Runner

Current public stable version: **0.4.4** for Linux x64 and Windows x64. Version **0.4.5** is the current release candidate. `OPERATING_GUIDE.md` is the authoritative operator guide; development checkpoint reports remain historical.

Electron application for importing Canada Post EST shipment history, checking delivery results, identifying late-delivery claim candidates, and submitting selected late-package support tickets under user supervision. Canada Post makes the final claim-eligibility decision.

## Important operating rule

The Step 3 queue contains only actionable `LATE_CANDIDATE` records: authoritative tracking has a usable original Delivery Standard and a successful-delivery date after that standard, and the current claim-attempt state permits execution. Previously submitted, already-submitted, terminal, unresolved, reconciliation-required, and otherwise blocked records are excluded automatically. Safe retry states already authorized by the claim-attempt rules remain available. A revised operational estimate is retained separately and does not replace an earlier original standard.

The other outcomes are `ON_TIME`, `REVIEW_REQUIRED`, and `TRACKING_ERROR`. A missing/invalid Delivery Standard or missing/invalid successful-delivery result remains `REVIEW_REQUIRED`; it is not promoted and cannot enter Step 3. Authentication, transport, API, timeout, and parser failures remain `TRACKING_ERROR` and also cannot enter Step 3. EST Shipment Date, EST Service Code, first attempt, policy-version selection, exclusion prediction, claim-window status, and predicted approval are not prerequisites for late-candidate detection; service/policy/window information is advisory and Canada Post makes the final claim decision.

## Install

```bash
npm ci
npm start
```

Node.js implements Steps 1 and 2. Step 2 uses the current Canada Post Developer Portal Tracking API: OAuth 2.0 client credentials, Bearer authorization, REST and JSON. PHP is no longer an installation prerequisite. Automated tests use synthetic fixtures and loopback mocks and never call production Canada Post services.

Step 1 uses EST parser `est-import-v5`. It requests both Manifest and ManifestItems, joins the documented Manifest `Mailing Date` to item rows by `Order Id`, maps ManifestItems `MATNR – Article Number` through the documented service table, and persists available normalized enrichment with source-field/provenance columns. Tracking PIN is mandatory. Missing Shipment Date or Service Code is never invented and does not exclude a row with a valid PIN; aggregate optional-metadata warnings are reported instead.

Create a current Canada Post Developer Portal Production application, add Tracking product access, and save its API Key as the **Tracking API 2.0 platform client ID** and its API Secret as the **Tracking API 2.0 platform client secret** in User Settings. Claim Runner always uses the production Tracking environment. Then run Step 1 and Step 2. Normal Step 2 automatically performs a fresh tracking run and does not require a separate diagnostic gate.

Tracking API service is preferred, EST service is the fallback, and unknown service remains valid optional enrichment. Internal semantic diagnostics, sanitized response inspection, and incomplete-run staging/recovery remain available for support and automated testing without appearing in the normal workflow. Incomplete Step 2 runs remain excluded from Step 3 and do not delete completed history.

Bulk tracking remains sequential (concurrency 1). Advanced Settings enforces a 3,100 ms minimum start-to-start interval with 0–100 ms positive jitter, so the legacy Tracking workload cannot exceed 20 starts in a rolling minute and positive jitter normally reduces it further. Exact SLM Monitor rejections and HTTP 429 responses pause at least 60 seconds; generic 502/503/504 responses and resource timeouts use at most two bounded exponential retries with jitter. Generic 504 responses are not mislabeled as throttling. OAuth tokens remain cached and reused. A stopped bulk run never restarts automatically.

Legacy `user.ini` Developer Program username/password values can still be imported into encrypted storage for migration safety, but they are labeled deprecated and inactive. They are never copied into the current client ID/secret fields and Step 2 never falls back to legacy Basic/XML. A legacy customer-number entry is removed during the one-time privacy reset and is never used to populate Step 1; enter the current number explicitly in User Settings. Optional `mobo` remains legacy Step 1 configuration.

The Canada Post web/EST login is entered in User Settings. Electron OS-keyring encryption is preferred. When a usable OS credential store is unavailable, the app uses AES-256-GCM device-local encryption protected by owner-only application-data permissions.

## Upgrade from 0.1

Overlay the hardening patch onto the existing project and launch once. The app migrates legacy `data/`, `logs/`, `config.local.json`, and root `user.ini` into Electron's per-user application data directory. Web and Developer API credentials are moved into encrypted storage. OS-keyring encryption is preferred, with a device-local encrypted fallback when necessary.

Verify the migrated data and credential status in User Settings. Current Developer Portal Tracking credentials must be entered separately; legacy values are never promoted automatically. Then remove any remaining legacy `config.local.json`, `user.ini`, `data/`, and `logs/` copies from the project directory. Rotate both web and API credentials if an earlier archive containing them was shared.

A clean source installation intentionally contains no credentials, device keys, tracking exports, claim screenshots, browser profiles, or logs.

## Isolated packaged migration rehearsal

The production-equivalent migration override `CANADA_POST_CLAIM_RUNNER_USER_DATA_DIR` is accepted only with `CANADA_POST_CLAIM_RUNNER_ISOLATED_TEST_CONFIRM=ISOLATED_MIGRATION_TEST`. Bootstrap validates and applies it before application-storage imports; it does not depend on `NODE_ENV=test`. The target must be a private, existing, canonical absolute directory separate from the home directory, repository, normal profile, and packaged application.

When active, the app uses that directory for Electron/Chromium session data and every application-owned mutable path. It shows a permanent banner and title suffix, and disables live claims, the built-in claim browser, updates, restore, and external publishing/export in the main process. Follow `MANUAL_RELEASE_GATES.md`; never point the override at the real profile itself.

## Files created at runtime

The local SQLite database is the authoritative source for shipment history, tracking checks, eligibility decisions, workflow runs, claim attempts, and reconciliation state.

On startup, the app reconciles the actual SQLite objects rather than trusting only `PRAGMA user_version`. An existing database is backed up to a unique timestamped file before any migration, and migrations commit atomically only after integrity and foreign-key checks pass. If migration fails, the workflow window remains closed and the recovery dialog offers the backup location, data-folder access, and a sanitized copyable diagnostic. Do not delete the database to bypass this guard; see `docs/DATABASE_MIGRATIONS.md`.

CSV and JSON files remain as workflow inputs, exports, and human-readable summaries:

- `tracking.csv`: imported shipment records;
- `claims.csv`: `LATE_CANDIDATE` rows only;
- `overdue-undelivered.csv`: overdue shipments that have not been delivered;
- `eligibility-review.csv`: records that cannot be safely auto-classified;
- `tracking-run-summary.json`: complete Step 2 counts;
- timestamped claim summaries and evidence files.

An interrupted or uncertain claim appears as **Needs attention** in Claim History and is not retried automatically. Its historical status, audit record, and retained evidence remain available for review. Failed claims are limited to three automatic attempts by default.

## Claim History

History is a single newest-first claim record with Refresh and CSV export. It shows tracking number, attempt time, status, confirmation when available, a concise result, and useful evidence. Reconciliation mutation buttons and developer utility controls are not exposed in the normal customer interface. Step 3 explains that Claim Runner controls the built-in browser and pauses explicitly when login, verification, or CAPTCHA input is required.

## Validation and stable build

```bash
npm test
npm run test:dev10
npm run test:updates
npm run test:localization
npm run lint
npm run lint:dev10
npm run format:check
npm run typecheck
npm run coverage
npm run test:mock-portal
npm run test:accessibility
npm run test:electron
npm run secret-scan
npm run release:audit
npm run sbom
```

The suites cover:

- expected-date/first-attempt late-candidate classification and revised-date handling;
- overdue but undelivered shipments;
- optional/missing EST metadata and Tracking API service precedence;
- encrypted credential storage and authenticated encrypted backups;
- claim selection, idempotency, interrupted attempts, and retry limits;
- Step 3 `WebContentsView` isolation, authoritative submission safeguards, mock navigation/outcomes, selector behavior, fault points and structured diagnostic redaction;
- SQLite migrations and immutable evidence, localization completeness, integer-cent reporting, GitHub release-asset digest verification and accessibility rules.
- current Tracking OAuth token acquisition/caching/refresh, exact official endpoints and headers, JSON schema normalization, archive/not-found/error handling, credential separation, support diagnostics, circuit semantics and packaged loopback smokes.

## Release process

Never ZIP the working directory. `npm run release:safe` materializes only allowlisted tracked files in a clean staging directory, scans them, writes a source manifest/checksum, extracts the archive and scans it again. Native CI builds Linux x64, Windows x64, and macOS universal packages from a reviewed clean Git commit, generates SHA-256 and provenance metadata, and audits packaged content. `RELEASE_CHANNEL` is not used. Production Step 3 uses Electron's built-in browser and the package must not contain a second Playwright browser runtime.

Starting with 0.4.0, **Check for Updates** uses GitHub's latest normal release and verifies the exact filename, platform, architecture, byte size, and GitHub SHA-256 asset digest. The already-distributed 0.4.0-beta.1 binary has the old compiled updater and requires one manual installation of 0.4.0. Existing application data remains in the same user profile.

On macOS, the updater opens the verified universal DMG and tells the operator to replace Canada Post Claim Runner in Applications. It never recursively replaces a running `.app` bundle. A final public macOS package requires Developer ID signing and Apple notarization; an unsigned CI DMG is only a technical test artifact.

See `docs/RELEASE_PROCESS.md`, `MANUAL_RELEASE_GATES.md`, `RELEASE_NOTES.md` and `SECURITY.md`.

## Step 3 safety model

Step 3 uses the app's isolated built-in Canada Post browser session. The runner selects that exact browser target, confirms authentication, restricts top-level navigation to Canada Post, fills one claim at a time, and records the attempt transactionally before the final action. Unknown, interrupted, timed-out, or confirmation-without-number outcomes are sent to reconciliation instead of being retried automatically.

## Step 3 operator controls

The v0.4.0 productization branch adds a safety layer before browser automation begins:

- a readiness preflight verifies local storage, database integrity, credentials, sender address, the late-candidate queue, and unresolved reconciliation warnings;
- the user reviews and selects the exact claims that may be processed;
- the selected queue is copied to a private run-specific CSV so later changes to `claims.csv` cannot alter an active run;
- Step 3 remains restricted to the built-in Electron browser.

Selecting candidates and choosing **Submit selected candidates** starts silent authoritative preflight and then the sequential built-in-browser workflow. There is no browser-mode choice or second confirmation dialog.

## Step 3 detailed diagnostics

Every Step 3 run creates a private diagnostic directory under the Electron per-user log directory:

```text
logs/step3-runs/step3-<timestamp>-run-<id>/
```

The directory includes:

- `timeline.jsonl`: complete machine-readable event timeline;
- `step3-detailed.log`: human-readable chronological trace;
- `electron-browser.jsonl`: sandboxed WebContentsView navigation, loading, crash, and bounds events;
- `live-status.json`: the last known state even if the worker is interrupted;
- `summary.json`: operation timing, warnings, errors, state, and final outcome;
- `page-states/`: redacted page structure, frames, visible controls, and visible-text samples;
- `manifest.json`: runtime and privacy metadata.

The trace records selector strategies, frame scans, form readiness, navigation transitions, browser/network failures, final-action dispatch state, confirmation polling, evidence metadata, and stop/shutdown behavior. It does not intentionally record passwords, cookies, authorization data, entered form values, or full tracking numbers.

Use **Open Detailed Diagnostics** in Step 3 to inspect the latest local run. **Settings → Advanced → Support bundle** previews its manifest and components before export. System integrity and sanitized setting status are selected by default; masked history and metadata-only log and Step 3 inventories require opt in. Credentials, tokens, cookies, browser profiles, raw Tracking API bodies, screenshots, filenames, and free-form operational text are always excluded. Review the archive before sharing; see [support bundles](docs/SUPPORT_BUNDLES.md).

Step 3 remains directly accessible and does not run a portal health or compatibility check. Its actual submission protections remain mandatory: only immutable, promoted `LATE_CANDIDATE` records can be selected; unresolved and terminal attempts are blocked; evidence hashes and snapshots are revalidated; CAPTCHA or text verification remains under human control in the isolated built-in browser; and uncertain final actions are never retried automatically.

Detailed runs are automatically limited to the newest 20 directories and 30 days of retention.
