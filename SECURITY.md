# Security and privacy

This application processes account credentials, shipment identifiers, addresses, contact details, authenticated browser sessions, and claim evidence.

## Rules

- Never share the application data directory or include it in a release ZIP.
- Never commit `user.ini`, `config.local.json`, `credentials.json`, `data/`, or `logs/`.
- Rotate Canada Post web and Developer API credentials if an archive containing those files was shared.
- Keep developer mode off except during a controlled diagnostic session; raw responses can contain customer data.
- Treat `unknown` and interrupted claim states as requiring manual reconciliation. Do not delete `claim-state.json` merely to force a retry.
- Do not expose the Electron debugging port beyond loopback or restore wildcard remote origins.

## Storage

The app stores mutable data under Electron's per-user `userData` directory. The exact path appears in User Settings and can be opened with the Data Folder button. The application data and log directories are restricted to the current OS user where the platform permits it.

The web password and Canada Post Developer API username/password are encrypted with Electron `safeStorage` only when a secure operating-system backend is available. They are not returned to the renderer. On Linux, credential persistence is refused if Electron reports the `basic_text` backend.

For initial API setup, `user.ini` may temporarily contain `username` and `password`. On the next app launch, those fields are imported into encrypted storage and removed from the file when secure storage is available. The remaining `customerNumber` and optional `mobo` values are not treated as authentication secrets.

## Retention

- Normal log files are pruned after 30 days.
- Claim screenshots and page-text evidence are pruned after 90 days.
- Claim state and audit records are retained because they prevent unsafe duplicate submissions.

Retention is age-based, not a substitute for securely deleting data before transferring or disposing of a computer.
