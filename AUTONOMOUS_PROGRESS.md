# Historical implementation record

This file preserves Dev 1–10 checkpoint history. It is not an operating guide and its artifact names, branches, versions, package sizes, and completion statements are superseded by `BETA_OPERATING_GUIDE.md` and issue #4.

# Autonomous productization progress

Last updated: 2026-07-28 (America/Toronto)

## 2026-07-28 Step 1 EST parser-v4 and invalid-import rejection

- Authorized aggregate inspection confirmed a systematic present-but-blank failure: 284/284 missing Shipment Date and 284/284 missing Service Code. No private row data was printed/retained and the operator file was untouched.
- Root cause: the deleted PHP/Node headerless ManifestItems fallback extracted positions 16/27/30 only, did not join Manifest `Mailing Date` at position 8 by `Order Id`, did not map ManifestItems `MATNR – Article Number` at position 2, and silently promoted blank output.
- Added explicit `est-import-v4` mappings, the documented two-block join, `est-article-services-2015-v1`, component-wise date parsing, provenance columns, value-free structural diagnostics, partial-row exclusion, and systemic date-failure preservation before output mutation.
- Added exact policy/invariant codes and a local Step 2 CSV date preflight before credentials/network setup. The defective 284-row CSV is invalid and must be replaced by a fresh supervised Step 1 import; it is never patched or reused.
- Targeted and complete source/static/security/dependency validation passed. The 1,037-entry/six-worker package audit and unpacked/extracted-AppImage populated, missing-date, preservation, and parser-v4 policy-input smokes passed against loopback mocks only.
- Final AppImage: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,185,094 bytes, SHA-256 `86c50659e25b54af7429020d55b7bde9d37aab95ac5bd2cc872c0321570146ee`.

## 2026-07-28 packaged SQLite startup migration recovery

- Root cause: schema version 5/6 was trusted even when `classification_records` was absent, so the former line 304 executed `ALTER TABLE classification_records ADD COLUMN run_id ...` before repairing the missing table.
- Replaced version-only branching with an explicit object-order manifest: core parents, claim columns, tracking/classification parents, dependent history/queue tables, finance, run scope, indexes, then immutable triggers.
- All schema repair plus `user_version = 7` is one immediate transaction. Failures roll back to the incoming schema/version; successful migration must pass `integrity_check` and `foreign_key_check`.
- Existing databases receive a unique owner-only, verified, timestamped SQLite backup before migration. Corrupt/unreadable input receives an explicitly unverified size-checked recovery copy; the source is not replaced.
- Electron now awaits initialization before opening the workflow window. Failure writes a value-free local diagnostic, offers **Open data folder**, **Copy diagnostic**, and **Exit**, and terminates cleanly.
- Twelve synthetic migration states pass, including current/no-op, v4 development/old claim records, missing and partial classification schemas, falsely advanced version, row preservation, corruption, foreign-key rejection, and forced rollback.
- Source suite, coverage, accessibility, loopback mocks, scans, both zero-vulnerability audits, SBOM, package audit, all rebuilt worker smokes, and packaged/extracted-AppImage startup probes passed without GUI launch or access to operator data.
- Current AppImage: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,160,506 bytes, SHA-256 `75382a237987132862b1359931b68e6a4445355de29902e9377ce9cddf67aa83`.

## 2026-07-28 live Tracking JSON normalization and adaptive rate limiting

- Corrected API-first service resolution with validated EST fallback and explicit provenance.
- Expanded the official direct-object event mapper for expected/revised dates, common lifecycle events, English/French attempt evidence, documented event-code precedence and separate actual delivery.
- Added value-free structural export, parser-version semantic gate, three-response semantic circuit, run-scoped staged promotion, fail-closed Step 3 authority checks and incomplete-run discard/reversion.
- Replaced the legacy 3.1-second sleep with a configurable sequential limiter: 500 ms default, 250 ms floor, 0–100 ms jitter, exact `Retry-After`, 60-second minimum on headerless 429, and two bounded gateway retries.
- Complete non-GUI tests, lint/format/typecheck, 92.85% line coverage, accessibility, mock portal, secret/release scans, zero-vulnerability full/production audits and SBOM passed. Final package validation is recorded below after the rebuild.

