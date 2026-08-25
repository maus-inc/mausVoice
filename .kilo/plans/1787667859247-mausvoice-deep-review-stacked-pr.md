# Plan: deep review and stacked PR for mausVoice 1.6 review findings (PR #132)

## Context

The user attached three comments to PR #132 (`arena/01a0358e-mausvoice` → `fix/superfix-review-findings`). CodeRabbit's automated plan in the same thread is a high-level checklist. The user's text and screenshots are more specific and call out six concrete failures that were only partially fixed in #132:

1. Mid-dictation style switch. Selecting Style B while recording reverts to Style A after the utterance finishes. The user wants the newly selected style to become the persisted default. The snapshot must style only the active utterance; the new style must survive finalization.
2. Windows installer sidebar art. `apps/desktop/src-tauri/tauri.conf.json` references `icons/nsis-sidebar.bmp`, but the file is absent. The source artwork `branding/mausvoice-sidebar-installerimg.png` is 548×1008 and is being squeezed into the 164×314 NSIS sidebar slot, so the installer shows compressed/letterboxed art. PR #133 already added custom NSIS installer sidebar art on top of the base, but the current PR #132 diff does not include it; the stacked PR must verify and pull that work in.
3. Review-before-insert. The current WebView is a separate `floating_window_create` window that looks like Chrome, asks for `http://tauri.localhost` microphone permission, hangs, then shows a blank white page, and the pill stays in `Loading` while the user reviews. The user wants a native review panel attached to the assistant pill that mirrors the assistant UI, has a drag affordance, releases the pill from processing, and never leaves a blank surface.
4. Thock audio. The new clip is "buzzy" instead of clicky. The user wants a real click-like transient, and a volume control. The current PR sets `THOCK_VOLUME = 0.45` but exposes no user control.
5. Agent continuation. The user wrote "I also noticed issues with the agent automatically continuing after tool use. It still just stops." The console log captured by CodeRabbit's grep confirms `Unhandled rejection: The resource id … is invalid` after `shouldContinue=true`, which the package-level `AgentLoop` cannot see. The desktop adapter in `apps/desktop/src/agents/run-agent.ts` awaits `createChatMessage` directly inside the `for await` loop; a rejection there ends the run.
6. Cerebras 402 history attribution. #132 only added in-memory `postProcessFailed`/`postProcessError`. The migration is present in the diff, but the user-visible symptom they reported is fixed in #132, so it stays verified and not regressed.

Goal: produce a new stacked PR that addresses all six points with a deeper review, then opens a PR targeting the current `fix/superfix-review-findings` head so the work is stacked above #132, #133, and #134.

## Base branch and stacked PR

- Stacked base: `origin/fix/superfix-review-findings` (sha `4ce879af`). The previous stacked PRs #133 (NSIS sidebar) and #134 (Kilo review follow-ups) are already on top of #132's base; the new branch sits above them.
- New branch name: `arena/01a0358e-mausvoice-deepreview` (kebab-cased deep-review suffix), forked from `origin/fix/superfix-review-findings`.
- Open the PR with `gh pr create --base fix/superfix-review-findings --head arena/01a0358e-mausvoice-deepreview --title "fix(deep-review): pill-attached review panel, style default, thock volume, agent continuation"`.
- Do not modify any of #132's commits; all changes land in new commits on top of the stacked base.

## Deeper review — what is missing from CodeRabbit's plan

CodeRabbit's plan enumerates 7 requirement blocks. The deeper review below adds concrete acceptance, diagnostics, and risk notes per point, plus the three points CodeRabbit missed or under-scoped:

- A. The new style must not be written back to the per-app style cache if per-app style is enabled. `saveManualStyleForApp` snapshots the tone at recording start; selecting Style B mid-recording then saving it as the app target would leak the new style into the wrong app.
- B. The pill-attached review panel must not require a new WebView. The existing `floating_window_create` composer and the assistant pill both have separate Tauri windows; reusing the pill's renderer avoids both. The "voice edit" mic prompt the user saw comes from the composer WebView asking for `getUserMedia()`; routing voice edit through the main window's existing mic capture path removes the prompt.
- C. The thock volume control must be wired all the way through: persisted in the user prefs table, surfaced in the Audio dialog, synced to Rust on startup, and used as the sink gain on the warm path AND the fallback path. #132 only set a hard-coded `THOCK_VOLUME` and changed the audio code; the user-facing control and persistence are absent.
- D. The desktop agent event handler must distinguish two rejection classes:
  1. Critical (model provider, final assistant message, conversation end) — propagate.
  2. Non-critical (per-tool-result `createChatMessage`, streaming-state updates, tool-UI updates) — log and continue.
  The `for await` loop must use a `try { await sideEffect() } catch (e) { log(...) }` wrapper, not a direct `await`.
