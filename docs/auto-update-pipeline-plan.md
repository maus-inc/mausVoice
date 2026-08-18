# Auto-update pipeline — E2E implementation plan

Status: implemented on `arena/01a00791-mausvoice`.

## 1. Why the current updater cannot work

Tracing the flow end to end (`AppSideEffects` → `updater.actions` → `desktop-utils/updater` → `plugin:updater|check` → `tauri.conf.json` endpoints → GitHub release assets) surfaces five independent breaks. Each one alone is fatal, so the shipped "check for updates" path has never been able to return an update.

1. **The shipped config has no endpoint.** `tauri.conf.json` declares `plugins.updater.endpoints: []`. The endpoints only exist in `tauri.prod.conf.json`, and the release workflow never passes `--config src-tauri/tauri.prod.conf.json` to `tauri build` — it only rewrites the `version` field inside that file. The production override is dead weight; released binaries ship the empty base list.
2. **The endpoints that do exist point at a repository that does not exist.** `https://github.com/mausvoice/mausvoice/...` — the project lives at `maus-inc/mausVoice`. The same wrong origin is hardcoded in `packages/desktop-utils/src/updater.ts` as `GITHUB_RELEASE_DOWNLOAD_BASE`, so the macOS `.pkg` fallback URL is unreachable too.
3. **No `latest.json` is ever produced.** `release.yml` uploads installers only. There is no job that collects the `.sig` files Tauri emits and assembles an update manifest, so even a correct endpoint would 404.
4. **The signing key is committed in plaintext** in both `release.yml` and `build-desktop.yml`, and the public key is patched into the config from a committed `TAURI_CI_PUBKEY` literal. Anyone can sign an artifact the app would auto-trust. `REVIEW.md` §5 classifies this as Critical.
5. **The frontend poisons its own dialog.** The first tick of the update interval calls `dismissUpdateDialog()`, which writes `dismissedUntil = now + 3 days`. Every launch therefore suppresses the auto-shown dialog for three days. The interval also runs every 60 seconds, which is a network call per minute for an artifact that changes a few times a year.

## 2. Target design

**Channel:** stable only. Prereleases publish installers but never a manifest, so the updater cannot pull a pre-release onto a stable user.

**Trust anchor:** no key material in the repository. `tauri.conf.json` ships `createUpdaterArtifacts: false` and an empty `pubkey`; the release workflow reads `UPDATER_PRIVATE_KEY` / `UPDATER_PRIVATE_KEY_PASSWORD` / `UPDATER_PUBLIC_KEY` from repository secrets, maps the private key onto `TAURI_SIGNING_PRIVATE_KEY` for Tauri, and patches `UPDATER_PUBLIC_KEY` into `plugins.updater.pubkey` for that build only. Stable publish is fail-closed: missing updater secrets must fail the job rather than ship unsigned. Only prereleases may skip manifest generation.

**Endpoint:** `https://github.com/maus-inc/mausVoice/releases/latest/download/latest.json`, declared once in the base config. `releases/latest/download` always resolves to the newest non-prerelease release, so the manifest URL is stable and needs no per-release tag rewriting.

### Backend / pipeline

| Change                                                                                                                 | File                                          |
| :--------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------- |
| New manifest builder: scan artifacts, pair each bundle with its `.sig`, map to Tauri platform keys, emit `latest.json` | `scripts/ci/build-updater-manifest.mjs`       |
| Signing gated on secrets; `updater` job builds + uploads `latest.json`; prerelease and unsigned runs skip it           | `.github/workflows/release.yml`               |
| Remove the committed signing key; CI validation builds stop producing updater artifacts                                | `.github/workflows/build-desktop.yml`         |
| `createUpdaterArtifacts: false`, empty `pubkey`, single real endpoint                                                  | `apps/desktop/src-tauri/tauri.conf.json`      |
| Drop the stale duplicated `plugins.updater` overrides                                                                  | `tauri.dev.conf.json`, `tauri.prod.conf.json` |

Platform key mapping follows Tauri v2: `darwin-aarch64` and `darwin-x86_64` both point at the universal `.app.tar.gz`; `windows-x86_64` at the NSIS `.nsis.zip`; `linux-x86_64` at the `.AppImage`. A bundle whose `.sig` is missing is a hard error — a manifest entry without a valid signature is worse than no entry, because the client surfaces a failing install instead of "up to date".

### Frontend

- Correct the startup dismissal bug: seed the "already handled this launch" ref without writing `dismissedUntil`.
- Poll every 6 hours instead of every minute, and skip the automatic check in dev mode.
- Track `lastCheckedAt` in updater state so the UI can say when it last looked.
- Distinguish a user-initiated check from a background one: a manual check reports "You're up to date" instead of silently doing nothing.
- Delete the unused `lastUpdateVersion` field.
- Minimal UI: a **Software update** section in More settings showing the running version and last-checked time with a _Check now_ button that exposes pending / up-to-date / available / error states.

### Docs

- `apps/docs/.../getting-started/updates.md` — rewritten for the real user-facing behaviour.
- `apps/docs/.../development/releases.md` — signing secrets, manifest job, prerelease guard.
- `apps/docs/.../development/auto-update.md` — new page documenting the pipeline end to end.
- `docs/RELEASE.md` — maintainer runbook including key generation and rotation.

### Tests

- `scripts/ci/updater-manifest.test.mjs` — drives the real script over fixture directories: platform mapping, missing-signature rejection, version/pub_date shape, refusal to emit for a prerelease.
- `apps/desktop/src/tauri-conf.test.ts` — contracts read from the live config: no key material committed, updater artifacts off by default, endpoint is HTTPS and points at the real repository.
- `apps/desktop/src/actions/updater.actions.test.ts` — the startup path no longer sets `dismissedUntil`, and a manual check surfaces the up-to-date result.

## 3. Verification

`pnpm --filter desktop run lint`, `check-types`, `test:unit`; `node --test scripts/ci/updater-manifest.test.mjs`; `pnpm --filter docs run build`; and a self-review of the full diff against `REVIEW.md` with the CodeRabbit persona, reported in `docs/auto-update-pipeline-review.md`.
