---
title: "Hotkey not detected"
description: "Resolve shortcut conflicts and platform registration before changing transcription settings."
sidebar:
  order: 2
---

If the pill does not react, transcription has not started. Leave provider and model settings alone until shortcut capture works.

Open **Settings → General → Hotkey shortcuts**, confirm **Hold to dictate**, and test it while a plain editor has focus. Choose a combination not reserved by the OS, window manager, keyboard utility, or target app. Compact keyboards can map Fn at firmware level, preventing applications from seeing it normally.

On macOS, revisit input/accessibility permission and restart the app. On Windows, run **Configure input permissions** and test outside elevated applications first. On Linux, identify X11 or Wayland. Sway must include `~/.config/sway/mausvoice-hotkeys`; Hyprland must source `~/.config/hypr/mausvoice-hotkeys.conf`; reload the compositor after changes.

If the binding works only with mausVoice focused, global capture is blocked or not registered. If another shortcut works, keep the replacement and report the specific unavailable key combination and platform.
