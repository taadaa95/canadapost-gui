# Canada Post Claim Runner

Electron application for importing Canada Post EST shipment history, checking delivery results, classifying late-delivery refund eligibility, and submitting eligible late-package support tickets under user supervision.

## Important operating rule

`claims.csv` contains only packages that:

- have an actual delivery date later than the guaranteed date;
- use a service recognized by the configured on-time-guarantee rules; and
- remain within the 30-business-day request window.

Undelivered overdue packages are not late-delivery refund claims. They are exported to `overdue-undelivered.csv` for separate investigation. Incomplete or unsupported eligibility records go to `eligibility-review.csv`.

## Install

```bash
npm ci
npm run install-browsers
npm start
```

PHP with the SOAP, DOM, cURL, and libxml extensions must be available for Steps 1 and 2.

Copy `user.ini.example` into the application data folder and enter the Canada Post Developer Program API credentials. On the next launch, the app imports those API credentials into encrypted per-user storage and removes the plaintext `username` and `password` lines after the encrypted copy is verified. `customerNumber` and optional `mobo` remain in `user.ini` as non-secret configuration.

The Canada Post web/EST login is entered in User Settings. Electron OS-keyring encryption is preferred. When a usable Linux keyring is unavailable, the app uses AES-256-GCM device-local encryption protected by owner-only application-data permissions.

## Upgrade from 0.1

Overlay the hardening patch onto the existing project and launch once. The app migrates legacy `data/`, `logs/`, `config.local.json`, and root `user.ini` into Electron's per-user application data directory. Web and Developer API credentials are moved into encrypted storage. OS-keyring encryption is preferred, with a device-local encrypted fallback when necessary.

Verify the migrated data and credential status in User Settings. Then remove any remaining legacy `config.local.json`, `user.ini`, `data/`, and `logs/` copies from the project directory. Rotate both web and API credentials if an earlier archive containing them was shared.

A clean source installation intentionally contains no credentials, device keys, tracking exports, claim screenshots, browser profiles, or logs.

## Files created at runtime

The local SQLite database is the authoritative source for shipment history, tracking checks, eligibility decisions, workflow runs, claim attempts, and reconciliation state.

CSV and JSON files remain as workflow inputs, exports, and human-readable summaries:

- `tracking.csv`: imported shipment records;
- `claims.csv`: eligible delivered-late rows only;
- `overdue-undelivered.csv`: overdue shipments that have not been delivered;
- `eligibility-review.csv`: records that cannot be safely auto-classified;
- `tracking-run-summary.json`: complete Step 2 counts;
- timestamped claim summaries and evidence files.

An interrupted claim becomes a reconciliation item and is not retried automatically. Failed claims are limited to three automatic attempts by default. Reconcile terminal, uncertain, or exhausted attempts before approving another submission.

## Validation

```bash
npm test
```

The test command checks JavaScript/PHP syntax and runs regression tests for:

- delivered-late eligibility;
- overdue but undelivered shipments;
- unsupported and missing service data;
- expired claim windows;
- service-name inference;
- encrypted credential storage;
- claim selection, idempotency, interrupted attempts, and retry limits;
- Step 3 browser isolation, dry-run safeguards, navigation, selector behavior, and structured diagnostic redaction.

## Release process

Do not ZIP the working directory directly. Build releases from a clean checkout with `.gitignore` enforced. Exclude `node_modules`; run `npm ci` on the target/build machine so Electron binaries and symlinks are installed correctly for that platform.

See `RELEASE_NOTES.md` and `SECURITY.md`.

## Step 3 safety model

Step 3 uses the app's isolated built-in Canada Post browser session. The runner selects that exact browser target, confirms authentication, restricts top-level navigation to Canada Post, fills one claim at a time, and records the attempt transactionally before the final action. Unknown, interrupted, timed-out, or confirmation-without-number outcomes are sent to reconciliation instead of being retried automatically.

Dry run is intentionally conservative. It fills the receiver, tracking, reference, sender, and contact fields, then stops on the sender/contact page before any final review or submission transition. A page-level guard also blocks final submission controls. Dry run is not a substitute for checking the Canada Post account when a previous run may have advanced unexpectedly.


## Step 3 detailed diagnostics

Every Step 3 run creates a private diagnostic directory under the Electron per-user log directory:

```text
logs/step3-runs/step3-<timestamp>-run-<id>/
```

The directory includes:

- `timeline.jsonl`: complete machine-readable event timeline;
- `step3-detailed.log`: human-readable chronological trace;
- `electron-browser.jsonl`: native BrowserView navigation, loading, crash, and bounds events;
- `live-status.json`: the last known state even if the worker is interrupted;
- `summary.json`: operation timing, warnings, errors, state, and final outcome;
- `page-states/`: redacted page structure, frames, visible controls, and visible-text samples;
- `manifest.json`: runtime and privacy metadata.

The trace records selector strategies, frame scans, form readiness, navigation transitions, browser/network failures, dry-run barriers, final-action dispatch state, confirmation polling, evidence metadata, and stop/shutdown behavior. It does not intentionally record passwords, cookies, authorization data, entered form values, or full tracking numbers.

Use **Open Detailed Diagnostics** in Step 3 to inspect the latest local run. The History tab's **Diagnostic ZIP** includes a re-sanitized copy of the latest Step 3 trace and excludes screenshots. Review diagnostic archives before sharing because free-form page text can contain information that no automated redactor can guarantee to detect.

Detailed runs are automatically limited to the newest 20 directories and 30 days of retention.
