# What was measured, and what was not

Every number in this file was produced by a command run in the Arena agent
sandbox on branch `arena/05c08045-mausvoice`, at the commit named in each row.
The commit matters: a count without one is a number that silently goes stale,
which is how this table came to report 581 Rust tests while the branch head ran
590. Commands that were
not run are not in the measured column; they are in the unmeasured column with
what would produce them.

This file exists because the two are easy to blur. A green test suite says a
contract holds; it does not say how fast anything is. Nothing below is an
estimate dressed as a measurement.

## Gates run, with their results

| Gate | Command | Result |
| --- | --- | --- |
| Rust unit tests | `cargo test --locked --lib` in `apps/desktop/src-tauri` | **590 passed, 0 failed, 1 ignored** (`18f3cb92`) |
| Rust lints | `cargo clippy --locked --all-targets -- -D warnings` | 0 warnings, 0 errors |
| Rust formatting | `cargo fmt --check` | clean |
| Frontend tests (unit) | `vitest run src` in `apps/desktop` | **4144 passed, 0 failed** across 357 files (`18f3cb92`) |
| Frontend tests (evals and integration) | `vitest run test` in `apps/desktop` | **not run without `GROQ_API_KEY`**; these suites call a live provider and fail on the missing key, so they are not part of the green figure above |
| Frontend types | `turbo run check-types` | 9/9 tasks successful |
| Preview types (TS 5.9) | `tsc --noEmit -p apps/preview/tsconfig.json` | clean |
| Preview production build | `pnpm --filter @maus-inc/preview build` | built in 16.4 s |
| QA document | `pnpm test:qa-docs` | 3/3 |
| Bindings | `scripts/bindings.sh` | regenerated, zero unexplained diff |

## Browser verification

Measured with a real Chromium 153.0.8010.0 driven over the DevTools protocol, not
a rendering of the page by another tool.

| What | How | Result |
| --- | --- | --- |
| Preview index renders | `scripts/verify/shot-home.mjs` | title `mausVoice · UI Preview & Specs`, 39 entries, 40 routes, **0 console errors, 0 failed requests** |
| Microphone dialog renders | `scripts/verify/shot-mic-dialog.mjs` | 2 switches, 1 slider, title `Microphone settings`, **0 problems, 0 console errors, 0 page errors, 0 unmapped native commands** |
| Dialog reaches the tester | measured scroll geometry | content 955 px in a 694 px box with `overflow-y: auto`; the Record button is hit-testable after scrolling, and the footer does not cover it |
| Dialog at 560 px | viewport measured at 560 px | dialog 496 px wide, 0 elements outside the viewport, no horizontal scroll |
| Dark mode | `prefers-color-scheme: dark` emulated | paper `rgb(22,22,23)`, body `rgb(12,12,13)`, heading text `rgb(242,241,238)` |
| Every preview route | `scripts/verify/sweep-preview.mjs` at 1280 px | **80 page loads (40 routes × 2 themes), 0 with problems** |
| Every preview route, narrow | same, at 900 px | **80 page loads, 0 with problems** |
| The `Recommended` chip | measured at 1100/900/700/600/560/480/400 px | 1 px gap to the select arrow at every width; crowded, never overlapping |

Before the four fixes in `00547d63`, the same sweep reported **30 of 80 page
loads with a problem across 15 routes**. That is the measurement the fixes are
accounted against, not an impression.

## Defects found by measuring, and fixed

| Defect | Evidence it was real | Fix |
| --- | --- | --- |
| Repository paths ran past the spec panels and were cut off by the window edge | `scrollWidth` 357 vs `clientWidth` 300 in a box with `overflow-x: visible`; reproduce with `node scripts/verify/sweep-preview.mjs` | `overflowWrap: anywhere` in all three places a path is rendered |
| Index heading and category blurbs collided with the text beside them | MUI renders an unknown typography variant as a `<span>`; reproduce with `node scripts/verify/shot-home.mjs` | `display: block` on those variants |
| "1 spec fields" | the rendered demo string | singular/plural |
| `TypographyWithMore` demo: the "Show more" toggle sat on the clamped text | measured container width **0 px**; the component sets `container-type: inline-size` and the demo tile shrink-wrapped it | demo asks for its width; the one real usage is in a block container and is unaffected |

## Not measured, and what would measure it

These are the gaps that matter, stated so nobody reads the table above as
coverage of them.

| Not measured | Why | What would measure it |
| --- | --- | --- |
| **Real capture latency** (`[audio-startup] total_ms=…`, per-stage microseconds) | No input device in this sandbox. Every recording path is driven through a fake sink. | Run the app on a machine with a microphone and read the `[audio-startup]` lines from a real press, cold and warm, and diff the stage breakdown. |
| **Whether a hold actually makes a press faster** | Same: nothing to open. | The same log pair: a press with keep-ready on against one with it off, same machine, same device. |
| **The busy-device classification against a real busy device** | No second process here can hold a device, because there is no device. | Two processes and one microphone: hold it in one, attempt an open in the other, and check the log says `in_use`. |
| **The usage probe against a live audio server** | `pactl` is not installed and there is no PulseAudio or PipeWire to answer it. | `pactl list source-outputs` with a recording application running, and confirm the app reports it by name. |
| **The UI inside the real Tauri WebView** | The browser verification drives the real components against a fake `window.__TAURI_INTERNALS__`; the IPC transport itself is not exercised. | Run `tauri dev` with a device attached and repeat the dialog checks. |
| **Any performance claim under load** | Not attempted, and no number here should be read as one. | A profiling run on target hardware. |

The figures above describe `18f3cb92`. They are what `vitest run src` and
`cargo test --locked --lib` report, not numbers carried over from an earlier
commit; the test count moves with every test added or removed, so it is stated
against a commit rather than on its own.

The suites under `apps/desktop/test` are excluded from the green figure above
because they need `GROQ_API_KEY`: they call a live provider and fail without a
key. The earlier revision of this page described that exclusion as "54 failing
frontend tests", which reads as a defect in the code and is not one. There are
also `GROQ_API_KEY`-gated suites in `test/evals/post-processing-eval.test.ts`,
`test/integration/post-processing-stability.test.ts` and
`test/integration/transcription.test.ts`. The single ignored Rust test is
documented in the source as needing hardware.
