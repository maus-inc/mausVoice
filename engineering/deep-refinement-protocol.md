# Deep refinement, authoritative elaboration

Elaboration for the deep refinement hard constraint in `AGENTS.md`, which now carries this protocol inline at full depth. This file is the fallback for when a tooling limit truncates `AGENTS.md`. Where the two differ, `AGENTS.md` governs, and the difference is a defect to fix here.

## Mindset

- Treat first-pass success as draft. The hypothesis is that detail may be low, edge cases rough, and a feature missing. Investigate with evidence, and allow an evidence-backed finding of "none missing" to satisfy the pass.

## Attention to detail

- For UI: states, transitions, empty/loading/disabled/hover, focus, keyboard, touch, contrast, typography, spacing, radius, density, motion against the tokens in `apps/desktop/src/styles/`.
- For non-UI: naming, consistency, error messages, platform conventions; skip UI design docs.
- Apply unslop/antislop; check all user-visible messages.

## Edge cases

- Enumerate: empty/maximal, boundaries/off-by-one, failure/cancellation/abort/retry/disconnect/shutdown, ordering/races, platform differences, all consumers of changed contract.
- Watch hiding-failure patterns; state expected behavior + verification per edge; add tests without weakening existing.

## Missing features

- Compare against intent + comparable shipped products (2+ external refs when relevant and authorized).
- Rank must/should/nice; for must-have name file/behavior/verification.
- Use Proactive 3-point proposal + confirmation; implement confirmed with minimal correct change.
- Holistic integration pass after.

## Execution

- Loop: implement -> detail audit -> edge sweep -> missing search -> propose -> implement -> focused verify -> repeat.
- Bound one improvement per iteration; fresh-context re-read each time.
- After each iteration, focused verification relevant to change; full Verification Gate only on final tree.
- Stop when evidence-backed pass finds no new gaps; shallow pass with no findings requires deeper digging.
- Record only durable lessons in `docs/decisions/`, not work logs.
