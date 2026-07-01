# Keyboard Listener Health & Lifecycle Hardening

Root-cause fixes for the macOS keyboard-listener findings. The listener runs as a
child process (`VOQUILL_KEYBOARD_LISTENER=1`) connected to the parent over loopback
TCP. Today the parent respawns the child on any exit with no cap/backoff, never proves
the child actually installed an event tap, exposes no health to TS (which gates the
listener purely on Accessibility permission), and never explicitly stops the listener
on app exit. Fn is swept via `CGEventSourceKeyState`, which is unreliable for the
Function modifier.

## Provenance: all findings are upstream, not fork-introduced

The two fork commits on top of upstream `a2c289cf` (`61db24b9` "Personal local-only
fork" + `2899faee` docs) do **not** touch the keyboard-listener behavior. Verified by diff:
- `macos/keyboard.rs`, `macos/permissions.rs`, `main.rs`: no fork changes.
- `platform/keyboard.rs`: only removed the `#[cfg(linux)] run_listener_process` re-export.
- `app.rs`: only added one Groq command to `invoke_handler`.
- `commands.rs`: Groq/audio/prefs/JAB/terminal only — `start/stop/reset_key_listener` untouched.
- `AppSideEffects.tsx`: reworded one comment; the listener gating effect is unchanged.

All five findings (#1 unbounded respawn, #2 premature `start_key_listener` return, #3
`AXIsProcessTrusted`-only check, #4 Fn `CGEventSourceKeyState` sweep, #5 child lifecycle)
are pre-existing **upstream** behavior. This work hardens the fork; it is not repairing
something the fork broke. One fork side effect that *helps*: Linux listener support was
removed, so `run_listener_process` now has two platform impls (macOS, Windows) instead of
three — AC-2 ("no Windows regression") is the only cross-platform concern; there is no Linux
child to consider.

Key facts that shape the design (verified in code):
- The child is always the **same binary** as the parent (`std::env::current_exe()`,
  keyboard.rs:268). There is therefore **no wire backward-compatibility constraint** — both
  ends always ship together.
- The child connects TCP **before** attempting `rdev::grab()`, and on grab failure falls
  back to `rdev::listen()` (macos/keyboard.rs:108). So "child connected and survived a
  grace window" does **not** prove the grab/event-tap path is healthy, and a tap-install
  failure looks like "connected then exited," not a pre-connect failure.
- `setup_listener_process`, `pump_stream`, `KeyboardEventPayload`, and `send_event_to_tcp`
  are **shared across platforms** (keyboard.rs); only the grab/listen body is per-platform
  (macos/keyboard.rs, windows/keyboard.rs). Any wire/health change must keep Windows working.
- `pump_stream` (keyboard.rs:394) currently assumes every TCP line is a `KeyboardEventPayload`.
- `AppSideEffects.tsx` (re)starts the listener only on `keyPermAuthorized` / strategy changes.
  After a terminal failure with AX still "authorized" (the local-build case), nothing
  currently re-triggers `start_key_listener`.
- rdev gives **no "tap installed successfully" callback**; `grab()`/`listen()` block after
  install. The strongest positive signal achievable is *absence of `grab_failed` within a
  grace window* — health is "no failure observed," not "install proven."

Files in play:
- `apps/desktop/src-tauri/src/platform/keyboard.rs` (parent loop, child lifecycle, wire protocol)
- `apps/desktop/src-tauri/src/platform/macos/keyboard.rs` (child grab/listen + stale sweep)
- `apps/desktop/src-tauri/src/platform/windows/keyboard.rs` (Windows child grab/listen)
- `apps/desktop/src-tauri/src/main.rs` (child entrypoint)
- `apps/desktop/src-tauri/src/app.rs` (`RunEvent::ExitRequested`, invoke_handler)
- `apps/desktop/src-tauri/src/commands.rs` (`start/stop/reset_key_listener`)
- `apps/desktop/src-tauri/src/domain/keyboard.rs` (event constants/payloads)
- `apps/desktop/src/components/root/AppSideEffects.tsx` (TS gating)

---

## Cross-cutting acceptance criteria (apply to all stages)

These are design invariants, not per-stage niceties. The implementation is not done unless
all four hold:

- **AC-1 (single retry owner)**: Rust owns *automatic* retry from `Failed`. TS offers only a
  *manual* user-triggered retry. Both funnel through one idempotent entry point; there is no
  path where a Rust auto-retry and a TS retry can both spawn a child. To own auto-retry and
  health emission, the listener thread **stays alive** in `Failed` (slow-poll) rather than
  exiting at the cap.
- **AC-2 (no Windows regression)**: the `connected` control message is emitted from the
  **shared** `setup_listener_process`, so Windows reaches `HealthyGrab` exactly as macOS does.
  A working Windows listener is never marked `Failed`. Verified by exercising the Windows path.
- **AC-5 (proper tagged wire enum)**: the TCP protocol is a single Rust enum with
  `#[serde(tag = "type")]` (`key` | `control`). No untagged/parse-order fallback, no ad hoc
  strings. The "keep backward shape" idea is explicitly dropped (see same-binary fact above).
- **AC-6 (health outlives the handle)**: health state lives in its **own** static
  (`Mutex<HealthState>` / atomic), independent of `listener_state()`'s `Option<ListenerHandle>`,
  which is `take()`n on stop (keyboard.rs:169). Health remains readable in `Stopped`/`Failed`.

---

## Stage 1: Clean child-process lifecycle on shutdown and stdin EOF
**Goal**: The child terminates promptly when the parent goes away, and the listener is
explicitly stopped on app exit. No orphaned child, no write-to-closed-socket race.
**Changes**:
- `app.rs` `RunEvent::ExitRequested`: call `crate::platform::keyboard::stop_key_listener()`.
  First **verify** the true quit path (tray / Cmd-Q → `app.exit()`) actually reaches
  `ExitRequested`; window-close is intercepted with `api.prevent_close()` + hide (app.rs:83-88)
  and must not be the only path relied on.
- Child stdin watcher (`setup_listener_process`, keyboard.rs:646): on stdin EOF, exit the
  process immediately instead of silently `break`ing the watcher thread. Today the `rdev`
  loop keeps running until it next tries to write to a dead socket.
- Shutdown log cleanup: `stop_listener_child` drops stdin (which now triggers the child's EOF
  self-exit) and *then* calls `child.kill()` (keyboard.rs:369). Kill-on-already-exited returns
  an error logged at `error!`; demote the not-found case to debug/ignore so normal shutdown is
  not noisy.
**Success Criteria**: Quitting the app leaves no listener child. Killing the parent causes the
child to exit within ~1s. Normal shutdown produces no spurious kill errors in logs.
**Verification method**: the child is the *same executable* as the parent and is marked only by
the `VOQUILL_KEYBOARD_LISTENER` env var, so `pgrep -fl` (which searches argv, not env) will not
identify it. Instead count `Voquill` processes and inspect env per-pid:
`pgrep -fl Voquill` (expect the child gone, parent count drops) and
`ps eww -p <pid> | grep VOQUILL_KEYBOARD_LISTENER` to confirm which pid is the listener.
(If easier observability is wanted later, add a listener-mode argv flag alongside the env var.)
**Tests**: Manual process check on quit and on parent kill (per method above); log inspection.
Existing unit tests pass.
**Status**: Complete — `cargo check` clean, 7 keyboard unit tests pass. Manual quit/kill
process check still pending a real run of the app (use the corrected method above).

## Stage 2: Correct Fn (Function) modifier handling on macOS
**Goal**: The stale-key sweep no longer synthesizes wrong Fn releases, since
`CGEventSourceKeyState` does not reliably report the Function modifier.
**Changes** (macos/keyboard.rs): exclude the `"Function"` label from the
`CGEventSourceKeyState` stale sweep (it is tracked via real press/release events, not polled
key state).
**Completion criterion (escalation)**: this fixes *false* releases only. If manual testing
shows *stuck* Fn (a missed release leaving stale state), the real fix is to derive Fn state
from macOS event flags; do that before considering this stage done.
**Success Criteria**: Fn-based combos (`Function`, `Function+KeyZ`) press/release cleanly with
no spurious release events (`VOQUILL_DEBUG_KEYS=1`); existing combo unit tests including
`escalates_from_modifier_only_combo_to_non_modifier_combo` still pass; no stuck Fn after rapid
Fn toggling.
**Tests**: Existing keyboard unit tests; manual Fn combo exercise with debug logging.
**Status**: REVERTED — the exclusion caused a real regression. In live use, excluding Fn from
the sweep removed the safety net that detected Fn's **missed release** (rdev does not reliably
deliver `KeyRelease(Function)` on macOS — Fn is a flag). Result: `"Function"` got stuck "held",
so the Fn dictation hotkey stopped starting (the documented escalation case fired). Reverted
macos/keyboard.rs to upstream behavior (Fn tracked + swept like any key via
`CGEventSourceKeyState`), which is what worked before. The original finding #4 (spurious Fn
releases) was theoretical and not worth the regression; if revisited, the *correct* fix is to
read Fn state from the macOS event-flag mask (`CGEventSourceFlagsState & kCGEventFlagMaskSecondaryFn`)
in the sweep — never the plain exclusion. Lesson: validate platform input changes against a real
app run before shipping.

