# Two-axis review: review-findings fixes on top of `3560b01`

Fixed point: `3560b01` (the superfix head = PR #63 head as reviewed by the four
assertive reports). Diff under review: this session's fix set (46 tracked
files, `+2,449 / -963`), plus eight new files (tests, `promise.utils.ts`,
`scripts/ci/release-shell-contracts.test.mjs`, the audit note, this note).

Method: [mattpocock/skills code-review] — Standards axis and Spec axis kept
separate; fixed-point diff commands:
`git diff 3560b01...HEAD`, `git log 3560b01..HEAD --oneline` (pre-commit, so
verified against the working tree directly).

## Standards

Repo standards consulted: `REVIEW.md` §3-§5 (Rust/Tauri backend, lockstep,
lifecycle/persistence rules), existing test conventions (hoisted `vi.fn()`
mocks per module, `setAppState` + `structuredClone(INITIAL_APP_STATE)`),
`scripts/ci/*-contracts.test.mjs` regex-contract style, i18n extract/sync
pipeline rules, Prettier/Oxlint configs.

- `commands.rs` private-HTTP rewrite follows §3 idioms: validation before
  await, per-hop caps unchanged, cancellation guard registration order
  unchanged, redirect semantics mirrored from reqwest's own documented
  behavior (307/308 keep method+body, else GET). New pure helpers are unit
  tested with the repo's existing test style.
- The dictation strategy queue now matches the lifecycle guidance in §3 of
  REVIEW.md (generation/nonce on teardown, rejection-safe chains). One
  judgement call: `enqueuePasteWork` swallows queue-internal errors after
  logging; call sites that must observe failures already branch on the
  boolean returned by `drainBacklogAndAppendSpace`.
- ContextMenu focus moves into a `useEffect`+ref because the `autoFocus` prop
  did not focus the div in practice — pinned by a regression test ("moves
  keyboard focus into the menu").
- Fowler smell sweep over the diff: no Duplicated Code beyond intentional
  mirror (the two pickers share a polling pattern; abstracting them is
  Speculative Generality for two call sites), no new Message Chains, no
  Middle Man (`logOnRejection` is one function with one job, replacing ~20
  naked `void` sites).
- All edited surfaces pass this repo's gates: desktop `tsc --noEmit`, oxlint
  (474 files, 0 warnings), Prettier clean, `git diff --check` clean, i18n
  extract+sync converges to no diff.

Smell baseline findings worth a second look next cycle (not regressions from
this diff): none.

## Spec

Spec = the four consolidated review reports; per-item conformance is in
`docs/pr63-pr109-review-findings-audit.md` ("Resolution record"). Traceability:
every finding marked _fix_ in the audit maps to a changed file here; every
_already correct_, _refuted_, and _out-of-band_ verdict carries its evidence
there.

- Behavior not asked for but shipped: the two edited settings descriptions
  (mutual-exclusion copy) are required for the C5 fix to be honest UI; the
  release-shell contract test and the updater-artifacts local warning were
  explicitly requested test/doc items from the reviews.
- Coverage gaps reviewers listed that are now test-covered: Gemini non-SSE/
  empty stream, reader cancel, 401-once, tool pairing; dictation backlog
  race/nonce/poison/re-append; elevation hangs and late result; tone rollback;
  context menu portal/Escape/focus; style delete confirmation; AssemblyAI
  payload contract; whisper.cpp pin + digest well-formedness; private-HTTP
  resolved-address policy including redirect-hop scope and dot-segment
  normalization; release-workflow shell contract.
- Left intentionally unfixed with a documented rationale: binary IPC framing
  (needs regenerated Specta bindings; no Rust toolchain here — documented
  inline in `commands.rs` and in the audit), the `.ghtoken` history rotation
  (credential rotation is out-of-band by definition), test-count CI pinning
  (style opinion per REVIEW.md necessity gate).

## Summary

Standards: 0 findings blocking; diff follows the handbook. Spec: all fixable
findings resolved or explicitly deferred/refuted with evidence. Measured
gates at commit time: 818/818 desktop unit+script scope, 59/59 voice-ai,
48/48 `node --test` script contracts, plus the workflow-level fixes split
into the handoff patch because the agent token may not push workflow edits.

Worst Standards item: none blocking; the picker duplication is a judgement
call. Worst Spec item: the binary-IPC deferral is a real cost (payloads up to
the 128 MiB cap inflate ~4x across the bridge) and should be scheduled when a
Rust toolchain workflow is available.

## Self-review loop outcome

Two findings of this diff against main's full handbook were caught and fixed
in-loop:

- §5.7 boolean cast — the new local-build updater warning used bare
  `process.env.CI` truthiness; now compares `=== "true"` explicitly.
- The i18n completeness gate exempted any placeholder-bearing sentence;
  placeholders are now translated (the gate only exempts model-name strings).

Final gates: 818/818 desktop unit+script vitest files, 59/59 voice-ai, 48/48
`node --test` script contracts, `tsc --noEmit` clean, oxlint 0 warnings,
Prettier clean on touched files, `git diff --check` clean, i18n extract+sync
converges to a no-op.
