# Canada Post Claim Runner beta operating guide

This is the current operator guide for version **0.4.0-beta.1** on branch `feature/dev11-beta-release-hardening`. Older Dev 1–10 notes are historical records, not current instructions.

## Safety model

Only a completed and promoted Step 2 run can supply Step 3. A `LATE_CANDIDATE` requires an authoritative successful-delivery date after the selected original Delivery Standard date. Revised operational estimates do not replace that original standard, and first-attempt evidence remains visible without disqualifying a successfully delivered-late shipment. Canada Post makes the final eligibility decision.

Policy guidance is advisory. The bundled policy coverage ends on 2026-07-26 and its holiday calendar ends on 2026-12-31. Claim-window dates are explicitly unverified estimates; stale or unsupported policy never marks a record definitively expired and never blocks a valid `LATE_CANDIDATE`.

Step 3 uses only Electron's built-in browser. It validates the latest promoted run and evidence hashes immediately before creating a private immutable snapshot. Submitted, duplicate, terminal, unresolved, reconciliation-required, and otherwise unsafe records are blocked. Dry run remains the default barrier; live submission needs a separate acknowledgement. An uncertain final action is never retried automatically. CAPTCHA or text verification stops automation and requires a visible built-in browser before operator action.

## Current technical contract

| Item | Current value |
| --- | --- |
| Application | `0.4.0-beta.1` |
| Database schema | `8` |
| EST parser/schema | `est-import-v5` |
| Tracking API contract | `1.0.0` |
| Tracking parser | `tracking-details-official-v4` |
| Tracking pacing | sequential, `3100 ms` minimum plus `0–100 ms` positive jitter |
| Tracking test gateway | `https://api-stg.canadapost-postescanada.ca` |
| Tracking production gateway | `https://api.canadapost-postescanada.ca` |
| Linux beta artifact | `Canada.Post.Claim.Runner-0.4.0-beta.1-linux-x86_64-beta.AppImage` |
| Windows beta artifact | `Canada.Post.Claim.Runner-0.4.0-beta.1-win-x64-beta.exe` |

## Supported workflow

1. Complete the first-run setup and review local-data/secure-storage status.
2. Sign in to Canada Post only in the built-in browser.
3. Save current Tracking API credentials without sharing or exporting them.
4. Run the one-shipment diagnostic. A successful semantic result gates normal Step 2.
5. Import shipments in Step 1, run Step 2, and inspect advisory policy warnings.
6. Review and select the exact Step 3 queue. Reconcile all ambiguous outcomes before retrying anything.
7. Start in dry-run mode. Live processing and canary verification remain separately acknowledged and supervised.

Never use a production account during automated testing. The repository's automated browser suites use only the synthetic loopback mock portal.

## Validation and release

Run the commands in `README.md` from a clean checkout. Release scripts reject a dirty tree or an unauthorized branch. Production updates fail closed until an operator configures the trusted Ed25519 public key and publishes a correctly signed canonical manifest. Unsigned beta packages are for the manual gates in `MANUAL_RELEASE_GATES.md`; they are not a production-signed release.

Historical implementation notes remain in `RELEASE_NOTES.md` and `AUTONOMOUS_PROGRESS.md` and are explicitly non-operative.
