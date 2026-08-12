# Codex implementation report

## 2026-07-28 Step 1 EST parser-v4 correction

The authorized aggregate-only inspection confirmed 284 rows, with both target headers present but `Shipment Date` blank in 284/284 rows and `Service Code` blank in 284/284 rows. No shipment values or complete rows were printed or retained. This is a systematic parser/mapping failure, and the existing CSV is non-authoritative.

The exact defect was structural. Both the deleted PHP importer and its Node port parsed ManifestItems independently. Their headerless fallback knew zero-based positions 16 (`Bar Code Id`), 27 (`Postal Zip Code`), and 30 (`Imported Order ID`) only. The Node worker also merged every returned block whenever `filetypes=2`. Neither implementation joined the Manifest-level `Mailing Date`, and neither mapped ManifestItems `MATNR – Article Number`; the writer silently promoted blank columns.

`lib/est-import-schema.js` introduces the explicit `est-import-v4` mapping. In the documented EST 2.0 headerless export, Manifest `Order Id` is position 0 and `Mailing Date` position 8; ManifestItems `Order Id` is position 0, `MATNR – Article Number` position 2, PIN position 16, postal position 27, reference position 30, and trace event/description positions 31/32. Step 1 requests file types `1,2`, parses blocks separately, joins on Order Id, and normalizes documented article numbers through `est-article-services-2015-v1`. Explicit header aliases cover shipment/mailing dates, service/product codes, authoritative service descriptions, and XML mailing/shipment date plus service/product code fields.

Dates are parsed component-wise into `YYYY-MM-DD`, validate real calendar dates, retain the source calendar day without timezone conversion, and support ISO, compact `YYYYMMDD`, explicit year-first slash, legacy numeric, and bounded English month forms. Creation/order dates, trace inquiry events, expected delivery, import/file timestamps, identifiers, and tracking-number formats are never fallback evidence. Service descriptions are accepted only through the canonical alias table; missing service is explicitly unavailable for API fallback.

Every promoted row carries normalized values, sanitized source-field names, provenance, and the import schema version. The gate requires valid PIN/date, recognized-or-explicitly-unavailable service, and provenance. At least half missing/invalid dates causes `EST_EXPORT_SHIPMENT_DATE_SCHEMA_FAILURE` before directory, backup, temporary-file, or destination mutation. Minority incomplete rows produce `IMPORTED_INCOMPLETE`, an aggregate warning, and exclusion from the promoted CSV. Step 2 checks every CSV date before credentials/network initialization.

Canonical normalized-shipment/classification-input schemas are now v2 and retain Shipment Date validation/source/provenance. Diagnostics are field-specific: missing date `POLICY_INPUT_SHIPMENT_DATE_MISSING`; invalid date `POLICY_INPUT_SHIPMENT_DATE_INVALID`; true attempt loss `NORMALIZED_FIRST_ATTEMPT_LOST`; unresolved service `SERVICE_UNRESOLVED`; hash divergence `EVIDENCE_HASH_MISMATCH`. An unrelated missing date can no longer emit the first-attempt-loss message.

The current production CSV was not modified, copied, backfilled, or reused. It requires a fresh supervised Step 1 import before any Step 2 request.

Validation passed for targeted parser/quality/policy/parity tests, complete `npm test`, lint (zero errors/four complexity warnings), format, typecheck, 93.80/72.59/97.61 coverage, accessibility, secret/release scans, zero-vulnerability production/full dependency audits, 509-entry SBOM, Linux packaging, and the 1,037-entry/six-worker package audit. Both the unpacked package and a headless extraction of the actual AppImage passed populated EST, missing-date rejection, previous-CSV preservation, and parser-v4-to-policy-input loopback smokes. No GUI or production service was launched/contacted.

