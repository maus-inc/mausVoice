# The pill locate gesture runs from the global listener strategy, not every platform

Date: 2026-11-18
Status: accepted

## Context

Issue #335 asks for a modifier double-tap that replays the pill's long-press outline so a person can find the pill on another monitor. The gesture must work while another application has focus, must not consume keys, and must stay off by default.

The repository has two keyboard strategies. macOS, Windows and Linux X11 use `rdev` in a listener child that publishes every press and release to the renderer as `keys_held`. Wayland uses a compositor bridge that registers chords and has no global key stream. A modifier-only double tap cannot be registered as a chord.

## Decision

Detect the gesture in TypeScript from the `keys_held` snapshots the listener already publishes. `LocateGestureSideEffects` subscribes to the Zustand store directly, so a fast press, release, press sequence cannot be lost between renders. The pure detector in `locate-gesture.utils.ts` owns the tap and window limits, and only fires for the modifier chosen in Settings.

Send `{"type":"locate"}` through the existing `sync_native_pill_assistant` command. The pill draws the long-press ring through the shared `advance_ring` driver, with no pointer state. The request is visual only and never starts a recording, moves the pill, or writes the visibility preference.

The trigger is a keyboard command, and `apps/desktop/DESIGN.md` says keyboard-invoked actions never animate, so the replay holds a complete outline at full opacity for its window and then clears it. There is no sweep, no rise ramp and no fade. `RingState::start_locate_still` is that path, and the pointer long-press keeps its sweep and its fade.

Hide the setting when `hotkeyStrategy` is `bridge`. The row is unavailable on Wayland because the gesture cannot be detected there, and offering a dropdown that does nothing would be worse than leaving it out.

Rejected: a native detector in the host. It would need a new enable flag, a new Tauri command and regenerated bindings, and it duplicates the input classification the renderer already performs for hold-to-talk. The listener path is the one dictation already depends on in the background. Rejected: an API-only chord fallback for Wayland. It expands the shortcuts registry for a second interaction that the issue did not ask for.

## Consequences

The feature works on macOS, Windows and Linux X11, where the listener runs. It does not work on Wayland, and the setting says so by being absent. The three pill crates typecheck and clippy-check for the host, the Windows msvc target and the macOS darwin target, and the GTK crate's tests pass under Xvfb. A manual run on real macOS and Windows hardware is still required before claiming the still outline looks right there.

On macOS, choosing Control also starts the system Dictation shortcut. The docs say so, and the feature is disabled until the person chooses a modifier.

The locate replay reuses the ring driver, so a future change to the outline's paint plan reaches it automatically. The tap and window values live in `apps/desktop/src/utils/locate-gesture.utils.ts` and have unit and fuzz tests. Any change to them must keep autorepeat, long holds and modifier combinations out of the trigger.

## Correction, 2026-11-27

Issue #356 reported the row as missing on Windows and read the strategy check as
the cause. It is not. `platform/windows/mod.rs` re-exports
`listener_hotkey_strategy`, so Windows has reported `listener` since the module
was written, and `apps/desktop/src/__tests__/hotkey-strategy.contract.test.ts`
now pins that mapping at the source. The check that can hide the row is the
health half added on 2026-11-22, and it was too narrow in two ways.

`listenerDeliversKeys` accepted only `healthy_grab` and
`degraded_listen_fallback`, the two states that prove a key path alive. Keys
arrive in `connected` as soon as the child's hook installs, and a hook that
cannot install reports `grab_failed` instead of resting there.
`fallback_starting` is already inside `rdev::listen()`. So the predicate now
accepts any state in which the listener has not reported failure, rather than
only the two that prove a key path alive. That is not the same as claiming every
keypress is observable: `connected` says a child is on the wire, not that its
hook is installed, and the availability rule does not own the hook's liveness.

Windows is where that wait is routine rather than momentary: it restarts the
listener on wake and on session unlock through `desktop_resume`, and the
elevation relaunch starts a new process. The row disappeared for each one.

Windows also removes a low-level hook that overruns `LowLevelHooksTimeout`
without telling the process. That is not one of those triggers and nothing here
watches for it: the child keeps running, the socket stays open, and the respawn
loop only restarts after the connection drops. A listener in that state stays
`connected` with no hook behind it, offering a gesture that has gone quiet, until
the next wake, unlock or relaunch respawns the child. Seeing it needs a watchdog
the native listener does not have; this change adds none and claims no more.

The rule also lived in two places. The settings row asked the strategy and the
health, and the detector asked only the strategy, so the two disagreed in both
directions, offering the gesture on a failed listener and hiding it while taps
were being delivered. `globalKeyStreamIsLive` now answers the question once and
both readers call it. The failure notice in `AppSideEffects` keeps the proven
states through `listenerIsProvenHealthy`, because a child that connects and dies
inside the grace window would otherwise reset the notice on every flap.

The preview seeds are part of the same defect. `preview/scenarios.ts` modelled
the strategy without a health state, and the verify harness set `"healthy"`,
which is not a member of `KeyboardListenerHealth`; both left the row out of every
capture, which is how a row that ships gets reviewed as missing. The harness now
types the value it seeds, and the scenario seeds `grab_failed` where the
accessibility permission it models is denied, so an invalid or impossible state
cannot pass quietly.
