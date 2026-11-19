# The pill locate gesture runs from the global listener strategy, not every platform

Date: 2026-11-18
Status: accepted

## Context

Issue #335 asks for a modifier double-tap that replays the pill's long-press outline so a person can find the pill on another monitor. The gesture must work while another application has focus, must not consume keys, and must stay off by default.

The repository has two keyboard strategies. macOS, Windows and Linux X11 use `rdev` in a listener child that publishes every press and release to the renderer as `keys_held`. Wayland uses a compositor bridge that registers chords and has no global key stream. A modifier-only double tap cannot be registered as a chord.

## Decision

Detect the gesture in TypeScript from the `keys_held` snapshots the listener already publishes. `LocateGestureSideEffects` subscribes to the Zustand store directly, so a fast press, release, press sequence cannot be lost between renders. The pure detector in `locate-gesture.utils.ts` owns the tap and window limits, and only fires for the modifier chosen in Settings.

Send `{"type":"locate"}` through the existing `sync_native_pill_assistant` command. The pill replays the long-press ring through the shared `advance_ring` driver, with a zero hold delay and no pointer state. The request is visual only and never starts a recording, moves the pill, or writes the visibility preference.

Hide the setting when `hotkeyStrategy` is `bridge`. The row is unavailable on Wayland because the gesture cannot be detected there, and offering a dropdown that does nothing would be worse than leaving it out.

Rejected: a native detector in the host. It would need a new enable flag, a new Tauri command and regenerated bindings, and it duplicates the input classification the renderer already performs for hold-to-talk. The listener path is the one dictation already depends on in the background. Rejected: an API-only chord fallback for Wayland. It expands the shortcuts registry for a second interaction that the issue did not ask for.

## Consequences

The feature works on macOS, Windows and Linux X11, where the listener runs. It does not work on Wayland, and the setting says so by being absent. The three pill crates typecheck and clippy-check for the host, the Windows msvc target and the macOS darwin target, and the GTK crate's tests pass under Xvfb. A manual run on real macOS and Windows hardware is still required before claiming the animation looks right there.

On macOS, choosing Control also starts the system Dictation shortcut. The docs say so, and the feature is disabled until the person chooses a modifier.

The locate animation reuses the ring driver, so a future change to the comet or pulse reaches this replay automatically. The tap and window values live in `apps/desktop/src/utils/locate-gesture.utils.ts` and have unit and fuzz tests. Any change to them must keep autorepeat, long holds and modifier combinations out of the trigger.
