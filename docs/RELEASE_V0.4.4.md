# Canada Post Claim Runner 0.4.4

Version 0.4.4 is the workflow-simplification and Windows shutdown-reliability release.

- The customer-facing workflow is reduced to two steps, with tracking classification automatically following shipment-history import.
- Saved credentials remain masked and Settings is simplified without weakening encrypted storage.
- Windows update installation launches the downloaded installer visibly.
- Closing the app after a successful claim no longer queries or destroys an already-destroyed Electron browser object.
- Windows lifecycle regression coverage protects the shutdown fix.
- Database schema remains version 8.

Canonical release candidates:

- Linux x64: `Canada.Post.Claim.Runner-0.4.4-linux-x86_64.AppImage`
- Windows x64: `Canada.Post.Claim.Runner-0.4.4-win-x64.exe`

The exact public binaries must come from the reviewed 0.4.4 canonical release source commit and pass the existing automated release checks. Physical Windows validation of the exact public installer remains a post-publication manual check.
