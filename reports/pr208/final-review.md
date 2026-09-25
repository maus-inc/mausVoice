# PR 208 Takeover & Mediation Final Review

Updated on 2026-09-24. This report covers the full audit, deep mediation, and resolution of all inline reviews and nitpicks for PR #208 on `arena/01a0ca7d-mausvoice`.

## Summary of Results

- **Consolidated PR**: PR #208 (`https://github.com/maus-inc/mausVoice/pull/208`), base `0.1.6` (`3a37f922ee5c2cccaedc34e4feac7c86c78f23bd`).
- **Topology**: Exactly ONE squashed commit consolidating all accepted features and fixes against `0.1.6`.
- **Inline Reviews Audited & Addressed**: 26 / 26 items verified, resolved, and tested (`reports/pr208/inline-feedback-dispositions.json`).
- **CodeAnt Nitpicks Audited & Addressed**: 7 / 7 items resolved (`reports/pr208/nitpicks-dispositions.json`).
- **Local Verification Status**:
  - TypeScript Typecheck (`pnpm check-types`): 9/9 tasks passed (0 errors).
  - Linting (`pnpm lint`): Prettier, oxlint, and ui-lint clean (0 errors, 0 warnings).
  - Desktop TS Unit Tests (`pnpm --filter desktop run test:unit`): 174 test files, 1,944 tests passed (100% PASS).
  - Preview Unit Tests (`pnpm --filter @maus-inc/preview test`): 2 test files, 13 tests passed (100% PASS).
  - Voice AI Unit Tests (`pnpm --filter @maus-inc/voice-ai test`): 24 test files, 202 tests passed (100% PASS).
  - CI Contract Test Suites (`node --test scripts/ci/*.test.mjs`): 38 suites, 180 tests passed (100% PASS).
  - Prettier Code Style (`pnpm format:check`): All matched files use Prettier code style.

---

## Mediation & Deep Fixes Implemented

### 1. Overlay & Native Pill Repositioning (`packages/rust_macos_pill/src/app.rs`)

- **Issue**: `ResetPosition` reported the window's geometry before the next tick rehomes it, returning stale coordinates.
- **Fix**: Called `reposition_window(ctx.window, &ctx.state, dt, now)` directly inside `InMessage::ResetPosition` prior to querying `pill_geometry`.
- **Audio Levels**: Drained `pending_levels` via `std::mem::take` to prevent replaying stale audio level batches.

### 2. Windows Pill Placement & Region Scaling (`packages/rust_windows_pill`)

- **Top Placement**: Corrected `default_pill_y` for `PILL_PLACEMENT_TOP` to subtract `(WINDOW_H_TYPING - content_canvas_height(win_h))`, matching content canvas geometry.
- **Region Scaling**: Scaled click bounding boxes for flash action and reject buttons around `(center_x, center_y)` using animation scale factor `scale`.
- **Audio Levels**: Drained `pending_levels` on each frame tick.

### 3. Linux GTK Pill Click Regions & Borrow Conflict (`packages/rust_gtk_pill`)

- **Reject Action**: Updated `union_flash_action` to inspect both `state.flash_action` and `state.flash_reject_action`.
- **Borrow Safety**: Dropped `style_name` explicitly before calling `refresh_selector_click_regions` in `draw.rs`.
- **Audio Levels**: Drained `pending_levels` via `std::mem::take`.

### 4. Code & Markdown Formatting Safeguards (`apps/desktop/src/utils`)

- **Inline Code Preservation**: Protected inline code tokens (`__MAUS_INLINE_CODE_${idx}__`) before HTML stripping in `assistant-pill-text.utils.ts` so backticked tags like `<b>` are preserved as `"<b>"`.
- **Indented Code Blocks**: Added `readIndentedCodeBlock` in `humanize.utils.ts` to protect 4-space and tab-indented Markdown blocks from prose scrubbing.
- **Raw Transcript Whitespace**: Preserved verbatim provider output without `.trim()` when `hallucinationFilterEnabled` is false in `transcribe.actions.ts`.

### 5. Desktop SPA & Lifecycle Reliability

- **Multi-Device Target Filtering**: Filtered `selectedRemoteTarget` in `MultiDeviceDialog.tsx` to require `target.deviceRole === "receiver"` and deleted old device ID on rename.
- **Composer Error Handling**: Caught errors from `composer_register_text` in `ComposerReview.run()` to trigger `fail(error)` and show a recovery toast.
- **Unmount Safety**: Guarded `setInstruction("")` in `ComposerPage.tsx` with `mountedRef.current`.
- **Background Interval Deduplication**: Guarded updater check in `AppSideEffects.tsx` with `if (!isMainWindow) return;`.
- **Preview Scaling Fix**: Replaced `inset: 0` with `top: 0, left: 0` in `apps/preview/src/recreated/assistant-panel.tsx`.
- **Internationalization**: Updated word-count string in `zh-CN.json` to use "词". Added safe format fallback in `getIntl().formatMessage` for node/test contexts.
- **CI TOML Rule Validation**: Upgraded `check-gitleaks-config.mjs` to validate table header syntax and assignment regex.

### 6. Architectural PR 208 Sweep (Maintainer Comments #18 - #21)

- **Maintainer #18 (`pill_process.rs`)**: Refactored pill stdout reader to parse incoming payloads as JSON before event dispatch and switch on the exact top-level `type` field (`PillEvent`). Eliminated substring matching (`line.contains`) that previously misclassified review decisions containing `"click"` or `"typed_message"`. Added regression test suite covering complex review payloads, malformed inputs, and unrelated events.
- **Maintainer #19 (`api_key_queries.rs`, `api-key.repo.ts`, `ApiKeyList.tsx`)**: Introduced explicit presence tracking and clear contract (`clearTranscriptionPath`) distinguishing an omitted field from an explicit clear. Updated SQL update query to conditionally update or clear `transcription_path = CASE WHEN ?13 THEN ?14 ELSE transcription_path END`. Added regression tests verifying that clearing a custom path restores default provider endpoint resolution.
- **Maintainer #20 (`vitest.config.ts`)**: Excluded Node-native runner test files (`scripts/run-tauri-dev.test.mjs`, `scripts/run-tauri-with-sidecars.test.mjs`) from default Vitest runs to prevent `No test suite found` failures during `pnpm --filter desktop test`, while ensuring they execute cleanly under `pnpm --filter desktop run test:unit`.
- **Maintainer #21 (`packages/rust_windows_pill/src/pill.rs`)**: Corrected origin calculation for `PILL_PLACEMENT_TOP` in `default_pill_y` by subtracting the typing canvas offset `(WINDOW_H_TYPING - DICTATION_WINDOW_HEIGHT)`. Added visible-footprint regression tests ensuring the rendered collapsed pill footprint lands directly at `work_area_top + MARGIN_BOTTOM`.
