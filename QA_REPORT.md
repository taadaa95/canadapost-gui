# v0.4.0-dev.2 QA report

## History refinement — 2026-07-29

History claim-attempt, reconciliation and Step 2 classification record boxes now use a 260 px CSS minimum and responsive `min(60vh, 640px)` maximum when populated, with independent vertical/horizontal scrolling, comfortable wrapping and opaque sticky table headers. Compact empty/loading/error states use a 180–220 px range. The page remains vertically scrollable and has no application-level horizontal overflow.

The new non-destructive Clear filters action resets search, status, and transient page/offset to the default first-page state, refreshes immediately, and disables itself at defaults. UI tests prove that no mutation IPC path is called, 500 synthetic records remain present, and an evidence sentinel remains byte-identical. Database tests prove pagination reads do not mutate records. The purely visual History-tab reconciliation badge and both renderer update paths were removed; the reconciliation data, dashboard, in-page count, refresh behavior and separate Results notification badge remain intact.

Zero, one, 19, 50 and 500-record fixtures, missing values, long identifiers/statuses/messages, sticky scroll behavior and tab alignment passed at 980×680, 1280×720, 1600×1000, 2560×1440 and maximized Electron viewports. The approved spacious Step 3 layout and native mock-browser bounds also passed unchanged. Complete `npm test`, formatting, typecheck, lint (zero errors; four pre-existing non-failing complexity warnings), 96.06% line/statement coverage, 73.05% branch coverage, 93.18% function coverage, accessibility, localization, mock portal, Electron E2E, 178-file release audit, secret scan, full/production npm audits (zero vulnerabilities), and the 509-entry SBOM passed.

The final package audit passed 1,037 ASAR entries and six external workers. All packaged Step 1, Step 2, database and isolated-profile smokes passed. Unpacked and headlessly extracted AppImage Electron E2E passed using only the local mock portal. No live Tracking request, live claim portal, or claim submission was used.

Final separately staged unsigned AppImage: `dist/history-refinement-packages/Canada Post Claim Runner-0.4.0-dev.2-linux-x86_64-beta.AppImage`, 387,197,413 bytes, built 2026-07-29 16:15:46 -0400, SHA-256 `cb29725725cbeb5342ad636398f124e796f17d489f60e0f71461c02475af097b`. Both prior verified `.1` AppImages remain byte-identical. The application remains pending supervised review.

## Step 2 operational pacing, live-log/counter reconciliation and spacious Step 3/History — 2026-07-29

Step 2 now enforces one in-flight Tracking request and a 3,100 ms minimum start-to-start interval with 0–100 ms positive jitter. This cannot exceed 20 starts in a rolling minute, and positive jitter normally reduces it further. Generic HTTP 502/503/504 and transport timeouts use at most two bounded exponential retries with 0–250 ms jitter while still obeying the start floor. Exact `Server / Rejected by SLM Monitor` and HTTP 429 responses wait at least 60 seconds. Tests prove pacing, backoff, cancellation, terminal success/failure exactly-once counting and OAuth token reuse. Generic synthetic 504 responses remained `gateway_timeout`; the prior observed live 504 responses were not proven to be SLM throttling.

Every worker terminal event stays redacted in stdout and persistent logs. The main process enriches only the renderer-bound copy from local `tracking.csv`; the Step 2 UI then deliberately displays the full PIN on one final LATE, ON TIME, NOT DELIVERED, REVIEW or ERROR line per shipment. RETRY lines use a separate warning class. Text labels accompany every color. The 2,000-line cap, independent scrolling, near-bottom follow and unread indicator remain covered.

Primary counters now reconcile late + on time + not delivered + delivered-but-unclassifiable + error exactly to checked. Review is supplementary. For the operator-verified latest run, `19 + 234 + 31 + 0 + 0 = 284`; 31 is derived from 30 review records without successful-delivery evidence plus one overdue/in-transit record. The previous 32 reflected one additional unresolved shipment, not a fixed UI constant. Successful-delivery-versus-original-standard classification remains unchanged at 19 candidates.

