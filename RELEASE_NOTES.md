# Historical release notes

Entries below preserve earlier development checkpoints. They are not current operator or release instructions. See `BETA_OPERATING_GUIDE.md` for 0.4.0-beta.1.

## Dev 11 candidate queue and Claim History simplification — 2026-08-12

- Step 3 now returns and displays only currently actionable `LATE_CANDIDATE` records. Submitted, already-submitted, terminal, unresolved, reconciliation-required, tombstoned, and otherwise blocked records remain protected by every authoritative submission check but no longer clutter the queue.
- History is now one newest-first Claim History list with Refresh and CSV export. Uncertain or exhausted latest attempts show **Needs attention** and the existing authoritative reconciliation actions inline; ordinary rows do not.
- Search/status filters, manual shipment entry, the classification viewer, the dedicated Reconciliation Queue, and duplicate History browser-session controls were removed. Backup, restore, stored-data management, and support bundles now live only under **Settings → Advanced**.
- Database schema 8, historical records, immutable classifications/evidence, attempts, audit data, duplicate tombstones, and reconciliation state remain intact.

# Canada Post Claim Runner 0.4.0-dev.10

## Step 3 executable queue and idle-browser correction — 2026-07-31

- Separates late-delivery candidates from candidates that are currently executable in Step 3.
- Prevents submitted, duplicate, terminal, unresolved, and reconciliation-required records from being selected or included by Select all.
- Revalidates claim-attempt state transactionally before creating the immutable worker snapshot.
- Keeps unresolved attempts blocked until they are resolved through authoritative Claim History actions, without adding a retry bypass.
- Keeps the native browser hidden until an executable snapshot passes mandatory preflight and main-process validation.
- Replaces the misleading white idle browser and generic Browser ready state with explicit idle, preparing, opening, loaded, hidden, and failure states.
- Keeps schema version 8, duplicate protection, SQLite queue authority, evidence hashes, update guards, dry-run protection, and CAPTCHA handling unchanged.

- Hardens the synthetic mock portal so retained Windows sockets cannot block CI shutdown indefinitely.
- Adds bounded mock-portal cleanup, a retained-socket regression test, and explicit CI job/step timeouts.
- Adds the dev.10 branch to the workflow push trigger.
- Preinstalls the Electron 43 runtime before Electron E2E and packaging jobs instead of relying on the first-launch download.
- Separates pure mock-portal checks from the Electron visibility E2E so failures identify the correct layer.
- Disables the unnecessary Gitleaks SARIF artifact upload and limits required CI artifact retention to seven days.
- Runs the Linux Step 3 Electron visibility E2E under Xvfb.
- Adds phase-level diagnostics, bounded submission handshakes, a global watchdog, and forced Windows Electron cleanup to prevent opaque E2E hangs.
- Waits for the Windows native verification view to stabilize before asserting attachment, bounds, placeholder state and browser status.
- Preserves the original E2E failure across cleanup and retries Windows temporary-directory removal instead of masking assertions with `EPERM`.
- Keeps the browser status at “Waiting for manual action” while text verification or CAPTCHA input is pending, even when asynchronous native-view visibility callbacks arrive afterward.
- Clears the manual-action browser phase only when claim processing resumes, the run ends, or browser navigation fails.

This is `0.4.0-dev.10`, an unsigned development build. It is not a public release.

# Canada Post Claim Runner 0.4.0-dev.9

## Focused UI debloat — 2026-07-31

- Removes deprecated Developer Program credentials from normal Settings; Step 2 remains OAuth/JSON-only with no Basic/XML fallback.
- Replaces the permanent Step 2 diagnostic-row panel with a compact, localized one-shipment dialog opened only by the diagnostic actions.
- Removes Step 3 readiness, manual-review, on-time and canary panels. Mandatory preflight now runs automatically, and the live confirmation contains a default-on first-candidate option.
- Keeps Step 3 selection, SQLite queue authority, transactional snapshots, evidence hashes, duplicate protection and reconciliation safeguards unchanged.
- Removes Financial recovery from the visible renderer and preload mutation surface while retaining historical schema-8 records for compatibility.
- Moves localized privacy preview/deletion controls into a closed-by-default modal opened from one Advanced Settings button.
- Gives the candidate queue additional vertical space without redesigning the existing dark, square-cornered interface.

This is `0.4.0-dev.9`, an unsigned development build. It is not a public release. No schema version change was made.

# Canada Post Claim Runner 0.4.0-dev.2

