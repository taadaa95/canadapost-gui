# Support and troubleshooting

1. Stop the run; do not delete the database or repeat a final claim action.
2. Check History for reconciliation or manual-review items and run Database Health.
3. For browser issues, use the session status control and clear the browser profile only after confirming that cookies/storage may be removed. Claim history is preserved.
4. Create a previewed support bundle or local crash report, review it for customer information, then share it through the approved support channel. See [Support bundles and portal compatibility](SUPPORT_BUNDLES_AND_PORTAL.md).
5. Record severity: **S0** security/privacy or duplicate financial action; **S1** data loss/uncertain submission; **S2** blocked core workflow; **S3** degraded/non-core issue; **S4** cosmetic/documentation.

Never request credentials, cookies, raw browser profiles or complete customer exports. Escalate S0/S1 immediately, preserve evidence and hashes, stop live submission, and follow the incident procedure. Vulnerabilities should be reported privately using the contact defined by the distributor; do not include live customer data in the initial report.

Common recovery actions are documented in `docs/DATABASE_MIGRATIONS.md`, `docs/BACKUP_HANDLING.md`, and `MANUAL_RELEASE_GATES.md`.