- E. The "resource id is invalid" log line in the diagnostics must be traced to a specific tool or persistence path so the regression test is anchored to the actual failure, not a synthetic one.

## Work items (ordered, smallest first)

1. **Branch and base sync.**
   - `git fetch origin fix/superfix-review-findings`
   - `git checkout -b arena/01a0358e-mausvoice-deepreview origin/fix/superfix-review-findings`
   - `git push -u origin arena/01a0358e-mausvoice-deepreview`
   - Open the stacked PR with the title above and the description below.

2. **Mid-dictation style default (D.1 in CodeRabbit, deepened).**
   - `apps/desktop/src/utils/dictation-style.utils.ts`: confirm `getEffectiveToneIdAtFinalize` still uses `toneIdAtStart` for post-processing of the active utterance. Keep this contract.
   - `apps/desktop/src/components/root/DictationSideEffects.tsx`: do NOT write `toneIdAtStart` back to `selectedToneId` during teardown or finalization. Audit `clearUtteranceToneSnapshots`, `stopRecording`, and `finalizeDictationStyle` to ensure no path overwrites the live selection.
   - `apps/desktop/src/actions/tone.actions.ts`: the existing `applyWritingStyleSelection` is the single owner. Verify hotkey, pill, and Styles page all funnel through it.
   - `apps/desktop/src/actions/app-target.actions.ts`: when per-app manual style is enabled, only persist the live selection AFTER it has been confirmed by the user, never from the recording-start snapshot. If the user switched mid-recording, save the new style, not the snapshot.
   - Add regression tests in `apps/desktop/src/utils/dictation-style.utils.test.ts`:
     - Start A, switch to B mid-recording, finalize → utterance uses A, live selection is B, next start uses B.
     - Same flow with per-app style enabled: B is saved as the app target, not A.
   - Add an integration test that drives `DictationSideEffects` through a fake `applyWritingStyleSelection` and asserts no overwrite.

3. **Windows installer sidebar art (D.2).**
   - Confirm #133 (commit `68fdc060`) is already in the stacked base. Read its changes and decide whether additional work is needed.
   - If #133 only added a logo bit and the user's screenshot still shows compression: replace the source artwork with a 164×314-safe design (logo + microphone mark within safe area) and add a CI assertion that the file is BMP, exactly 164×314, opaque.
   - If #133 fully covers it, mark the work item complete and reference the commit in the PR description.
   - Add the asset-contract check under `apps/desktop/scripts/check-installer-assets.ts` (or existing equivalent) and wire it into CI.

