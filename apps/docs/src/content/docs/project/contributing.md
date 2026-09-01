---
title: "Contributing"
description: "Prepare focused changes that fit the architecture and include the right validation."
sidebar:
  order: 1
---

Start from a current checkout and read the issue or source area before proposing behavior. Keep pull requests narrow enough to review: provider, native overlay, persistence, and documentation changes often have different test matrices.

For code, run the focused package tests plus root lint, type, and build commands that cover affected workspaces. For a Tauri command change, regenerate native TypeScript bindings. For a user-visible string, run i18n extraction/synchronization. For a migration, test fresh and upgraded databases. For docs, run Astro type checking and the production build.

Document privacy and platform differences explicitly. Do not claim all processing is offline when post-processing or API transcription is enabled, and do not present one compositor's input method as universal Linux behavior.

Open an issue for significant behavioral proposals so maintainers can confirm direction. Contributions are licensed under the repository's AGPLv3 terms.
