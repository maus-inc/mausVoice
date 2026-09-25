# PR 208 Review & Deep Remediation Roadmap

**Target branch:** `0.1.6` (`3a37f922`)
**Pull Request:** #208 (`https://github.com/maus-inc/mausVoice/pull/208`)
**Head Commit:** `5162182`
**Review Protocol:** `FULL-REVIEW.md` (authoritative) & 6-Pass Multi-Pass Review

---

## 1. Multi-Pass Review Matrix (6 Passes)

### Pass 1: Diff, Symbol, and Boundary Trace (Phase 1)

- **Tauri IPC & Generated Bindings:** Checked `commands.rs` against `packages/desktop-native-apis/src/bindings.ts`. Verified `transcription_audio_load` command matches frontend invocations across native and preview mock runtimes.
- **Preview Mock Runtime Boundaries:** Discovered IPC mismatch in `apps/desktop/src/preview/runtime.ts` handling `transcription_load_audio` instead of `transcription_audio_load`, and case sensitivity in `openRouterConfig` vs `openrouterConfig`.
- **Pill IPC Messages:** Traced `InMessage::ResetPosition` across macOS, Windows, and GTK implementations. Discovered macOS pill reported stale window geometry before running position tick.

### Pass 2: Contract Review (Phase 2 - Inputs/Outputs, Concurrency, Lifecycle, Failure)

- **Transcription Failure Handling:** In `DictationSideEffects.tsx`, empty transcriptions with warnings returned `{ shouldContinue: false }` without invoking `handleEmptyTranscriptionResult`, skipping recording persistence and error recovery toasts.
- **Hotkey Disablement Lifecycle:** In `DictationSideEffects.tsx`, `OPEN_CHAT_HOTKEY` was gated on `isActiveSession`, preventing users from opening chat when idle.
- **Multi-Device Target Selection:** In `MultiDeviceDialog.tsx`, target resolution did not filter by `role === "receiver"`, and device ID edits caused duplicate insertions rather than migrating/updating existing paired records.
- **Batch Transcription Silence Metadata:** In `transcribe-audio.repo.ts`, early exit on silence returned hardcoded `"api"` mode for local models, and leading silent chunks caused entire multi-segment recordings to report `null` metadata.

### Pass 3: Security, Authority & Secret Boundaries (Phase 3)

- **Prompt Console Logging:** In `prompt.utils.ts:829`, `console.log("Agent prompt", base)` leaked unredacted user transcripts and instructions to the production console.
- **Gitleaks CI Scanner Config:** In `check-gitleaks-config.mjs`, multiline arrays in `[extend]` truncated table boundaries, and substring matching on `"keywords"` risked false positives.
- **Incognito Persistence Confinement:** In `transcriptions.actions.ts:394`, imported audio under incognito mode did not create an in-memory session record, causing transcripts to disappear completely from the UI.

### Pass 4: Test Review & Test Validity (Phase 4)

- **Humanize Markdown Parser Protection:** In `humanize.utils.ts`, 4-space indented code blocks were parsed as prose, exposing code blocks to slop-word rewrites.
- **Assistant Pill Text Normalization:** In `assistant-pill-text.utils.ts`, HTML stripping executed before inline code replacement, destroying inline tags like `` `<div>` ``.
- **Gemini Multi-Tool Chat Conversations:** In `gemini.utils.ts`, consecutive `tool` results generated separate `user` turns, violating Gemini's alternating-turn schema.

### Pass 5: Desktop End-to-End & Runtime Scenarios (Phase 5)

- **Composer Window Positioning:** In `composer.utils.ts`, `ensurePillGeometry` was never called before opening the composer, defaulting to OS window placement on initial reviews.
- **Composer Text Registration Errors:** Rejections in `composer_register_text` bypassed `.catch()`, suppressing recovery notifications.
- **Periodic App Update Polling:** `useIntervalAsync` in `AppSideEffects.tsx` ran in auxiliary webview windows (e.g. composer), duplicating 6-hour polling checks.

### Pass 6: Anti-Pattern & Platform UI Sweep (Phase 6 & Sections 13-17)

- **GTK Pill Hit Testing & Region Union:** In `rust_gtk_pill`, `union_flash_action` only checked `flash_action`, ignoring `flash_reject_action`. `tick_audio_levels` failed to take pending levels, causing audio meters to stick during pauses.
- **Windows Pill Top Margin & Scale Math:** In `rust_windows_pill`, top placement positioned the window without accounting for content canvas height offset. Flash button click regions retained unscaled coordinates during scale animations.
- **Preview UI Scale Nesting:** In `apps/preview/src/recreated/assistant-panel.tsx`, `inset: 0` conflicted with explicit dimensions and scale transforms.

---

## 2. Remediation Plan