## Historical History scrolling checkpoint — 2026-07-29

- Bounds each populated History record section between a useful 260 px minimum and a responsive `min(60vh, 640px)` maximum, with independent vertical and horizontal scrolling. Opaque theme-aware table headers remain sticky while records scroll; long values wrap without forcing application-level horizontal overflow.
- This layout checkpoint predates the Dev 11 single-list Claim History interface described above.
- Bumps package, application, installer, localized release, and validation metadata to `0.4.0-dev.2`. Step 1, Step 2, Step 3, Tracking pacing, and claim-classification behavior are unchanged.

This remains an unsigned build pending supervised review. No live Tracking request, claim portal, or claim submission is used for validation.

Rebuilt unsigned Linux beta AppImage: `dist/history-refinement-packages/Canada Post Claim Runner-0.4.0-dev.2-linux-x86_64-beta.AppImage`, 387,197,413 bytes, built 2026-07-29 16:15:46 -0400, SHA-256 `cb29725725cbeb5342ad636398f124e796f17d489f60e0f71461c02475af097b`. The verified pacing/layout and Step 2 parity AppImages remain byte-identical and were not overwritten.

## Step 2 pacing, complete live results, reconciled counters and spacious workflow pages — 2026-07-29

- Enforces one Tracking resource request at a time with a 3,100 ms minimum start-to-start interval and positive jitter. Generic 502/503/504 and timeout retries are bounded and paced; exact SLM Monitor rejection is distinct and pauses at least 60 seconds. OAuth tokens remain cached across shipments and retries.
- Shows one terminal Step 2 line for every shipment. Full Tracking PINs exist only in the transient operator UI; worker output, disk logs, crash/audit artifacts and diagnostics stay redacted. Text labels and theme status classes distinguish LATE, ON TIME, NOT DELIVERED, REVIEW, RETRY and ERROR without relying on color alone.
- Reconciles every checked row into exactly one primary category: late, on time, not delivered, delivered-but-unclassifiable or error. Detailed review remains supplementary. The verified 284-row outcome therefore derives 31 not delivered from 30 reviews without successful-delivery evidence plus one overdue/in-transit shipment.
- Replaces cramped Step 3 containment with full-width vertically arranged queue, readiness, progress, 650–850 px embedded browser and 320–440 px live log sections. Step 3 and History now use normal page-level vertical scrolling with internal queue/log/table scrolling where appropriate; native browser bounds follow the visible slot intersection on scroll and resize.
- Keeps the successful-delivery-versus-original-standard 19-candidate semantics unchanged. This remains an unsigned supervised-review build; live claim submission remains pending supervised review.

Rebuilt unsigned Linux beta AppImage: `dist/pacing-layout-packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,197,396 bytes, built 2026-07-29 15:09:54 -0400, SHA-256 `f9885e47f306986cbd3633c08a33b97a92b363c8705258f812064578ed962609`. The two prior verified AppImages were not overwritten.

## Simplified late-candidate model — 2026-07-29

- Replaces predicted Canada Post claim eligibility with four operational outcomes: `LATE_CANDIDATE`, `ON_TIME`, `REVIEW_REQUIRED`, and `TRACKING_ERROR`.
- Compares successful delivery with the original Tracking API `expectedDeliveryDate` Delivery Standard. The later `changedExpectedDate` is retained as revised evidence but cannot suppress a delivery that was late against the original standard.
- Retains first-attempt date, timestamp, identifier, description, normalization rule, confidence, and provenance as evidence without using first attempt to disqualify a delivered-late shipment.
- The read-only 284-row parity audit derives 19 corrected candidates: 5 already selected, 8 previously suppressed by later-revised-date precedence, and 6 previously suppressed by first-attempt precedence. The audit found no service/window suppressions, missed recognizable delivery event, duplicate input, or accumulated active claim rows.
- Makes EST Shipment Date and Service Code optional enrichment. Step 1 retains every valid Tracking PIN and reports aggregate optional-metadata warnings; Step 2 no longer fails before the network when Shipment Date is blank.
- Uses Tracking API service first, EST service second, and unknown otherwise. Unknown service, policy coverage, exclusions, claim windows, holiday rules, and incomplete claim-form fields no longer block late-candidate detection.
- Generates the three Step 2 CSVs fresh after a complete traversal and deduplicates input by normalized Tracking PIN before lookup/promotion.
- Allows only `LATE_CANDIDATE` records into Step 3 and requires a complete, atomically promoted full Step 2 traversal. Stopped, failed, partial, review-required, and tracking-error states remain blocked.
- Records Canada Post approval/success, duplicate, rejection/ineligibility, and submission error separately. A rejection stores the returned reason, preserves evidence, continues the run, and is not counted as an application crash.

The source-level and retained-data findings are documented in `STEP2_ORIGINAL_PARITY_AUDIT.md` and `STEP2_CLASSIFICATION_PARITY_REPORT.md`. No production Tracking request or claim-portal action was used for this correction.

Rebuilt unsigned Linux beta AppImage: `dist/step2-parity-packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,193,263 bytes, SHA-256 `f3dc809a32e341e3e283232ad213e787e749b6482f6c34188ae637d194687888`. This remains a supervised-review build and is not marked production-ready.