Final artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage` (387,185,094 bytes), SHA-256 `86c50659e25b54af7429020d55b7bde9d37aab95ac5bd2cc872c0321570146ee`.

## 2026-07-28 Step 2 canonical diagnostic/bulk parity correction

The precise divergence was not a parser loss. The authorized diagnostic normalized event `1442` as `SUCCESSFUL_DELIVERY`, with first-attempt and actual-delivery timestamps present from the same event. The bulk log for that shipment also contained both dates and status `Delivered`; its imported EST row lacked `Shipment Date`. `classifyEligibility` consequently returned the generic foundational `REQUIRED_ELIGIBILITY_EVIDENCE_MISSING` result. Because the former diagnostic stopped at semantic validation and never constructed the bulk policy input, the two modes were not testing the same boundary.

`lib/normalized-shipment.js` now owns `canonical-normalized-shipment-v2`, its evidence hash and validators, privacy-safe serialization, `canonical-classification-input-v2`, the sole deterministic classification-input builder, and the semantic/policy invariant. The same object flows through JSON parsing, semantic validation, diagnostic preview/structure output, bulk staging, policy, atomic SQLite promotion, canonical CSV evidence, queue reconstruction, snapshotting, and pre-submission revalidation. Eligibility-relevant codes/categories/provenance remain after descriptions, locations, references, and raw response data are removed. Staging rejects raw event objects and SQLite stores only canonical safe event evidence.

The parser gate is now `tracking-details-official-v4`; authorized event `1442` is a stable successful-delivery mapping. A semantic pass followed by foundational missing policy evidence emits the exact internal invariant failure, aborts immediately, preserves the prior queue/completed result, and cannot feed Step 3. Status output derives from explicit delivered, attempted-not-delivered, in-transit, no-evidence, and overdue states, so delivered shipments cannot be labelled not delivered.

OAuth tokens carry their actual environment identity. Clear events report that environment, switches invalidate the preceding cache, and tests prove no test/production reuse. Resource requests default to a configurable 45-second timeout and retry transport timeouts only twice with bounded 1/2-second exponential backoff plus 0–250 ms jitter. Cancellation interrupts request/backoff, token reuse continues unless authentication fails, exhausted retries become shipment transport errors, and repeated identical failures can open the existing systemic circuit. Concurrency remains exactly one and ordinary API/policy outcomes are not retried.

Complete local, static, security, dependency, package, and headlessly extracted AppImage validation passed as recorded in `QA_REPORT.md`. No GUI, production Canada Post request, raw operator shipment response, or claim submission was used. Rebuilt artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,176,904 bytes, SHA-256 `497f14d54ea1ff771bc39a142b20285e3a1119d68eada911d76156ae19835eb6`. The prior v3 diagnostic/partial run remains non-authoritative; the remaining supervised gates are a new one-shipment v4 diagnostic and, only after it passes, a fresh five-row bulk Step 2 test.

## 2026-07-28 guarded production-equivalent isolated profile

Bootstrap order changed from Electron loading `main.js`, which immediately imported `app-storage` and froze `USER_DATA_ROOT`, to Electron loading `bootstrap.js`: capture default `app.getPath('userData')`; validate the exact two-variable override; set isolated Electron user/session/cache/crash/log paths; then import either the headless synthetic probe or normal `main.js`. An override request through environment variables can no longer be applied after storage initialization.

`lib/user-data-bootstrap.js` enforces absolute existing directory, canonical `realpath`, current ownership where available, non-world-writable permissions, and exclusion of filesystem root, home, normal profile/children, repository overlap, root/escaping symlinks, ASAR paths, the AppImage executable/mount and packaged resources. Both variables are mandatory and the confirmation must equal `ISOLATED_MIGRATION_TEST`. `lib/mutable-paths.js` centralizes the application-owned mutable path inventory and checks each path's existing ancestor for symlink escape before startup modification.

The exact isolated inventory covers `database/app.sqlite` plus WAL/SHM; `database-backups` and `database/migration-backups`; `config.json`, `credentials.json`, `credential-key.bin`; the `data` root, tracking/claims/overdue/review CSVs, stop file, selected-claims/queue-snapshot prefixes, evidence and tracking-run staging; logs and Step 3 diagnostics; Chromium session data, persistent partition, profile and temporary profile prefix; worker runtime; cache/crash dumps; and `tmp/backup-restore`. Archive/encrypted-backup scratch files now accept the contained temporary directory.

When active, the renderer shows the exact permanent warning and canonical path and Electron uses a title suffix. Main-process IPC rejects live claim submission, claim browser actions, updates, restore, external backups/diagnostics/history exports and publishing-type actions. `app-storage` suppresses repository legacy-data copying in isolated mode, so the copied profile migrates normally but nothing is read from or written back to the default profile.

New coverage is in `tests/user-data-bootstrap-test.js` and `scripts/smoke-packaged-isolated-profile.js`; packaging now starts from `bootstrap.js` and audits the new bootstrap/path/probe modules. The final unpacked package and headlessly extracted AppImage each passed first migration, schema/row checks, second-startup no-op, one-backup-only, byte-identical synthetic default-profile and unsafe-path rejection smokes without opening the GUI.

Final artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage` (387,168,744 bytes), SHA-256 `399c4cba3d7ef6a47494c8d2460881133d75f6632024c91ae6eeb02846d67a8f`.

## 2026-07-28 packaged SQLite startup migration recovery

The exact crash was the former `lib/claim-database.js:304` statement `ALTER TABLE classification_records ADD COLUMN run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;`. The old order was: unconditional version-1 table declarations; version-5 classification creation only when `user_version < 5`; then version-7 `run_id` alteration whenever `user_version < 7`. A partially migrated or falsely advanced version-5/6 database therefore skipped creation but still reached the `ALTER`.

The new order is an explicit manifest in `lib/database-migrations.js`: core parents; legacy claim columns; shipment/tracking/classification objects (with `classification_records` before the retained legacy review table and worker revalidations); finance; classification run scope; all dependent indexes; immutable triggers; schema version promotion. Actual `sqlite_master`, `table_info`, and index definitions are checked regardless of `user_version`. Supported additive missing columns are repaired explicitly; incompatible identity/relationship definitions fail closed.

One `BEGIN IMMEDIATE` transaction contains every schema change, validation, and `PRAGMA user_version = 7`. Failure rolls back all DDL/data effects and retains the incoming version. Successful migration requires `PRAGMA integrity_check = ok` and zero `foreign_key_check` rows. Existing runtime databases are first copied with SQLite's backup API to a unique timestamped owner-only path and the copy's integrity is verified. Backup names are never overwritten. Corrupt input is not replaced and receives a size-checked path explicitly labeled `unverified` when a verified SQLite backup is impossible.

`main.js` now uses a top-level awaited `startApplication`. The workflow window is gated by `databaseReady` and cannot be created before migration succeeds. A failure writes a bounded metadata-only diagnostic through `lib/startup-database.js`, offers **Open data folder**, **Copy diagnostic**, and **Exit**, and calls `app.exit(1)` after the chosen action. The diagnostic excludes database rows and sensitive values.

