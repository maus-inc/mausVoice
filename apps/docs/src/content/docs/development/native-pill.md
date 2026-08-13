---
title: "Native pill architecture"
description: "Understand each platform renderer, IPC boundary, shared geometry, drag/reset events, and render contracts."
sidebar:
  order: 7
---

The recording/Assistant pill is implemented natively three times: Cocoa in `rust_macos_pill`, Direct2D/DirectWrite in `rust_windows_pill`, and GTK/layer-shell in `rust_gtk_pill`.

The integration boundary differs by OS. macOS links the pill crate into Tauri and exchanges typed `InMessage`/`OutMessage` values over Rust channels. Windows and Linux spawn packaged pill binaries, wait up to 30 seconds for a ready message, then exchange newline-delimited JSON over stdin/stdout. `apps/desktop/src-tauri/src/pill_process.rs` retries a failed write once and turns pill output into Tauri events.

Inbound state includes sequenced phases, audio levels, visibility, style information, window size, Assistant UI state, and reset-position strategy. Sequence numbers prevent a late phase update from regressing Loading back to stale Recording. Outbound actions include click-to-dictate, pause/resume/cancel, style switching, Assistant talk/type/close, conversation opening, permission decisions, and position changes.

`rust_pill_shared` does not define this whole protocol. It owns rounded-rectangle path geometry and shared long-press ring constants/math so renderers trace and fade consistently. Message/state implementations remain platform-specific.

Dragging is also platform code: preserve the pointer offset, account for scale/monitor origins, clamp enough of the pill on screen, persist the dropped monitor/position, and emit position state used by the tray reset action. Test disconnected displays and both reset strategies.

After changing shared geometry, run its Cargo tests and all platform crates that compile on the host/CI. After changing a message, update the Tauri adapter plus all three consumers. Animation regressions often come from event-loop repaint behavior, so verify that held alpha stays pinned, release fades monotonically, and the zero-alpha transition forces a final clean frame.
