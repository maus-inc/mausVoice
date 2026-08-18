---
title: "Release process"
description: "Follow manual versioning through three-platform unsigned builds, release-body generation, publication, and Homebrew."
sidebar:
  order: 12
---

`.github/workflows/release.yml` runs only by manual dispatch. Inputs are version, prerelease status, optional release notes, and an optional tag; the default tag is `mausVoice-v{version}`. The workflow validates a restricted semver-like string and synchronizes the version in desktop `package.json`, base Tauri config, and production Tauri config inside the build checkout.

The non-fail-fast matrix produces:

- a universal Apple Silicon/Intel macOS build on macOS 14;
- Windows bundles on the current Windows runner;
- Debian and AppImage bundles on Ubuntu 22.04.

Each job installs pnpm/Rust/Bun, prepares platform toolchains and sidecars, builds frontend dependencies, and runs Tauri packaging. macOS requires its GPU sidecar; Windows/Linux currently do not hard-require theirs. Uploaded matrix artifacts expire after seven days but are consumed immediately by the publish job.

`scripts/ci/generate-release-body.mjs` discovers artifact basenames, creates download rows/chips, includes custom notes or commit subjects, warns when a platform is missing, and emits the required Groq/Deepgram key sentence. `softprops/action-gh-release` publishes a non-draft release with the requested prerelease flag. Builds are explicitly unsigned and unnotarized. The repository-visible throwaway updater key satisfies build machinery only; this workflow must not publish a trusted `latest.json`.

After release publication, the cask job downloads the exact expected universal DMG, computes SHA-256, renders `scripts/ci/render-cask.mjs`, and pushes `Casks/mausvoice-desktop.rb` to `maus-inc/homebrew-mausvoice`. It currently has no prerelease guard, so it runs after a successfully published prerelease too. A renamed/missing DMG therefore blocks cask publication even if another macOS artifact exists.

Before dispatch, review all version-bearing files and generated text with fixture artifact names. Afterward, verify each asset installs, the tag/title match, missing-platform warnings are absent, and Homebrew points to the same tag/checksum. Never test publication from an unreviewed fork or expose `RELEASE_TOKEN` in logs.