Step 3 now uses normal document scrolling and full-width vertical queue/readiness, progress, 650–850 px browser and 320–440 px live-log sections. History uses full-width summaries, controls and vertically separated record sections with comfortable rows and table-local horizontal overflow. Browser bounds are recalculated on scroll/resize and clamped to the visible slot intersection; an offscreen slot hides the native view. Static and Electron tests covered 0/1/19/50 candidates and history records, long content, tall embedded content, 980×680, 1280×720, 1600×1000, maximized 1585×1000 and 2560×1440. Source, unpacked package and extracted-AppImage E2E passed under Linux Wayland using only the loopback mock portal.

Complete `npm test`, formatting, typecheck, lint (zero errors; four non-failing complexity warnings), 96.06% line/statement coverage, 73.05% branch coverage, 93.18% function coverage, accessibility, mock portal, Electron E2E, 177-file release audit, secret scan, full/production npm audits (zero vulnerabilities), 509-entry SBOM, 1,037-entry/six-worker package audit, all packaged Step 1/Step 2/database smokes and isolated-profile smokes passed. No live Tracking request, live claim portal or claim submission was used.

Final separately staged unsigned AppImage: `dist/pacing-layout-packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,197,396 bytes, built 2026-07-29 15:09:54 -0400, SHA-256 `f9885e47f306986cbd3633c08a33b97a92b363c8705258f812064578ed962609`. The verified `dist/packages` and `dist/step2-parity-packages` artifacts remain byte-identical. The application remains pending supervised review.

## Simplified late-candidate model — 2026-07-29

The operational classifier returns only `LATE_CANDIDATE`, `ON_TIME`, `REVIEW_REQUIRED`, or `TRACKING_ERROR`. Its delivered-late rule is now successful delivery after the original Tracking API `expectedDeliveryDate`; later `changedExpectedDate` and earlier first-attempt events remain provenance/warnings and cannot suppress the candidate. The original read-only SOAP worker audit and retained run-62 data audit are in `STEP2_ORIGINAL_PARITY_AUDIT.md` and `STEP2_CLASSIFICATION_PARITY_REPORT.md`.

The 284-row retained evidence contains 19 original-standard-late successful deliveries. The former active rule selected 5: later-revised-date precedence suppressed 8 and first-attempt precedence suppressed 6. The same audit found 230 successful deliveries on/before the original standard, 35 records without successful-delivery evidence, 24 records with a later revised date, no missed recognizable delivery, no service/window suppression among the 19, and no duplicate or accumulated active claims.

Synthetic and sanitized-snapshot tests prove original-standard selection, revised-date preservation, successful delivery control with earlier attempt evidence, on-time same-day/early delivery, missing required evidence review, every original delivery-description form and current documented identifier, advisory service/window warnings, fresh/deduplicated CSV promotion, diagnostic/bulk parity, rejection as a recorded business outcome, and full-traversal/atomic-promotion gating before Step 3.

Complete `npm test`, lint (zero errors; four non-failing complexity warnings), formatting, typecheck, 96.06% line/statement coverage, 73.05% branch coverage, 93.18% function coverage, mock-portal, Electron E2E, accessibility, secret scan, 175-file release audit, production/full dependency audits, and the 509-entry SBOM passed. Every packaged Step 1/Step 2/database/isolated-profile smoke passed against the final build, including 10,000-row import, blank optional metadata, OAuth/401/504/timeout paths, cancellation/isolation, diagnostic/bulk parity, and direct AppImage profile extraction. The package audit covered 1,037 ASAR entries and six external workers.

Step 3 containment remained intact in source, normal Electron, unpacked package, and extracted-AppImage tests. Candidate counts 0/1/5/50, long rows/logs, tall embedded content, internal overflow, hidden panels, Windows-sized 1280×720, 1024×768, 980×680, 800×1000, 700×1000, 1600×1000, 2560×1440, and maximized 1600×1000 were covered. No live Tracking request, claim portal, or claim submission was used.

Final separately staged AppImage: `dist/step2-parity-packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,193,263 bytes, built 2026-07-29 14:13:49 -0400, SHA-256 `f3dc809a32e341e3e283232ad213e787e749b6482f6c34188ae637d194687888`. The previously verified `dist/packages` AppImage was not overwritten.

This section supersedes the older policy-reproduction and missing-date-rejection checkpoints retained below for historical context.

## Step 1 EST parser-v4 / quality-gate validation — 2026-07-28