This model supersedes the policy-reproduction requirements described in older checkpoint notes below.

## Public-beta hardening candidate

### Step 1 EST parser-v4 and completion-quality gate — 2026-07-28

- Corrects the systematic EST import defect confirmed by aggregate-only inspection: all 284 rows had present-but-blank `Shipment Date` and `Service Code` columns.
- Requests Manifest plus ManifestItems and joins Manifest `Mailing Date` (zero-based position 8) by `Order Id` (position 0). ManifestItems service evidence comes from `MATNR – Article Number` (position 2), normalized through `est-article-services-2015-v1`; PIN/postal/reference remain positions 16/27/30.
- Adds one explicit `est-import-v4` mapping for documented headerless, headered/legacy CSV, and shipment XML variants. Trace-event, creation/order, import/file, expected-delivery, and identifier-derived dates are prohibited.
- Persists normalized values plus sanitized source-field names, provenance, and schema version. Missing service is explicitly unavailable and may use the Tracking API fallback; missing Shipment Date cannot enter policy classification.
- Adds a fail-before-write quality gate. Half or more missing/invalid dates reject the entire import and preserve the preceding CSV without creating backup/temp output. Smaller incomplete subsets are reported and excluded.
- Uses exact diagnostics: `POLICY_INPUT_SHIPMENT_DATE_MISSING`, `POLICY_INPUT_SHIPMENT_DATE_INVALID`, `NORMALIZED_FIRST_ATTEMPT_LOST`, `SERVICE_UNRESOLVED`, and `EVIDENCE_HASH_MISMATCH`. Step 2 checks CSV dates before credentials or network setup.
- The existing 284-row CSV is invalid and must not be patched, backfilled, or reused. A fresh supervised Step 1 import is required.

Rebuilt unsigned Linux beta AppImage: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,185,094 bytes, SHA-256 `86c50659e25b54af7429020d55b7bde9d37aab95ac5bd2cc872c0321570146ee`.

### Step 2 canonical diagnostic/bulk parity and transport correction — 2026-07-28

- Introduces `canonical-normalized-shipment-v2` and one deterministic `canonical-classification-input-v2` builder for diagnostics, sanitized structure reports, normal bulk Step 2, policy evaluation, persistence, queue reconstruction, and pre-submission revalidation.
- Fixes the observed divergence: event `1442`, successful-delivery first-attempt evidence, actual delivery, same-event provenance, and Tracking API service provenance now survive every serialization/staging boundary. A missing EST shipment date is reported as that distinct foundational input problem instead of being mistaken for lost attempt evidence.
- Stops and preserves the queue when a semantic pass is followed by a missing-evidence policy result, using the explicit internal-classification invariant message. Partial runs never promote or authorize Step 3.
- Binds OAuth cache identity and clear logs to the active test/production environment; environment switches invalidate the correct cache and cannot reuse a token across environments.
- Adds a configurable 45-second Tracking resource timeout with at most two retries, bounded backoff/jitter, cancellation support, concurrency one, token reuse unless authentication fails, exhausted transport errors, and transient circuit behavior.
- Adds packaged loopback smokes for diagnostic/bulk input parity, event `1442`, timeout retry, and invariant-failure isolation.

Superseded Step 2 checkpoint artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,176,904 bytes, SHA-256 `497f14d54ea1ff771bc39a142b20285e3a1119d68eada911d76156ae19835eb6`.

### Step 2 earliest delivery-attempt correction — 2026-07-28

