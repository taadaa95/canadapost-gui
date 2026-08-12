# Stable release checklist

- Confirm the source SHA, clean worktree, requested branch, and passing automated suite.
- Confirm the artifact name is the exact stable platform filename with no channel suffix.
- Verify the byte size and SHA-256 in `SHA256SUMS.txt` against the built file.
- Confirm `releases/v<version>.json` records the same source SHA, filename, size, digest, and pending manual-validation state.
- Manually validate the exact package using `MANUAL_RELEASE_GATES.md`.
- Publish a normal GitHub release with `draft: false` and `prerelease: false`.
- Upload only the platform packages and `SHA256SUMS.txt`.
- Confirm GitHub's release asset reports the expected SHA-256 digest.
- Preserve the previous stable package and user-profile recovery data.