The operator-authorized aggregate-only Python CSV inspection found both target headers present and blank systematically: 284 total rows; 284 missing/0 populated Shipment Date; 284 missing/0 populated Service Code; no non-empty date formats or standardized service codes. No row or private value was printed or retained, and the file was not changed.

Synthetic coverage proves documented Manifest-to-ManifestItems joining, exact headerless positions, header aliases, XML variants, ISO/compact/localized date normalization, invalid/absent dates, no trace/creation/identifier inference, authoritative service article/code/description mapping, explicit unavailable-service API fallback, structural diagnostic redaction, all/majority rejection, minority exclusion, and byte-preservation of prior output on rejection. Policy tests prove Shipment Date reaches the shared canonical builder and each invariant uses its exact code.

Targeted tests and complete `npm test` passed. Lint exited 0 with four existing complexity warnings; formatting/typecheck passed; coverage was 93.80% lines/statements, 72.59% branches, and 97.61% functions; accessibility, secret scan, the 170-file release audit, production/full dependency audits with zero vulnerabilities, and the 509-entry SBOM passed.

The Linux build and 1,037-entry/six-worker package audit passed. Both `linux-unpacked` and a headless extraction of the final AppImage passed populated EST, missing-date rejection, previous-CSV preservation, and parser-v4 policy-input smokes against loopback mocks. Final AppImage: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,185,094 bytes, SHA-256 `86c50659e25b54af7429020d55b7bde9d37aab95ac5bd2cc872c0321570146ee`.

## Step 2 canonical diagnostic/bulk parity correction — 2026-07-28

The authorized one-shipment result and the incomplete bulk log were traced without reading raw shipment JSON. The bulk row did retain event `1442`, `firstAttemptDate=2026-07-15`, `deliveryDate=2026-07-15`, status `Delivered`, and Tracking API service resolution. Its EST row had no `Shipment Date`; the policy therefore returned the generic foundational missing-evidence result. The diagnostic had stopped after semantic normalization and never built or classified that same policy input, so it could pass while bulk classification failed.

`canonical-normalized-shipment-v2` and `canonical-classification-input-v2` now provide one schema-validated path for diagnostic preview, sanitized structure reporting, bulk staging, policy evaluation, SQLite promotion, CSV queue reconstruction, and pre-submission revalidation. The canonical evidence retains Shipment Date validation/source/provenance, status, service/provenance, expected/revised dates, first-attempt timestamp/code/category/provenance/confidence, actual delivery/code, same-event flag, safe normalized events, parser v4, and API contract v1. Raw response/event objects are rejected from staging and are not persisted. Event `1442` is mapped to `SUCCESSFUL_DELIVERY` from the authorized semantic report.

Policy input construction is now deterministic and shared. A semantic pass followed by foundational missing evidence is an internal invariant failure, stops the run, preserves the prior queue/completed run, and never promotes partial output. Production/test token-cache identity is environment-bound and environment-clear logs use the actual active environment. Tracking resources use a configurable 45-second default transport timeout, at most two timeout retries, bounded 1/2-second backoff plus 0–250 ms jitter, concurrency exactly one, cancellation-aware waits, no token refresh without authentication failure, and a transient-service circuit after repeated exhausted failures.

Final local results:

- targeted parity/invariant, normalization, policy, staging/database, token-environment, and timeout/cancellation/circuit tests: PASS;
- complete `npm test`: PASS;
- lint: zero errors and four non-failing orchestrator complexity warnings; formatting, typecheck, syntax, and `git diff --check`: PASS;
- coverage: 93.80% statements/lines, 72.59% branches, 97.61% functions;
- accessibility and loopback mock portal: PASS;
- secret scan and 168-file release audit: PASS;
- full and production dependency audits: zero vulnerabilities; SBOM/licence inventory: 509 entries;
- Linux AppImage build and package audit: PASS, 1,036 ASAR entries and six external workers;
- full unpacked-package Step 1/Step 2/database mock matrix: PASS;
- unpacked-package and headlessly extracted AppImage diagnostic/bulk parity, event-1442, timeout-retry, and invariant-isolation smokes: PASS.

No GUI, production Canada Post request, raw operator response, or claim submission was used. Final artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,176,904 bytes, SHA-256 `497f14d54ea1ff771bc39a142b20285e3a1119d68eada911d76156ae19835eb6`.