## 2026-07-28 current Tracking API OAuth/JSON migration — complete for mock/package scope

- Retrieved and hashed the official Canada Post Tracking OpenAPI document. The portal catalog generation is 2.0.0; the actual Tracking OpenAPI operation contract is 1.0.0 with `/tracking/v1`. The sanitized checked-in derivative records both rather than inventing a version.
- Replaced the public-beta Step 2 request path with OAuth 2.0 client credentials and JSON. Production uses `api.canadapost-postescanada.ca`; test uses `api-stg.canadapost-postescanada.ca`. The token and resource routes, `merchant` scope, `X-IBM-Client-Id`/`X-IBM-Client-Secret` headers, Bearer request and JSON schema come from the official contract/authentication guide.
- Added separate encrypted current client ID/secret settings and environment association. Website/EST and deprecated legacy Basic/XML credentials remain separate; nothing is copied or deleted. Tokens are memory-only, monotonic-expiry cached, proactively refreshed and retried once after a resource 401.
- Isolated the legacy client behind an explicit disabled entry point with no public-beta import or automatic fallback. Normal Step 2 is gated on a successful no-state-change one-shipment diagnostic for the exact credential revision, environment and API contract version.
- Added JSON event/expected-delivery/service/archive normalization, schema checks, safe OAuth/API diagnostics and status-first 502/503/504 classification. HTML-bodied 504 is now **Canada Post API gateway timed out (HTTP 504)**.
- Full non-GUI tests, lint/format/typecheck, 92.61% line coverage, accessibility, mock portal, secret/release scans, both npm audits, SBOM, Linux AppImage build, 1,021-entry package audit and all requested packaged OAuth/JSON smokes passed. The patched build dependency override reduced both production and full npm audits to zero vulnerabilities.
- Current AppImage: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,152,361 bytes, SHA-256 `f1d02690c98c16b44a41e8a463b8152916b11ca0ce9c4977f5f3890273fcdbdd`.
- No GUI was launched, no production Canada Post request was made, no claim/queue/customer state was touched, and no credentials or response bodies were exposed.

## Superseded 2026-07-28 legacy Step 2 diagnostics checkpoint

- Re-constrained the workflow shell to the Electron viewport after a late CSS override had re-enabled document growth. Steps 1–3 now have identical independent bounded log behavior, stable gutters, safe long-line handling, 2,000-entry DOM retention, threshold-based auto-follow and unread-count jump controls.
- Removed visible per-shipment Step 1 logging. Aggregate progress is emitted at 1/every 25/final; final totals remain; complete sanitized redacted shipment detail remains in disk logs.
- Verified the current official Canada Post legacy Get Tracking Details REST page: production/development hosts, GET PIN detail route, exact v2 Accept, Basic API key, language header and no body.
- Added explicit website/EST versus Developer Program API settings, environment association/mismatch checks, non-secret metadata and protected stdin transport. Website credentials are never used by the Step 2 worker.
- Added manual redirect capture/no-follow behavior, safe redirect fields, six HTML response types, status/XML diagnostics and specific operator messages.
- Reworked circuit state so an aborted 3-of-284-style run is blocked, never complete, reports attempted/remaining/errors/queue preserved, keeps normal completion markers and all queue/classification writes untouched, and requires a deliberate retry.
- Exposed the exactly-one-request diagnostic for a selected authorized row with double confirmation and no claims/eligibility/queue/run-summary changes.
- All requested source, mock, audit, layout, package and extracted-AppImage smokes passed. No GUI, claim submission, bulk production tracking or production Canada Post request occurred.

