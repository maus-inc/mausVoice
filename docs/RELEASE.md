# Releasing mausVoice

How to cut a release. One workflow, manual dispatch, nothing else.

## Before you start

- The release is **unsigned**. No Apple notary, no Windows codesign, no updater
  channel. That's by design — the repo has no signing keys, and a throwaway
  key is baked into the workflow for CI only. The GitHub Release page itself
  is the distribution channel.
- Releases are authored by **your account** (`Owie6789`), not
  `github-actions[bot]`, because the `RELEASE_TOKEN` secret holds your PAT.
  If that secret is ever missing, the workflow falls back to
  `GITHUB_TOKEN` (release would show as `github-actions[bot]`).
- Only `GROQ_API_KEY` and `RELEASE_TOKEN` exist as repo secrets. Don't add
  signing secrets — the workflow doesn't use them and the pipeline is built
  around no-signing.

## Steps

### 1. Bump the version (if you haven't)

Version lives in two committed files, and the release workflow injects it into a
third at build time:

- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/tauri.prod.conf.json` (no `version` field in the
  repo; the "Sync release version" step writes one during the release job)

The workflow also accepts a version input, but bumping the two committed files
first keeps the repo honest (the tag, the release title, and the built binaries
should agree).

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

## Troubleshooting

| Symptom                                             | Cause / fix                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build job fails                                     | Read the Actions log. Batch all fixes, push once — CI minutes are finite. Integration tests failing with a Groq 429/timeout is a rate limit, not your code: wait for reset and rerun. |
| macOS/Windows fail but Linux passes (or vice versa) | Platform-specific toolchain issue. macOS needs its two Rust targets; check the "Ensure universal macOS Rust targets" step. Windows needs the `CARGO_TARGET_DIR=D:\cargo` env.         |
| Release shows `github-actions[bot]`                 | `RELEASE_TOKEN` secret missing/wrong. Set it again: `gh secret set RELEASE_TOKEN --repo maus-inc/mausVoice --body "$(gh auth token)"` (or a fine-grained PAT with repo contents).     |
| Tag already exists                                  | You're releasing a version that was already tagged. Pick a new version or delete the old tag (only if you're sure).                                                                   |
| No Linux `.AppImage`                                | The matrix bundles `deb,appimage`; if AppImage packaging fails the whole Linux job fails. Check log for linuxdeploy errors.                                                           |
| Body looks wrong                                    | `scripts/ci/generate-release-body.mjs` builds the release description. You can run it locally with `ARTIFACTS_DIR=... RELEASE_TAG=...` etc. to preview.                               |

## How the pieces fit

| Piece                                  | Role                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `.github/workflows/release.yml`        | The whole pipeline: dispatch → 3-platform build → publish                      |
| `scripts/ci/generate-release-body.mjs` | Produces the release description (title, What's new, Downloads, install steps) |
| `RELEASE_TOKEN` secret                 | Authorizes release creation as the maintainer                                  |
| `docs/RELEASE.md`                      | This file. Update it when the pipeline changes.                                |

## Rules that keep the pipeline healthy

- Never publish updater channel metadata (`latest.json`, update-channel tags).
  The signing key is repo-visible; publishing a channel manifest would let
  anyone mint a "valid" update. If a future workflow adds
  `includeUpdaterJson`, that's a bug.
- Keep the release unsigned. No signing secrets exist; anything that
  references Apple/notary/Azure signing will stall the run.
- `release.yml` is the single release path. The old multi-channel
  orchestrator (`release.yml` 3-channel, `_release-desktop-impl.yml`,
  `release-enterprise-*`, `release-docs`, `retry-release`, `publish-packages`)
  was removed — don't recreate it.
- Keep `personal-fork-ci/workflows/` in sync with live CI templates; it's
  the re-apply fallback when a push token can't touch `.github/workflows/`.