Migration-specific files added: `lib/database-migrations.js`, `lib/startup-database.js`, `scripts/database-startup-probe.js`, `scripts/smoke-packaged-database-startup.js`, and `tests/database-migration-recovery-test.js`. Updated: `lib/claim-database.js`, `lib/runtime-workers.js`, `main.js`, `electron-builder.yml`, `scripts/audit-package.js`, `package.json`, `README.md`, `docs/DATABASE_MIGRATIONS.md`, and the requested status/release/QA/manual-gate reports.

Validation passed exactly as recorded in `QA_REPORT.md`: 12 migration states, full suite, syntax/lint/format/typecheck/coverage, accessibility, loopback mocks, secret/release scans, zero-vulnerability production/full audits, 509-entry SBOM, 1,030-entry/six-worker package audit, all existing package worker smokes, legacy/advanced database startup probes from both the unpacked package and headlessly extracted AppImage, and an extracted-AppImage controlled corrupt-database failure probe. No GUI or production endpoint was used.

Rebuilt artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,160,506 bytes, SHA-256 `75382a237987132862b1359931b68e6a4445355de29902e9377ce9cddf67aa83`. The remaining operator-copy rehearsal is documented under **Existing-database migration gate** in `MANUAL_RELEASE_GATES.md`.

## 2026-07-28 live Tracking JSON normalization and semantic run safety

The live mismatch was local, not OAuth transport: `scripts/get-tracking.js` treated any non-empty EST `Service Code` as authoritative before mapping the documented API `serviceName`. An unrecognized import value therefore masked a valid API value. Event normalization also lacked ordinary Tracking lifecycle categories, causing valid `significantEvents` collections to contribute unknown events and conservative review classifications.

Implemented contract paths are the official direct root, `$.serviceName`, `$.serviceName2`, `$.expectedDeliveryDate`, `$.changedExpectedDate`, and `$.significantEvents[*].{eventIdentifier,eventDate,eventTime,eventTimeZone,eventDescription,...}`. API service is resolved first, exact validated EST code second, and unknown last. The corrected first-attempt model selects the earliest qualifying attempt, including successful delivery, while retaining actual delivery separately and recording when both fields derive from the same event. Earlier failed attempts win; pickup, summary, estimated, arbitrary last-event, and undocumented delivery-to-post-office dates do not qualify. Official example code `1496` maps delivered and code `20` maps signature image; otherwise bounded English/French descriptions provide fallback categories.

The no-state-change diagnostic now records semantic criteria and parser `tracking-details-official-v4`, including safe first-event category/code, timestamp-presence flags, shared-event provenance, and confidence. A value-free structural export records paths/types/array lengths/safe enum codes and recognition errors only. Three matching parser-level failures in the initial HTTP-200 sample open the semantic circuit. All classifications stay in memory until full traversal; CSV promotion uses prepared files, owner-only preceding-output backups and rollback, SQLite uses one run-linked transaction, and Step 3 requires explicit proof of a complete promoted traversal. Discard restores available preceding output files and run-scoped current pointers without deleting immutable history.

The current worker is concurrency one with a 500 ms configurable default, 250 ms hard floor and 0–100 ms jitter. It honors `Retry-After`, uses 60 seconds without it on 429, bounds 502/503/504 retries to 1 and 2 seconds, supports cancellation during waits, and never retries shipment-specific results or restarts a bulk run.

Primary files added: `lib/tracking-service.js`, `lib/tracking-structure.js`, `lib/tracking-semantics.js`, `lib/tracking-rate-limiter.js`, `lib/tracking-run-staging.js`, `tests/tracking-live-normalization-test.js`, `tests/tracking-rate-limiter-test.js`, `tests/tracking-run-integrity-test.js`, and `tests/fixtures/tracking-details-live-shape.json`. Primary files updated: `lib/tracking-json.js`, `lib/tracking-normalizer.js`, `lib/tracking-client.js`, `lib/canadapost-errors.js`, `lib/tracking-diagnostic-gate.js`, `lib/claim-database.js`, `lib/app-storage.js`, `scripts/get-tracking.js`, `scripts/smoke-packaged-tracking-worker.js`, `main.js`, `preload.js`, `renderer.js`, `index.html`, tests, package scripts, and release/operator documentation.

## 2026-07-28 current Tracking API migration addendum

Step 2 now uses the current Canada Post Developer Portal architecture: a separate client-credentials token request followed by a Bearer-authenticated JSON `GET /pins/{pinNumber}/details`. Official source inspection found an important version distinction: the portal catalog generation is 2.0.0, but the downloadable Tracking OpenAPI contract is `info.version: 1.0.0` and `/tracking/v1`. The implementation and diagnostics use the official contract version and document both values.

Production token and tracking traffic is pinned to `api.canadapost-postescanada.ca`; test traffic is pinned to `api-stg.canadapost-postescanada.ca`. The exact token route is `/prod/devportal-portaildesdeveloppeurs/cpc-api-native-oauth-provider/oauth2/token`; the tracking base is `/prod/devportal-portaildesdeveloppeurs/tracking/v1`. Tokens use `grant_type=client_credentials`, `scope=merchant`, `X-IBM-Client-Id`, `X-IBM-Client-Secret`, form encoding and JSON. Resource requests use Bearer authorization and `Accept: application/json`, with no body, Basic, XML, SOAP or legacy fallback.

The current client ID/secret are distinct encrypted fields from website/EST and deprecated legacy Developer Program credentials. Tokens are never persisted. A worker caches them using a monotonic expiry, refreshes early, clears them on authentication failure/shutdown, and allows exactly one token refresh/resource retry after a 401. Credential or environment changes invalidate the one-shipment diagnostic gate; the API version is part of that gate.

