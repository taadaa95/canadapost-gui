# Privacy and retention policy draft

**Draft for legal and privacy review; not legal advice.** Canada Post Claim Runner is an independent product and is not affiliated with, endorsed by, or operated by Canada Post Corporation.

The application processes shipment identifiers, sender/receiver and contact information, tracking events, classification evidence, claim outcomes, financial recovery entries, screenshots/page text selected by the workflow, local credentials, and an authenticated browser session. Operational data remains on the user's device unless the user explicitly exports or shares it. Crash reporting is disabled by default and has no upload endpoint.

Credentials, cookies, browser sessions and device encryption keys are excluded from SQLite, application backups, diagnostic exports and release artifacts. Encrypted backups may contain customer and shipment data, evidence and non-secret settings. Diagnostic and crash-report redaction is best effort; the user must review files before sharing.

Default evidence retention is 90 days and is configurable. Application logs and detailed Step 3 diagnostic runs are pruned locally. Claim and classification audit history is retained until the user uses an approved export/deletion procedure because it protects against duplicate submission. Clearing the browser profile preserves claim history. Removing customer data requires: stop active work, create any required encrypted export, delete the selected records/evidence using the documented lifecycle procedure, verify database integrity, and securely dispose of external copies according to the operator's policy.

Before commercial use, legal counsel must approve lawful basis, retention periods, controller/processor roles, customer notices, access/correction/deletion handling, cross-border support transfers, breach notification, warranty/liability language and the end-user licence.