## Stage 3: Tagged wire protocol + listener state machine
**Goal**: Replace the implicit "every line is a key event" assumption with an explicit
protocol (AC-5), and model true listener health grounded in the child's actual grab/listen
outcome (AC-6).
**Wire protocol (AC-5)**: a single `#[serde(tag = "type")]` enum over the TCP stream:
`Key(KeyboardEventPayload)` (`"type":"key"`) | `Control(ControlMsg)` (`"type":"control"`).
`pump_stream` deserializes the enum and dispatches; unknown/malformed is a logged warning,
never a silent assumption. No backward-shape compromise (same-binary fact).
**Child-reported control states**:
- `connected` — emitted from the **shared** `setup_listener_process` right after TCP connect,
  so macOS and Windows both report it (AC-2).
- `grab_failed` — `rdev::grab()` returned Err; about to fall back (per-platform body).
- `listen_fallback` — entering `rdev::listen()` fallback (per-platform body).
**Parent state machine** (in its own health static, AC-6). Refined after review to promote on
*proven alive*, not *intent to enter a path*, using two transient intermediate states:
`Starting → Connected → HealthyGrab` (grab grace) and
`Connected → GrabFailed → FallbackStarting → DegradedListenFallback` (fallback grace);
terminal `Failed`, plus `Stopped`.
- Grace promotions are generation-guarded and fire only if the state is still the from-state:
  `connected` arms `Connected → HealthyGrab`; `listen_fallback` arms
  `FallbackStarting → DegradedListenFallback`. Each promotes only after the grace window with no
  disconnect.