Artifact from that superseded checkpoint: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`; SHA-256 `ac7e49fa80b8d0b880b7051e200b8ad4c16f7253f661abf5ea9d205b314184fd`.

## Current position

All feasible repository work for Phases 0–2 is implemented and validated. The verdict is **public-beta candidate**, not stable. The existing `v0.4.0-productization` branch contains substantial pre-mission operator-control work; it remains preserved as user-owned work. No reset, destructive cleanup, runtime-data deletion, push, publication, account login, real claim, CAPTCHA bypass, live canary or customer-data access was performed.

## Phase 0 checkpoint

- Added an explicit release allowlist, prohibited-path audit, redacting repository-native secret scanner, clean-worktree staging builder, content manifest, SHA-256 checksums, extracted-artifact rescan, and release-content tests.
- Researched and documented official Canada Post policy sources retrieved July 26, 2026. The current guide confirms that guarantee performance is measured to first delivery attempt. The 2025 peak notice requires domestic covered items mailed November 3, 2025 through January 11, 2026 to be at least two business days late.
- Added versioned policy/service/peak data and an explicit Canada Post holiday calendar covering 2024–2026. Dates outside policy/calendar coverage and regional-holiday ambiguity enter manual review.
- Added bilingual deterministic event normalization, distinct expected/first-attempt/actual dates, duplicate handling, conflict detection, timezone normalization, exclusion signals, raw hashes, and unknown-event handling.
- Added schema version 5 with immutable historical classifications and normalized tracking events, current pointers, structured claim details, manual reviews, audit events, reviewed queue snapshots, and worker revalidation records.
- Added manual-review queue IPC/UI with notes and explicit resolutions that do not overwrite automated classification.
- Step 3 now classifies the selected queue from current evidence, writes and persists a cryptographic reviewed snapshot, and revalidates immediately before each worker claim. Any evidence/classification/policy/deadline change blocks processing before a claim attempt is created.
- Queue previews now carry first-attempt, deadline, lateness, remaining-business-day, policy, calendar, and reason fields with tracking/service/urgency filters.

Phase 0 validation: `npm test` PASS; `npm run secret-scan` PASS; `npm run release:audit` PASS. The safe artifact builder correctly refuses the intentionally dirty worktree, so an actual source archive will be generated after reviewed changes are committed.

## Initial repository state

- HEAD: `2bfcc93` (`Clean trailing whitespace`)
- Branch: `v0.4.0-productization`, tracking `origin/v0.4.0-productization`
- Working tree: dirty before mission work began
- Pre-existing modified tracked files: `APPLY_UPDATE.md`, `QA_REPORT.md`, `README.md`, `RELEASE_NOTES.md`, `SECURITY.md`, `index.html`, `main.js`, `package-lock.json`, `package.json`, `preload.js`, `renderer.js`, `repair-install.sh`, and `tests/ui-contract-test.js`
- Pre-existing untracked productization files: `PRODUCTIZATION_ROADMAP.md`, `lib/claim-queue.js`, `lib/input-validation.js`, `lib/preflight.js`, and four associated test files
- Ignored local runtime paths include a credential/configuration file, `data/`, `logs/`, `node_modules/`, a browser profile, tracking and claim exports, evidence, and runtime logs. Their contents were not opened, copied, changed, staged, or included in test fixtures.
- Current architecture: Electron main and renderer are large monoliths; the primary renderer has context isolation and Node integration disabled but no explicit sandbox flag; Step 3 uses `BrowserView`; Steps 1 and 2 use PHP; operational data is stored in SQLite schema version 4 plus compatible CSV/JSON exports; backups are plaintext ZIP; CI runs only on Linux.

## Baseline validation

Command: `npm test`

Result: PASS (exit 0). JavaScript and PHP syntax checks passed. The following existing test programs reported success: eligibility, storage, IPC input validation, claim queue, preflight, Step 3 operator controls, database, archive, claim selection, site health, Step 3 browser hardening, Step 3 regression, Step 3 diagnostics, Step 3 navigation, and UI contract.

Command: `npm audit --omit=dev --json`

Result: PASS (exit 0). npm reported 0 production dependency vulnerabilities.

## Safety observations

- Runtime and customer data are ignored by Git, but the repository does not yet have an allowlist-based clean release materialization or a self-contained secret scanner.
- The existing backup includes operational/customer data in an unencrypted ZIP.
- Current eligibility uses actual delivery date rather than a normalized first-attempt event and counts weekdays without a versioned holiday calendar.
- Current claim selection snapshots CSV rows but does not cryptographically bind a current-policy revalidation result immediately before worker processing.
- No production service or private account action will be used for tests.

## Phase 1 checkpoint

- Replaced PHP Steps 1–2 with Node EST/REST XML implementations, hardened XML parsing and synthetic compatibility fixtures. PHP source and the PHP test prerequisite were removed.
- Added Electron Builder AppImage/NSIS targets, clean staging, packaged Chromium, source/package manifests, checksums, SBOM/licences, package audits and Linux/Windows CI.
- Added a loopback-only mock portal with login, validation, verification, duplicate, failure, redirect, selector, timing, ambiguous and crash scenarios.
- Migrated the embedded browser to sandboxed `WebContentsView`, enabled the main renderer sandbox, denied arbitrary renderer URL opens and added browser-profile/session status and clearing.
- Added scrypt/AES-256-GCM backups, malicious-archive limits, authenticated metadata, wrong-password/tamper tests, legacy migration warning and restore rollback.
- Added the first-run readiness wizard and expanded the queue with deadline/date/service/urgency search plus separate automatic/manual/ineligible views.

## Phase 2 checkpoint

- Extracted policy, normalization, queue, database, API/XML, release, backup, money, localization, crash, fault and update-security modules from the legacy workflow; added ESLint, Prettier, strict checked-JavaScript scope, coverage and a single package-version source.
- Added English/Canadian French catalogs and completeness tests, French support/release material, visible focus, reduced motion, modal focus trap, keyboard tabs and automated accessibility checks. Human assistive-technology/zoom/platform validation remains manual.
- Added append-only, currency-aware integer-cent financial entries and monthly/service/recovery reporting without invented values.
- Added fail-closed Ed25519 update-metadata verification, checksums, channel/downgrade protection and signing configuration without fake keys.
- Added local-only redacted crash reports with uploads disabled and privacy/threat/backup/support/incident/legal/lifecycle/pilot documentation.

## Final validation checkpoint

- `npm test`: passed all non-browser unit/integration/migration/security/UI contract programs.
- `npm run lint`: exit 0 with two documented complexity warnings in legacy renderer/worker orchestrators.
- `npm run format:check`: passed.
- `npm run typecheck`: passed.
- `npm run coverage`: passed at 92.55% statements/lines, 68.87% branches and 97.29% functions for the selected safety-critical module set.
- Mock portal, automated accessibility and Electron first-launch/sandbox tests passed before the user's request to stop opening the application. No further app launch will be performed; all remaining human UI testing is delegated in `MANUAL_RELEASE_GATES.md`.
- Secret scan, 125-file allowlist audit, production dependency audit, SBOM/licence generation, Linux package content audit (1,008 asar entries including the browser runtime), and AppImage SHA-256 verification passed.
- Full and production npm audits now report zero vulnerabilities after applying and testing the patched `brace-expansion` 5.0.8 build-tool override.
- `npm run release:safe` correctly refused the dirty worktree. This proves fail-closed behavior; a clean source archive must be produced after reviewed changes are committed.

## Guarded isolated-profile migration checkpoint — 2026-07-28

- Changed the package entry point to `bootstrap.js`, so the original Electron default profile is captured and the guarded override is validated/set before `app-storage`, database, configuration, log, browser or worker paths are computed.
- Added exact two-variable activation, canonical ownership/permission/default/home/repository/AppImage/ASAR/symlink validation and a centralized manifest for every application-owned mutable path.
- Added the persistent isolated-data banner/path/title plus main-process blocks for claims, claim browser/site health, updates, restore and external export/publishing actions. The normal profile is never imported or copied back in isolated mode.
- Added strict bootstrap/path tests and packaged first/second-startup smokes. Source, unpacked package and headlessly extracted final AppImage all migrated a copied synthetic v4 profile to schema 7, preserved its row, made exactly one verified backup, made the second startup a no-op, left a separate synthetic default profile byte-for-byte unchanged and failed closed for unsafe targets.
- Complete `npm test`, lint (four warnings, zero errors), formatting, typecheck, 92.89/70.05/97.29 coverage, accessibility, loopback mock portal, secret scan, 164-file release audit, zero-vulnerability production/full dependency audits, 509-package SBOM, Linux build, 1,035-entry/six-worker package audit and legacy/advanced packaged database smokes passed.
- Final AppImage: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,168,744 bytes, SHA-256 `399c4cba3d7ef6a47494c8d2460881133d75f6632024c91ae6eeb02846d67a8f`.

## Remaining actions

Only external/manual gates remain: reviewed commits/clean source archive, production signing and publishing credentials, physical Windows/Linux clean-install and accessibility testing, authorized Canada Post dry-run/account reconciliation/canary, legal/privacy approval, policy recheck and a real customer pilot. See `MANUAL_RELEASE_GATES.md`.

## Step 2 canonical parity checkpoint — 2026-07-28

- Traced the authorized diagnostic/bulk discrepancy exactly: event `1442`, first-attempt evidence, actual delivery, same-event state, status and service survived bulk parsing; the EST row lacked `Shipment Date`, while the former semantic-only diagnostic never built the policy input.
- Added canonical normalized-shipment and classification-input schemas, evidence-hash validation, one shared deterministic builder, boundary checks through staging/policy/database/queue/revalidation, raw-event staging rejection, invariant-stop behavior, and parser gate v4.
- Bound OAuth token caching/logging to the active environment and added configurable 45-second resource timeout handling with two bounded retries, cancellation, token reuse, concurrency one and transient circuit behavior.
- Passed targeted and complete tests, lint with four non-failing complexity warnings, format, typecheck, 93.80/72.59/97.61 coverage, accessibility, mock portal, secret/release/dependency/SBOM gates, Linux packaging, 1,036-entry/six-worker package audit, the full unpacked worker matrix, and four critical smokes from both the unpacked package and headlessly extracted AppImage.
- Final AppImage: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,176,904 bytes, SHA-256 `497f14d54ea1ff771bc39a142b20285e3a1119d68eada911d76156ae19835eb6`.
- The incomplete production Step 2 run remains unpromoted. Remaining supervised validation is one parser-v4 shipment diagnostic followed, only on success, by a fresh five-row bulk Step 2 test. No claims are to be submitted during either gate.

## Packaged Step 1 ENOTDIR correction — 2026-07-26

- Root cause: `lib/app-storage.js` defines `ROOT` from `__dirname`; in a packaged build that resolves to `resources/app.asar`. The former `spawnJsonProcess` used `cwd: ROOT`, so Linux attempted to use the ASAR archive file as a directory and emitted `spawn ENOTDIR`.
- The former Step 1 launch resolved to Electron's packaged `process.execPath`, `resources/app.asar/scripts/import-est-history.js`, and `cwd=resources/app.asar`. The executable was valid; the working directory was not, and workers also lacked a guaranteed real filesystem location.
- Added `lib/runtime-workers.js` as the sole named Node-worker resolver/launcher. Development workers resolve from the source app path; Linux/Windows packaged workers resolve from `process.resourcesPath/app.asar.unpacked`; all use Electron's executable with `ELECTRON_RUN_AS_NODE=1` and a validated private `USER_DATA_ROOT/worker-runtime` directory.
- Step 1, alternate shipping-history Step 1, Step 2 tracking, site health and submission use the same resolver. Missing executable/resource/cwd failures are actionable and occur before spawn. Step 1 waits for the child `spawn` event before its IPC call succeeds or its “started” event/log is emitted; spawn error immediately clears active state.
- Electron Builder now narrowly unpacks the five workers, worker libraries/configuration, CA bundle, WSDL, Playwright packages, secure XML parser and bundled Chromium without disabling ASAR.
- `tests/runtime-workers-test.js` covers development, packaged Linux, packaged Windows, ASAR/AppImage cwd rejection, directory validation, missing workers, spawn-state cleanup, start reporting and shared Step 1/Step 2 routing.
- `scripts/smoke-packaged-est-worker.js` launched the packaged Electron executable in Node mode against a loopback-only synthetic EST service, imported one synthetic shipment to a temporary directory, exited 0 and confirmed `ENOTDIR=false`. No GUI or live Canada Post endpoint was used.
- Final headless validation for this correction: `npm test`, lint (two pre-existing complexity warnings only), format, typecheck, coverage, mock portal, accessibility, package build, package audit, secret scan, production dependency audit and SBOM generation all passed. The AppImage must still receive a human packaged Step 1 test on the target desktop; this session did not open it.

## Historical packaged corrections: EST empty outcome and legacy tracking HTTP 500 — 2026-07-26

- Compared the current Node workers line by line with `git show HEAD:scripts/import-est-history-cli.php`, `import-shipping-history-cli.php`, `get-tracking-cli.php` and `scripts/lib/eligibility.php`. No live request, GUI, account login, private-data read or claim action was performed.
- Step 1 root cause: the Node EST port only recognized selected XML element names. The legacy PHP code also accepted every numeric XML leaf for workgroups and every XML/text leaf for order IDs. Valid legacy responses such as `<list><string>…</string></list>` could therefore yield no Node workgroups/orders, fall back to the customer number as workgroup and produce a false-empty result. Separately, both the worker and UI treated the legacy no-orders exit code 2 as failure.
- Step 1 now parses the legacy XML/plain-text forms, validates exact calendar dates, probes `2026-07-01`–`2026-07-26` and the legacy compact `20260701`–`20260726` form, distinguishes login HTML/unknown download/parser/recognized-zero/server/date errors, and emits a structured `EMPTY` or `IMPORTED` result. `EMPTY` exits 0, displays “Completed — no EST orders found for the selected date range.” and leaves an existing `tracking.csv` unchanged.
- Structural-only EST export inspection found 9 files: XML and text only; sanitized names consisted of connection, workgroup, MOBO, order-list and chunk-export roles. Sizes ranged from 7 to 82,484 bytes. All XML files were well formed; the recognized block export parsed 252 rows. This does not prove whether the July 1–26, 2026 account range itself was empty because private file contents/date associations were intentionally not inspected. The observed Node result is not reliable evidence of a true empty range because the port was defective.
- Step 2 root cause: the initial Node port hand-built SOAP and combined HTTP Basic authentication with a WS-Security UsernameToken while making parallel summary/detail calls. That was not equivalent to the deleted PHP `SoapClient`/WSDL implementation and mixed request construction layers, producing systemic HTTP 500 responses.
- The application has Developer Program API username/password fields and no OAuth settings. Step 2 now uses the current official Tracking REST v2 contract: one `GET https://soa-gw.canadapost.ca/vis/track/pin/{encoded-pin}/detail`, Basic API-key authentication, `Accept: application/vnd.cpc.track-v2+xml`, `Accept-Language: en-CA`, and no body, Content-Type, SOAPAction, envelope or WS-Security. OAuth mode is rejected before a request.
- Safe error diagnostics retain only status, bounded content type, Canada Post application code, redacted message, safe request/correlation ID, endpoint family, protocol, category and a systemic fingerprint. Full tracking numbers, credentials, authorization and full bodies are excluded.
- Three identical systemic authentication/schema/rate-limit/server failures now open a circuit, stop further requests, surface an actionable global error and preserve queue state. Shipment-specific No PIN History/not-found outcomes do not open it. The one-request diagnostic requires an explicit confirmation token and never changes claim/classification state.
- Final validation passed: focused EST/tracking integration tests; complete `npm test`; lint (two existing warnings only); format; typecheck; coverage (92.55/68.87/97.29%); mock portal; 136-file source allowlist audit; secret scan; zero-vulnerability production audit; SBOM/licences; Linux packaging; package audit (1,016 ASAR entries/five external workers); and all four smokes from a headless extraction of the actual AppImage.
- Superseded 2026-07-26 artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,115,457 bytes, SHA-256 `44871c7ae8ffb3a3d168197ef34c1d8c4ceec281649cf14676c35b2981eca2ff`. The current rebuild is recorded in the 2026-07-28 checkpoint above.
