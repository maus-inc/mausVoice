# The consolidation base keeps its own API-key, composer and lease layers

Date: 2026-11-06
Status: accepted

## Context

Two branches fixed overlapping ground: this one, and the consolidation branch
that became the base of this pull request. Both rewrote the same surfaces — the
API-key list, the composer, and the layer that holds a native recording — with
different shapes. Merging them file by file would have reintroduced two parallel
implementations of each, and a reader would have had no way to tell which one
runs.

## Decision

Where the base already solved the same problem, the base wins and the parallel
work is dropped rather than ported:

- **API-key list and composer.** The base moved credential handling behind
  `redaction.utils.ts` and restructured both components. This branch's
  `providerTestError` scrubbing, `useApiKeyFormSave` and `useApiKeyFormFields`
  are not reintroduced; the base's redaction covers the same leak.
- **Native recording lease.** `utils/native-recording-lease.ts` and
  `utils/local-recording-activity.ts` held a webview-local lease with retry and
  recovered-stop bookkeeping. The merged tree owns the same responsibility in
  `utils/native-recording-session.ts` on top of the Rust admission protocol
  (`recording_generation`, `start_recording`, `discard_recording`,
  `acknowledge_recording`), which is authoritative across windows instead of
  within one webview. Recovery bookkeeping lives in Rust, so the TypeScript
  copies are dead weight and stay gone.

Behaviour that only existed on this branch and is not covered by the base's
shape was ported instead of dropped: the whole-group dictation save, the
capture-failed flag on a partial recording, and the receiver's frame cap. Those
are in the tree with tests.

## Consequences

The pull request is smaller and has one implementation per surface, at the cost
of abandoning work that was finished on the other branch. A later reader looking
for `native-recording-lease` or `useApiKeyFormSave` finds this file instead of
the module.
