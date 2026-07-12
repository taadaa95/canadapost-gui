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

Copy `user.ini.example` into the application data folder and enter the Canada Post Developer Program API credentials. On the next launch, the app imports those API credentials into Electron OS-backed encrypted storage and removes the plaintext `username` and `password` lines when a secure backend is available. `customerNumber` and optional `mobo` remain in `user.ini` as non-secret configuration.

The Canada Post web/EST login is entered in User Settings. Its password is also stored only through secure OS encryption. On Linux, persistence is refused when Electron reports the insecure `basic_text` backend.

## Upgrade from 0.1

Overlay the hardening patch onto the existing project and launch once. The app migrates legacy `data/`, `logs/`, `config.local.json`, and root `user.ini` into Electron's per-user application data directory. Web and Developer API credentials are moved into encrypted storage where supported.

Verify the migrated data and credential status in User Settings. Then remove any remaining legacy `config.local.json`, `user.ini`, `data/`, and `logs/` copies from the project directory. Rotate both web and API credentials if an earlier archive containing them was shared.

A clean 0.2 installation intentionally contains no credentials, tracking exports, claim screenshots, browser profiles, or logs.

## Files created at runtime

- `tracking.csv`: imported shipment records
- `claims.csv`: eligible delivered-late rows only
- `overdue-undelivered.csv`: overdue shipments that have not been delivered
- `eligibility-review.csv`: records that cannot be safely auto-classified
- `tracking-run-summary.json`: complete Step 2 counts
- `claim-state.json`: current idempotency/reconciliation state
- `claim-history.jsonl`: append-only claim audit events
- `claim-run-summary*.json`: latest and archived submission summaries

An interrupted claim is converted to `unknown` and is not retried automatically. Failed claims are limited to three automatic attempts by default. Reconcile terminal or exhausted attempts in Canada Post before changing local state.

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
- claim selection, idempotency, interrupted attempts, and retry limits.

## Release process

Do not ZIP the working directory directly. Build releases from a clean checkout with `.gitignore` enforced. Exclude `node_modules`; run `npm ci` on the target/build machine so Electron binaries and symlinks are installed correctly for that platform.

See `RELEASE_NOTES.md` and `SECURITY.md`.
