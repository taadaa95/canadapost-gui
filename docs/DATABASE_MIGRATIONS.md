# Database migrations and recovery

The SQLite schema is forward-only and currently uses schema version 8. `lib/database-migrations.js` owns the ordered migration manifest; `lib/claim-database.js` owns runtime initialization and verified backups. `PRAGMA user_version` is a progress marker, not proof that schema objects exist.

## Ordered reconciliation

Every startup migration inspects `sqlite_master`, `PRAGMA table_info`, and index definitions. The order is fixed:

1. core parent tables (`app_metadata`, `runs`, `shipments`, `tracking_checks`, `claim_attempts`, `evidence`);
2. legacy claim-reconciliation columns;
3. shipment classification pointers and `tracking_events`;
4. `classification_records`;
5. dependent manual-review, audit, queue, worker-revalidation, and claim-detail tables;
6. `financial_entries`;
7. the classification `run_id` column;
8. promoted-run, database queue-snapshot identity/classification links, duplicate tombstones and generated-export ownership;
9. a one-time promoted-run backfill for complete historical Step 2 runs with run-scoped classifications;
10. dependent indexes; and
11. immutable-history triggers.

This order guarantees that `classification_records` exists before any `ALTER`, index, trigger, or foreign-key-dependent table operation that uses it. A named object with an incompatible type, column set, index definition, or trigger definition is rejected; `IF NOT EXISTS` is not used to conceal an incompatible schema.

All required changes and the final `PRAGMA user_version = 8` execute in one `BEGIN IMMEDIATE` transaction. The version is written only after every ordered step succeeds. Any failure rolls back the complete transaction and retains the incoming version and rows. `PRAGMA integrity_check` and `PRAGMA foreign_key_check` must pass before commit. A repeat startup on a valid version-8 schema is a read-only no-op apart from normal SQLite connection configuration.

## Supported historical and interrupted states

The reconciliation supports:

- a new or zero-byte database;
- the version-4 development/productization schema and its older claim-attempt columns;
- version-5/6 databases with no `classification_records` table;
- a classification table missing supported additive columns, including `run_id`;
- a falsely advanced version row with missing required objects;
- interruption after classification-table creation but before indexes;
- interruption after indexes but before final version promotion;
- dependent manual-review or worker-revalidation tables whose classification parent is missing; and
- repeated execution without duplicate history rows.

Required identity/relationship columns that cannot be added without changing meaning are treated as incompatible, not guessed or silently recreated. Corruption and existing foreign-key violations fail closed.

## Automatic pre-migration backup

The guarded Electron startup calls `initializeDatabase` before creating the workflow window. If an existing database needs any repair or forward migration, SQLite first creates a unique timestamped backup under the application `database-backups` directory. The destination must not already exist, is owner-only, must be non-empty, and must pass its own `PRAGMA integrity_check` before migration begins. A backup name is never reused or overwritten.

If an unreadable/corrupt database cannot be backed up through SQLite, startup makes a size-verified, owner-only `app-pre-migration-unverified-*.sqlite` recovery copy and labels it unverified. The source is never replaced. Migration failure reports the available backup/recovery-copy location.

## Startup failure behavior

Database initialization is awaited by the top-level guarded startup function. The main workflow window is created only after migration and validation succeed. A failure writes a value-free local JSON diagnostic, then presents **Open data folder**, **Copy diagnostic**, and **Exit** actions. The diagnostic contains only a code, migration stage, incoming schema version, backup location, and privacy flags; it contains no database rows, credentials, tracking numbers, customer data, or exception response bodies. Electron exits after the action, so it cannot remain running invisibly.

## Recovery procedure

1. Do not delete or rename the live database, WAL, SHM, migration backup, or recovery diagnostic.
2. Exit the application and copy the timestamped pre-migration backup to protected storage.
3. Give support the sanitized database-startup diagnostic, not database contents.
4. Rehearse the same application build against a copy of the database. Never diagnose against the only operator database.
5. Restore only through the documented in-app restore workflow or a supervised recovery procedure that validates integrity and relationships.
6. After recovery, verify claims, queues, classification history, tracking checks, reviews, audit rows, and the current schema version before resuming work.

`tests/database-migration-recovery-test.js` covers the 12 required fresh/current/legacy/partial/populated/corrupt/foreign-key/rollback fixture states. `scripts/smoke-packaged-database-startup.js` runs copied synthetic legacy and falsely advanced databases through the packaged Electron runtime in Node mode with strict unhandled-rejection behavior; it never creates a GUI window.

## Production-equivalent isolated-profile rehearsal

The packaged entry point is `bootstrap.js`. It captures Electron's original default `userData` path and validates `CANADA_POST_CLAIM_RUNNER_USER_DATA_DIR` before importing `main.js`, `lib/app-storage.js`, the database, workers, or any other path-dependent module. Activation requires `CANADA_POST_CLAIM_RUNNER_ISOLATED_TEST_CONFIRM=ISOLATED_MIGRATION_TEST`; `NODE_ENV=test` is neither required nor sufficient.

The chosen directory must be an existing owner-controlled absolute directory. It is resolved with `realpath` and rejected if it is a symlink, filesystem root, home directory, the normal profile or one of its children, the repository or an overlapping path, an ASAR/AppImage executable/mount/resources path, owned by another user, world-writable, or contains a symlink that escapes the chosen root. Rejection occurs before application storage is imported, and no migration is attempted.

When accepted, bootstrap calls `app.setPath` for `userData`, Chromium `sessionData`, cache, crash dumps, and application logs before normal startup. `lib/mutable-paths.js` then fail-closed validates the database and sidecars, database/migration backups, configuration, encrypted credentials/key, CSV state, logs, diagnostics, evidence, Chromium partitions/profiles, worker runtime, run staging, queue snapshot/selected-claim prefixes, cache/crash data, and backup/restore temporary space. An existing symlink resolving outside the isolated root aborts startup.

An isolated copied profile follows the normal schema-8 startup path. A profile requiring reconciliation receives one verified timestamped pre-migration backup in its own `database-backups` directory. A successful second startup sees the complete schema, creates no additional migration backup, and retains all rows. Isolated startup never performs the normal repository-to-profile legacy copy and never copies anything to the original Electron profile. The window is visibly marked, live claim/browser/update/export/restore actions are disabled, and the selected canonical path appears in the persistent support banner.

Automated validation uses only temporary synthetic profiles. `tests/user-data-bootstrap-test.js` covers bootstrap ordering, rejection and containment rules plus the first/second schema migration. `scripts/smoke-packaged-isolated-profile.js` invokes the packaged Electron entry point in a headless probe branch, verifies production startup and schema/row preservation twice, checks an independent synthetic default-profile sentinel byte-for-byte, and exercises packaged rejection paths without opening a window.
