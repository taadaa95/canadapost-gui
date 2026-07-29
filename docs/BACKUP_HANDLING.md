# Backup handling

New backups use `.cpcrbackup`, scrypt (`N=32768`, `r=8`, `p=1`) and AES-256-GCM with a random 16-byte salt and 12-byte nonce. The versioned header is authenticated, and the decrypted ZIP is checked by SHA-256 plus entry, path, size and compression-ratio limits before restore. Passwords are never persisted and cannot be recovered.

Restore validates authentication, archive structure, the SQLite header and `PRAGMA integrity_check`, preserves rollback copies, and rebases evidence paths. A legacy ZIP can still be restored for migration, but the application presents a strong unencrypted/untrusted warning. Keep backups in protected storage, transfer them only through approved channels, test restore periodically using synthetic or authorized data, and destroy expired copies according to the retention policy.
