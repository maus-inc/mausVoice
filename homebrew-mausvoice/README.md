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
- The download URL is templated on `version`, so when a new release lands,
  bumping the single `version` line is all that's needed.

Why not fully "latest" URL: the release asset is named with its version
(`mausVoice_<version>_universal.dmg`), and because every release is currently a
pre-release, GitHub's `releases/latest` redirect 404s. Homebrew casks therefore
need a concrete `version`; `livecheck` handles the "auto-detect latest" half.

## Publishing this tap

This directory is the source of the tap. To publish it:

1. Create a public GitHub repository named `homebrew-mausvoice` under the
   `maus-inc` organization.
2. Push the contents of this directory to it (keep the `Casks/` layout):

   ```bash
   git init homebrew-mausvoice && cd homebrew-mausvoice
   git remote add origin git@github.com:maus-inc/homebrew-mausvoice.git
   git add Casks README.md
   git commit -m "Add mausvoice-desktop cask"
   git push -u origin main
   ```

3. Verify:

   ```bash
   brew tap maus-inc/mausvoice
   brew install --cask mausvoice-desktop
   brew audit --cask mausvoice-desktop
   ```

## Pinning the checksum

The cask currently ships with `sha256 :no_check` because releases are unsigned
pre-releases whose checksums change frequently. Once releases stabilize, pin the
real checksum of the published `.dmg`:

```bash
shasum -a 256 mausVoice_<version>_universal.dmg
```

and replace `sha256 :no_check` with `sha256 "<checksum>"`.

## Notes

- The cask installs the **universal** build (`mausVoice_<version>_universal.dmg`),
  which runs on both Apple silicon and Intel Macs.
- The app is currently **unsigned / not notarized**. Gatekeeper shows an
  "unidentified developer" warning on first launch; right-click the app and
  choose **Open** to proceed. See the caveats in the cask.
- There is no separate dev-channel artifact today (the `dev` channel is just
  release cadence on the `main` branch), so there is no `-dev` cask. Add one
  only if a distinct dev build with a different bundle identifier is published.
