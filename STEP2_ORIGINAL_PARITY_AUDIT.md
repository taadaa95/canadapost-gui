# Step 2 original parity audit

Audit date: 2026-07-29  
Original application inspected read-only: `/home/kris/Downloads/canadapost-gui`  
Active application: `/home/kris/Documents/canadapost-gui`

## Executive conclusion

The original worker determines lateness from the successful-delivery date, not the first-attempt date. Its core comparison is `deliveryDate > expectedDate`. The active worker instead compared the earliest qualifying attempt (including a failed attempt or notice card) with a date that preferred a revised estimate. In the retained 284-row run, revised-date precedence suppressed eight delivered-late shipments and first-attempt precedence suppressed another six.

The original application is not a pure date comparator after that point: it only writes a late row to `claims.csv` when the service is on its configured guarantee allowlist and the run date is within 30 business days after the expected date. Those gates do not suppress any of the 19 successful-delivery-late records in the retained run because all 19 use `DOM.EP` and all are within the window.

## Original Step 2 pipeline

| Stage | Original file and function | Observed behavior |
|---|---|---|
| GUI launch | `renderer.js`: `startTrackingOnly()`, `buildTrackingOnlyOptions()` | The Step 2 button invokes `window.cpApp.runTracking({ fresh, developerMode: false })`. `fresh` defaults to the state of the checked `freshTracking` control (or `true` if absent). |
| Renderer bridge | `preload.js`: `runTracking` | Maps the GUI request to IPC `tracking:run`. |
| Process launch | `main.js`: `ipcMain.handle('tracking:run', ...)` | Verifies `tracking.csv` and credentials. A fresh run deletes the prior claims, processed-PIN, summary, overdue, and review outputs. It launches PHP with a fixed request interval. |
| Tracking worker | `scripts/get-tracking-cli.php` | Calls the Canada Post SOAP Visibility service at `https://soa-gw.canadapost.ca/vis/soap/track`, using the local `wsdl/track.wsdl`. |
| Primary operation | `get-tracking-cli.php`: loop and `extract_summary_status()` | Calls `GetTrackingSummary`. The summary's `expected-delivery-date` is the expected date. The successful-delivery date is `actual-delivery-date`, falling back to the summary event date only when the description is recognized as delivered. |
| Fallback operation | `get-tracking-cli.php`: `extract_detail_status()` | Calls `GetTrackingDetail` only when the summary contains no `pin-summary`. Uses `tracking-detail.expected-delivery-date` and the first significant event whose description is recognized as a successful delivery. |
| Delivery recognizer | `get-tracking-cli.php`: `is_delivered_description()` | Rejects “not delivered”, “unable to deliver”, and “delivery attempt”. Accepts delivered, community mailbox, parcel locker, and recipient-side-door wording. It has no event-identifier mapping. |
| Eligibility | `scripts/lib/eligibility.php`: `classify_delivery_eligibility()` | Normalizes dates; separates missing, in-transit, overdue, on-time, and delivered-late; then applies a 30-business-day window and service allowlist. |
| Claims write | `get-tracking-cli.php`: `DELIVERED_LATE_ELIGIBLE` branch | A row is added only when `classify_delivery_eligibility()` returns `DELIVERED_LATE_ELIGIBLE`. Existing claim PINs are deduplicated. |

The operative original logic is:

```text
if expected is missing/invalid: insufficient data
if successful delivery is missing: overdue/in transit according to today's date
if successful_delivery <= expected: delivered on time
if today > expected + 30 business days: delivered late, review required
if service is not on the guarantee allowlist: delivered late, review required
otherwise: delivered late eligible -> add to claims.csv
```

The expected date is the SOAP `expected-delivery-date`. The original source does not retain or distinguish an original standard from a later revised estimate. It does not use first attempt, latest event, or a separate revised-expected field in classification.

### Original filtering and output behavior

- Delivered shipments: compared by successful-delivery date with expected date.
- Attempted but not delivered: no special attempt model; without successful-delivery evidence they remain in transit or overdue.
- In transit: not written to claims; overdue shipments are written to `overdue-undelivered.csv`.
- Missing events/data: emitted as no-data or review; not written to claims.
- Services: only `DOM.EP`, `DOM.XP`, `DOM.XP.CERT`, `DOM.PC`, `USA.XP`, `INT.XP`, `INT.PW`, and `INT.PW.*` pass the original allowlist.
- Claim window: successful-delivery-late rows after 30 business days from expected are sent to review.
- Duplicates: existing claims are deduplicated by exact PIN; `processed_pins.txt` can skip previously completed late/on-time PINs.
- API errors: retried up to three times for the specific SLM rate-limit fault; other SOAP/application errors are counted and processing continues.
- `claims.csv`: opened in append mode when it already exists and is non-empty. A fresh GUI run deletes it first; a non-fresh run preserves prior unique rows.
- GUI count: `resetRunUi('step2')` resets the in-memory late counter, and each `pin_late` event increments it. The displayed late count is per-run event count, while a non-fresh `claims.csv` can be cumulative.

