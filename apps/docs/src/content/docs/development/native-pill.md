---
title: "Native pill architecture"
description: "Understand each platform renderer, IPC boundary, shared geometry, drag/reset events, and render contracts."
sidebar:
  order: 7
---

The recording/Assistant pill is implemented natively three times: Cocoa in `rust_macos_pill`, Direct2D/DirectWrite in `rust_windows_pill`, and GTK/layer-shell in `rust_gtk_pill`. TypeScript `OverlaySyncSideEffects` watches Zustand and invokes Tauri to push assistant/recording payloads (`active`, `input_mode`, `compact`, `messages`, `streaming`, `permissions`).

Waveform constants (shared across native crates) include `LEVEL_SMOOTHING` 0.18, `WAVE_BASE_PHASE_STEP` 0.11, `MAX_AMPLITUDE` 1.3, `STROKE_WIDTH` 1.6. Long-press drag arm is ~0.45s with an 8px move threshold. Dictation surface is about 200×86; Assistant compact/expanded sizes are larger (see crate `constants.rs`).

The integration boundary differs by OS. macOS links the pill crate into Tauri and exchanges typed `InMessage`/`OutMessage` values over Rust channels. Windows and Linux spawn packaged pill binaries, wait up to 30 seconds for a ready message, then exchange newline-delimited JSON over stdin/stdout. `apps/desktop/src-tauri/src/pill_process.rs` retries a failed write once and turns pill output into Tauri events.

Inbound state includes sequenced phases, audio levels, visibility, style information, window size, Assistant UI state, and reset-position strategy. Sequence numbers prevent a late phase update from regressing Loading back to stale Recording. Outbound actions include click-to-dictate, pause/resume/cancel, style switching, Assistant talk/type/close, conversation opening, permission decisions, and position changes.

`rust_pill_shared` does not define this whole protocol. It owns rounded-rectangle path geometry and the long-press ring's constants, easing and per-frame policy so renderers trace, shade and fade consistently. Message/state implementations remain platform-specific.

The long-press ring is driven by a single progress value rather than separate "filling" and "armed" renderers, so completion is continuous instead of a cut. Per point on the perimeter its brightness is `ring_envelope()` (a comet falloff behind the leading head) multiplied by `ring_glimmer()` (a travelling sine synced to the pill's waveform phase). Because the path is closed, distance `0` and distance `total_len` are the same point, so the envelope crossfades to a uniform outline through `ring_seal()` as the hold completes — without that the two ends meet at different brightnesses and leave a visible lump at the seam. For the same reason `RING_GLIMMER_CYCLES` must stay a whole number. The comet head dissolves and blooms out before completion, and inflation starts partway through the hold via `inflate_target()` so arming continues the motion instead of starting it.

Neither Cairo nor Direct2D can stroke a gradient along a path, so the shading is applied per segment to an evenly-spaced resampling of the perimeter (`resample_perimeter()`); uniform spacing matters because the raw path puts most of its vertices in the corner arcs. The resample buffer lives on the pill state and is reused every frame.

Dragging is also platform code: preserve the pointer offset, account for scale/monitor origins, clamp enough of the pill on screen, persist the dropped monitor/position, and emit position state used by the tray reset action. Test disconnected displays and both reset strategies.

After changing shared geometry, run its Cargo tests and all platform crates that compile on the host/CI. After changing a message, update the Tauri adapter plus all three consumers. Animation regressions often come from event-loop repaint behavior, so verify that held alpha stays pinned, release fades monotonically, and the zero-alpha transition forces a final clean frame. The arm-confirmation pulse outlives the ring's own alpha, so on Windows it needs its own liveness check in `needs_redraw()` and its own dirty flag when it retires, or it is culled mid-flight.