Current JSON parsing validates required detail/event fields, rejects a mismatched response PIN, ignores unknown properties, and preserves expected/changed expected delivery, canonical service provenance, active/archive flags, delivery/attempt/notice/exception categories, and event time/timezone. Persisted evidence omits raw response fragments, locations, references, and free-form descriptions. Incomplete evidence remains `REVIEW_REQUIRED` and cannot enter Step 3. Safe diagnostics prioritize status semantics, so an HTML 504 is a gateway timeout, and preserve no response body or recoverable secret metadata.

Migration-specific files: `index.html`, `renderer.js`, `preload.js`, `main.js`, `package.json`, `package-lock.json`, `eslint.config.js`, `user.ini.example`; `lib/app-storage.js`, `lib/runtime-secrets.js`, `lib/preflight.js`, `lib/canadapost-api.js`, `lib/canadapost-errors.js`, `lib/tracking-client.js`, `lib/tracking-contract.js`, `lib/tracking-oauth.js`, `lib/tracking-json.js`, `lib/tracking-diagnostic-gate.js`, `lib/legacy-tracking-client.js`, `lib/tracking-normalizer.js`; `scripts/get-tracking.js`, `scripts/smoke-packaged-tracking-worker.js`; `tests/tracking-api-v2-test.js`, `tests/integration-failure-handling-test.js`, `tests/node-migration-test.js`, `tests/storage-test.js`, `tests/preflight-test.js`, `tests/ui-contract-test.js`, `tests/fixtures/tracking-api-1.0.0.contract.json`; and the requested documentation/status files.

Final validation: complete `npm test` passed; lint exited zero with two documented complexity warnings; formatting/typecheck passed; coverage passed at 92.61% lines/statements, 68.87% branches and 97.29% functions; accessibility/mock portal/secret scan/release audit passed; production and full npm audits reported zero vulnerabilities; SBOM covered 509 installed entries; Linux packaging and the 1,021-entry/five-worker audit passed. Packaged loopback smokes passed for high-volume Step 1 plus token success, token failure, Tracking JSON success, one-time 401 refresh, 504 circuit state preservation and one-request diagnostic state integrity.

Rebuilt artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,152,361 bytes, SHA-256 `f1d02690c98c16b44a41e8a463b8152916b11ca0ce9c4977f5f3890273fcdbdd`. The remaining authorized setup/diagnostic procedure is gate 9 in `MANUAL_RELEASE_GATES.md`.

## 1. Executive summary

Canada Post Claim Runner `0.4.0-dev.1` has been moved from a supervised development workflow to a substantially hardened **public-beta candidate** at repository level. Phase 0 safety gates, the feasible Phase 1 engineering work, and the feasible Phase 2 commercial-readiness foundations are implemented. The product is not a stable-release candidate: code signing, physical clean-install/accessibility validation, authorized Canada Post validation, legal approval and a real pilot remain external gates.

No real Canada Post account was accessed. No credential was tested against the live portal, no CAPTCHA was bypassed, no real claim was submitted, no customer data was used, and nothing was pushed or published.

## 2. Initial repository state

- Branch `v0.4.0-productization`, HEAD `2bfcc93`.
- The worktree was dirty before this mission. Fourteen tracked files had user modifications and several productization modules/tests were untracked.
- Ignored runtime paths contained local data/configuration, logs and browser state. Their contents were not copied into source, fixtures, diagnostics or artifacts.
- Baseline used Electron `BrowserView`, PHP for Steps 1–2, SQLite schema 4, plaintext ZIP backups, actual-delivery-oriented eligibility and Linux-only CI.
- Baseline `npm test` passed; production dependency audit reported zero vulnerabilities.

## 3. Files and systems changed

Major new or extracted systems include:

- policy/calendar/domain: `config/policy-rules.json`, `config/holiday-calendar.json`, `lib/policy-engine.js`, `lib/business-calendar.js`, `lib/claim-domain.js`;
- tracking/import: `lib/tracking-normalizer.js`, `lib/canadapost-api.js`, `lib/secure-xml.js`, parsers/CSV/output modules and three Node CLI scripts;
- packaged manual-test fixes: `lib/canadapost-errors.js` and `lib/tracking-client.js`; revised EST/tracking workers, main/renderer result handling, legacy EST fixtures, systemic-failure integration tests and four package-level worker smokes;
- submission safety: `lib/eligibility-revalidation.js`, reviewed queue hashes, worker revalidation, conservative `REVIEW_REQUIRED` exclusion and fault points;
- persistence: SQLite schema 6, immutable evidence/classifications, queue snapshots, audits, structured claim data and financial entries;
- release/package: explicit allowlist, redacting scanner, safe staging, artifact/content audits, manifests/checksums, CycloneDX/licences, Electron Builder and Linux/Windows CI;
- packaged workers: `lib/runtime-workers.js` provides the single validated Node-worker map, development/Linux/Windows resolution, real-directory preflight and Electron-as-Node spawning for EST history, shipping history, tracking and submission;
- browser/security: `WebContentsView`, explicit renderer sandbox, production/test origin policy, navigation/permission/download blocking and session reset controls;
- recovery/product: encrypted backups, first-run wizard, queue filters, separated eligibility queues, money reporting, localization, accessibility, local crash reports and signed-update verification;
- documentation: policy sources, threat model, migrations, privacy/retention, backup, support, incident, legal, lifecycle, signing, accessibility, French support/release, pilot and manual gates.

PHP CLI and eligibility files were removed after Node fixture/parity tests passed. PHP is no longer an end-user prerequisite.