- Treats successful delivery as a qualifying delivery attempt. When it is the first qualifying event, first-attempt and actual-delivery timestamps remain separate fields and carry an explicit same-event provenance flag.
- Selects the earliest chronological qualifying event across failed attempts, notice cards, recipient-unavailable scans, address-related attempted deliveries, and successful delivery. Multiple attempts no longer create a false conflict.
- Prefers documented stable event identifiers, including authorized semantic confirmation of successful-delivery code `1442`; uses bounded English/French descriptions only as fallback and does not infer meanings for other safe identifiers merely seen in the structure report.
- Excludes parcel pickup, expected/final summary dates, arbitrary last events, and undocumented delivery-to-post-office scans from first-attempt evidence.
- Adds safe semantic diagnostics for first event code/category, timestamp presence, shared-event provenance and confidence; parser gate v4 invalidates the previous semantic gate result.
- Replaces contradictory delivered/not-delivered text with explicit delivered, attempted-not-delivered, in-transit, no-delivery-evidence and overdue states.
- Requires a complete, promoted, non-diagnostic full-traversal proof before Step 2 becomes authoritative for Step 3.

Rebuilt unsigned Linux beta AppImage: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,172,824 bytes, SHA-256 `3ea7596e507499c4bd520a07b131ffb885997bb758c360885a8dbbe6c495568f`.

### Guarded isolated application-data migration rehearsal — 2026-07-28

- Replaces the import-time-only storage decision with a packaged `bootstrap.js` entry point that captures the normal Electron `userData` path, validates the two-variable isolated migration guard, calls `app.setPath` for user/session/cache/crash/log paths, and only then imports normal application startup.
- Rejects relative, missing, file, root, home, default-profile, repository-overlap, symlink-escape, wrong-owner, world-writable, ASAR, AppImage executable/mount and packaged-resources targets. A centralized manifest checks the database/WAL/SHM, backups, configuration/secrets, CSVs, logs/diagnostics/evidence, Chromium state, workers, run staging, queue files, cache/crash files, and backup/restore temporary paths.
- Isolated mode displays a persistent warning banner with canonical path and a `[ISOLATED TEST DATA]` title suffix. Live claim/browser, update, restore and external publish/export actions are blocked in the main process.
- Isolated profiles use the normal transactional schema-7 migrator. Synthetic and packaged headless tests verify one pre-migration backup, row preservation, a second-startup no-op with no second backup, a byte-identical independent default-profile sentinel, and fail-closed path rejection without opening the GUI.

Rebuilt unsigned Linux beta AppImage: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,168,744 bytes, SHA-256 `399c4cba3d7ef6a47494c8d2460881133d75f6632024c91ae6eeb02846d67a8f`.

### Packaged SQLite startup recovery — 2026-07-28

- Fixes the AppImage startup failure where schema version 5/6 could skip `classification_records` creation and then execute `ALTER TABLE classification_records ADD COLUMN run_id ...` against a missing table.
- Reconciles actual SQLite tables/columns/indexes/triggers in dependency order instead of treating `PRAGMA user_version` as proof of completion.
- Applies every repair and version promotion in one immediate transaction, rolls back completely on failure, and requires integrity and foreign-key checks before commit.
- Creates and verifies a unique timestamped pre-migration backup before changing an existing runtime database. No backup is overwritten; corrupt input is preserved with a clearly unverified recovery copy.
- Awaits database readiness before creating the workflow window. Failure produces a sanitized local diagnostic and recovery dialog with data-folder/copy/exit actions, then exits cleanly.
- Adds 12 synthetic database states plus packaged Electron-as-Node startup probes for legacy and falsely advanced databases under strict unhandled-rejection mode.

Superseded SQLite-only checkpoint AppImage: 387,160,506 bytes, SHA-256 `75382a237987132862b1359931b68e6a4445355de29902e9377ce9cddf67aa83`.

### Live Tracking JSON normalization, semantic isolation and adaptive limiting — 2026-07-28

- Corrects the live service mismatch: documented `serviceName`/`serviceName2` now resolve first; a Step 1 `Service Code` is used only as a validated versioned-table fallback, with `tracking_api`, `est_import`, or `unknown` provenance.
- Normalizes the official direct-object `significantEvents` collection, original/revised expected dates, routine transit lifecycle events, notice-card/recipient-unavailable attempts, and separate actual delivery. Official example codes take precedence; English/French descriptions are bounded fallback evidence.
- Strengthens the one-shipment gate from HTTP-200 JSON to semantic usability and includes parser version invalidation.
- Adds **Export sanitized response structure**, which makes exactly one authorized lookup and stores no response body or private values.
- Adds a three-response semantic circuit and exact parser-failure stop message.
- Stages Step 2 results and promotes only after full success; incomplete runs cannot feed Step 3 and can be discarded while completed history remains.
- Replaces the legacy 3.1-second delay with concurrency-one adaptive limiting: 500 ms default, 250 ms floor, 0–100 ms jitter, exact `Retry-After`, 60-second no-header throttle pause, and bounded 502/503/504 backoff.
- Reduces normal visible protocol noise to one token-acquired entry, ten-row progress, sampled review totals, exceptional outcomes and final totals. Full sanitized protocol detail remains in the disk log.

