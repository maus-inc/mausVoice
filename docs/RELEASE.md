# Releasing mausVoice

How to cut a release. One workflow, manual dispatch, nothing else.

## Before you start

- The release carries **no OS code signing**. No Apple notary, no Windows
  codesign. The GitHub Release page is the distribution channel.
- The **updater** is signed separately, with a minisign key held in repository
  secrets. Nothing key-shaped is committed: the checked-in Tauri config ships
  `createUpdaterArtifacts: false` and an empty `pubkey`, and the build job
  enables both only when the secrets exist. Without them the pipeline **fails
  closed for a stable release**: the publish job's manifest-eligibility gate
  errors out rather than publish a release with no `latest.json`, because
  clients fetch it from `releases/latest/download/` and would 404 forever. A
  prerelease is the one case that still publishes unsigned installers with no
  manifest.
- Releases are authored by **your account** (`Owie6789`), not
  `github-actions[bot]`, because the `RELEASE_TOKEN` secret holds your PAT.
  If that secret is ever missing, the workflow falls back to
  `GITHUB_TOKEN` (release would show as `github-actions[bot]`).
- Repo secrets the pipeline reads: `RELEASE_TOKEN` (release authorship),
  `GROQ_API_KEY` (integration tests), and the updater trio
  `UPDATER_PRIVATE_KEY`, `UPDATER_PRIVATE_KEY_PASSWORD`, `UPDATER_PUBLIC_KEY`.
  Don't add Apple/Azure code-signing secrets — the workflow doesn't use them.

## Steps

### 1. Bump the version (if you haven't)

Version lives in two committed files, and the release workflow injects it into a
third at build time:

- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`

The workflow also accepts a version input and syncs both files inside the build
checkout, but bumping them first keeps the repo honest (the tag, the release
title, and the built binaries should agree).

```bash
# after editing the two files
git add apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json
git commit -m "chore: bump desktop version to 0.1.3"
git push
```

> Optional: if you only ever ship from a clean `main`, merge/push to main
> before releasing so the release builds the latest commit.

### 2. Run the workflow

- Repo → **Actions** → **Release mausVoice** → **Run workflow**
- Inputs:
  - **Version** (required): `0.1.3` or `0.2.0-rc.1`. Used for the tag
    (`mausVoice-v0.1.3`) and release title.
  - **Prerelease**: check for pre-releases/RCs. Leave off for a real release.
  - **Notes**: optional markdown for the "What's new" section. Leave empty to
    auto-generate from commits since the previous `mausVoice-v*` tag.
  - **Tag**: optional override. Defaults to `mausVoice-v{version}`.

What happens: three platform builds run in parallel (macOS universal,
Windows, Linux deb+AppImage), artifacts upload, then a publish job assembles
the release — versioned tag, generated/downloads-formatted body, all bundles
attached.

### 3. Watch it

- The `Build` matrix typically takes 20-40 min (macOS universal is the slow
  one; Windows redirects its cargo target to `D:\cargo` to avoid path
  limits).
- The `Publish` job runs after all three finish and creates the GitHub
  Release (draft: false, prerelease per your input).
- A failed build job retries the whole `Release mausVoice` run — the system
  is concurrency-locked (`release-mausvoice` group), so it won't double-post.

### 4. Verify

Open `https://github.com/maus-inc/mausVoice/releases` and check:

- The tag `mausVoice-v{version}` exists and the release is authored by
  **Owie6789**
- macOS: `.dmg` present (universal)
- Windows: `-setup.exe` present (NSIS)
- Linux: `.deb` + `.AppImage` present
- Release body has a **What's new** section, a **Downloads** table, and
  install notes
- Prerelease checkbox matches what you set
- For a stable release: `latest.json` is attached and
  lists `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, and
  `linux-x86_64`, each alongside its `.sig` (the run cannot reach this point
  without signing configured). For a prerelease, `latest.json` must be
  **absent**.
- Confirm an older installed build offers and installs the update.

## Troubleshooting

| Symptom                                             | Cause / fix                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build job fails                                     | Read the Actions log. Batch all fixes, push once — CI minutes are finite. Integration tests failing with a Groq 429/timeout is a rate limit, not your code: wait for reset and rerun. |
| macOS/Windows fail but Linux passes (or vice versa) | Platform-specific toolchain issue. macOS needs its two Rust targets; check the "Ensure universal macOS Rust targets" step. Windows needs the `CARGO_TARGET_DIR=D:\cargo` env.         |
| Release shows `github-actions[bot]`                 | `RELEASE_TOKEN` secret missing/wrong. Set it again: `gh secret set RELEASE_TOKEN --repo maus-inc/mausVoice --body "$(gh auth token)"` (or a fine-grained PAT with repo contents).     |
| Tag already exists                                  | You're releasing a version that was already tagged. Pick a new version or delete the old tag (only if you're sure).                                                                   |
| No Linux `.AppImage`                                | The matrix bundles `deb,appimage`; if AppImage packaging fails the whole Linux job fails. Check log for linuxdeploy errors.                                                           |
| Body looks wrong                                    | `scripts/ci/generate-release-body.mjs` builds the release description. You can run it locally with `ARTIFACTS_DIR=... RELEASE_TAG=...` etc. to preview.                               |
| Publish fails: `UPDATER_*` "are not configured"     | Expected fail-closed gate: a stable release must ship a signed `latest.json`. Set the `UPDATER_*` secrets and rerun, or release it as a prerelease.                                   |

## How the pieces fit

| Piece                                   | Role                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `.github/workflows/release.yml`         | The whole pipeline: dispatch → 3-platform build → publish                      |
| `scripts/ci/generate-release-body.mjs`  | Produces the release description (title, What's new, Downloads, install steps) |
| `scripts/ci/build-updater-manifest.mjs` | Builds the signed `latest.json` the app's updater reads                        |
| `RELEASE_TOKEN` secret                  | Authorizes release creation as the maintainer                                  |
| `UPDATER_*` secrets                     | Minisign keypair that signs updater bundles (the manifest references them)     |
| `docs/RELEASE.md`                       | This file. Update it when the pipeline changes.                                |

## Rules that keep the pipeline healthy

- Never commit a signing key, a real `pubkey`, or `createUpdaterArtifacts: true`.
  The key that signs an update is the key the app trusts to execute code; a
  repo-visible one lets anyone mint a "valid" update. Keys come from secrets at
  build time, and the edit stays inside the build checkout.
- Never publish `latest.json` for a prerelease. The publish job and the
  manifest script both refuse; if either guard is removed, that's a bug.
- No Apple/notary/Azure code signing. Anything referencing it will stall the run.
- `release.yml` is the single release path. The old multi-channel
  orchestrator (`release.yml` 3-channel, `_release-desktop-impl.yml`,
  `release-enterprise-*`, `release-docs`, `retry-release`, `publish-packages`)
  was removed — don't recreate it.
- Keep `personal-fork-ci/workflows/` in sync with live CI templates; it's
  the re-apply fallback when a push token can't touch `.github/workflows/`.
