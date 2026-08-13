---
title: "Pill and multi-monitor issues"
description: "Reset an off-screen pill and distinguish overlay placement from recording health."
sidebar:
  order: 9
---

Use the tray/menu-bar action **Reset Pill Position**. It is enabled after a custom position exists and returns the pill according to the configured monitor reset strategy.

If a monitor was disconnected, current native implementations check whether the saved display remains available and recover toward a visible or primary display. Restart after changing the display topology if the native overlay was created before the change.

To move it manually, long-press until the ring appears, drag, and release. A quick click does not arm a move. Position clamping uses the visible monitor footprint, so the pill should not be deliberately placed fully off-screen.

If dictation works but the pill is absent, investigate overlay support rather than providers. The Linux helper uses layer-shell where supported and can fall back to X11/Xwayland on unsupported compositors such as GNOME/Mutter; audio and shortcuts may remain functional even when neither overlay path succeeds.