## 4. Policy rules implemented

Official sources retrieved July 26, 2026 are registered in `docs/POLICY_SOURCES.md`. The engine:

- measures guarantee performance at the first delivery attempt and never substitutes actual delivery without evidence;
- keeps expected, first-attempt and actual-delivery dates distinct;
- uses explicit service/effective-date rules and a versioned 2024–2026 Canada Post holiday calendar;
- applies the official 2025 peak period to domestic covered services mailed November 3, 2025 through January 11, 2026, requiring at least two business days late;
- calculates the 30-business-day submission deadline and remaining verified business days;
- treats unknown service/events, missing attempt evidence, ambiguous regional holidays, policy/calendar gaps, conflicting events and possible exclusions/suspensions as `REVIEW_REQUIRED` or insufficient data;
- preserves raw/normalized evidence hashes and returns deterministic classifications, reason codes, source IDs and explanations.

## 5. Security changes

- Releases use an explicit allowlist and clean materialization; prohibited or unexpected content and likely secrets fail the build. Generated archives/packages are extracted and rescanned.
- Renderer and embedded browser are sandboxed with context isolation and no Node integration. Arbitrary renderer window opens, off-origin navigation, downloads and permissions are denied.
- Credentials travel to workers over protected stdin and are not stored in SQLite or returned to the renderer.
- New backups use scrypt plus AES-256-GCM authenticated encryption, random salt/nonce, authenticated metadata, checksums and archive resource/path limits.
- Submission attempts are persisted before processing; final action is never automatically repeated after uncertainty; terminal outcomes stay non-retryable; stale queues fail immediate revalidation.
- Crash reports are local-only, upload-disabled and redacted. Signed update metadata fails closed without a trusted Ed25519 public key and enforces channel, checksum and downgrade rules.
- `docs/THREAT_MODEL.md` records controls, residual risks and verification.

## 6. Database migrations

Schema 5 adds first-attempt fields, immutable normalized events/classifications, current pointers, the now-dormant legacy review table, audit events, claim details, queue snapshots/items and worker revalidations. Schema 6 adds append-only currency-aware financial entries using integer minor units. Schema 7 links classifications to the Step 2 run that promoted them so incomplete-run discard can restore preceding completed pointers without deleting immutable history. Migrations are forward-only, transactional and additive; integrity, representative upgrades, idempotency and historical preservation are tested. Restore preserves rollback copies and validates the candidate database before replacement.

## 7. Packaging changes

- Electron Builder creates unsigned Linux x64 AppImage, Windows x64 NSIS and unpacked builds.
- The pinned Playwright Chromium runtime is included under `app.asar.unpacked`; package audit fails if its executable is absent.
- The packaged Step 1 failure was caused by the former shared launch `{ executable: process.execPath, worker: app.getAppPath()/scripts/import-est-history.js, cwd: ROOT }`. Because `ROOT` derives from `lib/app-storage.js`'s packaged `__dirname`, both `app.getAppPath()` and `ROOT` resolve to `resources/app.asar`; the OS received the ASAR archive file as `cwd` and returned `ENOTDIR`.
- Original packaged values were: executable = the valid mounted Electron binary returned by `process.execPath`; worker = `<mount>/resources/app.asar/scripts/import-est-history.js`; cwd = `<mount>/resources/app.asar` (invalid because it is a file). `process.resourcesPath` was `<mount>/resources`; `$APPIMAGE` named the outer AppImage file but was not the selected cwd. Development used the repository Electron binary, `<repository>/scripts/import-est-history.js`, and the repository root cwd.
- The replacement keeps ASAR enabled. Named workers and their required `lib`, `config`, CA, WSDL, Playwright and XML-parser resources are narrowly unpacked to `process.resourcesPath/app.asar.unpacked`. Workers use `process.execPath` with `ELECTRON_RUN_AS_NODE=1`; `cwd` is the validated application-controlled `USER_DATA_ROOT/worker-runtime` directory. No worker executes inside ASAR, no AppImage file is treated as a directory, and no system Node installation is used.
- Step 1 and Step 2 share the same resolver. Missing executables, workers, packaged resources and invalid working directories fail preflight with actionable messages. Spawn errors clear active state, and Step 1 does not return success or emit/log “started” until the child emits `spawn`.
- CI covers Node 24 on Linux/Windows, tests, browser/mock/accessibility/Electron jobs, lint/format/type/coverage, secrets, dependency audit, SBOM, packages and package audits.
- Stable/beta channels and a code-signing-required Windows release configuration exist. No private key, fake certificate or claim of signing is present.
- The final local Linux beta AppImage was generated and its SHA-256 checksum verified. It remains unsigned and uses the default Electron icon.

### Step 1 EST zero-order correction

The deleted PHP implementation authenticated with HTTP Basic, called the EST Desktop `dop` and `ship/desktop` endpoint families, queried inclusive date path segments in ISO and compact forms, accepted numeric values from every XML leaf as potential workgroups, accepted XML leaf or line-oriented order IDs, and parsed the multi-file text export's ManifestItems section. The initial Node port used the same endpoints/media types but only selected named XML elements. A valid legacy `<list><string>…</string></list>` response could therefore produce no workgroups/orders, incorrectly fall back to the customer number as workgroup and report zero. The port also retained exit code 2 for no orders, which main/renderer treated as failure.