## Step 2 earliest delivery-attempt correction — 2026-07-28

The operator-authorized value-free structure reports were used only to confirm the live direct-object event path, timestamp fields, and safe `eventIdentifier` enums. Raw shipment JSON was not read or retained. No GUI or Canada Post production endpoint was launched during implementation or validation.

Regression coverage now proves successful delivery as the only attempt; failed attempt before delivery; notice card followed by pickup; multiple attempts with same-day time ordering; same-event first-attempt/actual-delivery fields; parcel pickup exclusion; conservative direct-to-post-office handling; address-related attempt mapping; earliest-attempt eligibility; non-contradictory status output; semantic provenance metadata; and incomplete-run Step 3 isolation.

Exact results:

- complete `npm test`: PASS;
- lint: exit 0 with four non-failing orchestrator complexity warnings; format, typecheck, syntax and `git diff --check`: PASS;
- coverage: 93.72% lines/statements, 72.61% branches, 97.56% functions;
- accessibility and loopback mock portal: PASS;
- source secret scan and 164-file release audit: PASS;
- full and production dependency audits: zero vulnerabilities; SBOM/licence inventory: 509 entries;
- Linux AppImage build and package audit: PASS, 1,035 ASAR entries and six external workers;
- all 13 unpacked-package Step 2 OAuth/JSON loopback smokes: PASS;
- unpacked high-volume Step 1, database legacy/advanced, and isolated-profile smokes: PASS;
- headlessly extracted final AppImage Step 2 success, first-attempt, diagnostic-state, semantic-gate, incomplete-isolation and rate-limiter smokes plus high-volume Step 1: PASS;
- actual AppImage isolated-profile migration/no-op/containment smoke: PASS.

Final artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,172,824 bytes, SHA-256 `3ea7596e507499c4bd520a07b131ffb885997bb758c360885a8dbbe6c495568f`.

## Guarded isolated userData migration rehearsal — 2026-07-28

The packaged entry point is now `bootstrap.js`, not `main.js`. Electron's original default `userData` path is captured first; the exact two-variable guard is validated; `app.setPath` assigns isolated user/session/cache/crash/log locations; only then are `main.js`, `app-storage`, database, configuration and worker modules imported. With the variables absent, bootstrap makes no path changes and normal packaged behavior is unchanged.

Validation fails closed for a missing/wrong confirmation, relative/nonexistent/file/root/home/default/default-child/repository-overlap path, root or escaping symlink, wrong owner, world-writable directory, or ASAR/AppImage executable/mount/resources overlap. Central startup validation covers the root; SQLite/WAL/SHM; database and migration backup directories; config, credential and key files; data/CSV/stop/selected-claim/queue/run files; logs, diagnostics and evidence; Chromium session/partition/profile state; worker runtime; cache/crash data; and backup/restore temporary files.

Isolated mode has the exact persistent banner, canonical path, `[ISOLATED TEST DATA]` title, and main-process blocks for live claim/browser, update, restore, external diagnostic/history export and publishing actions. Normal Step 1/2 actions remain deliberate; no action starts automatically. Isolated legacy-data migration reads only the supplied copied profile and never reads or copies back to the default profile.

Exact results:

- `npm run test:user-data-bootstrap`: PASS under strict unhandled rejections; all required valid/invalid path cases, bootstrap-before-storage import, normal-mode no-op, centralized containment, synthetic default-profile immutability, schema-7 row preservation, one first backup and second-startup no-backup passed;
- `npm run test:database-migrations`: PASS, 12 states;
- `npm test`: PASS, complete non-GUI suite;
- lint: exit 0 with four non-failing complexity warnings; format, typecheck and syntax: PASS;
- coverage: 92.89% lines/statements, 70.05% branches, 97.29% functions;
- accessibility and loopback mock portal: PASS;
- source secret scan and 164-file release audit: PASS;
- full and production dependency audits: zero vulnerabilities; SBOM/licence inventory: 509 entries;
- Linux AppImage build: PASS; package audit: 1,035 ASAR entries and six external workers;
- unpacked package and headlessly extracted final AppImage isolated-profile smoke: PASS; exactly one migration backup, schema 7, one representative row retained, second startup no-op/no second backup, synthetic default profile byte-for-byte unchanged, path rejection controlled, no GUI and no unhandled rejection;
- packaged legacy and falsely-advanced database startup smokes: PASS.

