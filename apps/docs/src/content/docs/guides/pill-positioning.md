---
title: Pill Positioning
description: Drag the recording pill to reposition it, and reset it back to its default spot.
---

The recording pill is the small floating indicator that shows when mausVoice is listening. You can drag it anywhere on your screen, and mausVoice remembers where you left it.

## Moving the Pill

1. Press and hold on the idle pill until it lights up with an outline. This is the long-press that arms dragging — a short click won't move it.
2. Keep holding and drag. The pill follows your pointer from wherever you grabbed it, not from its center, so it tracks your cursor exactly.
3. Release to drop the pill. The outline stays lit the entire time you're holding or dragging, and fades out shortly after you let go.

The pill can be dragged all the way to the edges of your screen — it stops right at the edge of the visible display area rather than leaving a gap.

## Moving Between Monitors

If you have more than one monitor, dragging the pill across a screen boundary moves it onto whichever display your pointer is currently over. Once you release the pill, it stays put on that display — it won't jump to another monitor just because your mouse cursor later passes over one.

## Resetting the Position

If the pill ends up somewhere inconvenient, you can restore it to its default position:

1. Open the mausVoice tray icon.
2. Select **Reset Pill Position**.

This menu item is only enabled after you've moved the pill; if the pill is already at its default spot, it's grayed out.

## Platform Notes

- **Windows and macOS** — dragging, edge clamping, and multi-monitor behavior described above work as documented.
- **Linux (X11)** — dragging and edge clamping work as documented.
- **Linux (Wayland)** — dragging works within what the `wlr-layer-shell` protocol exposes on your compositor. On GNOME versions older than 46, the pill overlay itself isn't rendered at all (see [Linux setup](../../getting-started/linux/#known-limitations)); recording and hotkeys are unaffected, but there's nothing to drag.