The correction validates real calendar dates, serializes July 1–26, 2026 exactly as `2026-07-01`–`2026-07-26` and then `20260701`–`20260726` for legacy compatibility, restores generic XML/plain-text parity, separates login HTML, unknown download, valid empty order list, recognized-zero-row export, parser failure, date error and service error, and emits a structured result. `EMPTY` exits 0 with the required completed message and never replaces `tracking.csv`; populated exports still use atomic replacement.

A privacy-preserving structural inspection of the existing EST export directory found nine XML/text files with sanitized connection, workgroup, MOBO, order-list and chunk-export roles. Sizes were 7–82,484 bytes. XML files were well formed; one recognized block export parsed 252 rows. Private contents and date associations were not opened. Therefore the observed July result cannot honestly be declared truly empty: the Node port was defective, and only an authorized human account rerun can resolve the account-specific result.

### Historical Step 2 systemic HTTP 500 correction (superseded by OAuth/JSON)

The deleted PHP worker used the supplied Tracking WSDL through PHP `SoapClient` and WS-Security UsernameToken, letting the WSDL serialize SOAP 1.1 operations. The initial Node port instead hand-built SOAP, applied HTTP Basic and WS-Security at once, and made parallel summary/detail requests. This was not protocol-equivalent and was the systemic request-construction defect behind the observed all-500 behavior.

The application settings already expose a Developer Program API username/password pair and no OAuth client/token configuration. The corrected worker therefore uses one official integration family: `GET https://soa-gw.canadapost.ca/vis/track/pin/{encoded-pin}/detail`, `Authorization: Basic base64(userid:password)`, `Accept: application/vnd.cpc.track-v2+xml`, `Accept-Language: en-CA`, with no body, Content-Type, SOAPAction, envelope or WS-Security. OAuth selection fails before a request. See `docs/INTEGRATION_PROTOCOLS.md` for official source metadata and the full protocol decision.

Safe failure data is limited to HTTP status, bounded content type, Canada Post application code, redacted message, request/correlation identifier, endpoint family, protocol, category and fingerprint. For example, the packaged systemic mock safely produced status `500`, media type `application/vnd.cpc.messages-v1+xml`, application code `SERVER_SCHEMA`, message `Request could not be processed.`, request ID `synthetic-request`, endpoint family `developer-program-tracking-v2`, protocol `REST`; credentials, authorization, full PIN and response body were absent.

The worker opens a circuit after three consecutive identical systemic authentication/schema/rate-limit/server failures, stops without the normal 3.1-second queue walk, preserves claims/review/overdue queue files and returns an actionable global error. No PIN History/not-found is shipment-specific and does not open the circuit. A deliberate one-row diagnostic requires `TRACKING_DIAGNOSTIC_MODE=1`, the confirmation token `ONE_REQUEST_NO_STATE_CHANGE`, and a selected row; it cannot update claims, classifications or the run summary.

## 8. Test coverage

The final non-interactive suite covers required Phase 0 policy boundaries, bilingual/ambiguous tracking events, deterministic evidence, schema migration/history, stale queues, Node EST/REST XML parity, queue/attempt/reconciliation safety, encrypted backup attacks, integer money, update signatures, crash redaction, localization key parity, mock portal scenarios, selected accessibility rules and package content.

Packaged-worker regression coverage additionally verifies development, packaged Linux and packaged Windows resolution; ASAR and AppImage cwd rejection; real-directory validation; missing-worker preflight; spawn-state cleanup; no false started state; common Step 1/Step 2 routing; Electron Builder unpack declarations; external package content; and an actual packaged Electron-as-Node Step 1 run against a loopback synthetic EST fixture.

Selected safety-critical module coverage passed at:

- statements/lines: 92.55%;
- branches: 68.87%;
- functions: 97.29%.

Before the user's instruction to stop opening the app, the Electron synthetic test passed first-run wizard, renderer sandbox, local mock `WebContentsView`, session clearing and database preservation. No further GUI/application launch was performed. The user will conduct human testing.

## 9. Commands run

Principal commands included:

```text
npm test
npm run lint
npm run format:check
npm run typecheck
npm run coverage
npm run test:mock-portal
npm run test:accessibility
npm run test:electron
npm run secret-scan
npm run release:audit
npm audit --omit=dev --audit-level=high
npm audit --json
npm run sbom
RELEASE_CHANNEL=beta npm run package:linux
npm run package:audit -- dist/packages/linux-unpacked
npm run test:packaged-step1
npm run release:finalize
sha256sum -c ../release-metadata/SHA256SUMS.txt
npm run test:packaged-step1-empty
npm run test:packaged-step2-success
npm run test:packaged-step2-circuit
AppImage --appimage-extract; run package audit and all four worker smokes against the extracted root
npm run release:safe
git diff --check
```

## 10. Exact test results

