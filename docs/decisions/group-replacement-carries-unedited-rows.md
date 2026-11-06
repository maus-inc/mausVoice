# A group replacement carries every row it does not edit

Date: 2026-11-06
Status: accepted

## Context

`hotkey_replace_dictation_language_hotkeys` replaces the whole dictation group in
one transaction. It matches the group with `action_name = 'dictate' OR
instr(action_name, 'additional-language:') = 1`, deletes those rows, and inserts
the rows the caller sends back.

The Dictation Language dialog is a partial editor. It shows one key combination
per language row plus one row for the primary dictate binding, and it sends the
group back on save. The shortcuts dialog, in the same app, lets a user attach a
second combination to dictation through `HotkeySetting`'s "Add another" button,
which writes a second row with `action_name = 'dictate'`. The dialog never
displayed those extra rows, so they were not in the list it sent back, and the
group delete removed them. Saving a language change silently deleted a shortcut
the user had configured somewhere else.

The first attempt at a fix is tempting and wrong: relax the dialog so it also
edits every dictate row. That turns a language dialog into a general shortcut
editor and still loses any row type a later feature adds.

## Decision

The replacement command accepts extra `dictate` rows in its `additional` list,
alongside the prefixed language rows, and validates each one as either the
primary action or a prefixed language. The dialog snapshots which row it is
editing, treats every other dictate row as an unedited row, and sends those back
with their keys intact. `createReplacementIdAllocator` in
`apps/desktop/src/components/settings/hotkey-draft-session.ts` hands each
snapshot row its own id, in snapshot order, so an action that owns several rows
can never hand the same id to two replacement rows and fail the insert.

The preview stub in `apps/desktop/src/preview/hotkey-replacement.ts` mirrors the
same rule, because a preview that rejects what SQLite accepts would hide the
bug in the surface used to inspect it.

## Consequences

A partial editor can share the group transaction with a full editor without
inventing per-row commands or losing atomicity. The cost is that the command's
parameter name, `additional`, now means "every group row except the primary
one", which the doc comment says out loud. A future partial editor over another
group has to repeat the same snapshot-and-pass-through step, and
`replace_hotkeys_by_prefix` keeps the strict prefix-only rule because style
hotkeys have one row per tone and no editor adds a second.
