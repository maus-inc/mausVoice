# The consolidated base supersedes this branch's parallel refactor

Date: 2026-11-06
Status: accepted

## Context

`arena/0.1.6-consolidation` (`f21a87d3`) and this branch forked from the same
merge base (`5ba53332`, PR #313). The base then landed 1,201 commits that folded
in equivalent work: the settings refactor (`SettingsPage`, section nav and the
scroll container are gone), the same "actions, repos and hooks" split
(`dictation-recording-intake.ts`, `recording-start-gate.ts`,
`DictationSideEffects.tsx`), the stop-to-History latency work
(`persistTranscriptNow`, the `HistoryOwner` union), and a remote receiver built
on `system/remote_channel.rs` with generation-scoped write gates.

This branch had 9 commits that independently rewrote the same surfaces. Merging
both sides as-is produced a tree that type-checked nowhere: `dictation.strategy.ts`
from the base used `HandleTranscriptParams.persistTranscriptNow` while the branch's
`strategy.types.ts` had removed it, and the branch's `native-recording-lease.ts`
addressed commands the base does not have.

## Decision

The base is the trunk. The merge keeps the base's implementation of every
surface both sides rewrote, and drops this branch's parallel modules (~350 files)
rather than leaving them in the tree as dead code that no call site reaches.

What the branch uniquely had, and how it was carried over:

- **Native recorder ownership** (the branch's reason to exist). Ported onto the
  base: `platform/recording_ownership.rs`, `platform/event_dispatch.rs`,
  `platform/latest_dispatch.rs`, the recorder rewrite in `platform/audio.rs` and
  `platform/linux/audio.rs`, the `Recorder::is_recording` / `stop_for_handoff`
  trait additions, the ownership commands (`recording_generation`,
  `acknowledge_recording`, `discard_recording`, `force_stop_recording`,
  `claim_browser_recording`, `release_browser_recording`), and the owner-aware
  `start_recording` / `stop_recording` / `pause_recording` / `resume_recording`.
  On the TypeScript side the admission is carried by
  `utils/native-recording-session.ts`, which every start, stop, pause, resume and
  abort now goes through.
- **Fallow** as a pull-request gate: `.fallowrc.json`,
  `.github/workflows/fallow.yml`, `.agents/skills/fallow*`,
  `scripts/ci/fallow.test.mjs`, `engineering/fallow.md`.
- **Native audio teardown patches** for `cpal`, `alsa` and `coreaudio-rs`, which
  the ported recorder needs in order to observe a failed close.
- **The `clear_local_data` gate**: the base's wipe body stays, and it now begins
  with `RecordingOwnership::begin_reset` and tears the recorder down through
  `force_stop_with_retry`, so a start that is mid-open cannot revive capture
  behind the closed native write gate.

## Consequences

- The base's CSP keeps `frame-src` for the onboarding YouTube embeds; this
  branch's `frame-src 'none'` hardening was reverted because it breaks them.
- The remote receiver keeps the base's `remote_channel` framing and
  generation-set state, with this branch's per-frame authorization bolted on
  (`secret_matches`, `authorize_final_text`) instead of its own receiver.
- Reviewers should read the merge commit as "adopt the base, re-port the
  recorder", not as "delete the branch's features": the dropped files are the
  base's equivalents, which are the ones the app now ships.
