# Decisions

Durable decisions, refusals and deviations. Not a work log.

Write a file here when one of these happens:

- A vendored skill's advice conflicts with `AGENTS.md`,
  `apps/desktop/docs/design-system-baseline.md` or `engineering/motion-design.md`. The repo
  wins, and the conflict gets recorded here with the reason.
- A skill is refused, dropped or overridden. `engineering/design-skills.md` requires
  the refusal to be recorded.
- A design baseline value changes. Record what changed and why in the same PR.
- A gate could not run, and the reason is durable rather than a one-off sandbox
  problem.
- A pattern class was found and only part of it was fixed, with the human's
  confirmation to keep the scope narrow. Name the remaining gap.

One decision per file. Name it for the decision, not the date, so a later reader can
find it: `mui-over-tailwind.md`, `no-playwright-harness.md`.

Keep the shape short:

```markdown
# <the decision in one sentence>

Date: YYYY-MM-DD
Status: accepted | superseded by <file>

## Context

What forced the choice.

## Decision

What was chosen, and what was rejected.

## Consequences

What this makes easy and what it makes hard.
```

Do not record session notes, plans or progress here. `AGENTS.md` says in-session
artifacts belong in the PR description in a collapsible block, and
`engineering/deep-refinement-protocol.md` says to record only durable lessons.
