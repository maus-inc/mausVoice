# 0.1.6 integration staging

Landing point for the remaining 0.1.6 work.

```
arena/01a0ca7d-mausvoice      shared base, and the head branch of #208
  -> integration/0.1.6-staging   this branch
```

#208 is the vehicle that carries `arena/01a0ca7d-mausvoice` into the `0.1.6` release branch. It is the base
of this stack. **Nothing merges into it, and it is not one of the PRs landed here.**

Every open PR listed in the merge order below still needs to be rebased and merged into this branch.

When all merge-queue PRs have landed, the `integration/0.1.6-staging` branch is promoted to the
`0.1.6` release branch via a dedicated promotion PR. That promotion step is a separate process
and is not part of this landing protocol.

## Boundaries

- Never merge into `main`.
- Never merge into `arena/01a0ca7d-mausvoice`, which is #208's branch.
- Only merge into `integration/0.1.6-staging`.

## Merge protocol

Merges into one branch are serial. One at a time.

1. Confirm the PR is `MERGEABLE`, CI is green, and no bot finding is unresolved or unclosed.
2. Obtain explicit human confirmation naming both source and destination branches.
3. Rebase the PR branch onto the current tip of `integration/0.1.6-staging`.
4. Resolve conflicts without discarding already-landed work. If that is not possible, stop and hand back.
5. Require the rebased PR head to receive fresh green CI and review-bot verification.
6. Merge with `--no-ff`, message naming the PR.
7. Confirm CI is green here before starting the next.

## Resource limits — this machine is small

The sandbox has roughly 8 GB of RAM and about 10 GB of disk. Both have been exhausted and the machine has
been wiped twice.

- **Concurrency is capped at one agent at a time.** Parallel agents on this box get OOM-killed. Do not
  start work you cannot finish alone.
- Never clone the repo again. A clone plus `node_modules` is about 1.4 GB.
- `node_modules` is already installed. Do not delete and reinstall it.
- No full Rust workspace build. Build the one crate you need, or skip the build. There is deliberately no
  shared `target/` directory.
- Avoid a full `pnpm run build`.
- Delete large temporary artifacts in the same heartbeat you create them.
- On a disk-full or OOM error, stop and report it. Do not retry the same build.

## Quality gate

Per `AGENTS.md`:

```
pnpm --filter desktop check-types
pnpm --filter desktop lint
pnpm --filter desktop test
pnpm --filter @maus-inc/voice-ai test
pnpm --filter @repo/agent test
```

Before push, run `pnpm run build`, `pnpm run check-types` and the linter, as `AGENTS.md` requires. Never edit a test to hide a defect. Bug fixes get a regression test.

## SonarCloud

Recurring blockers: duplicated lines over 3%, cognitive complexity over 15, negated conditions, nested
ternaries, `any` types, CSS custom properties needing an `unknown` cast to `React.CSSProperties`.

`// NOSONAR` is allowed only for top-level await in CommonJS, the `execCommand` fallback, and forced
reflow with `void`.

## Review

Every review finding from sourcery-ai, codeant-ai, kilocode, greptile, ahoybuoy, sonarcloud,
socket-security, deepscan, CodeRabbit and CodeFactor has to be closed before a PR lands here.
Answering a finding without fixing it or resolving its thread does not count. The per-PR merge
order is tracked on the integration PR.