## Active Step 2 before correction

| Stage | Active file and function | Pre-correction behavior |
|---|---|---|
| GUI/IPC | `renderer.js` → `preload.js` → `main.js` tracking IPC | Launches the Node tracking worker and preserves cancellation/run-state controls. |
| API worker | `scripts/get-tracking.js`: `main()` | Uses OAuth and the Developer Portal REST/JSON Tracking API, sequential rate limiting, bounded retries, staging, and atomic promotion. |
| JSON parse | `lib/tracking-json.js`: `parseTrackingJson()` | Retains `expectedDeliveryDate` as original and `changedExpectedDate` as revised, but exposed the revised date as the selected `expectedDeliveryDate` when present. |
| Normalization | `lib/tracking-normalizer.js`: `normalizeTrackingEvents()` | Recognizes successful delivery by documented identifiers `1442` and `1496` plus bounded English/French descriptions. It separately finds the earliest qualifying attempt and successful delivery. It selected revised expected candidates ahead of original candidates. |
| Canonical boundary | `lib/normalized-shipment.js`: `buildCanonicalShipment()`, `buildClassificationInput()` | Carries expected, revised expected, first attempt, and delivery into the common diagnostic/bulk classification boundary. |
| Classification | `lib/policy-engine.js`: `classifyEligibility()` | Selected `revisedExpectedDeliveryDate || expectedDeliveryDate`; selected `firstAttemptDate || actualDeliveryDate`; then classified late only when the selected attempt was after the selected expected date. |
| Promotion | `scripts/get-tracking.js` and `lib/tracking-run-staging.js` | Rebuilds claims/review/overdue files and promotes them only after a complete full traversal; incomplete runs preserve the prior queue. |

Pre-correction pseudocode:

```text
applicable_expected = revised_expected || expected
comparison_event = first_attempt || successful_delivery
if either is missing/invalid/contradictory: REVIEW_REQUIRED
else if comparison_event > applicable_expected: LATE_CANDIDATE
else: ON_TIME
```

## Behavioral differences

| Difference | Original | Active before correction | Effect/rank |
|---|---|---|---|
| Revised estimate | No separately modeled revised field | Revised date overrides original | **1 — demonstrated:** suppresses 8 original-standard-late rows in run 62; 24 records have a later revised value overall. |
| Comparison event | Successful delivery | Earliest attempt, falling back to delivery | **2 — demonstrated:** independently suppresses 6 original-standard-late rows in run 62. |
| Service gate | Hard gate after lateness | Optional enrichment; no hard gate | Cannot explain reduction to 5; it would make the original no broader than active for affected rows. |
| Claim window | Hard 30-business-day gate | Not a candidate gate | Cannot explain reduction to 5; all retained delivered-late rows are within the original window. |
| Delivery recognition | Description-only summary/detail logic | Documented identifiers plus bounded descriptions | No missed recognizable success event was found in retained run 62. |
| Output lifecycle | Append unless GUI `fresh` deletes outputs | Fresh, deduplicated atomic promotion after full traversal | Historical non-fresh original output can inflate file row totals; it does not explain the retained active run. |
| Partial runs | May leave incrementally written files | Isolated staging; no promotion | Reliability improvement to preserve. |

## Ranked explanation for “20+” versus 5

1. **Revised-date suppression is proven and accounts for 8 rows.** These shipments were late against the original `expectedDeliveryDate` but not late against the selected later `changedExpectedDate`.
2. **First-attempt suppression is proven and accounts for another 6 rows.** These shipments were successfully delivered after the original standard, but the current classifier used an earlier attempt.
3. **Historical accumulation is possible in the original.** Its non-fresh mode appends unique candidates to an existing `claims.csv`, so a file can represent several runs and exceed a current per-run total. The currently inspected original directory contains only one claim data row, so it cannot prove the earlier reported total.
4. **Different tracking snapshots can change the set.** The original SOAP summary and the current retained JSON evidence were collected at different times/endpoints. The active profile retains 19 successful-delivery-late rows for run 62; it cannot substantiate more than 19 for that snapshot.
5. **Recognizer differences contribute zero identifiable rows in run 62.** No retained event with recognizable delivery wording lacked normalized successful-delivery evidence.

## Supported conclusions

- The original core date rule is successful delivery after SOAP `expected-delivery-date`.
- The original app never used first attempt to make a delivered shipment on time.
- On the retained 284-row snapshot, exact execution of the original worker's date, service, and window conditions yields 19 candidates, not 20+.
- The proven current-rule suppressions among those 19 are revised-date precedence (8 rows) and first-attempt precedence (6 rows).
- `claims.csv` accumulation can explain some historical excess only when `fresh` was disabled or the worker was run directly against an existing file; the available original data does not prove that this occurred for the reported run.
- The active app's atomic full-run promotion, security, API reliability, database history, and Step 3 gating are independent improvements and should remain intact.
