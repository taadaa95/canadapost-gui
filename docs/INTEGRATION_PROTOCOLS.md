# Canada Post integration protocol decisions

Last verified against current official Canada Post pages: 2026-07-28

## Step 1: EST Desktop history

Step 1 preserves the legacy EST Desktop integration because the application settings contain EST/web credentials and a Canada Post customer number. It uses HTTP Basic authentication for the same `ws.postescanada-canadapost.ca` EST Desktop endpoint family used by the former PHP implementation:

- `GET /dop/connect` for authenticated connection validation;
- `GET /dop/{customer}/workgroup/customerNumber/{customer}` for workgroups;
- `GET /ship/desktop/{customer}/{workgroup}/{category}/order/{from}/{to}/{mobo}` for order identifiers;
- `POST /ship/desktop/{customer}/{workgroup}/{category}/exportorderhistory?filetypes=1,2` for the Manifest and ManifestItems export blocks.

The order query first serializes dates as inclusive `YYYY-MM-DD` path values and then uses the legacy `YYYYMMDD` compatibility form only when the first form has no order IDs. The exact July test range serializes as `2026-07-01` through `2026-07-26`, then `20260701` through `20260726`. Invalid calendar dates and reversed ranges fail before any request.

The official [EST 2.0 Export File Specifications](https://www.canadapost-postescanada.ca/cpc/doc/en/business/est/export.pdf) defines Shipment Date evidence at Manifest `Mailing Date`, not the ManifestItems trace-inquiry date. Parser `est-import-v4` separates the two blocks and performs the documented Order Id join without writing or retaining raw server responses.

| Variant | Shipment Date mapping | Service mapping | Join/position |
| --- | --- | --- | --- |
| EST 2.0 headerless Manifest | `Mailing Date` | n/a | Order Id 0; Mailing Date 8 |
| EST 2.0 headerless ManifestItems | joined Manifest date | `MATNR – Article Number` via `est-article-services-2015-v1` | Order Id 0; article 2; PIN 16; postal 27; reference 30; trace fields 31/32 |
| Headered/legacy CSV | exact `Shipment Date`, `Mailing Date`, `Ship Date`, or `Date Shipped` | exact `Service Code`/`Product Code`, documented article number, or authoritative canonical description | header position from exact normalized name |
| Shipment details XML | exact `mailing-date`, then `shipment-date` | exact `service-code`, then `product-code` | XML element provenance |

`Date Time Trace Inquiry Event` remains trace metadata and never becomes Shipment Date. Creation/order dates, expected delivery, import/file timestamps, identifiers, and tracking-number structure are never date/service fallbacks. Dates normalize without timezone conversion to `YYYY-MM-DD` after real-calendar validation. Supported bounded inputs are ISO/date-time-leading ISO, `YYYYMMDD`, year-first slash, legacy numeric month/day (or unambiguous day/month), and English month-name forms.

Each row retains the sanitized source-field name, normalized value, provenance, and `est-import-v4`. Missing service is explicitly unavailable and may be supplied by Step 2. Missing Shipment Date makes a row incomplete. A half-or-greater missing/invalid date ratio fails the entire Step 1 import before output mutation; a smaller incomplete subset is reported and excluded. The prior output is preserved on failure. HTML/login pages, unknown downloads, valid empty order lists, recognized exports with zero usable rows, parser failures, and quality-gate failures remain distinct outcomes.

Detailed parity decisions:

| Concern | Legacy PHP | Corrected Node |
| --- | --- | --- |
| Authentication/session | HTTP Basic on every request; connect probe; no cookie jar | Same Basic/connect model; credentials arrive over protected stdin; no cookie jar |
| Methods/endpoints | GET connect/workgroup/order; POST export | Same |
| Headers | Versioned DOP/Ship `Accept`, language, XML Content-Type for export, explicit user agent | Same versioned media types/language/Content-Type; runtime fetch user agent because EST does not document a required value |
| Dates | Inclusive path bounds, ISO then compact compatibility form | Validated inclusive path bounds, same two forms; no timezone conversion or time component |
| Redirects/login | cURL did not opt into redirects | Fetch rejects redirects; redirect/login HTML is an authentication/unexpected-response diagnostic rather than silently following to a portal |
| Cookies | None | None |
| Compression/TLS | cURL automatic decompression, configured CA bundle | Fetch automatic decompression and platform/Electron trusted certificate store; HTTPS production-host allowlist |
| Workgroups/orders | Numeric/all-leaf XML extraction; XML or line-oriented order IDs | Same, with bounded/deduplicated identifiers and safe counts only in logs |
| Export discovery | Multi-file blocks were merged when file type 2 was selected | Manifest and ManifestItems selected separately; exact schema mapping plus safe structural diagnostics |
| Output | Generated tracking CSV even when date/service were blank | Quality-gated atomic CSV with source/provenance; structured imported/incomplete/empty result; rejection/empty preserves existing output |

The EST Desktop interfaces are legacy account functions and do not have equivalent current public Developer Program documentation. Their continued account compatibility remains a human release gate; no private account request was made during implementation.

## Step 2: current Developer Portal Tracking API

Canada Post released its current Developer Portal platform on April 30, 2026. The portal catalog metadata identifies the platform API generation as **2.0.0**, while the official Tracking OpenAPI document identifies the Tracking operation contract as **1.0.0** and uses the `/tracking/v1` base path. The application records both values and sends `1.0.0` as the diagnostic API contract version; it does not relabel the official operation schema as 2.0.0.

Authoritative contract metadata, retrieved July 28, 2026:

- portal product: `tracking-api-1.0.0`;
- OpenAPI source: `https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/download/4687/document`;
- OpenAPI version: `3.0.0`; `info.title`: `Tracking`; `info.version`: `1.0.0`;
- retrieved document size: 82,326 bytes;
- SHA-256: `189b373a4df79f0f45e27280de72950bf3e18792c59775e674807e67318d2e29`;
- checked-in derivative: `tests/fixtures/tracking-api-1.0.0.contract.json`, a sanitized contract summary with no portal examples, credentials, tokens, customer information or response bodies.

### Environments, OAuth and request contract

| Purpose | Production | Test |
| --- | --- | --- |
| Gateway hostname | `api.canadapost-postescanada.ca` | `api-stg.canadapost-postescanada.ca` |
| Tracking base path | `/prod/devportal-portaildesdeveloppeurs/tracking/v1` | `/prod/devportal-portaildesdeveloppeurs/tracking/v1` |
| Token path | `/prod/devportal-portaildesdeveloppeurs/cpc-api-native-oauth-provider/oauth2/token` | `/prod/devportal-portaildesdeveloppeurs/cpc-api-native-oauth-provider/oauth2/token` |

The production origin and route come directly from the OpenAPI server and OAuth security scheme. The official test examples replace the production gateway with `api-stg.canadapost-postescanada.ca`; the test token URL applies that official test gateway to the exact token route declared by the OpenAPI security scheme. This derivation is explicit because the downloadable document contains only the production server entry.

The token operation is a separate `POST` using `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`, headers `X-IBM-Client-Id` and `X-IBM-Client-Secret`, and form fields `grant_type=client_credentials` and `scope=merchant`. A valid JSON response must contain a Bearer `access_token`, positive `expires_in`, and the `merchant` scope. Tokens are cached only in worker memory using a monotonic deadline, refreshed before expiry, invalidated on authentication failure, and discarded on worker exit. A resource 401 invalidates the token, obtains one new token, and retries the resource once; a second 401 stops.

The tracking-detail operation is exactly:

```text
GET {tracking-base}/pins/{pinNumber}/details
Authorization: Bearer <access-token>
Accept: application/json
```

`pinNumber` is the only required path parameter. There are no required query parameters. `Accept-Language` (`en-CA` or `fr-CA`) and `platform-id` are optional headers. The operation requires the `merchant` scope. Step 2 sends no request body, Basic authorization, XML media type, `Content-Type`, `SOAPAction`, SOAP envelope or WS-Security header.

The detail response is an official **direct JSON object with no wrapper**. It requires `pin`, `activeExists`, `archiveExists`, `signatureImageExists`, and `suppressSignature`. Service is documented at `$.serviceName` and `$.serviceName2`; expected dates are at `$.expectedDeliveryDate` and `$.changedExpectedDate`; events are at `$.significantEvents[*]`. Significant events require `eventDate` and `eventTime` and may carry `eventIdentifier`, `eventDescription`, and `eventTimeZone`. Unknown JSON fields are ignored. Required-field, type, response-shape, or response-PIN mismatches stop classification; missing first-attempt or other eligibility evidence remains `REVIEW_REQUIRED` rather than being fabricated and cannot enter Step 3. Persisted normalized evidence excludes response locations, references, free-form event descriptions, and raw response fragments.

`activeExists` indicates the active tracking repository and `archiveExists` indicates the archive. A response with neither flag becomes a shipment-specific not-found outcome, not a systemic circuit failure. The OpenAPI documents 200, 400, 401, 403, 404, 500, 503, and 504 for details. Its standard JSON error schema requires `title`, `detail`, and `errors`; each item requires `errorCode` and `message`. The 401 schema defines `httpCode`, `httpMessage`, and `moreInformation`.

Step 2 uses exactly one in-flight Tracking resource request and enforces a configurable 3,100 ms minimum start-to-start interval plus 0–100 ms positive jitter. This cannot exceed the documented legacy Tracking throttle group of 20 transactions per rolling 60-second window, and positive jitter normally reduces it further. An exact `Server / Rejected by SLM Monitor` application response is classified separately and waits at least 60 seconds. HTTP 429 also waits at least 60 seconds (and longer when `Retry-After` requires it). Generic HTTP 502/503/504 and transport timeouts use at most two bounded exponential retries with 0–250 ms jitter; a generic 504 remains a gateway timeout and is not called throttling. Every retry also obeys the 3,100 ms start floor. Shipment-specific not-found, delivered, eligibility, and `REVIEW_REQUIRED` outcomes are never retried. A bulk run is never automatically restarted.

### Credential separation and legacy isolation

| UI/storage purpose | Exact mapping | Active use |
| --- | --- | --- |
| Canada Post website / EST login | `webUsername` + encrypted `webPassword` | Step 1 EST and Step 3 website only |
| Tracking API 2.0 platform client ID | encrypted `trackingClientId` | OAuth `X-IBM-Client-Id` only |
| Tracking API 2.0 platform client secret | encrypted `trackingClientSecret` | OAuth `X-IBM-Client-Secret` only |
| Tracking API environment | `trackingApiEnvironment`: `test` or `production`, recorded with the encrypted pair | Current token and resource gateway selection |
| Legacy Developer Program credentials — deprecated | encrypted `apiUsername` + `apiPassword`; `apiEnvironment`: `development` or `production` | Inactive forensic/migration module only |

Current credentials are trimmed at save/use boundaries, but only present/missing metadata is displayed. No secret lengths, prefixes, hashes or values are logged. Website and historical credentials are never copied into current fields. Existing encrypted historical values remain untouched for supported upgrade compatibility, are not exposed in normal Settings, and cannot be selected by Step 2. The Step 2 worker supports only OAuth/JSON and has no Basic/XML fallback client.

Changing or clearing the current encrypted pair or environment creates a new credential revision, clears the successful one-shipment diagnostic gate, and is blocked while a worker is active. The gate includes the official API contract version and parser/normalizer version. Normal Step 2 stays disabled until the diagnostic succeeds for that exact revision/environment/API/parser tuple. The safe 3,100 ms bulk pacing is therefore unavailable until semantic validation succeeds.

### Live JSON normalization correction

The production transport/authentication result proved that OAuth and the gateway were healthy. The normalization defect was local: the worker selected any non-empty EST `Service Code` before attempting the documented API `serviceName`, without first validating the EST value. An unrecognized imported value therefore suppressed a valid API service. The parser also recognized only eligibility-significant descriptions, so ordinary `significantEvents` such as accepted, processed, in transit, out for delivery, pickup, and electronic-information events remained `UNKNOWN` and forced review.

The corrected resolution order is:

1. exact canonical mapping of `$.serviceName` or `$.serviceName2`, provenance `tracking_api`;
2. exact validation of Step 1 `Service Code` against the versioned service table, provenance `est_import`;
3. `unknown` when neither is recognized; the record stays out of Step 3.

No service is inferred from the tracking-number format. The evidence records the source, canonical code, and normalized service. The operator-authorized value-free production structure reports confirmed the live paths `$.significantEvents[*].eventIdentifier`, `eventDate`, `eventTime`, and `eventTimeZone`; they contained only paths, types, array lengths, and safe identifier enums, not shipment JSON. Official example codes `1496` (delivered) and `20` (signature image) take precedence over descriptions, and the authorized semantic diagnostic confirms `1442` as successful delivery for the inspected production event. Meanings are not guessed for other identifiers merely observed in the structure report. Otherwise bounded English/French descriptions map explicit attempt, notice card, recipient unavailable, address-related attempted delivery, successful delivery, return, disruptions, and ordinary transit lifecycle categories.

First attempt remains informational evidence and is the earliest chronological qualifying event. Successful delivery is normalized separately and controls late-delivery classification. If a failed attempt precedes delivery, the earlier event remains first-attempt evidence but does not suppress a successful delivery after the original Delivery Standard. The original/public delivery-standard date is selected ahead of a later revised operational estimate; both dates and their provenance remain preserved. Parcel pickup, expected/final summary dates, arbitrary last events, and delivery-to-post-office scans do not fabricate successful-delivery evidence.

The one-request semantic gate now requires recognized direct-object schema, parsed active/archive status, located and parsed (or documented empty) event collection, recognized events when the collection is non-empty, parsed expected delivery when present, a recognized API or EST service, no critical schema mismatch, and unchanged state. Its safe diagnostic reports the first qualifying event identifier/category, first-attempt and actual-delivery timestamp presence, shared-event flag, provenance, and confidence without descriptions, dates, locations, or shipment identifiers. Parser version `tracking-details-official-v4` is part of the gate, invalidating the earlier v3 success gate. A 200 response that fails these checks does not enable normal Step 2.

Diagnostic and bulk execution both build `canonical-normalized-shipment-v2` and then call the same deterministic `canonical-classification-input-v2` builder. Canonical schema and evidence-hash validation runs before/after privacy serialization, staging, policy, database promotion, queue reconstruction, and revalidation. Resource transport timeout is configurable through `TRACKING_RESOURCE_TIMEOUT_MS` (45,000 ms default; 1,000–120,000 ms accepted), retries at most twice with bounded backoff/jitter, remains concurrency one, honors cancellation, and does not refresh OAuth unless authentication fails.

## Failure and diagnostic behavior

HTTP, redirect, HTML and OAuth/API JSON errors are reduced to safe structured diagnostics: token/resource status, bounded content type, endpoint family, selected environment, method, response hostname, redirect status/sanitized destination, WWW-Authenticate scheme, application code, redacted human message, correlation/request ID, HTML classification, known body type, API version, scope, category and systemic fingerprint. Classification priority is HTTP status semantics, OAuth/API JSON error, redirect, content type, then HTML markers. Thus an HTML-bodied 504 is reported as **Canada Post API gateway timed out (HTTP 504)**, not unknown HTML. HTML is classified from bounded title/form/action markers and then discarded. Supported classifications are login/SSO, access denied, gateway/WAF, maintenance, generic Canada Post website and unknown HTML. Authorization values, credentials, access tokens, complete tracking numbers, response bodies, redirect queries, cookies and full private URLs are never emitted.

Three consecutive identical authentication, redirect, HTML, schema, endpoint/rate-limit or server failures open the circuit and preserve the existing claims/review/overdue queues and deferred database classification writes. Statuses 502, 503 and 504 are transient gateway/service failures and never mark a shipment checked. Shipment-specific not-found outcomes do not open the circuit. A successful response resets the consecutive-failure count. Circuit-open workers emit `tracking_aborted`, never `tracking_complete`; the UI reports attempted/total/remaining/error counts, queue preservation, and **Stopped — systemic integration failure**. A deliberate retry is required after configuration is corrected; a bulk run is never automatically restarted.

A separate semantic circuit samples the first three HTTP 200 responses. It opens when all sampled responses share a parser-level failure such as an unlocated event collection, non-empty event arrays with zero recognized events, unresolved service despite available import evidence, or the same schema mismatch. It does not open merely because a legitimate shipment lacks first-attempt evidence. Its exact operator message is **Stopped — Tracking API responses were received, but required fields could not be normalized.**

Normal runs stage all CSV and SQLite classification changes in memory. Output files are prepared and promoted together with owner-only preceding-output backups; SQLite normalization/classification writes use one transaction and run ID. Any cancellation, HTTP/systemic circuit, semantic circuit, error, skipped row, or incomplete traversal leaves the prior authoritative files and database pointers unchanged. The main process additionally requires an explicit `COMPLETE`, `statePromoted: true`, non-diagnostic, full-traversal summary before marking the run authoritative. If the process is interrupted in the narrow cross-resource promotion window, Step 3 still fails closed because the run is not complete. **Discard incomplete Step 2 run** then restores preceding output files when a run backup exists, archives the discarded current files in that run directory, re-points run-scoped classifications to their preceding completed records, preserves immutable history, and keeps Step 3 blocked until a new full recomputation completes.

Step 2 exposes **Test API connection with one shipment** plus a one-based authorized `tracking.csv` row selector. It displays a confirmation explaining the token-plus-single-resource lookup and no-state-change behavior. The main process independently requires the confirmation flag and passes the three worker controls below plus the current client ID/secret on protected stdin:

```text
TRACKING_DIAGNOSTIC_MODE=1
TRACKING_DIAGNOSTIC_CONFIRM=ONE_REQUEST_NO_STATE_CHANGE
TRACKING_DIAGNOSTIC_ROW=<one-based selected CSV row>
```

It validates configuration, makes one OAuth token request when no valid in-memory token exists, and makes exactly one Tracking resource request. It reports redacted stages for configuration, token acquisition, resource dispatch, JSON receipt, shipment-specific result and unchanged state. It redacts the selected tracking number and does not write `claims.csv`, review/overdue queues, eligibility/classification database state or the normal run summary. It never falls through into a full run or legacy mode. It must only be invoked by an authorized human; automated coverage uses a loopback mock.

**Export sanitized response structure** uses the same deliberate one-row flow and exactly one resource request. It never stores the raw response. Its owner-only JSON report contains property paths, value types, array lengths, safe bounded event-code/delivery-option/boolean enum values, timestamp/event-code/service/status field names, schema/semantic validation errors, and recognized/unrecognized paths. Values for PINs, names, addresses, postal/location/signature/reference/customer/description fields and all credentials/tokens are omitted.

## Live-log retention and privacy

Steps 1 and 2 use fixed/viewport-derived workspaces with independent live-log scrolling. Step 3 and History deliberately switch to normal page-level vertical scrolling: full-width queue/readiness, progress, browser, log, filters and record sections retain comfortable heights and spacing. The Step 3 queue and log keep their own bounded vertical scrolling, while wide tables scroll horizontally inside their cards. The native browser receives only the visible intersection of its DOM slot and the application viewport and is hidden when the slot is offscreen. All logs retain safe wrapping, stable scrollbar gutters, a 2,000-line DOM cap, near-bottom auto-follow and the unread **Jump to latest** control.

Before a Step 3 worker is spawned, the main process creates or reuses the isolated `persist:canadapost-claims-builtin` `WebContentsView`, binds a per-view nonce, verifies the current loopback CDP endpoint, and publishes the exact top-level page target ID. The endpoint, target ID, and nonce are passed directly to the worker process. The worker rejects zero or multiple exact matches and never chooses a renderer by URL, title, target order, browser-context order, or session partition alone. Hiding an offscreen browser slot detaches its native view without destroying this automation identity; destruction stops an active Step 3 worker safely.

Browser creation and display are separate lifecycle stages. At run start and after the target handshake, the main process asks the active renderer for a fresh browser-slot measurement. A visible slot causes the same view to be attached (or reattached), raised to the top child-view position, assigned the slot/viewport intersection as positive native bounds, and explicitly shown. Scroll, resize, maximize, tab activation, navigation readiness, and display-metric changes repeat this synchronization. An offscreen slot hides and detaches the native view but preserves its webContents, nonce, and target ID. A visibility watchdog blocks worker release—and stops manual-verification waiting safely—unless the view is attached with positive bounds intersecting the BrowserWindow content area. The HTML placeholder and browser status are driven by the resulting main-process display state rather than target existence alone.

Step 1 no longer renders one line per shipment. It emits visible aggregate progress at the first row, every 25 rows and the final remainder, plus final totals. Each shipment still produces a sanitized `detailLevel: shipment` disk event containing only a redacted tracking marker and ordinal. The full sanitized disk event stream remains available even after old visible DOM entries are discarded.
