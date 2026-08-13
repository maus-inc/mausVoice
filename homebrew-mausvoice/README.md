# mausVoice Homebrew tap

A [Homebrew](https://brew.sh) tap that installs the **mausVoice** macOS app from
the official GitHub Releases.

## Install

```bash
brew tap maus-inc/mausvoice
brew install --cask mausvoice-desktop
```

Upgrade with:

```bash
brew upgrade --cask mausvoice-desktop
```

> `brew tap maus-inc/mausvoice` clones this repository
> (`maus-inc/homebrew-mausvoice`). The cask pulls the universal `.dmg` straight
> from the `maus-inc/mausVoice` GitHub Releases page.

## Version tracking (auto-resolve latest)

The cask uses a `livecheck` against
`https://github.com/maus-inc/mausVoice/releases.atom`, which includes
pre-releases. This means:

- `brew livecheck mausvoice-desktop` and `brew outdated --cask` automatically
  report the newest published release (including pre-releases).
- The download URL is templated on the release `tag` and asset `version`. A
  published cask is rendered from the repo template with the exact `version`,
  `tag`, and `sha256` (see "How the tap is published" below) — it is not edited
  by hand.

Why not fully "latest" URL: the release asset is named with its version
(`mausVoice_<version>_universal.dmg`), and because every release is currently a
pre-release, GitHub's `releases/latest` redirect 404s. Homebrew casks therefore
need a concrete `version`; `livecheck` handles the "auto-detect latest" half.

## How the tap is published (automated)

The `release.yml` workflow in `maus-inc/mausVoice` publishes the cask
automatically on every release:

1. The `publish-cask` job downloads the freshly released macOS DMG and computes
   its SHA-256.
2. `scripts/ci/render-cask.mjs` stamps the `version`, the release `tag`, and the
   `sha256` into the cask (source of truth lives here in `mausVoice`). It fails
   if the rendered cask still contains `:no_check`, so a checksum-less cask is
   never published.
3. The job commits and pushes `Casks/mausvoice-desktop.rb` to this repository.

It authenticates with the `RELEASE_TOKEN` secret (the same maintainer token the
release job uses), so it must have `Contents: write` on
`maus-inc/homebrew-mausvoice`.

## First-time setup (one-off, manual)

Create the tap repository and seed it with just this README; the `publish-cask`
job adds `Casks/mausvoice-desktop.rb` (with a real checksum) on the first
release:

```bash
git clone https://github.com/maus-inc/mausVoice.git && cd mausVoice
git checkout <branch with homebrew-mausvoice/>
cd homebrew-mausvoice
git init -b main
git add README.md
git commit -m "Add mausVoice tap"
git remote add origin https://github.com/maus-inc/homebrew-mausvoice.git
git push -u origin main
```

The cask is not committed here — it is rendered from the repo template on every
release. `render-cask.mjs` refuses to emit a cask that still contains
`:no_check`, so a checksum-less cask is never published.

Verify (after the first release has published the cask):

```bash
brew tap maus-inc/mausvoice
brew install --cask mausvoice-desktop
brew audit --cask mausvoice-desktop
```

## Notes

- The cask installs the **universal** build (`mausVoice_<version>_universal.dmg`),
  which runs on both Apple silicon and Intel Macs.
- The app is currently **unsigned / not notarized**. Gatekeeper shows an
  "unidentified developer" warning on first launch; right-click the app and
  choose **Open** to proceed. See the caveats in the cask.
- There is no separate dev-channel artifact today (the `dev` channel is just
  release cadence on the `main` branch), so there is no `-dev` cask. Add one
  only if a distinct dev build with a different bundle identifier is published.
