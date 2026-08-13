---
title: "Tauri backend"
description: "Work with native commands, managed state, platform modules, database setup, audio, crypto, and capabilities."
sidebar:
  order: 5
---

The Rust application lives in `apps/desktop/src-tauri/`. `main.rs` configures the Linux display backend/X11 threading before Tauri and can relaunch the same binary in keyboard-listener or GPU-enumerator modes. `app.rs` installs plugins, managed state, native services, the invoke handler, and lifecycle behavior.

## Source ownership

- `commands.rs` is the frontend command surface for recording, permissions, keyboard, insertion, database entities, audio snapshots, diagnostics, pairing, and receiver/sender operations.
- `platform/` contains OS-specific focus, keyboard, paste, audio, overlay, and permission code.
- `system/` owns paths, crypto, diagnostics, GPU/model information, tray, auth, storage, and remote transport.
- `db/`, `domain/`, and `state/` contain SQL queries/migrations, serialized domain types, and Tauri-managed resources.

Startup opens an SQLx pool with at most five connections, registers plugin-SQL migrations, purges old logs, writes startup diagnostics, creates the recorder/overlay/tray, and prewarms interaction audio. Closing the main window normally hides it rather than exiting. Windows includes WebView keepalive handling so background hotkeys survive occlusion.

Base `tauri.conf.json` identifies `com.mausinc.desktop`, builds an 1100×700 frameless window with an 800×600 minimum, bundles CPU/GPU transcription sidecars, and scopes the asset protocol to `$APPDATA/transcription-audio/**`. Its updater endpoint list is empty; `tauri.prod.conf.json` contains a legacy release endpoint, while the current unsigned release workflow intentionally publishes no trusted `latest.json`.

Return structured errors across invokes and treat a missing sidecar/pill as a recoverable runtime condition where possible. Keep capability JSON and filesystem/shell scope narrow. After changing Specta-exposed commands or types, run `pnpm gen:bindings` from the root and inspect `packages/desktop-native-apis/src/bindings.ts` rather than editing generated declarations by hand.