- `npm test`: PASS.
- `npm run lint`: PASS, exit 0; two complexity warnings remain (`renderer.js` event-description orchestration and the submit-worker `main`).
- `npm run format:check`: PASS.
- `npm run typecheck`: PASS.
- `npm run coverage`: PASS at 92.55/68.87/97.29 percent lines/branches/functions.
- `test:mock-portal`: PASS.
- `test:accessibility`: PASS for the configured automated rules.
- `test:electron`: PASS before the user halted further app opening; not rerun after that instruction.
- secret scan: PASS.
- source allowlist audit: PASS for the final 136 candidates; the new sanitized `.txt` legacy fixtures are allowed only in the test tree.
- production dependency audit: PASS, zero vulnerabilities.
- full development audit: PASS, zero vulnerabilities after the patched `brace-expansion` 5.0.8 override; production audit also reports zero.
- SBOM/licence inventory: PASS, 523 installed package entries.
- Linux AppImage generation: PASS.
- targeted Node migration/EST/tracking failure tests: PASS. Coverage includes populated/empty/login HTML/invalid date/unknown export/parser failure, legacy fixtures, exact REST Basic request, OAuth mismatch, SOAP and REST errors, 401/403/404/429/500/503 parsing, HTTP-200 application errors, systemic circuit behavior, ordinary not-found behavior, redaction, queue preservation and deliberate diagnostic mode.
- packaged Step 1 smokes: PASS for empty and populated synthetic exports; empty preserved the sentinel `tracking.csv`, both exited 0 and neither emitted `ENOTDIR`.
- packaged Step 2 smokes: PASS for success (one request, exit 0) and systemic 500 (exactly three requests, circuit open, queue preserved, exit 1 as designed).
- final AppImage extraction validation: PASS; the actual checksum-identified AppImage was extracted headlessly, audited and passed all four worker smokes. No GUI or production host was used.
- safe source archive: EXPECTED REFUSAL because the preserved worktree is dirty.

## 11. Package-content audit results

The final inspected Linux package contained 1,016 `app.asar` entries. The audit found no prohibited runtime/configuration path, no likely secret, no unexpected application root, confirmed the pinned Chromium executable, and verified all five worker modules plus `runtime-workers`, the API/error/parser/tracking clients, policy/configuration, CA and WSDL dependencies under `resources/app.asar.unpacked`. The actual AppImage extraction repeated the same audit and all four loopback worker smokes. The beta AppImage checksum matches the finalized `dist/release-metadata/SHA256SUMS.txt`. A clean committed source archive was intentionally not produced from the dirty tree.

Superseded 2026-07-26 artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,115,457 bytes, SHA-256 `44871c7ae8ffb3a3d168197ef34c1d8c4ceec281649cf14676c35b2981eca2ff`. See section 17 for the rebuilt 2026-07-28 artifact.

## 12. Known limitations

- Main/renderer and submit-worker orchestrators remain large; major domain/security responsibilities were extracted, but two complexity warnings document follow-up refactoring targets.
- Canadian French catalog infrastructure, primary navigation/readiness/financial terminology and French support/release documents exist, but legacy UI and dynamic messages require a complete human language review before calling localization complete.
- Automated Electron coverage does not yet drive the entire import → classification → queue → selected submission → crash/restore lifecycle inside one GUI process. Unit/integration/mock coverage exists; human end-to-end validation is required by user direction.
- Fault points and duplicate/reconciliation invariants are tested at module/worker-contract level; platform crash behavior still needs supervised packaged rehearsal.
- Linux AppImage uses the default Electron icon.
- Policy/calendar auto-classification coverage ends in 2026 and must be updated from official sources.
- No real portal selector/account compatibility result is claimed.
- The July 1–26, 2026 EST result is indeterminate until an authorized human reruns it; structural inspection proves legacy-format data exists but deliberately does not associate private exports with that date range.
- The corrected Tracking REST request is verified against official documentation and local mocks, but the owner must perform one deliberately selected production diagnostic request before allowing a full queue.
- The headless package smoke proves the external Step 1 process architecture and local EST parsing/output path, but the AppImage GUI button flow still requires the user's physical human test.
- Production and development dependency audits are clean after the tested build-tool override; dependency advisories must still be rechecked immediately before release.

## 13. External manual gates

The authoritative checklist is `MANUAL_RELEASE_GATES.md`: production signing/publishing, physical Windows/Linux install/upgrade/uninstall/restore, complete assistive-technology and French review, authorized EST date-range verification, one-request Tracking REST diagnostic, supervised Canada Post submission/account reconciliation, current policy/customer-contract verification, legal/privacy approval and a measured customer pilot.

## 14. Local commits created

None. The tree was dirty before the mission and core files contain intertwined user changes. Creating broad commits would have risked committing unrelated pre-existing work, so changes were left unstaged for review. No push or history rewrite occurred.

## 15. Final Git status

Branch remains `v0.4.0-productization` at original HEAD `2bfcc93`, with a dirty worktree. Final status inspection reported 101 modified/deleted/untracked paths, including pre-existing user changes and this mission's implementation. Ignored runtime/customer/browser/build-cache data remains untracked and uncommitted. Generated `dist/`, `coverage/` and dependency directories are ignored.

## 16. Verdict

**Public-beta candidate.** The repository has strong safety, policy, data, packaging and synthetic-test foundations. It is **not** a stable-release candidate until every manual gate is completed and the known localization, full-workflow E2E, platform, signing, legal/pilot and development-toolchain risks are resolved or formally accepted.

## 17. Superseded 2026-07-28 legacy Step 2 HTML/login checkpoint

### Exact live-log implementation

The final CSS override fixes `html`/`body` to the application viewport, makes `body` a two-row grid, and carries `height: 100%`, `min-height: 0`, `min-width: 0` and hidden outer overflow through `main.tabbed-main`, `.app-shell`, the active step panel, `.step-workspace` and `.step-log-card`. Each `.log` is the sole scrolling child with `overflow-y: auto`, `overflow-x: auto`, safe wrapping, `scrollbar-gutter: stable both-edges`, overscroll containment and size/layout/paint containment. Step 3 keeps its compact viewport-derived log height; narrow layouts scroll inside the tab rather than growing the document.

`renderer.js` keeps at most the latest 2,000 visible DOM lines. A 56-pixel bottom threshold controls auto-follow. When the operator scrolls upward, appended lines do not change the scroll position; an unread counter appears in **Jump to latest** and explicit activation returns to/follows the bottom. A renderer-wide final redaction guard prevents complete 10–35-character tracking-like identifiers from entering any of the three rendered logs.

