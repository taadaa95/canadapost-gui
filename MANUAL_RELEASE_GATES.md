# Manual and external release gates

The following are **not completed** by this autonomous repository session:

1. Obtain and protect a real Windows code-signing certificate and release/update signing keys; configure publishing credentials; sign and independently verify final artifacts.
2. Perform physical clean-install, launch, uninstall, upgrade, backup/restore, browser-runtime and accessibility tests on supported Windows and Linux systems. CI is not a substitute.
3. Have legal/privacy counsel approve the privacy, retention, licence, disclaimer, support and lifecycle drafts.
4. Have an authorized Canada Post account owner perform any credential test, supervised dry run, CAPTCHA/text verification, account reconciliation and one-claim live canary. This session performed none of those actions.
5. Verify current Canada Post policy/customer contract and holiday/guarantee notices immediately before release; extend the policy/calendar beyond 2026 before classifying later shipments.
6. Conduct a real customer pilot using `docs/PILOT_READINESS.md`, including support coverage, deletion exercise and post-pilot review.
7. Treat the existing 284-row `tracking.csv` as invalid: both target columns are present but Shipment Date and Service Code are blank in every row. Do not patch, backfill, rename, reuse, or feed it to Step 2/Step 3.
8. On a physical target Linux system, launch the newly built AppImage and perform a fresh Step 1 import with an authorized test account under human supervision. Confirm that it recognizes Manifest and ManifestItems, reports parser `est-import-v4`, and no `ENOTDIR` occurs. This repository session verified only packaged loopback fixtures and did not launch the GUI or access an account.
9. Verify the new CSV has a valid ISO Shipment Date on every promoted row plus `Shipment Date Source Field`, `Shipment Date Provenance`, `Service Code Source Field`, `Service Code Provenance`, and `Import Schema Version`. Service Code may be empty only with explicit-unavailable provenance because Step 2 can resolve it from the Tracking API. If half or more dates are missing/invalid, confirm Step 1 fails with `EST_EXPORT_SHIPMENT_DATE_SCHEMA_FAILURE` and the prior valid CSV is byte-unchanged.
10. On that authorized packaged run, repeat the intended EST range and verify whether it is genuinely empty. Confirm the UI shows either an imported count or the exact completed-no-orders message and that an empty result leaves the previous valid `tracking.csv` intact. Repository inspection cannot safely prove the private account's date-specific contents.
11. Only after the fresh Step 1 quality gate passes, complete the current Tracking API diagnostic and supervised five-row procedure. The earlier diagnostic, defective CSV, and incomplete bulk run are non-authoritative and must not be reused by Step 3:
    1. Create an application in the current Canada Post Developer Portal and request/confirm access to the Tracking product. Do not use the Canada Post account/EST password or deprecated Developer Program Basic credentials.
    2. Open Settings and verify that **Canada Post website / EST login**, **Legacy Developer Program credentials — deprecated**, **Tracking API 2.0 platform client ID**, and **Tracking API 2.0 platform client secret** are four clearly separated settings.
    3. Enter the Developer Portal API Key as the current client ID and API Secret as the current client secret. Select the matching `Test` or `Production` environment. Production uses `api.canadapost-postescanada.ca`; test uses `api-stg.canadapost-postescanada.ca`. Save. Never copy legacy or website credentials into these fields.
    4. In Step 2, select the one-based `tracking.csv` row for one shipment the operator is authorized to query.
    5. Click **Test API connection with one shipment**, read the no-state-change explanation, and deliberately confirm. It may make one OAuth token request, then must make exactly one Tracking JSON resource request and must not start the full queue or invoke legacy mode.
    6. Review the redacted stages: configuration valid; token acquired or failed; Tracking request sent; JSON response received; shipment-specific result; state unchanged. Safe fields may include environment, contract version 1.0.0, endpoint hostname, token/resource HTTP status, `merchant` scope, token expiry duration, content type, Canada Post error code, request/correlation ID, and redacted PIN suffix.
    7. Confirm there is no client ID, client secret, token, authorization header, secret-length metadata, complete PIN, cookie, query string or response body.
    8. Verify `claims.csv`, eligibility/review queues, selected queue and summary counts remain unchanged. Confirm parser `tracking-details-official-v4`, canonical schema `canonical-normalized-shipment-v2`, classification-input preview, event code `1442`/category `SUCCESSFUL_DELIVERY` where applicable, both timestamps, same-event flag, Tracking API service provenance, and no first-attempt/actual-delivery missing-evidence result. Correct missing Tracking product permission, scope, credentials, environment, or foundational EST fields before deliberately retrying.
    9. If semantic validation fails after HTTP 200, click **Export sanitized response structure**, deliberately confirm the one-shipment request, and review the generated owner-only report in the logs directory. Confirm it contains only paths, types, array lengths, safe codes, recognition flags and validation errors—no raw body or shipment/customer/location/reference values.
    10. Confirm the semantic report recognizes the direct root, `$.serviceName`/`$.serviceName2`, `$.significantEvents[*]`, active/archive status and expected/revised delivery paths. If the API omits service, confirm the selected Step 1 row has a valid canonical `Service Code` and the diagnostic reports source `est_import`.
    11. Confirm first-attempt evidence identifies its source code/category/time separately from actual delivery. Successful delivery may populate both fields with a same-event flag; an earlier failed attempt must remain first. Genuinely missing attempt evidence must remain review-required.
    12. After parser/configuration correction, rerun **Test API connection with one shipment**. Only a semantic and classification-preview pass for the current credential revision, environment, API version, parser version, canonical schema, and complete foundational row enables the bulk button. Do not reuse the observed partial classifications.
    13. Prepare exactly five authorized rows with complete EST foundational fields. Run a fresh supervised Step 2 traversal from the beginning. Confirm diagnostic/bulk classification-input parity for the repeated shipment, event `1442` survives staging, delivered text is never paired with “not delivered,” timeout retries do not increment completed shipment counts, and any failure leaves the prior queue/current completed run authoritative.
    14. Confirm the five-row run reports `COMPLETE`, `statePromoted=true`, `queuePreserved=false`, and attempted equals total before allowing it to feed Step 3. Do not submit claims during this gate; review the resulting automatic/manual/ineligible queues first.

