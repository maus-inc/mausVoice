---
title: "Register App"
description: "Capture the focused application as a target so you can give it per-app writing styles and insertion settings."
sidebar:
  order: 11
---

Registering an app captures the currently focused application as an **app target** — a local record mausVoice keeps so it can apply per-application preferences when you dictate into that app. This page describes what registration does, when it happens automatically, how to trigger it manually, and what to check when it does not behave as expected.

## What Register App does

When you register, mausVoice asks the operating system for the **foreground (focused) application** at that instant and creates or updates a single row for it:

- **Detection:** on macOS via `NSWorkspace.frontmostApplication.localizedName` and its `icon`; on Windows and Linux via the focused-window tracker (`ferrous-focus`), which prefers the app name parsed from the window title (text after the last ` — `, ` – `, or ` - `) and falls back to the process/binary name (prettified, e.g. `chrome.exe` → `Chrome`). The name is normalized to an ID by lowercasing, replacing non-alphanumeric runs with `_`, and trimming underscores (empty results receive a generated `app_target_…` ID).
- **Storage:** one row per app in the local SQLite database (`app_targets` table, field `id` = normalized name, `name` = display name, `created_at` preserved on updates) and mirrored in the frontend state `appTargetById`. An app icon is also saved: the OS icon rendered to 128 px PNG, base64-encoded over IPC, and uploaded to local storage at a per-app path (only if present and only when the target is new or missing an icon).
- **Effect:** the app appears in the app list used by **Writing Styles** (`Settings → Writing Styles` / `AppStylingLayout`) and the per-app rows of **Settings → General → Text insertion options**. Once a row exists you can set, per app:
  - **Writing style (tone)** — `toneId`, used at the end of dictation when styling mode is *Based on app*.
  - **Insertion method** — `insertionMethod` (`paste` vs simulated typing).
  - **Paste keybind** — `pasteKeybind` (Windows/Linux; e.g. `Shift+Insert`).
  - **Typing speed** — `typingSpeedMs` (delay between simulated keystrokes).

Registration never changes the global defaults. It only adds (or refreshes) the row so per-app overrides become possible.

## When registration happens automatically

You rarely need to register by hand. The app also registers on its own:

1. **Dictation strategy** — each ordinary dictation calls `tryRegisterCurrentAppTarget()` at startup (`DictationStrategy.loadAppTarget` / `DictationSideEffects`) to ensure the current target exists before post-processing chooses a style.
2. **Tray label sync** — after successful detection the frontend calls `set_register_app_label` so the tray menu shows `Register current app [AppName]` as a preview of what the next click would register.
3. **Icon refresh** — an existing target without an `iconPath` is treated as needing registration again, so its icon is fetched and saved on the next dictation.

If the app already exists and already has an icon, automatic dictation-time registration is a no-op for storage (the row is still returned so post-processing can resolve `toneId`).

## How to register manually

Use manual registration when the desired app has never been dictated into, or when you want an explicit row for it without dictating first.

### From the tray / menu-bar icon

1. Focus the application you want to register (click its window so it is foreground).
2. Click the **mausVoice** tray icon (Windows/Linux) or menu-bar icon (macOS).
3. Choose **Register current app** — when detection has already run the item reads **Register current app [AppName]** so you can confirm before clicking.
4. Return to mausVoice and open **Writing Styles**. The newly registered app appears alphabetically in the list. If it is missing, try the step again without changing focus.

This path works even when mausVoice itself is not the active window, because the OS still reports the previously focused app at the moment of detection (with a 2-second timeout on the `get_current_app_info` Tauri command).

### From the Writing Styles page

**Writing Styles** shows a **How it works** empty state when no targets exist:

> 1. Open the app you want to style (like Slack or Chrome).  
> 2. Click the mausVoice icon in the menu bar and click "Register current app".  
> 3. Go back to mausVoice and select a writing style for that app.

Follow those three steps; the list populates after the tray action completes. Dictating once into the target app has the same effect, because dictation also registers automatically.

## What changes after registration