### Current Canada Post Developer Portal Tracking migration — 2026-07-28

- Replaces the public-beta legacy Basic/XML Tracking request with OAuth 2.0 client credentials, Bearer authorization, REST and JSON.
- Pins the official production gateway `api.canadapost-postescanada.ca`, test gateway `api-stg.canadapost-postescanada.ca`, token route, `/tracking/v1` base, `GET /pins/{pinNumber}/details`, `merchant` scope and exact IBM client headers.
- Documents the official version distinction: portal catalog generation 2.0.0; Tracking OpenAPI operation contract 1.0.0.
- Adds separate encrypted current client ID/API Key and client secret/API Secret fields plus test/production selection. Website/EST and deprecated legacy credentials are never copied, removed or used by current Step 2.
- Keeps OAuth tokens in memory only, refreshes before expiry, invalidates on failures/shutdown, and retries a resource request only once after 401.
- Validates current JSON detail/error schemas and maps expected delivery, service/archive state and full event timing/location evidence into the conservative normalized model. Unknown fields are tolerated; missing evidence remains `REVIEW_REQUIRED` and is excluded from Step 3.
- Isolates and disables the deprecated Basic/XML client with no automatic fallback.
- Requires the one-shipment no-state-change diagnostic to succeed for the current credential revision, environment and API version before normal Step 2 is enabled.
- Prioritizes status semantics: HTML-bodied 502/503/504 responses are transient gateway/service failures, and 504 reports **Canada Post API gateway timed out (HTTP 504)**.
- Adds packaged loopback smokes for token success/failure, JSON Tracking success, one-time 401 refresh, 504 circuit preservation and one-request diagnostic state integrity.
- Resolves the development build-tool audit advisory with a tested `brace-expansion` 5.0.8 override; production and full npm audits now report zero vulnerabilities.

Rebuilt unsigned Linux beta AppImage: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,152,361 bytes, SHA-256 `f1d02690c98c16b44a41e8a463b8152916b11ca0ce9c4977f5f3890273fcdbdd`.

### Superseded legacy Step 2 protocol checkpoint — 2026-07-28

- Constrains the application shell to the available viewport and makes the Step 1, Step 2 and Step 3 logs independent `overflow-y: auto` regions with safe horizontal overflow/wrapping, stable scrollbar gutters and complete `min-height: 0` / `min-width: 0` containment.
- Bounds rendered log retention to the latest 2,000 entries. Auto-follow continues only while the operator is near the bottom; scrolling up shows an unread-count **Jump to latest** control.
- Replaces visible per-shipment Step 1 messages with aggregate progress at row 1, every 25 shipments and the final remainder. Final totals remain visible; sanitized redacted shipment-detail events remain in the complete disk log.
- Separates Canada Post website/EST credentials from Developer Program API username/password fields and adds explicit production/development environment selection plus non-secret credential metadata.
- Uses the documented REST v2 production/development endpoints and exact GET/Accept/Basic/Accept-Language/no-body request contract. Redirects are manually captured and never followed.
- Adds safe classifications for login/SSO, access denied, gateway/WAF, maintenance, generic Canada Post website and unknown HTML responses, plus actionable 401/403/429/500/503 and XML application diagnostics.
- Circuit-open Step 2 runs now report **Stopped — systemic integration failure** with attempted/total/remaining/error/queue-preserved counts; they never emit or display normal completion and do not alter claims, review queues or deferred classification state.
- Adds the deliberately confirmed **Test API connection with one shipment** action. It makes exactly one lookup for the selected authorized CSV row and never changes claim, eligibility or queue state or continues into the full run.
- Adds a 10,000-line laptop/high-resolution layout regression and packaged synthetic high-volume, redirect, login-HTML, one-request and circuit-breaker smokes.

