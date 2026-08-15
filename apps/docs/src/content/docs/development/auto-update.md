---
title: "Auto-update pipeline"
description: "How the updater manifest is signed and published, and how the desktop app consumes it."
sidebar:
  order: 13
---

The updater is a code-execution channel: whatever the manifest names is downloaded, verified, and run on a user's machine. The pipeline is therefore built so that the untrusted parts (endpoints, artifacts, release metadata) live in the repository, and the one trusted part — the signing key — never does.

## Trust model

Tauri's updater verifies every download against a minisign public key compiled into the binary. Two properties follow:

- **The private key must never be committed.** Anyone holding it can sign a build that every installed copy of mausVoice will accept and execute. It lives only in repository secrets.
- **The public key in a build must match the key that signed the manifest.** A build carrying a throwaway key cannot install a properly signed release, and vice versa. Rotating the key means shipping a new build before the next signed release.

Accordingly `apps/desktop/src-tauri/tauri.conf.json` commits `createUpdaterArtifacts: false` and an empty `pubkey`. Development builds, CI validation builds, and forks all produce unsigned installers with no updater artifacts. Only the release workflow, and only when the secrets exist, flips both on.

## Required secrets

| Secret                         | Purpose                                                                     |
| :----------------------------- | :-------------------------------------------------------------------------- |
| `UPDATER_PRIVATE_KEY`          | minisign private key Tauri signs bundles with (`TAURI_SIGNING_PRIVATE_KEY`) |
| `UPDATER_PRIVATE_KEY_PASSWORD` | passphrase for that key; set to an empty secret if the key has none         |
| `UPDATER_PUBLIC_KEY`           | matching public key, patched into `plugins.updater.pubkey` for the build    |

Generate a pair with `pnpm --filter desktop exec tauri signer generate -w ~/.tauri/mausvoice.key`. Keep the private key and its passphrase offline; store both halves plus the passphrase in the repository's secret store.

If `UPDATER_PRIVATE_KEY` or `UPDATER_PUBLIC_KEY` is missing, the release job emits a warning and degrades gracefully: installers still build and publish, but unsigned, with no `.sig` files and no manifest. Nothing silently ships a build that clients would refuse or, worse, wrongly trust.

## Release flow

1. **Resolve signing mode.** The build job checks for both key secrets and records `enabled=true|false`.
2. **Enable updater artifacts.** Only when signing is enabled: `createUpdaterArtifacts` is set to `true` and the real `pubkey` is patched into the config inside the build checkout. The edit is never committed.
3. **Build.** Each platform runs `tauri build`, producing installers plus, when signing is on, the updater bundles (`.app.tar.gz`, `.nsis.zip`, `.AppImage`) and a detached `.sig` beside each.
4. **Build the manifest.** After artifacts are downloaded, `scripts/ci/build-updater-manifest.mjs` pairs every updater bundle with its signature and writes `latest.json`.
5. **Publish.** `latest.json` and the `.sig` files are uploaded as release assets alongside the installers.
6. **Homebrew.** The cask job runs for stable releases only.

The app resolves the manifest from `https://github.com/maus-inc/mausVoice/releases/latest/download/latest.json`. GitHub's `releases/latest` always points at the newest **non-prerelease** release, so the endpoint is stable across versions and a pre-release cannot become the update target.

## The manifest builder

`scripts/ci/build-updater-manifest.mjs` maps bundles onto the target triples Tauri asks for: `darwin-aarch64` and `darwin-x86_64` both resolve to the single universal `.app.tar.gz`, `windows-x86_64` to the NSIS `.nsis.zip`, and `linux-x86_64` to the `.AppImage`. Each entry carries the contents of the corresponding `.sig` and a download URL against the release tag.

Two refusals are deliberate:

- **A bundle without a matching `.sig` fails the run.** An unsigned entry is worse than a missing one — the client would download it and then fail verification, which the user experiences as a broken install rather than "you are up to date". The error lists every unsigned bundle at once.
- **A prerelease never produces a manifest.** The publish job guards this, and the script asserts it again so a regression in the workflow cannot leak a pre-release into the stable channel.

`node --test scripts/ci/updater-manifest.test.mjs` drives the real script over fixture artifact trees covering all of the above.

## Client behaviour

`checkForAppUpdates()` in `apps/desktop/src/actions/updater.actions.ts` owns the check. Concurrent calls coalesce onto one in-flight promise, and a check is skipped while a download or install is running. It records `lastCheckedAt` on every outcome, including failures.

Passing `{ userInitiated: true }` marks a check the user asked for: it sets `upToDateConfirmed` when nothing is found so the UI can say so, opens the dialog even inside the three-day dismissal window, and suppresses the background toast because the Settings section reports the result inline.

Background checks run every six hours from `AppSideEffects` and are skipped in dev mode. The interval hook fires once on mount, so startup is still covered.

## Verifying a release

After a signed run, confirm that `latest.json` is attached to the release and lists every platform you built, that each `url` resolves against the release tag, and that a previous version of the app offered and installed the update. If you rotated the key, verify with a build carrying the new public key — an older build will correctly reject the new signature.
