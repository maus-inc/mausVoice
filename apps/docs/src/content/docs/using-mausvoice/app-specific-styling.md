---
title: "Application-aware styling"
description: "Register target applications, assign per-app styles, and understand manual automatic-loading behavior."
sidebar:
  order: 10
---

Application targets are local records keyed from the detected foreground application's name. A target can hold a writing style and, separately, text-insertion overrides. Dictating in an app normally registers or refreshes its record automatically; you can also focus an app and choose **Register current app** from the mausVoice tray/menu-bar menu. See [Register App](./register-app/) for the full registration flow, detection details, and troubleshooting.

## Based on app mode

1. Open **Settings → General → More settings** and set **Styling mode** to **Based on app**.
2. Open **Writing Styles**.
3. If the app is missing, focus it, register it from the tray menu, then return to mausVoice.
4. Choose a style on that app's row.

At the end of dictation, mausVoice resolves the foreground app again and passes that target's style to post-processing. An unassigned or unrecognized target currently resolves through the built-in Polished fallback. The app list's **Default style** control is stored separately; verify the row assignment you actually need rather than assuming every blank row inherits that control.

On Windows and Linux, the row's overflow menu also exposes a per-app paste binding. The fuller **Settings → General → Text insertion options** dialog can set each target's insertion method, paste binding, and simulated-typing speed. These output settings are independent of writing style.

## Manual mode and Automatic style loading

Manual mode normally uses the currently selected style. When **Settings → General → More settings → Automatic style loading** is on, starting an ordinary dictation makes a best-effort, non-blocking attempt to load the style previously stored for the focused app. When dictation ends, the current manual style is saved back to that app target. Turn the switch off if one manual choice should remain fixed as you move between apps.

Automatic loading applies only in Manual mode and ordinary dictation—not Assistant recording or the onboarding override. Because lookup is asynchronous, focus changes during startup can make the current selection the safer source of truth.

Foreground-app detection is best-effort. Elevated windows, remote desktops, sandboxes, unusual window managers, and fast focus changes can produce an unknown or different app name. If output uses the wrong style, inspect the app row, keep focus on the destination through release, or use Manual mode with automatic loading off.