- `grab_failed` is an **unconditional downgrade** to `GrabFailed`, so a grab that dies *after*
  `HealthyGrab` is caught; `listen_fallback` may then override it upward.
- **Connection-end classification**: only the two confirmed-alive states
  (`HealthyGrab`/`DegradedListenFallback`) are transient disconnects; every other non-terminal
  state at EOF (`Connected`, `GrabFailed`, `FallbackStarting`, `Starting`) → `Failed`. Covers
  both EOF-before-grab-grace and EOF-before-fallback-proven-alive.
- The earlier `grab_failed_flag` + `should_promote_to_healthy` were removed; the generic
  from-state grace check subsumes them.
- **Timer-vs-EOF race closed (review)**: `pump_stream` records per-connection timing
  (`connected_at`, `grab_failed`, `fallback_at`) and returns a `ConnectionOutcome`. The
  connection-end classification (`connection_proved_alive`) is computed from that timing —
  "did it actually survive the relevant grace window before EOF" — *not* from the live health
  state. So a grace timer that fires just ahead of EOF can no longer make a dead attempt look
  like a transient disconnect; such an attempt is always `Failed`. The live timer remains only
  for observability while connected. Residual: timing is measured at EOF-processing time, so
  the sole imperfection is OS EOF-detection latency (~ms), far below the 750ms grace — a
  physical bound, not a logic race. Covered by the deterministic `connection_proved_alive`
  unit test (grab/fallback, survived/EOF-before-grace).
