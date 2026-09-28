# 0.1.6 integration staging

Landing point for the remaining 0.1.6 work. This branch is stacked on top of #209.

```
arena/01a0ca7d-mausvoice          shared base
  -> arena/01a0d76f-mausvoice        #209 onboarding. Base of this stack. Not merged into by us.
     -> integration/0.1.6-from-209  this branch
```

## Boundaries

- Nothing merges into `main`.
- Nothing merges into `arena/01a0d76f-mausvoice`.
- Nothing merges into `arena/01a0ca7d-mausvoice` without an explicit instruction.

## Merge protocol

Merges into one branch are serial. One merge at a time, in the order listed in the tracking PR.

1. Confirm the PR is green and its review findings are closed.
2. Rebase the PR branch onto the current tip of `integration/0.1.6-from-209`.
3. Resolve conflicts without discarding already-landed work. If that is not possible, stop and hand back.
4. Merge with `--no-ff`, message naming the PR.
5. Re-request CI and confirm green before starting the next.

## Disk safety

This machine has run out of disk twice and had its storage wiped. It currently has roughly 3.5 GB free.

- Never clone the repo a second time. Work in the shared workspace. A second clone plus `node_modules` is
  about 1.4 GB.
- `node_modules` is already installed. Do not delete and reinstall it casually.
- There is no `target/` directory. Do not create a full Rust workspace build; build the one crate you need.
- A full `pnpm run build` is usually avoidable. Prefer the per-package checks below.
- Delete large temporary artifacts in the same heartbeat you create them.
- On a disk-full error, stop and report. Do not retry the same build.

## Quality gate

Per `AGENTS.md`:

```
pnpm --filter desktop check-types
pnpm --filter desktop lint
pnpm --filter desktop test
pnpm --filter @maus-inc/voice-ai test
pnpm --filter @repo/agent test
```

Before push: `pnpm run build`, `pnpm run check-types`, linter. Never edit a test to hide a defect. Bug
fixes get a regression test.

## SonarCloud

Recurring blockers: duplicated lines over 3%, cognitive complexity over 15, negated conditions, nested
ternaries, `any` types, CSS custom properties needing an `unknown` cast to `React.CSSProperties`.

`// NOSONAR` is allowed only for top-level await in CommonJS, the `execCommand` fallback, and forced
reflow with `void`.

## Review

The full per-PR merge order and review lanes are tracked on the integration PR. Review findings from
sourcery-ai, codeant-ai, kilocode, sonarcloud and deepscan all have to be closed before a PR lands here.