Visible per-shipment Step 1 logging was removed. `scripts/import-est-history.js` now emits `est_imported_detail` only as a sanitized `detailLevel: shipment` disk event with a redacted PIN marker, while `est_import_progress` is visible at row 1, every 25 shipments and the final remainder. `est_complete` provides final order/import totals. Disk event retention remains complete and is independent of the 2,000-line DOM limit.

### Exact Step 2 credential mapping and request behavior

- Website / EST: public `webUsername` and separately encrypted `webPassword`; used by EST/Desktop and Step 3 website flows.
- Tracking API username: separately encrypted `apiUsername`, with legacy one-time `user.ini` `apiUsername` or `username` import only.
- Tracking API password: separately encrypted `apiPassword`, with legacy one-time `user.ini` `apiPassword` or `password` import only.
- Environment: public `apiEnvironment` (`production` or `development`) plus an environment association in the encrypted API credential record when a key pair is saved.

The website password is never copied to or resolved as the API password. Metadata contains only present/missing, trimmed length, source setting name, selected/stored environment and distinct-setting status. A known environment mismatch fails before a request. Production maps to `https://soa-gw.canadapost.ca/vis/track/pin/{encoded-pin}/detail`; development maps to `https://ct.soa-gw.canadapost.ca/vis/track/pin/{encoded-pin}/detail`. Both use GET, exact `application/vnd.cpc.track-v2+xml` Accept, Basic API-key authorization, `en-CA`, no body and no Content-Type/SOAPAction/SOAP/WS-Security fields.

Fetch uses `redirect: manual`. Every 301/302/303/307/308 fails systemically without following. Only original status, source hostname, destination hostname, destination pathname without query and an SSO/login marker survive. HTML categories are `login_sso`, `access_denied`, `gateway_waf`, `maintenance`, `generic_canada_post` and `unknown_html`; bounded title/form/action inspection is discarded with the body. Failure diagnostics also include safe status/content type/endpoint/environment/method/response host/auth scheme/XML application code/redacted message/request ID/page type fields.

Circuit-open runs emit `tracking_aborted`, not `tracking_complete`, and display **Stopped — systemic integration failure** with attempted, total, remaining, errors and queue-preserved fields. Claims/review/overdue files and deferred database classification writes remain unchanged. Main-process state is `blocked`, and a deliberate retry is required.

The Step 2 **Test API connection with one shipment** button accepts a selected authorized one-based CSV row, requires deliberate UI and main-process confirmation, makes exactly one request, emits only safe redacted diagnostics, changes no claim/eligibility/queue/normal-summary state and cannot fall through into the normal run.

### Files changed for this correction

`index.html`, `renderer.js`, `main.js`, `package.json`, `user.ini.example`, `lib/app-storage.js`, `lib/runtime-secrets.js`, `lib/preflight.js`, `lib/canadapost-api.js`, `lib/canadapost-errors.js`, `lib/tracking-client.js`, `scripts/import-est-history.js`, `scripts/get-tracking.js`, `scripts/smoke-packaged-est-worker.js`, `scripts/smoke-packaged-tracking-worker.js`, `tests/integration-failure-handling-test.js`, `tests/live-log-layout-test.js`, `tests/storage-test.js`, `tests/ui-contract-test.js`, `docs/INTEGRATION_PROTOCOLS.md`, `AUTONOMOUS_STATUS.json`, `AUTONOMOUS_PROGRESS.md`, `CODEX_IMPLEMENTATION_REPORT.md`, `QA_REPORT.md`, `RELEASE_NOTES.md` and `MANUAL_RELEASE_GATES.md`.

### Exact final validation

- Targeted tracking/UI/storage/preflight/layout tests: PASS.
- `npm test`: PASS.
- `npm run lint`: PASS (exit 0) with two non-failing complexity warnings in the existing large renderer and Step 3 worker orchestrators.
- `npm run format:check`, `npm run typecheck`, `git diff --check`: PASS.
- `npm run coverage`: PASS — 92.55% statements/lines, 68.87% branches, 97.29% functions.
- `npm run test:accessibility`, `npm run test:mock-portal`: PASS headlessly.
- `npm run secret-scan`, `npm run release:audit`: PASS; 137 source candidates audited.
- At that checkpoint the production audit was clean and the full development audit reported 16 packaging-only findings; the current migration resolved them with the tested override documented above.
- `RELEASE_CHANNEL=beta npm run package:linux`: PASS.
- Package audit: PASS for 1,016 ASAR entries and five external workers.
- Unpacked and actual headlessly extracted AppImage smokes: PASS for Step 1 high-volume (10,000 rows), Step 2 redirect, HTML login, one-request success and three-identical-failure circuit. The unpacked package additionally passed Step 1 empty/populated and Step 2 ordinary success. No GUI or production service was used.

Superseded artifact from that checkpoint: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,127,782 bytes, SHA-256 `ac7e49fa80b8d0b880b7051e200b8ad4c16f7253f661abf5ea9d205b314184fd`.

The remaining manual one-request procedure is in `MANUAL_RELEASE_GATES.md` gate 10. It requires an authorized operator to save the matching production Developer Program API key pair, select one owned shipment row, deliberately confirm the one-request action, review only redacted protocol diagnostics, verify state did not change, and refrain from the full run until the diagnostic succeeds or yields an understood shipment-specific not-found result.