Final artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,168,744 bytes, SHA-256 `399c4cba3d7ef6a47494c8d2460881133d75f6632024c91ae6eeb02846d67a8f`.

## Packaged SQLite startup migration recovery — 2026-07-28

The failure was reproduced structurally without the operator database. The exact failing statement was the former `lib/claim-database.js:304` `ALTER TABLE classification_records ADD COLUMN run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;`. A version-5/6 marker skipped the version-5 table creation even when that table was absent, then the version-7 branch attempted the `ALTER`.

The replacement migration manifest creates and validates parents before dependents, columns before their indexes, and tables before their triggers. It reconciles actual `sqlite_master`/column/index state, rejects incompatible definitions, runs as one immediate transaction, promotes `user_version` only after all steps succeed, and requires `integrity_check` plus `foreign_key_check`. Runtime startup creates and validates a unique backup before repair and does not create the main window until database readiness resolves.

Exact results:

- 12-state migration fixture suite under `--unhandled-rejections=strict`: PASS; all supported states migrated, retained representative rows, had no duplicate classification history, passed integrity/foreign-key checks, and were no-ops on second startup;
- corrupt, foreign-key-invalid, and injected-failure fixtures: PASS; controlled errors, backup/recovery copy retained, source preserved, transaction/version rollback verified;
- complete `npm test`: PASS;
- lint: exit 0 with three pre-existing complexity warnings; formatting, syntax and typecheck: PASS;
- coverage: 92.85% lines/statements, 70.05% branches, 97.29% functions;
- accessibility and loopback mock portal: PASS;
- secret scan and 158-file release audit: PASS;
- production and full dependency audits: zero vulnerabilities; SBOM/licence inventory: 509 entries;
- Linux AppImage build and package audit: PASS, 1,030 ASAR entries and six external workers;
- unpacked-package and actual extracted-AppImage startup smokes: PASS for copied synthetic legacy-v4 and falsely advanced-v7 databases, including first migration, verified backup, row retention and repeat no-op startup; extracted-AppImage corrupt input exited 1 with a controlled value-free diagnostic, exact recovery copy, and no unhandled rejection;
- rebuilt high-volume Step 1 and complete Step 2 loopback smoke matrix: PASS.

No GUI, operator database, production Canada Post service, or claims workflow was used. Artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,160,506 bytes, SHA-256 `75382a237987132862b1359931b68e6a4445355de29902e9377ce9cddf67aa83`.

## Live Tracking JSON normalization validation — 2026-07-28

No GUI and no Canada Post production service were used. Synthetic official-shape fixtures and loopback OAuth/Tracking mocks cover direct-object schema paths, nullable fields, API/EST service provenance, English/French event categories, first attempt versus actual delivery, revised expected delivery, unknown fields, schema failure, semantic gate/circuit behavior, raw-value-free structural reports, atomic database/file rollback, incomplete-run discard, bounded visible logs, and the sequential adaptive limiter.

Current source results: `npm test` passed; lint exit 0 with three non-failing complexity warnings; formatting and typecheck passed; coverage passed at 92.85% statements/lines, 70.05% branches and 97.29% functions; accessibility and mock portal passed; secret scan and 153-file release audit passed; full and production npm audits reported zero vulnerabilities; SBOM covered 509 installed entries. The 1,026-entry package audit and all unpacked-package parser, EST fallback, first-attempt, semantic gate pass/fail, incomplete isolation, rate limiter, token, 401 and 504 loopback smokes passed. Headless extraction of the actual AppImage also passed parser, semantic-failure, incomplete-isolation and limiter smokes.

## Current Developer Portal Tracking API migration — 2026-07-28

