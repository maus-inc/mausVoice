## Summary

Describe what this change does, why it is needed, and which part of the repository it touches. Write the opening paragraph for a reader who has never seen this codebase and does not know what to look out for.

## Changes

<details>
<summary>Files and behaviour</summary>

- Files changed:
- Behaviour or policy changed:
- Packages touched under `packages/` that need a rebuild before consumers see the change:

</details>

## Verification gate

Head SHA: `0000000000000000000000000000000000000000`

Replace the zero placeholder with the current 40-character hexadecimal PR head SHA. A result from an earlier edit does not verify this head.

- `pnpm install --frozen-lockfile`: <passed, failed, or not run with reason>
- `pnpm run lint`: <passed, failed, or not run with reason>
- `pnpm run check-types`: <passed, failed, or not run with reason>
- `pnpm run build`: <passed, failed, or not run with reason>
- `pnpm run test`: <passed, failed, or not run with reason>
- `pnpm run format:check`: <passed, failed, or not run with reason>
- `pnpm run skills:verify`: <passed, failed, or not run with reason>
- `pnpm run test:secret-scan`: <passed, failed, or not run with reason>
- `node --test scripts/ci/*.test.mjs`: <passed, failed, or not run with reason>
- `pnpm gen:bindings` produced no diff: <yes, no, or not applicable>

Per-package gates, when the change touches that package:

- `pnpm --filter desktop check-types` and `pnpm --filter desktop lint`:
- `pnpm --filter desktop test`: <the `GROQ_API_KEY` integration tests may be unavailable; name them if skipped>
- `pnpm --filter @maus-inc/voice-ai test`:
- `pnpm --filter @repo/agent test`:
- `pnpm --filter @maus-inc/preview test`:
- `pnpm --filter desktop test:integration`:
- `pnpm --filter desktop test:webdriver`:

Rust gates, when the change touches any of the seven Cargo workspaces:

- `cargo fmt --check` in the six gated crates: <passed, failed, or not run with reason>
- `cargo clippy --locked -- -D warnings` in `apps/desktop/src-tauri`: <status>
- `CARGO_BUILD_JOBS=1 cargo test --locked --lib` in `apps/desktop/src-tauri`, and the equivalent in `packages/rust_transcription`, `packages/rust_pill_shared`, and `packages/rust_gtk_pill` under `xvfb-run -a`: <one combined status or one line each>

Every `not run` entry needs its own reason and the substitute command that ran instead. A sandbox that cannot reach the network is not a reason on its own. Follow `engineering/sandbox-vendored-toolchain.md` first, then report what still cannot run.

## Code research gate

<details>
<summary>Research notes</summary>

- Queries searched:
- Sources, with the assumption each one verified:
- Pattern class named, plus every other location where the same root cause could recur:
- Edge cases considered and their disposition:
- Failed attempts:

Only `Failed attempts` may say `None`. Queries, sources, pattern class, and edge cases must contain real entries.

</details>

## Proactive and deep refinement evidence

<details>
<summary>Proactive protocol</summary>

- Intent hypothesis, 1 to 2 sentences:
- Pattern class and instances found, with search evidence:
- Proposal presented, minimal against comprehensive scope, file list, and the verification that proves the class is fixed:
- Human confirmation evidence, only when scope expansion was proposed. Otherwise state that no expansion was needed and give the search evidence that no broader class exists:

</details>

<details>
<summary>Deep refinement evidence</summary>

- Detail gaps checked: visible surfaces, invisible surfaces, messages, and both theme modes:
- Edge cases enumerated and dispositioned, with the verification for each:
- Missing features researched, with sources, ranked must, should, and nice, and the outcome for each: implemented with confirmation, or deferred with a reason:
- Refinement verification, focused checks per iteration plus the full gate on the final tree:

</details>

## Design and UI confirmation

- Product UI touched: <yes or no>
- Design files read before the first edit: `apps/desktop/DESIGN.md`, `apps/desktop/docs/design-system-baseline.md`, `engineering/motion-design.md` for motion work, and the component spec under `apps/preview/specs/`, or <not applicable>
- Rendering inspected: the demo group in `apps/preview` on port 5193, in light mode and in dark mode, and what it confirmed, or why no inspection was possible:

## Review classification

Substantially critical: No

Reason if yes: <explain which criterion applies>

<!-- Set Yes for a breaking change, a security fix, a major architecture or protocol change, a new platform support claim, or a repo policy or workflow change that materially affects future work. -->

## Review requests

- CodeRabbit review: <comment link and head SHA, or `not requested` with the reason this PR is not substantially critical>
- Kilocode bot handoff, only when work was delegated because this sandbox could not reach a host or run a tool: <comment link and what it was asked for, or `not used`>
- SonarCloud on this head: <0 new issues and no annotations, or the link to what remains>

For a substantially critical PR, post `@coderabbitai review` as a standalone comment and record its link and head SHA here. After each push or fix round, request review again and record the new link and SHA. For every other PR the review loop stays local, on `REVIEW.md` and `FULL-REVIEW.md`.

## Checklist

- [ ] I confirmed the base branch this work was cut from, and the PR does not target `main` with unmerged base work.
- [ ] I ran the applicable gate commands on the head SHA above.
- [ ] I recorded the code research gate notes, including the named pattern class.
- [ ] I applied `REVIEW.md` and the relevant `FULL-REVIEW.md` modules, up to three passes, and fixed every critical, major, minor, nitpick, and UI finding.
- [ ] I checked Sonar for new issues and annotations on this head.
- [ ] I requested CodeRabbit only when this PR is substantially critical.
- [ ] No secrets, tokens, or raw provider output appear in this description, in a collapsible block, or in the diff.

## Footer

MausAgent | Filed by `<actual model slug>`, with `@<verified GitHub username>`, on `<YYYY-MM-DD>`