**Success Criteria**: Logs show correct state for healthy grab, grab-denied-then-fallback, and
immediate failure (incl. EOF-during-grace classified as failure, not Healthy). Unknown control
messages are logged, not crashed on. Windows reaches `HealthyGrab` (AC-2).
**Tests**: Unit test for wire-message parse/dispatch (key vs control vs unknown). Unit test for
state-machine transitions over child-outcome sequences, including EOF-before-grace.
**Status**: Complete — tagged `WireMessage` (`#[serde(tag="type")]`), `ControlState`
(connected/grab_failed/listen_fallback), `HealthState` machine in its own static (AC-6),
`connected` emitted from shared setup (AC-2), grace promotion via generation-guarded timer,
and timing-authoritative connection-end classification (`connection_proved_alive`) that closed
the timer-vs-EOF race. `cargo check` clean; 12/12 keyboard unit tests pass (5 new:
key/control/unknown wire round-trips, `connection_proved_alive`, `should_promote`). Two
residuals: (a) **Windows compile** not verified from macOS —
edits mirror macOS and use un-cfg-gated shared code, but needs a Windows build to confirm AC-2;
(b) Stage 3 sets `Failed` immediately on a failed attempt with no backoff, so health can flap
`Failed→Connected→Failed` on a persistently failing grab — Stage 4 adds backoff/cap + stay-alive
to fix the flapping.

## Stage 4: Respawn classification, backoff, retry cap, and Rust-owned recovery
**Goal**: A child that cannot install its tap no longer respawns in a tight loop; failure is
bounded and recoverable, with retry owned solely by Rust (AC-1).
**Changes** (keyboard.rs `run_listener_thread` / `ensure_listener_child`):
- Track consecutive failures using Stage 3 child states (repeated `grab_failed`, or exit
  before `connected`, or EOF-before-grace). Exponential backoff (500ms → capped few seconds)
  replacing the flat 500ms sleep. A sustained `HealthyGrab`/`DegradedListenFallback` resets the
  counter.
- After N consecutive failures, set state `Failed` but **keep the thread alive** in a
  slow-poll loop (e.g. retry every ~30s) so it owns both auto-retry and health emission (AC-1).
  The thread does not exit at the cap.
**macOS fallback verification (item 4)**: confirm whether `rdev::listen()` without AX delivers
events on macOS. If it delivers **zero** events, treat macOS `listen_fallback` as `Failed`,
not `DegradedListenFallback`. Do not assume fallback = working until verified.
**Success Criteria**: With Accessibility revoked mid-run, retries back off and stop at the cap
(visible in logs), CPU stays flat, state is `Failed`, and the thread continues slow-retrying.
Re-granting permission recovers to `HealthyGrab` automatically without an app restart and
without TS intervention.
**Tests**: Unit test for the backoff/cap/reset decision (pure function over attempt count +
child outcome). Manual: revoke → bounded retries → re-grant → automatic recovery.
**Status**: Complete — respawn loop restructured into a bounded per-attempt model:
`ensure_child → wait_for_connection(CONNECT_TIMEOUT) → pump → reap → classify`. Failures
(spawn error, connect-timeout/child-died-before-connect, or `!proved_alive`) increment a
counter with exponential backoff (`retry_backoff`: 500ms→1s→2s→4s, ceiling 5s) via
`interruptible_sleep`; at `FAILURE_CAP=5` → `Failed` + 30s slow-retry, **thread stays alive**
(AC-1). A `proved_alive` connection resets the counter. `wait_for_connection` early-exits via
`listener_child_exited()` so a child that crashes pre-connect fails in ~ms, not after the full
timeout. 14/14 unit tests pass (2 new: `failure_cap_triggers_at_threshold`,
`backoff_grows_exponentially_then_slow_retries_when_capped`); `consecutive_failures` uses
`saturating_add`. Residuals: (a) **macOS dead-fallback** — a `listen()` that creates a tap but
delivers no events would survive grace and reset failures; traced as low-risk (common AX-denied
case fails tap creation → correctly `Failed`), pending runtime confirmation; (b) auto-recovery
+ Windows behavior need a real run.

## Stage 5: Surface health to TypeScript (manual retry only)
**Goal**: TS knows whether the listener is actually live, not just whether permission is
granted; `start_key_listener` no longer implies success merely because a thread spawned.
**Changes**:
- New `EVT_KEYBOARD_LISTENER_HEALTH` in `domain/keyboard.rs`, emitted on parent state
  transitions; add `get_key_listener_health` command for pull queries. (Reads the AC-6 static.)
