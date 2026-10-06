# Capabilities

Every entry in this folder is a Tauri capability: the list of windows it applies to and the set of plugin permissions those windows get. `default.json` is the only file, and it carries the identifier `default`.

## What this file does and does not control

Four separate mechanisms are often confused for one. Getting them mixed up is how a Tauri app ends up with a hole, or with a permission nobody can explain later.

| Mechanism | Where it lives | What it decides |
| --- | --- | --- |
| `windows` | this file | Which webview labels may call native commands at all |
| `remote.urls` | this file | Which remote origins may call native commands at all |
| `permissions` | this file | Which plugin commands those windows may invoke |
| webview CSP `connect-src` | `tauri.conf.json` | Which hosts the page's own `fetch` may reach |
| `assetProtocol.scope` | `tauri.conf.json` | Which local files the `asset:` protocol may serve |

`remote.urls` and the permissions list solve different problems. A capability scoped to loopback only means a hosted page cannot invoke `simulate_type`. It says nothing about where the app's own JavaScript may send a request, which is the CSP's job. Both lists need updating when a provider is added, and `security.csp` in `tauri.conf.json` holds the mirror. The `csp-connect-src` contract test guards that mirror.

## The `default` capability

Applies to `main` and `floating-*`. Twenty permissions, in four groups.

**Core window and lifecycle.** `core:default`, `core:event:default`, `log:default`, `autostart:default`, `updater:default`, `process:default`, `dialog:default`, `window-state:default`. The six explicit `core:window:allow-*` entries (`start-dragging`, `start-resize-dragging`, `minimize`, `maximize`, `unmaximize`, `close`) are the ones the pill window needs and `core:default` does not include.

**Shell.** `shell:allow-spawn` is restricted to the two transcription sidecars by name, with `sidecar: true` and `args: true`, so the allowlist cannot be widened to an arbitrary binary by a later edit. `shell:allow-kill` and `shell:allow-stdin-write` are unscoped on purpose: both can only address a process this app already started.

Shell commands an agent runs at a user's request do not use this permission at all. They go through the `run_terminal_command` Tauri command, which validates against a Rust-side `ALLOWED_COMMANDS` table and rejects forbidden shell characters. That split is deliberate. `shell:allow-execute` is never granted, with or without a `cmd` restriction, because Tauri filters its arguments as an allowlist of literal tokens while an agent needs to pass a composed command line.

**Files.** `opener:default` plus `opener:allow-open-path` scoped to `$APPLOG` and `$APPLOG/**`, so the app can open its own logs and nothing else on disk.

**Network.** `http:default` with an explicit HTTPS host allowlist and no wildcard. A `https://*` entry would let injected page script exfiltrate to any TLS host through Rust, sidestepping the webview CSP entirely, because plugin-http executes the request in the Rust process where CSP cannot see it.

## Computer use

The computer-use commands (`list_displays`, `capture_screen`, `capture_screen_region`, and the fourteen `computer_use_*` commands) need no new permission here. They are `#[tauri::command]` functions in the app itself rather than plugin commands, so Tauri does not gate them, and no remote origin can reach them because `remote.urls` is loopback-only.

That leaves one hole worth naming. A `floating-*` webview runs the app's own code, holds the same capability as `main`, and shows content the user did not author. If such a window could capture the screen or move the pointer, it would be an input device. A capability cannot express this, because capabilities restrict a command wholesale and these commands are safe for one caller and not the other. So the check lives in Rust instead: every computer-use command takes a `tauri::WebviewWindow` and calls `require_computer_use_window`, which rejects any label other than `main`. The window argument is the capability token.

## Changing this file

Adding a permission needs three things, not one:

1. The entry here.
2. The matching host in `security.csp`'s `connect-src` in `tauri.conf.json`, when it is a network permission. The contract test enforces this direction.
3. A line in this README saying what it permits and why it is not wider.

Never add a wildcard to any CSP directive. Never extend `dangerousDisableAssetCspModification` in `tauri.conf.json` beyond the existing `["style-src"]`. That array disables Tauri's automatic CSP injection for the asset protocol on the listed directives only, and `style-src 'self' 'unsafe-inline'` is what Emotion and MUI runtime styles need. It does not relax `script-src`.