Until these gates are complete, the appropriate verdict is **public-beta candidate**, not stable-release candidate.

## Existing-database migration gate

Before distributing this build, an authorized operator must test only a protected copy of the existing application database:

1. Exit the installed application and preserve the database together with any `-wal` and `-shm` files.
2. Copy those files to an isolated test application-data directory; do not move, rename, or edit the originals.
3. Start the rebuilt AppImage against that isolated copy on the target Linux system.
4. Confirm a new timestamped file appears in `database-backups`, the workflow opens, schema version 7 is reported by support diagnostics, and claims, queues, classification history, tracking results, reviews, and audit history remain present.
5. Exit and start the same build a second time. Confirm it is a no-op and does not create another migration backup.
6. If the recovery dialog appears, use **Copy diagnostic**, record the backup location, exit, and retain every source/backup file. Do not retry against the operator's original database.

This repository session used only synthetic temporary databases and did not open the GUI or access the operator database.

### Exact Fish-shell isolated migration procedure

Run this only as an authorized operator on the target Linux system. Fully exit the app before the copy. Never point the override directly at `/home/kris/.config/canadapost-gui`.

```fish
set TESTDATA "$HOME/Documents/canadapost-appdata-migration-test-"(date +%Y%m%d-%H%M%S)
cp -a "$HOME/.config/canadapost-gui" "$TESTDATA"
chmod -R go-rwx "$TESTDATA"

env \
  CANADA_POST_CLAIM_RUNNER_USER_DATA_DIR="$TESTDATA" \
  CANADA_POST_CLAIM_RUNNER_ISOLATED_TEST_CONFIRM=ISOLATED_MIGRATION_TEST \
  "dist/packages/Canada Post Claim Runner-0.4.0-dev.1-linux-x86_64-beta.AppImage" \
  --appimage-extract-and-run
```

Verify the title includes `[ISOLATED TEST DATA]` and the persistent banner says **ISOLATED TEST DATA — changes do not affect the normal application profile** and shows the canonical `$TESTDATA` path. Confirm schema version 7, the expected claims/queues/classification/tracking/review/audit records, and exactly one new verified file in `$TESTDATA/database-backups`. Live claim submission, the built-in claim browser, update actions, external publishing/export, and restore must remain disabled.

Fully exit the isolated instance and run the same `env` command a second time with the unchanged `$TESTDATA`. Confirm startup is a migration no-op and `$TESTDATA/database-backups` receives no second pre-migration backup. Do not copy any migrated file back to the normal profile. Retain both the untouched normal profile and the isolated copy until the release decision is complete.
