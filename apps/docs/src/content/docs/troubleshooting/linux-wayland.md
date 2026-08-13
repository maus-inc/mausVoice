---
title: "Linux and Wayland"
description: "Fix compositor shortcuts, uinput insertion, and overlay limitations without applying X11 assumptions."
sidebar:
  order: 5
---

Run `echo $XDG_SESSION_TYPE` before troubleshooting. Wayland intentionally restricts global key capture and synthetic input.

For insertion, install `ydotool`, add the user to the appropriate input group, and configure a udev rule that grants group access to `/dev/uinput`. Log out and in after membership changes. Test `ydotool type "hello"` in a disposable editor. Sway and Hyprland can use `wtype` where their virtual-keyboard support allows it.

For shortcuts, ensure Sway includes the generated mausVoice file and Hyprland sources its generated configuration, then reload the compositor. GNOME follows a different registration path.

Pill visibility is separate. The GTK helper uses layer-shell when the compositor supports it and attempts to relaunch through X11 when it detects an unsupported compositor such as GNOME/Mutter and an Xwayland display is available. Recording and hotkeys can still work if neither overlay path succeeds, so verify raw transcription before classifying an invisible pill as total app failure.

Do not run the entire desktop app as root to bypass uinput permissions. Correct the narrow device rule instead.
