# Production package-size budget

Dev 10's verified Linux x64 AppImage was 387,230,260 bytes and bundled a 646 MiB uncompressed Playwright Chromium payload in addition to Electron. Version 0.4.0-beta.1 removes that second browser runtime and uses `playwright-core` only as the CDP client for Electron's built-in `WebContentsView`.

| Artifact | Hard budget | Dev 10 baseline |
| --- | ---: | ---: |
| Linux x64 AppImage | 200,000,000 bytes | 387,230,260 bytes |
| Windows x64 NSIS | 220,000,000 bytes | Not measured on Windows in this workspace |

`npm run package:size -- <package-directory>` fails above budget and writes `dist/release-metadata/package-size-<platform>.json` with the reviewed commit, exact artifact bytes, baseline reduction, and major unpacked contributors. `npm run package:audit -- <unpacked-directory>` independently rejects full Playwright, `.local-browsers`, browser executables, obsolete external profiles, tests, fixtures, runtime data, logs, source maps, credentials, and unexpected roots.

Platform budgets may change only through a reviewed source change with a documented measured reason. They must not be raised merely to make a failing package pass.
