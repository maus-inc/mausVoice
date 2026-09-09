---
title: "Auto-update pipeline"
description: "How signed updater bundles are verified and published, and how the desktop app consumes their manifest."
sidebar:
  order: 14
---

The updater is a code-execution channel: whatever the manifest names is downloaded, verified, and run on a user's machine. The pipeline therefore treats endpoints, build artifacts, and release metadata as untrusted inputs; the signing key is the only trust anchor and never lives in the repository.

## Trust model

Tauri's updater verifies every download against a minisign public key compiled into the binary. Tauri serializes its public-key file and detached signatures as Base64 values; its runtime decodes those values before verification. Two properties follow:

- **The private key must never be committed.** Anyone holding it can sign a build that every installed copy of mausVoice will accept and execute. It lives only in repository secrets.
- **The public key in a build must match the key that signed the updater bundles.** The manifest references those bundles, and Tauri verifies each download against the compiled-in key; the manifest itself is not signed. A build carrying a throwaway key cannot install a properly signed release, and vice versa. Rotating the key means shipping a new build before the next signed release.

Accordingly `apps/desktop/src-tauri/tauri.conf.json` commits `createUpdaterArtifacts: false` and an empty `pubkey`. Development builds, CI validation builds, and forks all produce unsigned installers with no updater artifacts. Only the release workflow, and only when the secrets exist, flips both on.

## Required secrets

| Secret                         | Purpose                                                                            |
| :----------------------------- | :--------------------------------------------------------------------------------- |
| `UPDATER_PRIVATE_KEY`          | Tauri's Base64-serialized minisign private-key value (`TAURI_SIGNING_PRIVATE_KEY`) |
| `UPDATER_PRIVATE_KEY_PASSWORD` | passphrase for that key; set to an empty secret if the key has none                |
| `UPDATER_PUBLIC_KEY`           | matching Base64-serialized public-key value, patched into `plugins.updater.pubkey` |

Keep these values exactly as `tauri signer generate` wrote them; do not Base64-decode or reformat them before storing them. The release workflow decodes the public key and generated `.sig` files only for its independent `minisign` command-line verification.

Generate a pair with `pnpm --filter desktop exec tauri signer generate -w ~/.tauri/mausvoice.key`. Keep the private key and its passphrase offline; store both halves plus the passphrase in the repository's secret store.

:::caution[Keep generated keys outside the checkout]
Create the key files outside the repository. In PowerShell, use an explicit home-directory path:

```powershell
pnpm --filter desktop exec tauri signer generate -w "$HOME\.tauri\mausvoice.key"
```

Set the secrets with `-b` so PowerShell passes each generated value as one argument:

```powershell
gh secret set UPDATER_PRIVATE_KEY --repo maus-inc/mausVoice -b (Get-Content -Raw "path\to\mausvoice.key")
gh secret set UPDATER_PUBLIC_KEY  --repo maus-inc/mausVoice -b (Get-Content -Raw "path\to\mausvoice.key.pub")
gh secret set UPDATER_PRIVATE_KEY_PASSWORD --repo maus-inc/mausVoice
```

`Get-Content -Raw` preserves the generated value as one string. Do not edit or re-encode either key file before storing it.
:::

If `UPDATER_PRIVATE_KEY` or `UPDATER_PUBLIC_KEY` is missing, the build job emits a warning and builds unsigned installers with no `.sig` files and no manifest. Publishing then depends on the channel, and a **stable release fails closed**: the manifest-eligibility gate in the publish job errors out (`::error::`, non-zero exit) before anything is uploaded, because clients resolve `latest.json` from `releases/latest/download/` and a stable release without it would 404 every installed copy and permanently disable updates. A prerelease is the one case that degrades gracefully: it publishes the unsigned installers and deliberately skips the manifest. Nothing silently ships a build that clients would refuse or, worse, wrongly trust.

## Release flow

1. **Resolve signing mode.** The build job checks for both key secrets and records `enabled=true|false`.
2. **Enable updater artifacts.** Only when signing is enabled: `createUpdaterArtifacts` is set to `true` and the real `pubkey` is patched into the config inside the build checkout. The edit is never committed.
3. **Build.** Each platform runs `tauri build`, producing installers plus, when signing is on, the updater bundles (`.app.tar.gz`, `.nsis.zip`, `.AppImage`) and a detached `.sig` beside each.
4. **Resolve manifest eligibility.** The publish job derives the channel from the version itself. A version whose prerelease identifier disagrees with the workflow's prerelease input fails the job; a prerelease skips the manifest; a stable release missing the signing secrets fails closed rather than publish without `latest.json`.
5. **Verify signatures.** For a stable release, the workflow decodes Tauri's Base64 key and `.sig` values to temporary files, then has `minisign` verify every recognized updater bundle before a manifest is written.
6. **Build the manifest.** After artifacts are downloaded and verified, `scripts/ci/build-updater-manifest.mjs` pairs every updater bundle with its signature and writes `latest.json`.
7. **Publish.** `latest.json` and the `.sig` files are uploaded as release assets alongside the installers.
8. **Homebrew.** The cask job runs for stable releases only.

The app resolves the manifest from `https://github.com/maus-inc/mausVoice/releases/latest/download/latest.json`. GitHub's `releases/latest` always points at the newest **non-prerelease** release, so the endpoint is stable across versions and a pre-release cannot become the update target.

## The manifest builder

`scripts/ci/build-updater-manifest.mjs` maps bundles onto the target triples Tauri asks for: `darwin-aarch64` and `darwin-x86_64` both resolve to the single universal `.app.tar.gz`, the bare `windows-x86_64` key prefers the MSI installer (NSIS is published under the installer-specific `windows-x86_64-nsis` key), and `linux-x86_64` to the `.AppImage`. Each entry carries the contents of the corresponding `.sig` and a download URL against the release tag.

Two refusals are deliberate:

- **A bundle without a matching `.sig` fails the run.** An unsigned entry is worse than a missing one. The client would download it and then fail verification, which the user experiences as a broken install rather than "you are up to date". The error lists every unsigned bundle at once.
- **A prerelease never produces a manifest.** The publish job guards this, and the script asserts it again so a regression in the workflow cannot leak a pre-release into the stable channel.

`node --test scripts/ci/updater-manifest.test.mjs` drives the real script over fixture artifact trees covering all of the above.

## Client behaviour

`checkForAppUpdates()` in `apps/desktop/src/actions/updater.actions.ts` owns the check. Concurrent calls coalesce onto one in-flight promise, and a check is skipped while a download or install is running. It records `lastCheckedAt` on every outcome, including failures.

Passing `{ userInitiated: true }` marks a check the user asked for: it sets `upToDateConfirmed` when nothing is found so the UI can say so, opens the dialog even inside the three-day dismissal window, and suppresses the background toast because the Settings section reports the result inline.

Background checks run every six hours from `AppSideEffects` and are skipped in dev mode. The interval hook fires once on mount, so startup is still covered.

## Verifying a release

After a signed run, confirm that `latest.json` is attached to the release and lists every platform you built, that each `url` resolves against the release tag, and that a previous version of the app offered and installed the update. If you rotated the key, verify with a build carrying the new public key. An older build will correctly reject the new signature.
