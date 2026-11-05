## Summary

Describe what this change does, why it is needed, and which part of the repository it touches. Write the opening paragraph for a reader who has never seen this codebase and does not know what to look out for.

Everything below this paragraph returns inside a collapsible block, except the verification gate, the checklist and the footer. A review round or a babysit poll adds a row to the round log, never a new section, and a raw log never goes in the body at all.

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
- `cargo clippy --locked -- -D warnings` in `apps/desktop/src-tauri`, and `--all-targets` in `packages/rust_pill_shared`: <status>
- `CARGO_BUILD_JOBS=1 cargo test --locked --lib` in `apps/desktop/src-tauri` and `packages/rust_transcription`, `cargo test --locked` in `packages/rust_pill_shared`, and `xvfb-run -a cargo test --locked` in `packages/rust_gtk_pill`: <one line each>
- `packages/rust_transcription/tests/sidecar_integration.rs`: <the seven that run, and the four `#[ignore]` ones named with their gap number>

Every `not run` entry needs its own reason and the substitute command that ran instead. A sandbox that cannot reach the network is not a reason on its own. Follow `engineering/sandbox-vendored-toolchain.md` first, then report what still cannot run.

<details>
<summary>Changes</summary>

- Files changed:
- Behaviour or policy changed:
- Packages touched under `packages/` that need a rebuild before consumers see the change:

</details>

<details>
<summary>Code research gate</summary>

- Queries searched:
- Sources, with the assumption each one verified:
- Pattern class named, plus every other location where the same root cause could recur:
- Edge cases considered and their disposition:
- Failed attempts:

Only `Failed attempts` may say `None`. Queries, sources, pattern class, and edge cases must contain real entries.

</details>

<details>
<summary>Proactive and deep refinement evidence</summary>

Proactive protocol.

- Intent hypothesis, 1 to 2 sentences:
- Pattern class and instances found, with search evidence:
- Proposal presented, minimal against comprehensive scope, file list, and the verification that proves the class is fixed:
- Human confirmation evidence, only when scope expansion was proposed. Otherwise state that no expansion was needed and give the search evidence that no broader class exists:

Deep refinement.

- Detail gaps checked: visible surfaces, invisible surfaces, messages, and both theme modes:
- Edge cases enumerated and dispositioned, with the verification for each:
- Missing features researched, with sources, ranked must, should, and nice, and the outcome for each: implemented with confirmation, or deferred with a reason:
- Refinement verification, focused checks per iteration plus the full gate on the final tree:

Depth pass, from `AGENTS.md` section 2b.

- Field named:
- Moves taken that the task did not ask for:
- Rawest material started from:
- Methods and tools used:
- Gate per claim: run with the result, or labelled as a hypothesis awaiting verification with what would settle it:

</details>

<details>
<summary>Design and UI confirmation</summary>

- Product UI touched: <yes or no>
- Design files read before the first edit: `apps/desktop/DESIGN.md`, `apps/desktop/docs/design-system-baseline.md`, `engineering/motion-design.md` for motion work, and the component spec under `apps/preview/specs/`, or <not applicable>
- Rendering inspected: the demo group in `apps/preview` on port 5193, in light mode and in dark mode, and what it confirmed, or why no inspection was possible:

</details>

<details>
<summary>Review classification</summary>

- Substantially critical: No
- Reason if yes: <explain which criterion applies>

Set Yes for a breaking change, a security fix, a major architecture or protocol change, a new platform support claim, or a repo policy or workflow change that materially affects future work.

</details>

<details>
<summary>Review requests</summary>

- CodeRabbit review: <comment link and head SHA, or `not requested` with the reason this PR is not substantially critical>
- Kilocode bot handoff, only when work was delegated because this sandbox could not reach a host or run a tool: <comment link and what it was asked for, or `not used`>
- SonarCloud on this head: <0 new issues and no annotations, or the link to what remains>

For a substantially critical PR, post `@coderabbitai review` as a standalone comment and record its link and head SHA here. After each push or fix round, request review again and record the new link and SHA. For every other PR the review loop stays local, on `REVIEW.md` and `FULL-REVIEW.md`.

</details>

<details>
<summary>Review and babysit log</summary>

One row per round, newest first. A round is one push plus everything it triggered. Keep each cell to a clause. The failing job log, the raw check output and the polling trail stay in the check run, never here.

| Round | Head SHA  | What arrived                                 | What changed    | Disposition                                                 |
| ----- | --------- | -------------------------------------------- | --------------- | ----------------------------------------------------------- |
| 1     | `0000000` | <checks, threads, annotations, bot findings> | <the fix batch> | <resolved, deferred with reason, or escalated to the human> |

Rules for this log.

- Append to the table. Do not add a heading, a section or a nested list per round.
- Fold anything longer than a clause. A round with a long explanation gets a nested `<details>` with its own `<summary>`, inside this block.
- Never paste a full CI log, an entire review body, or a polling timeline. Link the check run or the comment instead.
- When the log passes ten rounds, summarise rounds one to five into a single row rather than letting the table grow without limit.

</details>

<details>
<summary>Sandbox limits hit</summary>

- Gap numbers from `engineering/sandbox-coverage-gaps.md` that stopped a gate:
- Substitute command run instead:
- Anything a reviewer must run themselves because this sandbox could not:

</details>

## Checklist

- [ ] I confirmed the base branch this work was cut from, and the PR does not target `main` with unmerged base work.
- [ ] I ran the applicable gate commands on the head SHA above.
- [ ] I recorded the code research gate notes, including the named pattern class.
- [ ] I applied `REVIEW.md` and the relevant `FULL-REVIEW.md` modules, up to three passes, and fixed every critical, major, minor, nitpick, and UI finding.
- [ ] I ran the depth pass and gate every fourth answer, run or labelled.
- [ ] I checked Sonar for new issues and annotations on this head.
- [ ] I requested CodeRabbit only when this PR is substantially critical.
- [ ] Every review and babysit record is folded, and the round log has one row per round.
- [ ] No secrets, tokens, or raw provider output appear in this description, in a collapsible block, or in the diff.

## Footer

MausAgent | Filed by `<actual model slug>`, with `@<verified GitHub username>`, on `<YYYY-MM-DD>`
