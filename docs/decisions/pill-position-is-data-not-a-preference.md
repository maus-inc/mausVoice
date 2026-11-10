# The pill's parked position is user data in its own table, resolved by a shared pure function

Date: 2026-11-10
Status: accepted and implemented

## Context

The floating dictation pill remembered where it was parked only for the length of its
own process. Each pill binary held the origin in memory, published it as
`PositionChanged` after a drag, and the desktop forwarded the event to the renderer
without storing it. Every launch therefore started from the default corner, so a user
who parks the pill on a second display had to move it again after each restart.

Storing it is not a one line change, because the value is only meaningful against the
display it was measured on:

- Displays appear and disappear between launches. Clamping a saved origin into the
  wrong display leaves the pill behind a taskbar or entirely offscreen.
- Resolution and scale change on a display that stays connected, so an origin that was
  valid is now outside the work area.
- Work areas move. A dock or taskbar at a new edge changes the rect the pill was
  clamped against without changing its origin.
- A reset means "forget this", but the pill republishes the corner it lands on, so a
  naive save turns the reset into a value the next launch restores.
- The clear-local-data flow promises the pill returns to its default corner, which
  makes the row part of the privacy set.

Three pill implementations exist (`gtk`, `macos`, `windows`) and each owns its own
coordinate space, drag clamping and window class.

## Decision

- One record, owned by `packages/rust_pill_shared/src/restore.rs`. `ParkedWindow`
  carries the window origin, the window size and the work area it was parked against,
  with `SCHEMA_VERSION = 1` and a JSON wire form. `ParkedWindow::new` rejects a
  non-finite or empty window, so an unusable event cannot overwrite a good record.
- The record stores the work area the pill clamps against, not a display id. It is both
  the display identity used for restore matching and the same rect the pill already
  publishes on `PositionChanged`, so save and restore cannot disagree about what was
  measured.
- Coordinates are screen-absolute with the top left as origin and y increasing
  downwards. Windows and X11 report that directly; macOS converts through
  `primary_top - (y + height)` at its own boundary.
- `restore(parked, areas, window_size, bounds_for)` is a pure function with no
  platform calls. It chooses, in order: the display with the exact stored work-area
  rect; else the display at the same origin; else the display with the nearest
  origin; else `Placement::PlatformDefault`. An exact match keeps the stored origin. Any
  other match keeps the fraction of the slide room the pill occupied, so a pill on the
  left half comes back on the left half after a resolution change. The caller passes
  the same `DragBounds` math its drag path uses, so the clamp cannot drift from drag.
- Restore is applied before the window's first frame on each platform: at
  `CreateWindowExW` on Windows, at `setFrameOrigin` before `orderFront` on macOS, and at
  `XMoveWindow` during realize in X11. There is no post-ready fix up, so a restore is
  not a visible jump.
- The host passes the record to a pill process as `--saved-position=<json>`; the macOS
  pill is linked into the host process and receives the decoded value directly.
- Saves happen on settle, not at shutdown, because the app does not always reach
  shutdown. Each pill publishes `has_saved_position`, and the host stores only when it
  is true. A reset publishes false with the default corner, so it cannot undo itself.
- `reset_pill_position` clears the row before it asks the pill to re-home.
- `pill_position` is in `USER_DATA_TABLES_TO_CLEAR`, and the save takes
  `lock_local_data_write`, so a drag that lands mid-clear cannot write the row back
  after the wipe.
- Wayland never saves or restores. A layer-shell surface cannot set its own origin, so
  offering to restore there would be a promise the platform cannot keep. The GTK pill
  re-execs itself on X11 where it can, and stays on the platform default otherwise.
- A missing table, an undecodable row or a rejected payload degrades to the default
  corner and logs. No failure in this path is user-visible.

## Rejected alternatives

- Columns on `user_preferences`: the renderer upserts that whole row from state that
  knows nothing about window geometry and would null the value on the next unrelated
  preference save.
