# User preferences are written whole, guarded in-process, with one CAS column

Date: 2026-11-05
Status: accepted

## Context

`user_preferences_set` → `upsert_user_preferences` writes every column of the
`user_preferences` row for the local user. The statement has no expected-value or
revision predicate, so two concurrent writers produce a last-write-wins result on
every column except the one that is deliberately preserved.

What already protects the row:

- The desktop serialises preference writes through `enqueuePrefsMutation`, and the
  payload is derived from the newest committed state when the task reaches the queue
  head, not when it was enqueued (`apps/desktop/src/actions/user.actions.ts`).
  `preferencesRevision` and `pendingPreferenceMutations` stop a delayed
  `refreshUserAndPreferences` read from overwriting a value written while it was in
  flight.
- `expansion_flags` has its own single-column path with a compare-and-set
  (`compare_set_expansion_flags`, `compareAndSetExpansionFlags`), and the whole-row
  writer preserves the stored value on conflict (`PRESERVED_ON_CONFLICT`), so a stale
  snapshot cannot undo a concurrent flag change.

What is not protected: two processes, or two windows with separate JavaScript
contexts, saving at the same time. Each has its own mutation queue, so each can carry
a snapshot that predates the other's write and overwrite that field with the old
value. The reconciling write is silent.

## Decision

Keep the whole-row write for now, and do not add a revision column to this change.

Reasons, in order of weight:

1. A revision check cannot be added at the SQL boundary alone. Every caller sends a
   full snapshot derived from a read that may be seconds old, so the server cannot
   tell "the user chose this value" from "the client did not know about the other
   write". A correct fix changes the client contract to field-level patches or to an
   expected-revision token carried from read to write, and every write site has to
   move with it, including the onboarding, elevation and settings paths.
2. The cross-context window is narrow: only the main window edits preferences in
   normal use, and the composer popout does not. The in-process queue already covers
   the case that actually occurs, which is several actions saving in one window.
3. The change would be unverifiable here in the way that matters. The failure needs
   two live windows writing the same row, which this environment cannot stage; a
   refactor of the whole preferences path would ship on unit tests alone.

## Consequences

Cross-window preference edits remain last-write-wins, and the losing field is
recorded only as the value the database ends up with. When preferences gain a second
writer surface, or when a reporter can reproduce a lost preference change, the fix is
the contract change in point 1 above: read returns a revision, write carries it, and
a mismatched revision is retried by re-deriving the payload from the fresh row rather
than by forcing the stale one through.
