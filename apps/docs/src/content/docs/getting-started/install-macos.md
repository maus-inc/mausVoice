---
title: "Install on macOS"
description: "Install an unsigned mausVoice release on macOS and grant the permissions dictation needs."
sidebar:
  order: 3
---

Current public artifacts are intentionally unsigned and are not notarized. macOS therefore requires an explicit first-open confirmation even when the download is valid.

## Disk image

1. Open the latest [mausVoice release](https://github.com/maus-inc/mausVoice/releases) and download the macOS `.dmg`.
2. Open the disk image and drag mausVoice into **Applications**.
3. In Finder, open **Applications**, Control-click mausVoice, choose **Open**, and confirm. Using the context menu is important when the normal double-click is blocked as coming from an unidentified developer.
4. Complete microphone and input/accessibility permission prompts during onboarding.

A warning by itself does not establish whether a file is safe. Verify that the download came from the `maus-inc/mausVoice` release page and inspect the release notes and checksums when supplied.

## Homebrew cask

The release workflow also updates a Homebrew cask after publishing a normal release:

```bash
brew tap maus-inc/mausvoice
brew install --cask mausvoice-desktop
```

Upgrade it later with:

```bash
brew upgrade --cask mausvoice-desktop
```

If macOS permissions were denied, open **System Settings → Privacy & Security** and review Microphone and Accessibility/Input Monitoring access for mausVoice. Permission labels can differ between macOS versions. Restart mausVoice after changing them so the native event tap and recorder are recreated.