- A raw window origin with no display rect: it cannot tell a valid origin from an
  origin on a display that is gone, so the fallback would have to guess.
- Restoring after the pill reports ready over stdin: the window is already on screen,
  so the user sees it move.
- Re-deriving the display from the window rect at save time: restore would then judge
  the position by a different rect than the one it was clamped against.

## A second root cause found in review

The first version of this change restored the origin correctly and then let each
platform's idle path move the pill a moment later. On Windows the window was created
at the restored origin, but the state still started with `has_saved_position: false`
and `saved_x`/`saved_y` at zero, so the first cursor tick 60 ms later parked the pill at
the default corner. macOS and Windows also clamped the restore against the whole OS
window, which is a large transparent canvas, while the idle tick clamped the visible
pill. A pill saved near an edge came back hundreds of pixels inward.

Both are one pattern: two implementations of "where does this window belong", one for
restore and one for idle. Source-text guards cannot see this, because each
implementation is individually plausible. The fix is structural. `footprint_bounds`
and `centered_bottom_footprint` in `restore.rs` are now the only description of the
resting arrangement, and `the_restored_origin_is_a_fixed_point_of_the_idle_clamp` plus
`the_resting_footprint_clears_the_selector_slot` fail if the two ever diverge again.
The reserve passed to the helper has to include the selector slot below the pill,
because that slot is part of why the window is taller than the pill.

## The pill has to forget, not just be cleared

Gating the save and the delete closes the race inside the native process, but not the
one across the reload. `clear_local_data` wipes the row and reopens writes, the renderer
reloads the window, and startup asks the pill for its geometry so the composer can
anchor to it. The pill is still running and still holds the pre-clear position in
memory, so it answers with that position and the row is written straight back. The user
confirmed a wipe and got a table row back.

The gate cannot fix this, because the write is legitimate by the time it happens. The
fix is a protocol message: `forget_position` clears only the pill's `has_saved_position`
flag and does not move the window, so the pill answers `RequestPosition` honestly
instead of pretending the spot it sits at was chosen by the user. The clear sends it
before it marks itself ready for the frontend to finish, which is before the reload can
reach the pill. The save also refuses to run without a live write generation, so the
window between the gate reopening and the reload is closed on both sides.

No gap remains here: a pill that is not running during the clear holds nothing in
memory to forget, and the row it would have restored from is already gone, so that case
needs no message.

## Consequences

Easy: adding a save point or a platform is a call into `restore` plus the platform's
own apply call. The interesting arithmetic has one tested implementation, and the
record format is versioned, so a future shape change can reject old rows explicitly
instead of guessing.

Hard: the record describes one window size. A pill whose size changes between releases
restores its origin and lets the clamp place it, which is correct but not exactly the
old spot. The identity of a display is its work-area rect, so a display whose work
area changes in both origin and size at once matches only as "nearest", which remaps
proportionally rather than exactly.

## Verification

- `cargo test --lib` in `packages/rust_pill_shared`: 17 `restore` tests covering exact
  match, dock move, unplugged display, rearranged layout, resolution change, negative
  origins, a window larger than the display, corrupt records, version mismatch and
  argument round trips.
- Windows and macOS cross-target `cargo clippy --all-targets -- -D warnings`; GTK
  `clippy` and `fmt`; desktop `clippy --all-targets` plus 429 library tests, including
  the `pill_position` table in the privacy set guard.
- The fixed-point and slot-reserve tests were checked by reintroducing each defect:
  dropping the reset write from the save gate, seeding the Windows state as unsaved,
  and omitting the slot from the reserve each make a guard fail.
- `scripts/ci/pr28-contracts.test.mjs` pins the new contract: the X11 applied origin is
  `restored.unwrap_or(init_pos)`, the Windows default corner still comes from the
  created height, the macOS pill starts saved only when a record was restored, the save
  takes the clear gate, and each reset clears the row before re-homing.
