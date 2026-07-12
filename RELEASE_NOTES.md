# Canada Post Claim Runner 0.2.0 — Hardening release

## Claim correctness

- Only packages that are actually delivered after the guaranteed date can enter `claims.csv`.
- Overdue but undelivered packages are written to `overdue-undelivered.csv` for the missing-package workflow.
- Unknown, unsupported, or incomplete service data is written to `eligibility-review.csv`.
- Eligibility now checks the configured guaranteed-service allowlist and the 30-business-day request window.
- Service codes can be inferred from Canada Post tracking service names when the history export omits the code.
- Duplicate tracking PINs are not appended repeatedly to `claims.csv`.

## Submission integrity

- Step 3 rejects rows not marked `ELIGIBLE - DELIVERED LATE` or lacking an actual delivery date.
- `claim-state.json` prevents automatic resubmission of locally confirmed, duplicate, interrupted, or unresolved claims.
- Interrupted attempts become `unknown`; failed claims stop after three automatic attempts by default.
- `claim-history.jsonl` is an append-only audit trail.
- Run summaries are retained with timestamps instead of only overwriting the previous summary.
- Built-in browser automation only attaches to Canada Post pages.

## Security and privacy

- Mutable files now live under Electron's per-user application data directory.
- Existing local data and configuration are migrated on first launch.
- Web passwords and Canada Post Developer API credentials use Electron OS-backed encryption and are never returned to the renderer.
- Legacy `user.ini` API secrets are imported and removed from plaintext when secure storage is available.
- Password storage is disabled when Linux only offers the insecure `basic_text` backend.
- The CDP endpoint is randomized and restricted to loopback; wildcard remote origins were removed.
- Browser navigation is restricted to Canada Post for the embedded claim view.
- Config IPC uses an allowlist instead of accepting arbitrary object fields.
- Update URLs must use HTTPS.
- Logs use private file permissions and have a 30-day retention policy; claim evidence uses 90 days.
- Release exclusions prevent credentials, sessions, logs, shipment exports, and evidence from entering source archives.

## Reliability and UX

- Tracking reports eligible, overdue, review-required, no-data, skipped, and error counts.
- Full runs block claim submission when tracking lookups have unresolved errors.
- The Electron runtime is used for the Node claim worker, eliminating reliance on a separate global `node` command.
- Tabs now implement keyboard navigation and proper ARIA tab state.
- The broken ZIP-packaged `node_modules` directory is no longer treated as a distributable runtime.
