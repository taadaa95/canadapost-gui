# Canada Post Claim Runner 0.4.2

Version 0.4.2 is a product-facing workflow cleanup release:

- Step 2 removes advanced diagnostic and incomplete-run recovery controls from the normal workflow. It remains an automatic fresh tracking run and no longer requires the normal-user diagnostic gate.
- Claim History removes **Mark submitted**, **Mark not submitted**, and **Approve retry** while preserving evidence, historical statuses, reconciliation records, and audit data.
- A successful settings save displays **Settings saved**. Credential encryption, OS-keyring detection, and AES-256-GCM fallback behavior are unchanged.
- The visible unsigned-development-build badge is removed without changing release signing or safety infrastructure.
- Results notification badges now hide completely at zero, increment for off-tab results, clear when Results opens, retain an accurate nonzero result count, and reset to a hidden zero state.
- Database schema remains version 8.

Canonical release candidates:

- Linux x64: `Canada.Post.Claim.Runner-0.4.2-linux-x86_64.AppImage`
- Windows x64: `Canada.Post.Claim.Runner-0.4.2-win-x64.exe`
- macOS universal: `Canada.Post.Claim.Runner-0.4.2-mac-universal.dmg` only if Developer ID signed and notarized

Do not publish `v0.4.2` until Kris physically validates and approves the exact checksum-identified packages.
