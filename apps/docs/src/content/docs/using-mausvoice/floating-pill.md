---
title: "Floating pill"
description: "Read, move, and reset the native recording indicator across displays."
sidebar:
  order: 4
---

The pill is the small always-on-top recording indicator implemented separately for macOS, Windows, and GTK/Linux. Its job is status and quick spatial feedback, not transcript editing.

## Reposition it

1. Press and hold the idle pill until its outline indicates that dragging is armed.
2. Keep holding and move the pointer. The pill follows from the point where it was grabbed.
3. Release at the desired position. The ring fades after release and the position is persisted.

Positioning is clamped to the visible monitor area. On multi-monitor systems the native implementation identifies the relevant display and recovers toward an available monitor if a saved display is disconnected.

Use the tray menu's **Reset Pill Position** action to return to the default placement. The reset item is disabled when there is no moved position to reset. Native position-change events keep this menu state synchronized.

## Find the pill

The pill can sit on any display. Under Settings, Appearance, Pill, choose Alt, Shift or Control in **Show pill position with modifier double-tap**, then double-tap that key. On macOS those are the Option, Shift and Control keys. The pill replays its long-press outline at its current position, including the comet sweep and the confirmation pulse.

The setting starts at Disabled and stays disabled after an upgrade. The gesture never starts a recording, moves the pill, or changes its saved visibility. A hidden pill appears for the animation and hides again when it ends.

On Linux, the gesture needs a global keyboard listener. An X11 session has one. A Wayland session does not, so the setting stays hidden there.

On macOS, choosing Control means a double-tap also starts the system Dictation shortcut. If both are enabled, a Control double-tap can start Dictation and play the pill animation. Choose Alt or Shift if that conflict matters.

On Linux, placement depends on the active display backend. The helper uses layer-shell on supporting Wayland compositors and attempts an X11/Xwayland fallback when the compositor does not support layer-shell, notably on GNOME/Mutter. Dictation can continue even if no usable overlay backend is available.