The current Step 2 path is OAuth 2.0/JSON only. Contract tests pin the official production/test gateways, token/tracking routes, Tracking contract version 1.0.0 (on the portal's 2.0.0 generation), `merchant` scope, IBM client headers, form grant, Bearer/JSON resource request and required response/error fields. Tests also cover missing/mismatched/whitespace-normalized credentials, memory-only token cache/expiry/proactive refresh, one-time 401 refresh, second-401 stop, product/scope failures, archive/not-found responses, first-attempt/expected/delivered normalization, unknown JSON, 400/401/403/404/409/429/500/502/503/504, `Retry-After`, redirects, redaction, no legacy fallback, diagnostic gate invalidation and one-resource diagnostic state integrity.

Exact final results:

- targeted Tracking OAuth/JSON, storage, preflight, UI and integration tests: PASS;
- `npm test`: PASS, including the 10,000-line live-log layout suite;
- lint: exit 0, two non-failing existing complexity warnings; format and typecheck: PASS;
- coverage: 92.61% lines/statements, 68.87% branches, 97.29% functions;
- accessibility and loopback mock portal: PASS;
- secret scan and 144-file release audit: PASS;
- production dependency audit and full development audit: zero vulnerabilities after the `brace-expansion` 5.0.8 build-tool override;
- CycloneDX SBOM/licence inventory: 509 installed entries;
- Linux AppImage build and package audit: PASS, 1,021 ASAR entries and five external workers;
- packaged high-volume Step 1 plus token-success, token-failure, Tracking-success, 401-refresh, 504 and diagnostic-state loopback smokes: PASS.

No GUI, production Tracking service or claims flow was launched. Current artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,152,361 bytes, SHA-256 `f1d02690c98c16b44a41e8a463b8152916b11ca0ce9c4977f5f3890273fcdbdd`.

## Superseded legacy live-log/tracking diagnostic checkpoint — 2026-07-28

The final viewport chain is `body → main.tabbed-main → .app-shell → active tab → .step-workspace → .step-log-card → .log`, with every grid/flex overflow ancestor constrained by `min-height: 0` and `min-width: 0`. The document is fixed to the application viewport; each log owns its vertical/horizontal overflow and stable scrollbar gutter. Renderer retention is exactly 2,000 visible entries, while disk events are not truncated. Auto-follow is threshold-based, pauses after upward scrolling, counts unread entries and resumes only through **Jump to latest**.

Step 1 emits sanitized per-shipment `est_imported_detail` disk events but renders only aggregate `est_import_progress` events at 1/every 25/final plus the final total. No complete tracking number is permitted through the generic renderer log sink.

Step 2 now maps website/EST and Developer Program credentials separately, validates only non-secret presence/trimmed length/source/environment metadata, chooses the official production or development host, builds the exact Basic GET request, handles redirects manually, classifies six HTML page families and defers queue/classification writes until a non-aborted run. Circuit-open workers emit `tracking_aborted`, not `tracking_complete`. The one-request action requires UI and main-process confirmation and preserves all state.

Validation results:

- Targeted protocol/storage/preflight/UI/layout tests: passed.
- `npm test`: passed, including the 10,000-line Playwright layout test at 1440×900 and 2560×1440.
- Lint: exit 0 with two existing non-failing complexity warnings; formatting and typecheck passed.
- Coverage: 92.55% lines/statements, 68.87% branches, 97.29% functions.
- Accessibility and mock portal tests: passed headlessly.
- Secret scan and 137-file release-source audit: passed.
- Production dependency audit: zero vulnerabilities. Full development audit: 16 high, zero critical, confined to the documented packaging-tool dependency tree.
- Linux AppImage build and 1,016-entry package audit: passed.
- Both unpacked package and headlessly extracted AppImage passed Step 1 high-volume and Step 2 redirect/login/one-request/circuit synthetic smokes. No GUI or production Canada Post service was launched/contacted.

Verified artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage`, 387,127,782 bytes, SHA-256 `ac7e49fa80b8d0b880b7051e200b8ad4c16f7253f661abf5ea9d205b314184fd`.

## Autonomous productization update — 2026-07-26

Repository validation now covers the versioned first-attempt policy engine, bilingual tracking normalization, holiday/peak/deadline boundaries, immutable classification evidence, conservative `REVIEW_REQUIRED` exclusion, stale queue blocking, Node EST/REST XML parity, encrypted backup attacks, local portal scenarios, fault points, renderer/IPC/browser isolation, `WebContentsView`, session clearing, onboarding, localization keys, accessibility rules, financial integer arithmetic, crash redaction, signed-update metadata, release content, packaging and SBOM/licence output.

Linux unpacked packaging and its content/browser-runtime audit passed locally. The Electron first-launch/sandbox E2E passed against the loopback mock portal. No live account action, real claim, real customer data, signed artifact, physical Windows/Linux clean install or real pilot was performed.

The exact final command/result ledger is in `AUTONOMOUS_STATUS.json` and `CODEX_IMPLEMENTATION_REPORT.md`. Remaining manual work is authoritative in `MANUAL_RELEASE_GATES.md`.

## Packaged Step 1 worker regression — 2026-07-26

The `spawn ENOTDIR` failure was reproduced by code/package inspection: packaged `ROOT` is the `resources/app.asar` archive and the old shared launcher passed that file as `cwd`. All named Node workers now resolve through `lib/runtime-workers.js`, use the packaged Electron executable with `ELECTRON_RUN_AS_NODE=1`, execute from `resources/app.asar.unpacked`, and use a validated private `userData/worker-runtime` directory as `cwd`.

New regression coverage passed for development, Linux package and Windows package path resolution; ASAR/AppImage cwd rejection; missing resources before spawn; active-state cleanup; delayed “started” reporting; shared Step 1/Step 2 resolution; builder unpack declarations; and package-content location. Both `linux-unpacked` and a headless extraction of the final AppImage passed the synthetic Step 1 smoke test against loopback only: one synthetic shipment imported, exit code 0, and no `ENOTDIR`. The GUI was not launched.

That intermediate artifact was superseded by the EST/tracking correction build documented below.

## Packaged EST empty-result and tracking HTTP 500 regression — 2026-07-26

The Node EST port did not match the legacy PHP code's generic XML-leaf workgroup/order discovery and could incorrectly conclude that a valid legacy response was empty. It also propagated the legacy exit-code-2 no-orders outcome as a failure. The worker now recognizes legacy XML/plain-text fixtures, validates/serializes July 1–26 as `2026-07-01`–`2026-07-26` (plus documented compact compatibility probe), reports structured `EMPTY`/`IMPORTED` outcomes and atomically preserves the existing tracking export on empty results. Source and UI contract tests prove the required empty-result message is completed, not failed.

The Step 2 Node port had hand-built SOAP with both transport Basic and WS-Security credentials. It was replaced with the official Developer Program Tracking REST v2 contract matching the app's existing API-key settings. Safe REST/SOAP application-fault parsing and a three-identical-systemic-failure circuit breaker were added. The mock 500 run made exactly three calls, reported safe protocol diagnostics and preserved the existing queue; five ordinary No PIN History responses did not open the circuit.

Focused tests, complete `npm test`, lint, format, typecheck, coverage, mock portal, secret scan, zero-vulnerability production audit, SBOM, Linux packaging and package audit passed. A headless extraction of the actual final AppImage passed Step 1 empty/populated and Step 2 success/systemic-500 smokes. The GUI was not launched and no live endpoint was contacted.

Superseded 2026-07-26 artifact: `dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage` (387,115,457 bytes), SHA-256 `44871c7ae8ffb3a3d168197ef34c1d8c4ceec281649cf14676c35b2981eca2ff`. The current artifact is recorded in the 2026-07-28 section above.

## Implemented

- Shared IPC input validation with bounded strings, booleans, timeouts, counts, and tracking selections.
- Step 3 readiness preflight covering storage, database integrity, credentials, sender address, eligible queue, built-in browser mode, and reconciliation warnings.
- Reviewable claim queue with per-claim selection.
- Private immutable selected-claims CSV snapshot for every Step 3 run.
- Explicit acknowledgement before any live submission worker starts.
- Canary mode limited to the first selected claim.
- Mandatory built-in browser mode.

## Validation

- JavaScript and PHP syntax checks passed.
- Existing eligibility, database, backup, claim-selection, Step 3 hardening, navigation, diagnostics, and UI tests passed.
- New IPC validation tests passed.
- New claim queue CSV snapshot tests passed.
- New preflight tests passed.
- New Step 3 operator-control tests passed.

## Still required before stable release

- Visual test on the target Linux desktop.
- Successful supervised dry run with two claims.
- Successful supervised canary live run with one low-risk claim.
- Review generated Step 3 diagnostics and reconciliation state after the canary.
- Obtain and verify production signing/update keys, complete physical Windows/Linux clean-install and accessibility testing, approve legal/privacy drafts, and complete a measured customer pilot.
