# Step 2 classification parity report

Audit source: latest completed and atomically promoted tracking run (`runs.id = 62`) in the local profile database.  
Run interval: 2026-07-29T17:08:17.759Z–2026-07-29T17:26:21.930Z.  
Method: read-only SQLite/CSV analysis; no network request and no profile mutation.

## Counts derived from retained evidence

| Measure | Count |
|---|---:|
| Total records / unique normalized PINs | 284 / 284 |
| Current production-rule candidates | 5 |
| Exact original-app-rule candidates | 19 |
| Successful delivery later than the selected expected date | 13 |
| Successful delivery later than the original delivery-standard field | 19 |
| Final delivery late, first attempt on/before original standard | 6 |
| Final delivery late, excluded by service/policy filters | 0 |
| Final delivery late, excluded by original claim-window logic | 0 |
| Final delivery late, routed to review required | 0 |
| Later revised date replaced an earlier original standard | 24 |
| Recognizable successful-delivery wording missed by the normalizer | 0 |
| Duplicate input records / duplicate claims rows | 0 / 0 |
| Records lacking successful-delivery evidence | 35 |
| Successful delivery on or before the original standard | 230 |

The selected-date arithmetic is complete: 249 records have successful-delivery evidence (`13 late + 236 on/before selected`), and 35 do not (`249 + 35 = 284`). Against the original standard, 19 are late and 230 are on/before. The current output files contain 5 claim rows, 31 review rows, and 1 overdue/in-transit row, with no duplicate rows. The database has 32 `REVIEW_REQUIRED` classifications because the overdue row is routed to its separate CSV after classification.

## Suppressed original-rule-late records

Only the last four PIN characters are shown. Two unrelated PINs can share a suffix, so the suffix is a display identifier, not a key.

| Redacted PIN | Standard | First attempt | Successful delivery | Current result | Suppression rule |
|---|---|---|---|---|---|
| `…1115` | 2026-07-13 | 2026-07-13 | 2026-07-14 | ON_TIME | `FIRST_ATTEMPT_ON_OR_BEFORE_EXPECTED_DATE` |
| `…1116` | 2026-07-03 | 2026-07-03 | 2026-07-04 | ON_TIME | `FIRST_ATTEMPT_ON_OR_BEFORE_EXPECTED_DATE` |
| `…2113` | 2026-07-10 | 2026-07-09 | 2026-07-11 | ON_TIME | `FIRST_ATTEMPT_ON_OR_BEFORE_EXPECTED_DATE` |
| `…2128` | 2026-07-17 | 2026-07-17 | 2026-07-20 | ON_TIME | `FIRST_ATTEMPT_ON_OR_BEFORE_EXPECTED_DATE` |
| `…3119` | 2026-07-08 | 2026-07-08 | 2026-07-09 | ON_TIME | `FIRST_ATTEMPT_ON_OR_BEFORE_EXPECTED_DATE` |
| `…6110` | 2026-07-15 | 2026-07-13 | 2026-07-21 | ON_TIME | `FIRST_ATTEMPT_ON_OR_BEFORE_EXPECTED_DATE` |
| `…4115` | 2026-07-13 | 2026-07-14 | 2026-07-14 | ON_TIME | later revised date (2026-07-14) replaced original standard |
| `…4122` | 2026-07-17 | 2026-07-22 | 2026-07-22 | ON_TIME | later revised date (2026-07-22) replaced original standard |
| `…4125` | 2026-07-20 | 2026-07-21 | 2026-07-21 | ON_TIME | later revised date (2026-07-21) replaced original standard |
| `…6118` | 2026-07-06 | 2026-07-07 | 2026-07-07 | ON_TIME | later revised date (2026-07-07) replaced original standard |
| `…8115` | 2026-07-17 | 2026-07-20 | 2026-07-20 | ON_TIME | later revised date (2026-07-21) replaced original standard |
| `…8118` | 2026-07-09 | 2026-07-10 | 2026-07-10 | ON_TIME | later revised date (2026-07-10) replaced original standard |
| `…9112` | 2026-07-09 | 2026-07-10 | 2026-07-10 | ON_TIME | later revised date (2026-07-10) replaced original standard |
| `…9112` | 2026-07-14 | 2026-07-15 | 2026-07-15 | ON_TIME | later revised date (2026-07-15) replaced original standard |

Every original-rule-late/current-rule-not-late record is accounted for: six by first-attempt precedence and eight by later-revised-date precedence. None was sent to review or filtered by service or claim-window rules.

## Expected-date provenance findings

The JSON Tracking response parser retains two API fields:

- `expectedDeliveryDate` → retained as `originalExpectedDeliveryDate`;
- `changedExpectedDate` → retained as `revisedExpectedDeliveryDate`.

Before correction, both the parser and normalizer selected the revised value when present. Run 62 has 107 records where the revised and original values differ and 24 where the revised value is later. Eight delivered-late records were suppressed by that later selected date.

The API schema calls the first field `expectedDeliveryDate`; it does not provide a stronger immutable/public “Delivery Standard” label or an explicit statement that the value can never itself be revised server-side. The local evidence can prove field provenance, but it cannot prove the upstream historical immutability of that field. The corrected selector should therefore prefer `expectedDeliveryDate`, preserve `changedExpectedDate`, and attach an uncertainty warning when both concepts cannot be independently proven.

## Recognition and missing evidence

The retained normalized event collection contains 253 `SUCCESSFUL_DELIVERY` events across 249 delivered shipments. A case-insensitive scan for the original recognizer's successful-delivery wording found no shipment with recognizable delivery text but an empty normalized actual-delivery date.

Thirty-five records have no successful-delivery evidence. They must not become delivered-late claims. At the run timestamp:

- 1 in-transit record was past its standard and was routed to overdue/in-transit;
- 31 in-transit records were due that day or later and were review required;
- 3 records had attempt evidence but no successful delivery and were previously called on time by the first-attempt classifier.

Under successful-delivery semantics, those three attempted-only records are no longer `ON_TIME`; without successful delivery they require review (or overdue routing once their standard has passed).

## Duplicate and accumulation findings

- The run has 284 rows and 284 distinct normalized PINs.
- Current `claims.csv` has 5 rows and no duplicate PIN.
- Current review and overdue outputs also have no duplicates.
- Active full-run outputs are freshly generated and atomically promoted, so the retained result is not cumulative.
- The original worker's non-fresh append mode could preserve prior unique claim rows, but the inspected original directory currently has only one claim row and supplies no evidence that the reported 20+ was a single-run result.

## Derived corrected result

For this retained snapshot, the corrected delivered-late rule produces **19 candidates**. The increase from 5 is exactly eight shipments suppressed by later-revised-date precedence plus six suppressed by first-attempt precedence. This is a data-derived result, not a target count.

No live Tracking API request was needed. No claim portal was opened and no claim was submitted.
