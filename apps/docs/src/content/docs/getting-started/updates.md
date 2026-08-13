---
title: "Updates and release channels"
description: "Install newer builds safely and understand the current release workflow."
sidebar:
  order: 9
---

GitHub Releases is the source of truth for public versions and platform artifacts. Releases are created by a manually dispatched workflow that builds macOS universal, Windows, and Linux packages, publishes a GitHub release, and then updates the Homebrew cask. The cask job currently runs after prereleases too, so maintainers must choose that input deliberately.

Current packages are unsigned and self-built. The base Tauri configuration has no updater endpoints, while the production override still points at a legacy GitHub `latest.json` URL. The release workflow deliberately does not publish that updater manifest. In-app update indicators may exist in the interface, but do not assume the configured endpoint can deliver an update for a given build.

## Upgrade safely

- Read the release notes for migration or platform warnings.
- Close active dictations before replacing the application.
- Install the newer package using the same method used originally. Homebrew users can run `brew upgrade --cask mausvoice-desktop`.
- Launch the updated app and make a short test dictation.

Preferences and history are stored outside the application bundle, so replacing the executable is different from clearing local data. Still, back up important history before testing a pre-release. Treat a pre-release as an unsigned test build rather than the normal update path.
