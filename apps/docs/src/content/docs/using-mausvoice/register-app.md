---
title: "Register App"
description: "Capture the focused application so you can give it per-app writing styles and insertion settings."
sidebar:
  order: 11
---

Registering an app captures the currently focused application as an **app target** — a local record mausVoice keeps so it can apply per-application preferences when you dictate into that app. This guide describes what registration does, when it happens automatically, how to trigger it manually, and what to check when it does not behave as expected.

## What Register App does

When you register, mausVoice asks the operating system for the **foreground application** at that instant and creates or updates a single entry for it:

- **Detection** identifies the app by its display name, preferring the name shown in the window title and falling back to the executable name when needed. The name is normalized into a stable identifier so "Google Chrome" and "google-chrome" resolve to the same target.
- **Storage** saves the target locally on this device — its display name, creation time, chosen writing style, insertion preferences, and a small rendered copy of the app icon. If the system cannot provide an icon, mausVoice stores a generated placeholder instead, so every target has an image.
- **Effect** makes the app appear in **Writing Styles** and in **Settings → General → Text insertion options**. Once a target exists you can customize it per app:
  - **Writing style** — which style post-processing uses when that app is focused.
  - **Insertion method** — whether text is delivered by clipboard paste or simulated typing.
  - **Paste keybind** — which shortcut the paste path sends (e.g. Shift+Insert).
  - **Typing speed** — delay between simulated keystrokes when typing is used.

Registration never changes the global defaults. It only adds (or refreshes) the entry so per-app overrides become possible.

## When registration happens automatically

You rarely need to register by hand. mausVoice also registers on its own:

1. **During dictation** — each ordinary dictation ensures the current target exists before choosing a style, so simply dictating into a new app registers it.
2. **Tray label preview** — after detection the tray menu updates to **Register current app [AppName]** so you can see what the next manual registration would capture.
3. **Icon refresh** — if an existing target is missing its icon, the next dictation fetches and saves it.

If the app already exists and already has an icon, automatic registration does not create duplicate data; it simply reuses the existing entry.

## How to register manually

Use manual registration when the desired app has never been dictated into, or when you want an explicit entry for it without dictating first.

### From the tray / menu-bar icon

1. Focus the application you want to register (click its window so it is foreground).
2. Click the **mausVoice** tray icon (Windows/Linux) or menu-bar icon (macOS).
3. Choose **Register current app** — when detection has already run the item reads **Register current app [AppName]** so you can confirm before clicking.
4. Return to mausVoice and open **Writing Styles**. The newly registered app appears alphabetically in the list. If it is missing, try the step again without changing focus.

This works even when mausVoice itself is not active, because the system still reports the previously focused app at the moment of detection (with a short timeout).

### From the Writing Styles page

**Writing Styles** shows a **How it works** empty state when no targets exist:

> 1. Open the app you want to style (like Slack or Chrome).  
> 2. Click the mausVoice icon in the menu bar and click "Register current app".  
> 3. Go back to mausVoice and select a writing style for that app.

Follow those three steps; the list populates after the tray action completes. Dictating once into the target app has the same effect.

## What changes after registration

- **New row in Writing Styles** — sorted alphabetically. Each row has a style selector. A freshly registered row starts with no style assigned and behaves like any other target until you choose one.
- **New entry in Text insertion options** — the dedicated dialog (**Settings → General → Text insertion options**) lists insertion method, paste keybind, and typing speed for that target on all platforms. In the **Writing Styles** list itself, the overflow menu that exposes the paste shortcut is hidden on macOS (use the Settings dialog there instead).
- **Tray label preview** — the tray item updates to **Register current app [MostRecentName]** so the next manual registration is explicit.
- **No automatic style assignment** — a new entry starts with the global paste shortcut as its initial value and no writing style; assign what you need.

During dictation with **Styling mode = Based on app**, mausVoice checks the foreground app again at the end of processing and uses that target's style. With **Manual mode + Automatic style loading**, registration also enables the cycle that restores the last manually chosen style for the focused app on the next dictation.

## Per-app settings explained

| Setting | Where to set it | What it controls |
| --- | --- | --- |
| **Writing style** | Writing Styles row → style selector | Which writing instructions post-processing uses when that app is focused. |
| **Insertion method** | Text insertion options → per-app override | Whether dictated text is delivered via clipboard paste or simulated keystrokes. |
| **Paste keybind** | Text insertion options → per-app override | Key sequence the paste path sends. |
| **Typing speed** | Text insertion options → per-app override | Delay between simulated keystrokes; raise it when fast typing drops characters. |

These settings are independent. A style can be set without touching insertion, and vice versa. Refer to [Application-aware styling](./app-specific-styling/) and [Text insertion options](../../configuration/text-insertion-options/) for full behavior.

## Troubleshooting

**Wrong app was registered.** Focus is sampled at the instant detection runs. If you switched windows too quickly — or an overlay, launcher, or the mausVoice window itself was foreground — the sampled name may not be the one you intended. Focus the intended app, wait a moment, then choose **Register current app** again without clicking anything else. The tray label **Register current app [Name]** shows what will be registered before you click.

**App not detected / shows "Unknown application".** Detection is best-effort. Elevated (admin/root) windows, remote-desktop viewers, sandboxed or Wayland sessions, and unusual window managers can hide the focused app. Fix: run mausVoice at the same privilege level as the target (see [Permissions](../../getting-started/permissions/) and [Linux / Wayland](../../troubleshooting/linux-wayland/)) and keep the destination focused through the release of the dictation shortcut.

**Similar names create separate rows.** Variants such as "Chrome" vs "Chrome Beta", a browser PWA, or different packaged builds normalize to different entries. Assign the style to the exact name shown in Writing Styles.

**Icon missing or generic.** This is cosmetic. If an icon could not be fetched, mausVoice stores a placeholder gradient instead. A later dictation will try again to fetch the real icon when the app is focused.

**Row not appearing after registration.** Verify the list is sorted alphabetically. If you registered while mausVoice held focus, the sampled name may have been "mausVoice" itself. Refocus the intended app and register again with mausVoice in the background.

## Privacy

App registration is stored locally on this device — the app name, creation time, chosen style and insertion preferences, and the rendered icon. This data is not sent to transcription or styling providers.

Two additional retention paths to be aware of:

- **Stored icons remain on disk separately.** Clearing app data removes the database entries for targets, but previously rendered icons stored under the app-icons directory are not deleted automatically. If you need them removed, clear the app storage directory as well (see [Clear local data](../../configuration/clear-local-data/) and [Data locations](../../reference/data-locations/)).
- **Optional analytics.** When an analytics token is configured, mausVoice sends the focused app's display name in an "App Used" analytics event at dictation time. This is distinct from provider traffic and only occurs when analytics is enabled.

OS-level detection runs on-device and requires no additional network permission.

## Appendix: Technical notes

Implementation details that are useful for contributors but not needed for everyday use:

- **Platform detection** uses native APIs per OS (macOS via the workspace's frontmost application; Windows/Linux via the focused-window tracker). Title parsing prefers text after the last ` — `, ` – `, or ` - ` separator before falling back to the process name.
- **Identifier normalization** lowercases the name, replaces non-alphanumeric runs with `_`, and trims underscores. Empty results receive a generated `app_target_…` identifier.
- **Icon handling** renders the OS icon to a small PNG (base64 over IPC) and uploads it to per-user app storage. Failures fall back to a generated gradient placeholder, so storage never silently skips the icon.
- **Error handling** for detection failures maps to user-visible "Unknown application" and best-effort retry rather than surfacing low-level OS errors.
