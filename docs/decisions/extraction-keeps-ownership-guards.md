# Extracting a branch keeps its ownership guards and their order

Date: 2026-11-05
Status: accepted

## Context

The complexity gate rewards extracting a branch into a helper. In the dictation
paths, the branch that gets extracted usually sits between an ownership check and a
write. `postProcessFinalizedTranscript` in
`apps/desktop/src/components/root/DictationSideEffects.tsx` decides whether the
transcript will be stored, checks `isCurrent()`, and then stores. Extracting the
storage step into `storeFailedRecording` moved the decision but dropped the check
between the decision and the write, so a retired recording could still write.
`DictationSideEffects.test.ts` covers this with "does not dispatch storage if the
storage decision retires the owner" and failed on the extracted version.

The same hazard exists on the start side. `beginRecording` builds a strategy, checks
availability, loads an app based style, and then rechecks ownership. The recheck is
what stops a stop that landed while the style loaded from starting a provider
session. It survives an extraction only if the helper returns its result instead of
returning early.

## Decision

Extract the branch, and move the guards with it. The helper must run every
`isCurrent`, generation, and session check the inline code ran, in the same order,
against the same snapshot, and the caller must still act on the helper's answer.
Verification for each extraction is the file's own test, run right after the edit.

Rejected: extracting the branch and re-deriving the guard from the helper's result
type. A boolean named after storage does not say which snapshot it was computed
from, and the compiler cannot see a missing call.

## Consequences

The extraction stays mechanical, so review can compare the helper against the lines
it replaced. Two checks that look redundant are sometimes not, and both stay.

Extraction can also break a source-shape contract. Several CI tests assert on
identifiers rather than behaviour: `scripts/ci/pr28-contracts.test.mjs` pins
`Number.isSafeInteger(payload.offset)`, `payload.generation !== generation`, and
`payload.ownerId !== ownerId` inside
`apps/desktop/src/sessions/audio-chunk-events.ts`. Renaming the parameter to
`offset` and inverting the generation comparison kept the behaviour and failed
those assertions, so a behaviour-preserving extraction still needs
`node --test scripts/ci/*.test.mjs`, not just the file's unit test.

Each extraction costs one targeted test run before the next one starts. The full
unit gate is `vitest run src scripts` from `apps/desktop`, which is 405 files and
4,950 tests without credentials. A bare `vitest run` also loads
`test/integration/**` and `test/evals/**` from `vitest.config.ts`, and those need
provider keys, so a clean sandbox reports 54 failures that are not code failures.

`fallow audit --gate new-only --base <sha>` compares the working tree with the base
commit, so its `introduced` flag means "absent at the base commit" rather than
"written by this edit". Confirm the edit with `git diff -- <path>` before
refactoring a function because of that flag.
