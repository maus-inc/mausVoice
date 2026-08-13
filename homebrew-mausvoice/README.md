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
- The download URL is templated on `version`, so a new release is a one-line
  version bump.

Why not fully "latest" URL: the release asset is named with its version
(`mausVoice_<version>_universal.dmg`), and because every release is currently a
pre-release, GitHub's `releases/latest` redirect 404s. Homebrew casks therefore
need a concrete `version`; `livecheck` handles the "auto-detect latest" half.

## How the tap is published (automated)

The `release.yml` workflow in `maus-inc/mausVoice` publishes the cask
automatically on every release:

1. The `publish-cask` job downloads the freshly released macOS DMG and computes
   its SHA-256.
2. `scripts/ci/render-cask.mjs` stamps the `version` and `sha256` into the cask
   (source of truth lives here in `mausVoice`).
3. The job commits and pushes `Casks/mausvoice-desktop.rb` to this repository.

It authenticates with the `RELEASE_TOKEN` secret (the same maintainer token the
release job uses), so it must have `Contents: write` on
`maus-inc/homebrew-mausvoice`.

## First-time setup (one-off, manual)

Create the tap repository and seed it once, then CI takes over:

```bash
git clone https://github.com/maus-inc/mausVoice.git && cd mausVoice
git checkout <branch with homebrew-mausvoice/>
cd homebrew-mausvoice
git init -b main
git add Casks README.md
git commit -m "Add mausvoice-desktop cask"
git remote add origin https://github.com/maus-inc/homebrew-mausvoice.git
git push -u origin main
```

Verify:

```bash
brew tap maus-inc/mausvoice
brew install --cask mausvoice-desktop
brew audit --cask mausvoice-desktop
```

Until the first release runs through the new pipeline, the checked-in cask uses
`sha256 :no_check`; the first automated publish pins the real checksum.

## Notes

- The cask installs the **universal** build (`mausVoice_<version>_universal.dmg`),
  which runs on both Apple silicon and Intel Macs.
- The app is currently **unsigned / not notarized**. Gatekeeper shows an
  "unidentified developer" warning on first launch; right-click the app and
  choose **Open** to proceed. See the caveats in the cask.
- There is no separate dev-channel artifact today (the `dev` channel is just
  release cadence on the `main` branch), so there is no `-dev` cask. Add one
  only if a distinct dev build with a different bundle identifier is published.
