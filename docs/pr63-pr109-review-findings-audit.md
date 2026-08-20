# Review findings audit: PR #63 and PR #109 vs `3560b01`

Research note for the four assertive reviews of the superfix head. Each finding
was re-verified against the code at `3560b01` before any fix was written.
Verdicts: **fix** (real, addressed in this branch), **already correct** (the
reviewed stale snapshot predates the current fix), **refuted** (claim does not
hold), **out-of-band** (cannot be fixed by editing code).

External facts were checked against primary sources: the Hugging Face API for
`ggerganov/whisper.cpp` (revision `5359861c739e955e79d9a303bcbc70fb988958b1`,
per-blob LFS SHA-256 digests), the rfd 0.15.4 feature list on docs.rs, and the
AssemblyAI/xAI/Gemini API references.

## Findings marked for fix

| Finding                                                                                                                                                                                                                              | Source(s) | Evidence                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release.yml` "Build Tauri app" step runs POSIX `if [ ... ]` on `windows-latest` with no `shell: bash`                                                                                                                               | C, D      | `.github/workflows/release.yml:332-351`, matrix has `windows-latest` at line 158; every other POSIX step in the file declares `shell: bash`                                 |
| `humanizeScrub` collapses `\s{2,}` (paragraphs, code fences, JSON) and rewrites words inside code                                                                                                                                    | C, D      | `apps/desktop/src/utils/humanize.utils.ts:108`, call site `apps/desktop/src/agents/run-agent.ts:272` overwrites the persisted message                                       |
| Gemini `functionResponse.name` gets the synthetic `toolCallId` (`gemini-tc-N`), not the function name                                                                                                                                | C         | `packages/voice-ai/src/gemini.utils.ts:374` vs ids minted at `:449`                                                                                                         |
| Gemini retries every non-2xx (400/401/403/404) three times with a rebuilt base64 payload                                                                                                                                             | A         | `gemini.utils.ts:181` wraps untyped `Error`s in `retry({ retries: 3 })`                                                                                                     |
| Gemini streaming treats 200 HTML/empty/malformed-SSE as a successful empty completion; reader never released on early exit                                                                                                           | A         | `gemini.utils.ts:476-530`, `parseGeminiSse` has no `try/finally` and no "saw a valid chunk" check                                                                           |
| Gemini has no abort signal or deadline; `GenerateTextInput.signal` is dropped by `GeminiGenerateTextRepo`                                                                                                                            | C, D      | `apps/desktop/src/repos/generate-text.repo.ts:399-424`, `GeminiStreamChatArgs` at `gemini.utils.ts:404`                                                                     |
| Dictation backlog races: finalize drains outside `pasteQueue`; a failed drain with `newSegment` drops the new segment and clears `backlogActive`; queue rejects with no `.catch` guard; `cleanup()` never advances the session nonce | C, D      | `apps/desktop/src/strategies/dictation.strategy.ts:113-128,150,184-190,262-269,385-394`                                                                                     |
| "Review before insert" is silently void when real-time output is also on (every interim path passes `skipReview: true`)                                                                                                              | C         | `dictation.strategy.ts:167,197`; toggles at `apps/desktop/src/components/settings/MoreSettingsDialog.tsx:372-400`                                                           |
| Context menu renders `position: fixed` inline under Framer Motion route wrappers (re-anchored/clipped); Escape bubbles to parent dialogs                                                                                             | C, D      | `apps/desktop/src/components/common/ContextMenu.tsx:558-573`, `apps/desktop/src/components/dashboard/DashboardPage.tsx:56-74` (motion.div keeps `filter`/`transform`)       |
| Right-click "Delete" on a style deletes immediately, no confirmation, rejection uncovered                                                                                                                                            | C, D      | `apps/desktop/src/components/styling/ManualStylingRow.tsx:118`; confirmed flow exists in `ToneEditorDialog.tsx:352-360`                                                     |
| whisper.cpp ggml blobs come from mutable `/resolve/main/` with no digest, unlike the ONNX models                                                                                                                                     | B         | `packages/rust_transcription/src/models.rs:239-261`; the verified pipeline already exists (`DownloadArtifact.sha256`, `downloads.rs:716`)                                   |
| Composer-text reaper thread never stops and pins the map `Arc` for the process lifetime                                                                                                                                              | B         | `apps/desktop/src-tauri/src/state/floating_window.rs:44-52`                                                                                                                 |
| `unexpected_cfgs = "allow"` hides cfg drift                                                                                                                                                                                          | B         | `apps/desktop/src-tauri/Cargo.toml:119-123`                                                                                                                                 |
| `rfd` uses default features on macOS/Windows but not Linux                                                                                                                                                                           | B         | `Cargo.toml:81,93,102`; rfd 0.15.4 defaults pull `async-std`, `xdg-portal`, `ashpd`, `pollster`, `urlencoding` (docs.rs feature list)                                       |
| Private-HTTP and plaintext saved-endpoint validation inspects the URL string, never the resolved addresses; `no_proxy()` covers only the `PrivateNetwork` policy                                                                     | A, C, D   | `apps/desktop/src-tauri/src/commands.rs:640-655,671-748,840-855`                                                                                                            |
| `style` selection rollback restores a snapshot already containing the new id                                                                                                                                                         | C, D      | `apps/desktop/src/actions/tone.actions.ts:151-180` writes memory before `setSelectedToneId` snapshots `existing` in `user.actions.ts:47-84`                                 |
| Elevation preflight: undated awaits gate the whole app; preflight writes `draft.userPrefs` directly, bypassing `setUserPreferences` side effects                                                                                     | C, D      | `apps/desktop/src/actions/elevation.actions.ts:74-111`, gate at `AppWithLoading.tsx:15-40`                                                                                  |
| Secret scan workflow can never run its PR step (no `pull_request` trigger)                                                                                                                                                           | C, D      | `.github/workflows/secret-scan.yml:3-6,35-41`                                                                                                                               |
| `lint-desktop.yml` lost its least-privilege `permissions` block                                                                                                                                                                      | C, D      | `.github/workflows/lint-desktop.yml` has no `permissions:`                                                                                                                  |
| `i18n-sync.mjs` sorts with host-dependent `localeCompare`                                                                                                                                                                            | C, D      | `apps/desktop/scripts/i18n-sync.mjs:38`                                                                                                                                     |
| OpenAI docs claim the default model is `gpt-transcribe`; the implementation defaults to `whisper-1` and the model list has no `gpt-transcribe`                                                                                       | A         | `apps/docs/src/content/docs/providers/openai.md:12` vs `packages/voice-ai/src/openai.utils.ts:97-105,36-42`                                                                 |
| Both model pickers poll every 3 s with no in-flight guard and apply results after unmount/config change                                                                                                                              | A         | `OpenAICompatibleModelPicker.tsx:44-83`, `OllamaModelPicker.tsx:31-64`                                                                                                      |
| Bare `void set…()` preference calls produce unhandled rejections because the actions rethrow after the snackbar                                                                                                                      | C         | `updateUserPreferences` rethrows (`user.actions.ts:139-178`); flagged call sites in `AIAgentModeConfiguration.tsx:44-76`, `MoreSettingsDialog.tsx`, `MultiDeviceDialog.tsx` |
| `OpenAICompatibleRepo` branch in `OllamaModelPicker` (dead today) probes `${base}/models` without `/v1`                                                                                                                              | D         | `OllamaModelPicker.tsx:37`; the live `OpenAICompatibleModelPicker` passes a built URL so it is correct                                                                      |
| New UI strings ship as English placeholders in all nine non-English locales                                                                                                                                                          | D         | 65-86 keys identical to English per locale; review allows translating now or marking the rollout deferred                                                                   |
| `Vec<u8>` request/response bodies cross IPC as JSON number arrays (hundreds of MB at the configured caps)                                                                                                                            | C, D      | `commands.rs:451-466`; fix needs regenerated Specta bindings (Rust toolchain), so deferred with an inline note                                                              |
| `.ghtoken` credential may still live in git history                                                                                                                                                                                  | C, D      | File absent from tree and ignored (`.gitignore:115`); `gh api commits?path=.ghtoken` returns `[]` on default branch. Rotation and history purge remain out-of-band          |

## Already correct at the current commit (no action)

- DevTools are behind the compile-time `debug-assist` feature (`app.rs:267`); no unconditional `tauri/devtools` dependency.
- AssemblyAI retranscription sends the `speech_models` array (stale PR snapshot issue only).
- Context-menu surfaces exist throughout (stale PR snapshot issue only).
- Windows elevation gate and "Close mausVoice" -> real quit (`ElevationDeclinedDialog.tsx` -> `quitAfterElevationDecline` -> `quit_app`).
- `test-package-rust-transcription.yml` keeps the 45-minute timeout.
- `StyleHotkeysDialog` disables editing when post-processing is unavailable.
- `TitleBar` resize listener releases after cleanup via the cancellation flag.
- `ElasticSlider` keeps `translate(-50%, -50%)` in every thumb state
  (`THUMB_CENTER_TRANSFORM`).
- The "asyncronously" nitpick is not present at HEAD.

## Refuted with evidence

- **`audio.rs` 320,001 Hz comment (B).** 320,001 is inside the 8,000-384,000
  band, and `gcd(320001, 16000) = 1` means its polyphase table exceeds the 4M
  coefficient cap. The comment says exactly that some in-band rates are
  rejected; no edit needed.
- **ContextMenu `autoFocus` on a `Paper` div is a no-op (D).** React DOM's
  commit path focuses any host element with the `autoFocus` prop, and the
  element has `tabIndex={-1}`; keyboard navigation receives focus. A
  regression test now pins this.
- **Retranscription stale-generation early return strands the row (D doc).**
  `nextRetranscribeGeneration` only runs inside `retranscribeTranscription`,
  which is guarded by `isRetranscribingId`, so a generation can never be
  superseded while that row is in flight. Also flagged as not reproducible by
  the fourth review.
- **Gladia forced `streamReady = true` loses audio silently (D).** The timeout
  branch records `addWarning("Gladia did not become ready...")` and the SDK
  buffers `sendAudio` while not connected; this matches the documented
  contract (`gladia-transcription-session.ts:224-232`).
- **rfd `features = ["macos"]/["windows"]` (B's suggested patch).** Those
  features do not exist in rfd 0.15.4. The correct fix is
  `default-features = false` on both platforms so the Linux-style minimal
  surface is consistent.
- **Test-count assertion in CI (B).** A hardcoded pass count fails on every
  legitimate test refactor; zero-test suites already fail lint/type gates.
  Not adopted; counted as a style opinion per the REVIEW.md necessity gate.

## Deferred with a reason

Speech-to-text bodies through Specta JSON (above) is bound by the 32/128 MiB
caps and changing it requires regenerating `packages/desktop-native-apis` with
a Rust toolchain, which this environment lacks. Documented inline in
`commands.rs` and re-listed in the follow-ups section of this file's parent
note. The buffered (non-incremental) SSE responses over the private-HTTP
bridge are a documented tradeoff: local endpoints, short rewrite payloads.

## Resolution record (what this branch changed)

Workflows and CI:

- `release.yml`: `shell: bash` on every POSIX step that lacked it, including
  the matrix-spanning "Build Tauri app" step; new
  `scripts/ci/release-shell-contracts.test.mjs` guards the rule and runs in
  `test-docs.yml`.
- `secret-scan.yml`: added the `pull_request` trigger so gitleaks scans a PR's
  commit range before merge, not only after push to main.
- `lint-desktop.yml`: restored least-privilege `permissions: contents: read`.
- `run-tauri-with-sidecars.mjs`: local (non-CI) `tauri build` with
  `createUpdaterArtifacts: false` now prints a loud "this build cannot
  self-update" warning.

TypeScript and React:

- `humanize.utils.ts`: fenced code blocks and inline code pass through
  untouched; whitespace collapse is horizontal-only, so Markdown structure and
  JSON survive the scrub. 7 new structure-preservation tests.
- `gemini.utils.ts`: `functionResponse.name` now maps through
  tool-call-id to function name (orphan results dropped); `GeminiHttpError`
  carries the status and the retry helper skips non-retryable 4xx/abort (one
  request for 401/400, retries preserved for 429/5xx/network); streaming
  rejects empty or non-SSE 200 bodies instead of faking a success; the stream
  reader is cancelled and released in a `finally`; `signal` threading plus a
  5-minute deadline on non-streaming calls. 7 new tests.
- `dictation.strategy.ts`: all paste/drain work runs through one
  rejection-safe serial queue (`pasteQueue` can no longer poison); the
  finalize drain joins the queue (no double delivery with the poll); a failed
  combined drain re-backlogs the new segment; `cleanup()` advances the session
  nonce so stale drains self-invalidate. 4 new tests.
- Settings: real-time output and review-before-insert are mutually exclusive
  at the action layer with UI copy saying so (same persisted write). 3 new
  tests.
- `ContextMenu`: menu renders in a `document.body` portal (no transformed
  ancestor re-anchoring or clipping), Escape is consumed in capture phase so
  host dialogs survive it, and focus is moved into the menu explicitly
  (`autoFocus` on a div proved unreliable in tests). 3 new tests.
- `ManualStylingRow`: right-click Delete now opens the shared ConfirmDialog,
  and a rejected delete keeps the dialog open instead of producing an
  unhandled rejection. 3 new tests.
- `tone.actions.ts`: style switches snapshot the previous selection and
  restore it when persistence fails; the failure is logged and the promise no
  longer rejects into fire-and-forget callers. 1 new test.
- `elevation.actions.ts`: prefs read (15 s) and relaunch (5 min) are bounded;
  late relaunch results are ignored post-watchdog; prefs seeding routes
  through `setUserPreferences` so derived settings apply. 3 new tests.
- `ollama.repo.ts` flow: both model pickers now poll single-flight with
  stale-completion drops on unmount/re-configure; the openai-compatible branch
  builds the `/v1` base before probing. 6 new tests (picker + repo contract).
- Shared `logOnRejection` wrapper applied to every flagged bare-`void`
  preference call in `AIAgentModeConfiguration`, `MoreSettingsDialog`, and
  `MultiDeviceDialog`.
- `assemblyai.utils`: new contract tests pin the exact `speech_models`
  payload (fallback pair, legacy migration, no singular `speech_model`).
- `i18n-sync.mjs`: deterministic code-unit sort (produces byte-identical
  output to current catalogs), and all 86 new/updated user-facing strings are
  translated across the 9 locales. Placeholder integrity is verified by the
  applier, and `i18n:sync` re-runs as a no-op.

Rust:

- `commands.rs`: every request and redirect hop is validated, DNS-resolved,
  and policy-checked against the resolved addresses, then dialed pinned to
  those addresses; plaintext policies bypass the system proxy; link-local and
  unspecified addresses are rejected for every policy. 3 new test groups,
  including the `/v1/../admin` dot-segment case.
- `models.rs` + `api.rs`: whisper.cpp ggml downloads pin to revision
  `5359861c739e955e79d9a303bcbc70fb988958b1` with the upstream LFS SHA-256 for
  each blob (identical to the checksums in whisper.cpp's download script);
  env-var URL overrides remain and intentionally skip the digest check.
- `floating_window.rs`: the composer-text reaper wakes on a condvar and is
  joined on `Drop` — no sleeper thread holds the map alive past shutdown. 2
  new tests.
- `Cargo.toml`: `unexpected_cfgs` back to `warn` with the check-cfg list;
  `rfd` uses `default-features = false` on macOS/Windows matching Linux
  (rfd's defaults are the Linux portal stack — ashpd, async-std, pollster).

Docs:

- `openai.md`: default transcription model is `whisper-1` (matches the code).

## Post-review rounds on this branch

Round 2 (self-review vs main's full REVIEW.md, before PR creation): `CI=false`
truthiness in the sidecar script, and the i18n gate's placeholder exemption —
both fixed pre-merge.

Round 3 (reviewer re-verified case by case):

- SonarCloud flagged my comparator ternary (S3358) and my splitting regex
  (S8786 backtracking, S5843 complexity). The splitting regex was deleted
  outright in favor of a line scanner, then restructured once more when that
  scan introduced an optional-chain/startsWith/cognitive-complexity trio.
- The kilocode review caught a true fence-semantics defect (info-string lines
  inside fences closed the block) and my review of its report caught a second
  one (block-boundary newlines were lost when rejoining segments). Both fixed
  with exact-output regression tests, plus CRLF closing fences, leading-indent
  preservation, and horizontal-only em-dash folding.
- The same review caught the credential re-attachment flaw in my
  cross-origin strip (per-hop comparison) and the dead `www-authenticate`
  entry. Strip is now an initial-origin latch with a TcpListener-driven
  redirect-chain test asserting the header never reaches a foreign origin,
  including on the hop back.
- Conflicts with the docs overhaul PR (#125) were merged: base deletion of a
  stale plan file won, AGENTS.md took the union of both sides, and the base's
  more precise OpenAI doc paragraph was kept over mine.

## Still open (out-of-band)

- Rotate/revoke the token that may have been committed as `.ghtoken` and purge
  it from history (`git filter-repo` or BFG). The file is absent from the tree
  and ignored since.
- Binary IPC for the private/saved-endpoint bodies (see "Deferred").
