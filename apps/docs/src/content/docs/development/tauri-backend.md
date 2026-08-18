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
- `system/` owns audio feedback and snapshots, capabilities, bridge and remote transport, crypto, diagnostics, GPU/model information, machine identity, managed paths, storage, and tray behavior. It has no authentication module; the active local personal profile is implemented by the TypeScript `PersonalAuthRepo`.
- `db/`, `domain/`, and `state/` contain SQL queries/migrations, serialized domain types, and Tauri-managed resources.

Startup opens an SQLx pool with at most five connections, registers plugin-SQL migrations, purges old logs, writes startup diagnostics, creates the recorder/overlay/tray, and prewarms interaction audio. Closing the main window normally hides it rather than exiting. Windows includes WebView keepalive handling so background hotkeys survive occlusion.

Base `tauri.conf.json` identifies `com.mausinc.desktop`, builds an 1100×700 frameless window with an 800×600 minimum, bundles CPU/GPU transcription sidecars, and scopes the asset protocol to `$APPDATA/transcription-audio/**`. It declares a single updater endpoint resolving to the latest stable release's `latest.json`, with `createUpdaterArtifacts` disabled and an empty `pubkey` so no trust anchor is committed; the release workflow injects the real key and enables artifacts from secrets. The `tauri.dev.conf.json` and `tauri.prod.conf.json` overrides now only set product name and identifier.

Return structured errors across invokes and treat a missing sidecar/pill as a recoverable runtime condition where possible. Keep capability JSON and filesystem/shell scope narrow. After changing Specta-exposed commands or types, run `pnpm gen:bindings` from the root and inspect `packages/desktop-native-apis/src/bindings.ts` rather than editing generated declarations by hand.

## Command registration

1. Add `#[tauri::command]` and `#[specta::specta]` in `commands.rs`.
2. Register the command in `app.rs` `invoke_handler`.
3. Add it to `collect_commands!` in `examples/gen_bindings.rs`.
4. Run `pnpm gen:bindings`.
5. Call the generated wrapper from a repo, then an action — not from a raw UI handler.

Typical domains: `start_recording` / `stop_recording` / `list_microphones`, `paste` / `simulate_type`, `transcription_*`, `user_*`, `api_key_*` (encrypt before persist).

## Security reminder

External provider hosts belong in CSP `connect-src` and `http:default`, **not** `remote.urls`. `remote.urls` stays localhost-only so those origins cannot invoke IPC. Never add `*` to CSP.
