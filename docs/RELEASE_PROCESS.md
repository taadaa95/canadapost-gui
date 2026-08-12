# Stable release process

Release builds use one normal version stream and never require `RELEASE_CHANNEL`. Source archives use the explicit release allowlist, require a clean Git worktree, scan for prohibited content and secrets, and are re-audited after extraction.

For a reviewed clean commit:

```bash
npm ci
npm run release:guard
npm test
npm run test:dev10
npm run test:updates
npm run test:localization
npm run test:accessibility
npm run lint
npm run lint:dev10
npm run format:check
npm run typecheck
npm run coverage
npm run test:mock-portal
npm run secret-scan
npm run release:audit
npm audit --omit=dev --audit-level=high
npm run release:package
```

`release:guard` rejects a dirty tree, a commit different from `RELEASE_SOURCE_COMMIT`, or a branch other than `feature/dev11-beta-release-hardening`. The branch name is retained for PR continuity; it is not an application update channel.

`release:package` creates a fresh temporary Git materialization, installs locked dependencies, reruns tests, builds `Canada.Post.Claim.Runner-<version>-linux-x86_64.AppImage`, audits packaged content, and generates:

- `SHA256SUMS.txt` plus a platform-specific internal copy;
- package-size report;
- CycloneDX SBOM and dependency licence inventory;
- provenance bound to the exact source SHA;
- `releases/v<version>.json` with manual validation still marked pending.

Only the AppImage and `SHA256SUMS.txt` belong in the public Linux Downloads section. Keep internal audit metadata outside the public asset list.

Do not create or publish the GitHub release until Kris manually validates the exact built AppImage. See `MANUAL_RELEASE_GATES.md` and `docs/GITHUB_UPDATES.md`.
