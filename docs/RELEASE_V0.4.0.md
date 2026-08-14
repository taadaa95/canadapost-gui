# Canada Post Claim Runner 0.4.0

Stable platform packages:

- Linux x64: `Canada.Post.Claim.Runner-0.4.0-linux-x86_64.AppImage`
- Windows x64: `Canada.Post.Claim.Runner-0.4.0-win-x64.exe`

- Step 3 now shows only claims that can be acted on now; previously submitted and blocked records are excluded automatically.
- Claim History is now a simple newest-first record, with **Needs attention** actions shown only when a claim requires resolution.
- Removed the obsolete Health Check and Eligibility Manual Review interfaces.
- Corrected customer-number privacy handling and preserved existing application data in the user's profile.
- Simplified future updates to one stable GitHub Latest release stream with exact package, size, and SHA-256 verification.

Users of 0.4.0-beta.1 must install 0.4.0 manually once because the old binary's updater cannot be changed remotely. Existing application data remains in the same user profile.

Windows was rebuilt from the same validated source commit as Linux and passed the native Windows automated package and content-audit gates. Physical Windows manual validation is not claimed by the automated release record.
