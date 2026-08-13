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

On Linux, placement depends on the active display backend. The helper uses layer-shell on supporting Wayland compositors and attempts an X11/Xwayland fallback when the compositor does not support layer-shell, notably on GNOME/Mutter. Dictation can continue even if no usable overlay backend is available.