4. **Pill-attached native review panel (D.3 + D.4, deepest change).**
   - Remove the separate composer window entirely:
     - `apps/desktop/src/utils/composer.utils.ts`: replace `reviewTextInComposer` with `requestPillReview(text)` that returns a `Promise<string | null>` resolved by a native pill message.
     - `apps/desktop/src/components/composer/ComposerPage.tsx`: delete the file and its route.
     - `apps/desktop/src-tauri/src/commands.rs`: drop `floating_window_create`/`floating_window_destroy` usage for the composer; keep the command for other surfaces if any.
   - Extend the shared pill protocol in `packages/rust_pill_shared/src/lib.rs` with:
     - `ReviewRequest { id, text, mode }`
     - `ReviewState { id, text, status: editing|inserting|cancelled|error, error? }`
     - `ReviewAction::Insert(finalText)`, `ReviewAction::Cancel`, `ReviewAction::Edit(text)`
   - Render the review panel below the pill in all three native renderers:
     - `packages/rust_windows_pill/src/ui/`
     - `packages/rust_macos_pill/src/ui/`
     - `packages/rust_gtk_pill/src/ui/`
   - Use the existing assistant panel visual tokens (palette, spacing, typography) so the panel matches the assistant UI.
   - The pill header / drag region is the panel's drag affordance. No separate title bar.
   - Voice edit in the panel reuses the main window's mic capture path (`apps/desktop/src/utils/mic-capture.utils.ts` if it exists, otherwise the existing dictation capture). It does not create a new WebView, so no `getUserMedia()` prompt appears.
   - Decouple the review lifecycle from the dictation lifecycle:
     - `DictationSideEffects`: after finalize, set `isProcessing=false` and any in-flight `Loading` state to `Idle` before the review state opens.
     - The pill must not self-close while the review is open. The pill only closes when the user dismisses the review (Insert, Cancel, or window close) or after a bounded timeout.
   - Edge cases:
     - A second review request while the first is open updates the active review state and resolves the first promise with `null` (Cancel).
     - A new dictation start while review is open is allowed; the review keeps its own text and completion handler, and a new recording does not tear down the panel.
     - Every completion path clears timers, event listeners, and transient native UI state.
   - Tests:
     - `packages/rust_pill_shared/src/lib.rs` unit tests for review protocol state transitions.
     - Shared `requestPillReview` tests: Insert, Cancel, close, timeout, second request, dictation during review.
     - Renderer interaction tests (at least one per platform) for Insert/Cancel buttons and drag affordance.