| #   | Component / File                                             | Issue Description                                 | Proposed Deep Fix                                                                 |
| --- | ------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | `packages/rust_macos_pill/src/app.rs`                        | `ResetPosition` reports stale coordinates         | Execute `unsafe { tick(ctx.window, &ctx.state) }` before querying `pill_geometry` |
| 2   | `apps/desktop/src/preview/scenarios.ts`                      | Missing system tones in preview state             | Seed `getDefaultSystemTones()` into `state.toneById` alongside custom tones       |
| 3   | `apps/desktop/src/utils/prompt.utils.ts`                     | Prompt leaking to console                         | Remove `console.log("Agent prompt", base)`                                        |
| 4   | `apps/desktop/src/preview/runtime.ts`                        | `openRouterConfig` property casing mismatch       | Normalize casing in `api_key_update` wire record mapping                          |
| 5   | `apps/desktop/src/preview/runtime.ts`                        | Unhandled mock command `transcription_audio_load` | Add `case "transcription_audio_load"` matching repository invocations             |
| 6   | `apps/desktop/src/components/root/DictationSideEffects.tsx`  | Empty transcript with warnings discards audio     | Invoke `handleEmptyTranscriptionResult` before returning                          |
| 7   | `apps/desktop/src/components/root/DictationSideEffects.tsx`  | Open chat hotkey disabled when idle               | Remove `!isActiveSession` constraint from `OPEN_CHAT_HOTKEY`                      |
| 8   | `packages/rust_gtk_pill/src/input.rs`                        | Reject button clicks ignored on GTK pill          | Check both `flash_action` and `flash_reject_action` in `union_flash_action`       |
| 9   | `packages/rust_gtk_pill/src/pill.rs`                         | Waveform stuck during recording pause             | `std::mem::take` from `pending_levels` on each frame                              |
| 10  | `apps/desktop/src/components/settings/MultiDeviceDialog.tsx` | Sender displayed as receiver                      | Filter `pairedDevices` for `device.role === "receiver"` in target selection       |
| 11  | `apps/desktop/src/components/settings/MultiDeviceDialog.tsx` | Device ID edit creates duplicate record           | Delete old record with `editingDeviceId` when ID is modified                      |
| 12  | `packages/rust_windows_pill/src/pill.rs`                     | Top placement offset by content margin            | Adjust top placement Y coordinate by content canvas height                        |
| 13  | `packages/rust_windows_pill/src/draw.rs`                     | Flash click regions unscaled during fade          | Scale click region coordinates around `(center_x, center_y)`                      |
| 14  | `apps/desktop/src/actions/transcriptions.actions.ts`         | Imported audio lost in incognito mode             | Register in-memory transcription in `state.transcriptionById`                     |
| 15  | `apps/desktop/src/utils/humanize.utils.ts`                   | Indented code blocks scrubbed as prose            | Add indented code block protection to Markdown scanner                            |
| 16  | `apps/preview/src/recreated/assistant-panel.tsx`             | `inset: 0` layout scaling conflict                | Replace `inset: 0` with `top: 0, left: 0`                                         |
| 17  | `apps/desktop/src/i18n/locales/zh-CN.json`                   | Character unit used instead of word unit          | Update Chinese word count message to "词"                                         |
| 18  | `scripts/ci/check-gitleaks-config.mjs`                       | Multiline arrays & keyword false positives        | Verify table header line structure and match `keywords =` assignment              |
| 19  | `packages/rust_gtk_pill/src/draw.rs`                         | `style_name` double borrow in tooltip frame       | Drop borrow before invoking `refresh_selector_click_regions`                      |
| 20  | `packages/voice-ai/src/gemini.utils.ts`                      | Multiple tool calls create invalid user turns     | Group consecutive `functionResponse` parts into one user turn                     |
| 21  | `apps/desktop/src/utils/assistant-pill-text.utils.ts`        | HTML strip destroys inline code tags              | Protect inline code spans with placeholder tokens during HTML stripping           |
| 22  | `apps/desktop/src/utils/composer.utils.ts`                   | `composer_register_text` error uncaught           | Wrap in try/catch and route errors through `this.fail(error)`                     |
| 23  | `apps/desktop/src/utils/composer.utils.ts`                   | Composer unanchored on first review               | Call `ensurePillGeometry()` before initializing `ComposerReview`                  |
| 24  | `apps/desktop/src/actions/transcribe.actions.ts`             | Leading whitespace altered when filter disabled   | Preserve verbatim text without `.trim()` when filter is off                       |
| 25  | `apps/desktop/src/components/common/ContextMenu.tsx`         | Disabled menu items focusable via keyboard        | Skip `item.disabled` items in keyboard navigation                                 |
| 26  | `apps/desktop/src/components/composer/ComposerPage.tsx`      | `setInstruction` called after unmount             | Move `setInstruction("")` inside `if (mountedRef.current)`                        |
| 27  | `apps/desktop/src/components/root/AppSideEffects.tsx`        | Duplicate updater poll in secondary windows       | Guard interval with `if (!isMainWindow) return;`                                  |
| 28  | `apps/desktop/src/repos/transcribe-audio.repo.ts`            | Silent chunks report null / wrong metadata        | Use instance `transcriptionMode` and find first valid segment metadata            |
