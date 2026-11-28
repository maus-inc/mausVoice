# A maximized title bar restores itself, then hands the drag to the OS

Date: 2026-11-27
Status: accepted

## Context

Issue #354 reports that dragging a maximized mausVoice window no longer restores it and keeps the drag. Windows and the common Linux desktops do this for a decorated window because the window manager owns the caption. mausVoice draws its own title bar (`decorations: false`) and moves the window through Tauri, so nobody implements the restore.

Two behaviours in the current bar make it worse. Tauri's injected `drag.js` starts the move loop on the first `mousedown`, before the pointer has moved, so a click on a maximized bar already unmaximizes the window and leaves it at full-screen width (tauri#11945) and swallows the `mouseup` a double-click needs (tauri#10767). That is why the repository defers the drag by four pixels on Windows and Linux. A deferred drag then handed to `drag_window` posts `WM_NCLBUTTONDOWN(HTCAPTION)` on Windows, which restores the window at its saved rectangle instead of keeping the grab point on the bar, so the window jumps.

## Decision

When the deferred drag commits and the window was maximized at the press, the renderer measures the grab point, unmaximizes, places the restored window under the pointer, and then starts the OS move.

- The grab point is read on the maximized window, as a fraction of its width and a pixel offset from its top. A fraction, because the restored window is narrower and the press has to keep its place along the bar.
- The placement is read after the restore, at the restored size, from `cursorPosition` scaled to logical pixels, and clamped so the bar never goes above the top of the work area. The wait is the `onResized` event, not the `unmaximize` promise: `tao` posts `set_maximized(false)` to its event-loop thread, so that promise resolves while the resize is still queued and a size read straight after it can return the maximized geometry. The event is bounded by a 500ms timeout so a platform that never emits one cannot strand the gesture.
- Only then does `startDragging()` run, so the OS move loop continues from a window already under the pointer.

The decision lives in `apps/desktop/src/components/root/useWindowDrag.ts`, with the arithmetic in `apps/desktop/src/utils/window-drag.utils.ts` so it can be tested without a window. macOS is untouched: AppKit restores a zoomed window with `performWindowDragWithEvent:` and keeps it under the pointer itself.

Rejected: posting `WM_SYSCOMMAND` with `SC_MOVE | HTCAPTION` (0xF012) from the renderer. There is no command for it, it would add a Tauri command and regenerated bindings, and Wine's `defwnd.c` shows the system move loop early-returns when the window is zoomed, which is the case being fixed. Rejected: restoring through `SW_RESTORE`. `platform/windows/window.rs` guards it precisely because it unmaximizes, so it would fight the restore this change performs. Rejected: leaving the restore to `drag_window`. It restores at the saved rectangle, which is the jump the issue reports.

## Consequences

The gesture is one restore, one placement and one handoff, and a test asserts that order. A press that never travels four pixels still does not restore, so double-click on a maximized bar still toggles. A sideways drag on the bar now restores too, because a maximized window has nowhere to move sideways and the gesture would otherwise do nothing.

The placement runs on a scaled display, so the pointer is divided by the scale factor before it is compared with a logical size. Multi-monitor work areas are read from `currentMonitor`, so a monitor left of the primary places the window correctly.

A Windows run on real hardware is still required to confirm the OS move loop continues cleanly from the placed position. That is recorded in the pull request's sandbox limits rather than claimed here.
