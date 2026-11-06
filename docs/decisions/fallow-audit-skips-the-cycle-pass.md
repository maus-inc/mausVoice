# The Fallow audit skips the cycle pass; a separate gate owns cycles

Date: 2026-11-06
Status: accepted

## Context

`fallow audit --gate new-only` attributes a finding to whichever file a pull
request touched, which is the wrong unit for a *cycle*: a cycle has no home file,
so editing any one of its members makes an inherited cycle look introduced. On
this branch that produced five failures that the base branch had before the
branch existed — `actions/transcribe.actions.ts` reaching the session layer,
which reaches `transcribe.actions.ts` back through `repos`, `utils/user.utils.ts`
and `sessions/index.ts`. The audit offered no config lever to exclude them:
`audit.deadCode` is a boolean that also drops unused-file findings, and
`ignoreFindings` does not cover cycles.

The one cycle edge that was removable *was* removed: the pre-transcriber imported
its metadata type from `actions/transcribe.actions.ts` and now imports it from
`types/transcription-metadata.types.ts`.

## Decision

`pnpm run fallow:audit` passes `--skip architecture`, so the pull-request gate
judges dead code, complexity, duplication and styling only. Import cycles are
gated instead by `scripts/ci/fallow.test.mjs`, which runs the cycle analysis once
and fails on any cycle that is not in `INHERITED_CYCLES` — an explicit list with
a comment per entry.

Rejected: performing the layer inversion (moving the transcription call out of
`actions` into a module the session layer may import) as part of a
pull-request-babysitting pass. It touches every file in the cycle, changes
runtime import order in the transcription path, and its only benefit here is to
make an inherited finding stop being *reported* as new.

## Consequences

- A new cycle still fails CI, through `node --test scripts/ci/*.test.mjs`, and
  the failing message names both endpoints of the cycle.
- `fallow audit` no longer reports cycles at all, so a reviewer looking for them
  has to run `test:fallow` or `fallow health` to see them.
- When the cycle is genuinely broken later, the entry comes out of
  `INHERITED_CYCLES` in the same commit that breaks it: the same test also fails
  when a listed cycle is no longer observed, so the list cannot quietly outlive
  the cycles it describes. Adding that assertion is how two entries left stale by
  the metadata-type move were found and deleted.