- **New row in Writing Styles** — sorted alphabetically by `name`. Each row has a style selector for its `toneId`.
- **New row in Text insertion options** — on Windows and Linux the per-app overflow menu and the dedicated dialog (`AppKeybindingsDialog`, reachable from `Settings → General → Text insertion options`) expose insertion method, paste keybind, and typing speed for that target. On macOS these insertion overrides are not shown.
- **Tray label preview** — the tray item updates to `Register current app [MostRecentName]` so the next manual registration is explicit.
- **No automatic style assignment** — a freshly registered row has `toneId = null` (or the global paste keybind as its initial `pasteKeybind`). It behaves like any other target until you assign values.

During dictation with **Styling mode = Based on app**, mausVoice resolves the foreground app again at the end of processing and uses that target's `toneId`. With **Manual mode + Automatic style loading**, registration also enables the best-effort load/save cycle that restores the last manually chosen style for the focused app on the next dictation.

## Per-app settings explained

| Field | Where to set it | What it controls |
| --- | --- | --- |
| **Writing style** (`toneId`) | Writing Styles row → style selector | Which writing instructions post-processing uses when that app is focused. |
| **Insertion method** (`insertionMethod`) | Text insertion options → per-app override | Whether dictated text is delivered via clipboard paste or simulated keystrokes. |
| **Paste keybind** (`pasteKeybind`) | Text insertion options → per-app override (Windows/Linux) | Key sequence the paste path sends (default `Shift+Insert`). |
| **Typing speed** (`typingSpeedMs`) | Text insertion options → per-app override | Delay between simulated keystrokes; raise it when fast typing drops characters. |

These four fields are independent. A style can be set without touching insertion, and vice versa. Refer to [Application-aware styling](./app-specific-styling/) and [Text insertion options](../../configuration/text-insertion-options/) for the full behavior of each control.

## Troubleshooting

**Wrong app was registered.** Focus is sampled at the instant detection runs and times out after 2 seconds. If you switched windows too quickly — or if an overlay, launcher, or the mausVoice window itself was foreground — the sampled name may not be the one you intended. Focus the intended app, wait a moment, then choose **Register current app** again without clicking anything else in between. The tray label `Register current app [Name]` shows what will be registered before you click.

**App not detected / shows "Unknown application".** Detection is best-effort. Elevated (admin/root) windows, remote-desktop viewers, sandboxed or Wayland sessions (Linux), and unusual window managers can hide or return an empty window title/process name. The Rust layer maps these to `AppInfoError::Unsupported`, `PermissionDenied`, or `NotAvailable`. Fix: run mausVoice at the same privilege level as the target (see [Permissions](../../getting-started/permissions/) and [Linux / Wayland](../../troubleshooting/linux-wayland/)), and keep the destination focused through the release of the dictation shortcut.

**Similar names create separate or unexpected rows.** Two variants (e.g. `Chrome` vs `Chrome Beta`, a browser PWA, or `code` vs `Code — Insiders`) normalize to different IDs and thus different rows. Assign the style to the exact name shown in Writing Styles. On Windows/Linux, title parsing takes the text after the last separator, so a heavily branded window title may resolve differently than its executable name.

**Icon missing.** A target can exist without `iconPath` if the OS did not return an icon or the upload failed; dictation will try to fetch it again on the next visit (`shouldRegisterAppTarget = !existingApp || !existingApp.iconPath`). This is cosmetic and does not affect styling or insertion.

**Row not appearing after registration.** Confirm that registration succeeded by checking Writing Styles sorted alphabetically. If you registered while mausVoice held focus, the name sampled may have been "mausVoice" itself. Refocus the intended app and register again with mausVoice in the background.

## Privacy

App registration is entirely local. The app name, normalized ID, creation timestamp, chosen `toneId` / insertion preferences, and the rendered app icon PNG are stored in the local SQLite database and app storage on this device; they are never sent to transcription or styling providers. Removing a target's row (by clearing its local data) deletes these fields. The OS-level detection runs on-device and requires no additional network permission.