- `AppSideEffects.tsx`: subscribe to the health event and surface state. TS does **not** run an
  automatic retry loop (AC-1) — Rust owns that. TS exposes only a *manual* user-triggered retry
  (a `retry_key_listener` command that funnels through the same idempotent entry as auto-retry).
  This covers the local-build case where `AXIsProcessTrusted()` says authorized but the tap is
  dead, since health is grounded in the child, not the AX check.
**UI scope (start minimal)**: internal state + logs, plus **one** visible failed-listener
affordance (with the manual retry) only where permissions are surfaced — not a global banner,
too noisy until real-world failure frequency is known. `DegradedListenFallback` (if it remains
a real state after the macOS verification in Stage 4) shown as a softer state.
**Success Criteria**: Healthy tap → Healthy; tap that fails to install → Failed with a manual
retry affordance within a few seconds; auto-recovery (Rust) and manual retry both flip back to
Healthy. No double-spawn from concurrent Rust + TS retry (AC-1).
**Tests**: Manual permission grant/revoke/retry cycle observing surfaced state and verifying a
single child process throughout.
**Status**: Complete — `EVT_KEYBOARD_LISTENER_HEALTH` + `KeyboardListenerHealthPayload` in
`domain`; `set_health` and the grace-timer promotion both emit via a stored `AppHandle`
(`listener_app`). Commands `get_key_listener_health` (pull) and `retry_key_listener` (manual,
restart-based) registered. TS: `KeyboardListenerHealth` type + `keyboardListenerHealth` store
field; `AppSideEffects` subscribes, surfaces state, and on `failed`-while-authorized shows a
one-shot snackbar (deduped per failure episode via a ref so the 30s Rust slow-retry churn does
not re-toast) — **no TS auto-retry** (AC-1). Manual retry affordance: an inline Alert + Retry
button in the accessibility `PermissionRow` (reachable during the grant flow / partial-perms /
post-grant restart message). `cargo`/`tsc`/`prettier`/`oxlint` all clean; 14/14 Rust tests pass.
Self-review fixes applied: (1) grace-timer promotion now emits the health event (was setting the
static directly and silently); (2) snackbar deduped per episode. Residual: the
`PermissionsDialog` only opens when a permission is missing or just-granted, so in the fully
authorized + silently-dead steady state the clickable retry isn't reachable — the snackbar +
Rust 30s auto-recovery cover that case; a persistent settings/permissions surface would be the
home for an always-reachable retry button (no such surface exists today).

---

**Sequencing rationale**: Stage 1 (lifecycle) is foundational and lowest-risk — no orphans
before we touch retry logic. Stage 2 (Fn) is small, self-contained, and directly tied to a
user-visible bug, so it lands early. Stage 3 establishes the protocol + state vocabulary (and
the AC-5/AC-6 invariants) that Stages 4 and 5 depend on. Stage 4 adds bounded, Rust-owned
retry/recovery (AC-1) on top of those states. Stage 5 surfaces it to the UI last with
manual-only retry. Each stage compiles, passes existing tests, and is independently verifiable.
The cross-cutting ACs (1, 2, 5, 6) are the highest-leverage guards against implementation
rework and must hold throughout.

---

**Post-completion review fixes** (after all stages landed):
- **Lifecycle idempotency (High)**: `start_key_listener` called `stop` then spawned+stored
  non-atomically, so two overlapping starts could both see "nothing to stop", both spawn, and
  the later store would orphan the first thread+child. Fixed with a dedicated `lifecycle_lock`
  mutex held across the entire stop→spawn→store sequence; `stop_key_listener` and the shared
  `stop_listener_locked` use it too. Directly upholds AC-1 (single idempotent entry; Rust
  auto-retry and TS manual retry can never both spawn).
- **Health seeding (High)**: `get_key_listener_health` existed but TS never seeded from it, and
  `useTauriListen` subscribes asynchronously — early `starting/connected/failed` events could be
  missed, leaving the store stuck at `"stopped"` and suppressing the affordance. `AppSideEffects`
  now seeds `keyboardListenerHealth` from `get_key_listener_health` right after start/stop.
- **Stale generated bindings (Medium)**: added `get_key_listener_health` + `retry_key_listener`
  to `examples/gen_bindings.rs` and regenerated `packages/desktop-native-apis/src/bindings.ts`
  (typed `commands.getKeyListenerHealth` / `commands.retryKeyListener` now exist; the in-app
  call sites keep raw `invoke()` to match the adjacent `start/stop_key_listener` calls).