5. **Thock volume control (D.5).**
   - Persist `interactionFeedbackVolume: number` (0..1, default 0.35) in the user prefs table. Add a migration `079_interaction_feedback_volume.sql` (next available integer; do not renumber) and register in `apps/desktop/src-tauri/src/db/mod.rs`. Add the field to `UserPreferences` in `packages/types/src/user.types.ts`, the Rust domain, the repo, the bindings, and the existing user actions.
   - `apps/desktop/src/components/settings/AudioDialog.tsx`: add a slider under the existing "Interaction feedback" toggle. Disable the slider when the toggle is off. Commit on slider release.
   - `apps/desktop/src/components/root/AppSideEffects.tsx`: on startup and on preference change, invoke a new Tauri command `audio_set_feedback_volume(volume: f32)` that updates an `AtomicU32` (or `OnceLock<f32>`) used by `play_thock_clip` and the fallback path. Clamp to `[0.0, 0.5]` server-side for safety.
   - `apps/desktop/src-tauri/src/system/audio_feedback.rs`:
     - Remove the hard-coded `THOCK_VOLUME` constant.
     - Read the live volume from the new global.
     - Apply the gain on the warm path AND the `play_clip_fallback` path (currently `play_clip_fallback` ignores volume for thock; this is the regression CodeRabbit called out in #132 and must be closed here).
   - Replace the WAV clips with a short, click-like transient. The current clips are bass-heavy by design. Use a 30–50 ms band-limited click (≈ 1–2 kHz, fast decay). Source a new asset and commit it under `apps/desktop/src-tauri/assets/audio/thock-*.wav`. Keep `play_thock_press`/`deep`/`release` as the entry points so call sites don't change.
   - Tests:
     - Rust: gain propagation, clamp, startup sync, fallback path applies volume.
     - TS: default value, persistence round-trip, slider disabled when toggle off, live update without restart.

6. **Desktop agent continuation (D.6).**
   - `apps/desktop/src/agents/run-agent.ts`:
     - Wrap each side effect (per-tool-result `createChatMessage`, streaming state updates, tool-UI updates) in a `safeSideEffect(label, fn)` helper that catches rejections, logs a sanitized error with conversation id and tool-call id, and returns. Use this everywhere a non-critical persistence or UI call sits inside the `for await` loop.
     - Keep critical paths (model provider errors, end-of-conversation tool) propagating so the loop terminates correctly.
     - Ensure `createChatMessage` failures for tool results do NOT terminate the run; the in-memory `AgentLoop` continues and the next iteration is issued.
   - Trace the specific `resource id is invalid` line in the diagnostics (CodeRabbit's grep hit the diagnostics zip). Identify the tool or persistence path that produced it. Add a focused regression test that forces the same rejection and asserts the loop still issues the next model request.
   - `packages/agent/src/agent-loop.test.ts`: extend with multi-tool and post-tool continuation cases; confirm cancellation-vs-tool-error discrimination (a `cancelled` run is not mislabeled as a tool failure).
   - Add `apps/desktop/src/agents/run-agent.test.ts` tests for: `createChatMessage` rejection on `tool-call-result`, streaming state update rejection, tool UI update rejection, and a happy multi-tool run.

7. **Verification gate.**
   - `pnpm --filter desktop lint`
   - `pnpm --filter desktop check-types`
   - `pnpm --filter @maus-inc/voice-ai test`
   - `pnpm --filter @repo/agent test`
   - Desktop focused tests: dictation style, pill review protocol, audio feedback, agent run, post-processing attribution, markdown.
   - `cargo test` for `rust_pill_shared`, Windows/macOS/GTK pill crates, and `src-tauri`. (CI on Windows; macOS and Linux per available runners.)
   - Installer asset contract test runs in CI.
   - Manual Windows verification at 100/125/150/200% scaling: NSIS sidebar art, thock click quality and volume, review panel drag/Insert/Cancel/timeout, agent continuation after a real tool call.

## Files to be touched (non-exhaustive, mapped to the work item)

- `apps/desktop/src/utils/dictation-style.utils.ts`, `apps/desktop/src/utils/dictation-style.utils.test.ts`
- `apps/desktop/src/components/root/DictationSideEffects.tsx`
- `apps/desktop/src/actions/tone.actions.ts`, `apps/desktop/src/actions/app-target.actions.ts`
- `apps/desktop/src/components/settings/AudioDialog.tsx`
- `apps/desktop/src/components/root/AppSideEffects.tsx`
- `apps/desktop/src-tauri/src/commands.rs`
- `apps/desktop/src-tauri/src/system/audio_feedback.rs`
- `apps/desktop/src-tauri/src/db/mod.rs`, new `apps/desktop/src-tauri/src/db/migrations/079_interaction_feedback_volume.sql`
- `packages/types/src/user.types.ts` and the user-prefs domain/repo
- `apps/desktop/src/utils/composer.utils.ts`, deletion of `apps/desktop/src/components/composer/ComposerPage.tsx` and its route
- `packages/rust_pill_shared/src/lib.rs`
- `packages/rust_windows_pill/`, `packages/rust_macos_pill/`, `packages/rust_gtk_pill/` (review panel UI)
- `apps/desktop/src/agents/run-agent.ts`, `apps/desktop/src/agents/run-agent.test.ts`
- `packages/agent/src/agent-loop.test.ts`
- `apps/desktop/src-tauri/assets/audio/thock-press.wav`, `…-deep.wav`, `…-release.wav` (replace)
- New CI script: `apps/desktop/scripts/check-installer-assets.ts` and CI wiring

## Risks and open questions

- The pill-attached review panel is the largest single change. The native pill renderers are platform-specific; the Windows path (WebView2-backed) is the most likely to surface new edge cases. The work item lists acceptance criteria that the implementer must hit; if a platform cannot honor the drag affordance in one iteration, the implementer must call that out in the PR description rather than ship a partial UX.
- Replacing the WAV clips requires sourcing or generating click transients. If the implementer cannot generate acceptable assets in-scope, ship the volume control alone and call out the asset change in a follow-up; do not leave the buzzy default.
- The diagnostics zip contains logs that the implementer should grep for `resource id is invalid` to anchor the agent continuation test to a real failure. If the exact call site cannot be identified, the implementer must add a test that exercises both `createChatMessage` and tool-UI update rejection paths.
- Confirm whether the stacked base already contains #133 and #134 by inspecting `origin/fix/superfix-review-findings` before opening the PR. If only #132 is present, the implementer must rebase onto the current head before pushing.

## Out of scope

- Any other 1.6 review items not raised by the user (e.g. assistant markdown rendering, Cerebras streaming normalization) are already in #132 and verified by CodeRabbit. Do not reopen.
- macOS / GTK build verification beyond the existing CI matrix; only Windows is in the user's report.
- A full UX rewrite of the assistant panel itself; the review panel reuses its tokens but does not redesign it.
