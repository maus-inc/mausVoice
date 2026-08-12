---
title: macOS
description: Install mausVoice on macOS.
---

## Download

Download the latest release from the [download page](https://maus-inc.github.io/mausVoice/).

1. Open the downloaded `.dmg` file.
2. Drag the mausVoice icon into the Applications folder.
3. Eject the disk image.
4. Open mausVoice from your Applications folder. On first launch, macOS may ask you to confirm since the app was downloaded from the internet — click **Open**.

## Homebrew

You can also install mausVoice via [Homebrew](https://brew.sh):

```bash
brew tap mausvoice/mausvoice
brew install --cask mausvoice-desktop
```

Upgrade with:

```bash
brew upgrade --cask mausvoice-desktop
```

To install the development channel instead:

```bash
brew install --cask mausvoice-desktop-dev
```
