---
title: "Updates and release channels"
description: "How mausVoice checks for new versions, installs them, and what to do when the built-in updater cannot."
sidebar:
  order: 9
---

mausVoice updates itself from GitHub Releases. The app reads a manifest published alongside each stable release; the manifest references signed updater downloads, and mausVoice verifies each download's signature against a public key compiled into the app before replacing itself. An artifact that fails verification is discarded, so a tampered or mirrored download cannot be installed.

## How the app checks

The desktop app checks for updates when it starts and every six hours after that, as long as the window is not hidden. Development builds never check, because they run against a locally built bundle no release manifest describes.

When a newer version exists you will see:

- the update dialog, unless you turned off **Automatically show updates** or dismissed the dialog within the last three days;
- an **Update ready** entry in the dashboard menu;
- a badge on the menu bar / tray icon;
- on Windows and Linux, a toast, because the tray badge is easy to miss there.

## Check on demand

Open **Settings → More settings → Software update**. The section shows the version you are running and when the app last checked, and the **Check now** button runs a check immediately. A manual check reports its outcome inline — _You're up to date_, the version that is available, or a connection error — and it ignores the three-day dismissal window, so it will show you an update you previously snoozed.

## Installing

Choose **Update** in the dialog and mausVoice downloads the new version with a progress bar, installs it, and restarts. Your preferences, history, dictionary, and API keys live outside the application bundle and are untouched.

On macOS, if the app is running from a location it cannot write to — a read-only volume, a quarantined download, or a directory owned by another user — the in-place update fails. mausVoice detects this and falls back to downloading the `.pkg` installer and opening it in Installer.app; that path only ever downloads over HTTPS from `github.com`. The cleanest fix is to move mausVoice into `/Applications` and update from there.

Homebrew users can also run `brew upgrade --cask mausvoice-desktop`. The tap is only ever pointed at stable releases.

## Release channels

There is a single stable channel. Pre-releases are published to GitHub with installers so you can download and test them deliberately, but they are never served to the updater and never pushed to the Homebrew tap, so a pre-release cannot arrive on your machine on its own. A pre-release build is not OS-code-signed (no Apple notary, no Windows codesign), even when the updater bundles it references are signed: read the notes, and back up important history before installing one.

## When updating fails

- **"Could not check for updates."** The app could not reach GitHub. Check your connection or a corporate proxy, then use **Check now**.
- **The install fails on macOS.** See the read-only case above; move the app to `/Applications`.
- **You would rather not auto-update.** Turn off **Automatically show updates** to stop the dialog appearing on its own. The app still checks in the background so the menu entry stays accurate, and nothing installs without you choosing **Update**.

Downloading the newer installer from the [releases page](https://github.com/maus-inc/mausVoice/releases) and installing over the top always works as a fallback. Close any active dictation first, then launch the updated app and make a short test dictation to confirm your setup survived.