- Corrects Step 1 legacy EST response parsing for generic XML-leaf workgroups/order IDs and plain-text order lists. A successful empty range is now a completed structured result, displays “Completed — no EST orders found for the selected date range.” and never replaces the prior `tracking.csv`.
- Corrects Step 2 to use Canada Post Developer Program Tracking REST v2 with the existing API-key Basic credentials instead of mixed hand-built SOAP/WS-Security request construction.
- Adds redacted Canada Post REST/SOAP fault diagnostics, endpoint/credential-mode validation, a three-identical-systemic-failure circuit breaker, queue preservation, and an explicitly confirmed one-request no-state-change diagnostic.
- Adds sanitized legacy EST parity fixtures and actual-AppImage headless smokes for empty/populated Step 1 plus success/systemic-500 Step 2.
- Fixes packaged AppImage Step 1 `spawn ENOTDIR`: Node workers now use one validated runtime resolver, Electron's packaged executable in Node mode, a real private working directory, and external ASAR-unpacked worker resources. Step 1 reports “started” only after a successful OS spawn.
- Adds Linux/Windows worker-path regressions, package-content enforcement, and a loopback-only packaged EST smoke test that imports synthetic data without launching the GUI or contacting Canada Post.
- Replaces actual-delivery shortcuts with a versioned first-attempt policy engine, explicit holiday/peak/service data, deterministic evidence and conservative `REVIEW_REQUIRED` classification.
- Persists immutable classifications/tracking events, claim details, queue hashes and immediate worker revalidation in SQLite schema 6.
- Replaces PHP Steps 1–2 with Node EST/REST XML implementations and synthetic parity fixtures.
- Adds clean allowlisted releases, redacting secret scans, manifests/checksums, SBOM/licences, AppImage/NSIS builds and Linux/Windows CI.
- Adds a deterministic local mock portal and fault points without contacting or imitating bypass of Canada Post protections.
- Migrates `BrowserView` to sandboxed `WebContentsView`, sandboxes the main renderer, blocks arbitrary navigation/permissions/downloads, and adds session-clearing controls.
- Adds scrypt/AES-256-GCM backups with authenticated metadata and malicious-archive limits, a first-run readiness wizard, richer queue deadlines, Canadian French resources and accessibility checks.
- Adds append-only integer-cent recovery reporting, local-only redacted crash reports, signed update metadata/channel/downgrade verification and commercial-readiness documentation.

This remains an unsigned development build and is a public-beta candidate only. No real Canada Post login, claim, canary, customer pilot or physical clean-install test was performed. See `MANUAL_RELEASE_GATES.md`.

## Operator-control foundation

- Adds a Step 3 readiness preflight.
- Adds a reviewable claim queue with per-claim inclusion controls.
- Snapshots the exact selected queue into a private run-specific CSV before starting the browser worker.
- Requires explicit acknowledgement before a live submission run.
- Adds canary mode to process only the first selected claim.
- Makes the built-in Electron browser mandatory for Step 3.
- Adds shared renderer-to-main input validation and strict bounds for run options.
- Adds regression tests for queue selection, preflight, confirmation, and browser-mode enforcement.

This is a development build and should not be tagged as stable until supervised dry-run and live-canary validation are complete.

# Canada Post Claim Runner 0.3.6

## Step 3 diagnostic-driven refinement

- Removes two expected negative field probes from every claim.
- Waits for the actual next-page marker before capturing diagnostics or filling fields.
- Prefers stable Canada Post control IDs before accessibility-label fallbacks.
- Produces useful non-empty reference and sender/contact page snapshots.
- Separates known Canada Post/Electron page defects from application automation errors.
- Adds `automationErrorCount` and `siteIssueCount` to Step 3 summaries.
- Treats expected optional-field misses as debug information instead of warnings.
- Keeps all v0.3.5 navigation, dry-run, duplicate-prevention, and browser hardening protections.

## Validation

- Full test suite passed.
- New regression coverage verifies deterministic setup transitions and diagnostic issue classification.
- Live submission was not performed in the isolated build environment.

# Canada Post Claim Runner 0.3.5

## Step 3 launcher navigation stability

- Uses the canonical Canada Post late-package support route first, with UI navigation fallback.
- Treats the late-package article as a terminal launcher page and only searches for Open a ticket there.
- Waits for actual forward navigation before activating another control.
- Prevents support/late breadcrumb loops.
- Classifies launcher failures with dedicated navigation codes instead of CAPTCHA_PENDING.
- Forces the Step 3 child process to exit after its final JSON event so the UI cannot remain stuck in running state.
- Downgrades aborted advertising/analytics requests to diagnostic debug noise.
