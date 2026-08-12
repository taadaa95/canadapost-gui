# Supported platforms, updates and lifecycle draft

**Draft.** Stable releases target 64-bit Windows through NSIS and 64-bit Linux through AppImage. Node 24 is the CI validation runtime and Electron/Playwright versions are locked in `package-lock.json`. macOS is not currently supported.

There is one normal stable version stream. The updater uses GitHub Latest, accepts only a strictly newer stable release and exact platform artifact, and verifies GitHub's SHA-256 release-asset digest before installation. Protected operations, automatic database backup, interrupted-update recovery, and rollback remain in force.

Proposed support policy: security fixes for the current stable and immediately previous stable release, at least 90 days' notice before ordinary end of life, and accelerated retirement only for an actively exploitable security or policy defect. Actual dates and contractual commitments require commercial approval.
