# Phase 3 — Consolidation Report (maus-inc/mausVoice)

**Branch:** `arena/01a0c779-mausvoice` → base `0.1.6`
**Tip:** `53202172` — 306 commits on top of `4b9c1b0` (fix/superfix-review-findings)
**Scope vs origin/0.1.6:** 1,013 files changed, +107,994 / −19,577
**Gate status:** `check-types` 9/9 (desktop, preview, all packages) · vitest `src` 144/144 files · `scripts` 5 files/66 tests + node --test 4/4 · Rust validated in CI only (no local cargo)

> **Push & PR creation blocked:** the sandbox's GitHub token expired mid-session
> (`gh auth status`: "token in GH_TOKEN is no longer valid"). Reconnect GitHub in
> Arena, then: `git push origin arena/01a0c779-mausvoice` and
> `gh pr create --base 0.1.6 --head arena/01a0c779-mausvoice`.

---

## 1. Consolidation ledger — accepted PRs

| PR   | Branch                         | Absorbed as                    | Notes                                                                                              |
| ---- | ------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| #63  | fix/superfix-review-findings   | merge base `4b9c1b0`           | base of this branch                                                                                |
| #149 | expansion/1                    | `b97ced87` + repair `ff79a5d7` | 27 foundation commits; #144's 2 competitor-doc commits excluded; prefs/migration/locale union      |
| #74  | arena/01a01583                 | `b89471aa`                     | 10-locale key union                                                                                |
| #190 | arena/01a08611                 | `d5e7a829`                     | clean                                                                                              |
| #191 | fix/pill-idle-after-transcript | `157242ee`                     | DictationSideEffects union                                                                         |
| #192 | arena/01a08680-item02          | `632fd6eb`                     | stack items 02–13 restaged; ours-preferred on 47 conflicts; bindings ChatMessage `metadata` synced |
| #193 | feature/01                     | `489865d8`                     | clean                                                                                              |
| #194 | feature/02                     | `e1e40e85`                     | clean                                                                                              |
| #195 | feature/03                     | `b8daf7f3`                     | clean                                                                                              |
| #196 | feature/04                     | `8f70e040`                     | clean                                                                                              |
| #197 | feature/05                     | `76c38bac`                     | 10-locale union                                                                                    |
| #198 | feature/06                     | `ade1b17a`                     | TitleBar theirs; 9 locales                                                                         |
| #200 | feature/07                     | `97b0f5be`                     | update/release system                                                                              |
| #201 | feature/08                     | `9f9866fd`                     | review-before-insert redesign; pill-review tests rewritten                                         |
| #202 | feature/09                     | `229c1d78`                     | chat overhaul; AgentActivity deleted                                                               |
| #203 | feature/10                     | `1d80836f`                     | onboarding synthesis                                                                               |
| #204 | feature/11                     | `7d946e8b`                     | MoreSettingsDialog UD → toggles ported to SettingsPage                                             |
| #205 | feature/12                     | `aa14a4a5`                     | pipeline timing; 4-conflict synthesis; `trace` threaded                                            |
| #206 | feature/13                     | `70e93000`                     | motion tokens; 4-conflict synthesis (THEIRS + our springs; pressScale 0.97)                        |

## 2. Consolidation ledger — accepted branches

| Branch                          | Absorbed as                         | Unique content                                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arena/01a08680-mausvoice`      | _(0 commits)_                       | UX-01..03 fully contained in #192                                                                                                                                                                                                           |
| `arena/01a08119-mausvoice`      | `764979f6`                          | HTTP frame ceiling division, decode buffers, audio-dir holding (6 fixes)                                                                                                                                                                    |
| `arena/01a08138-mausvoice`      | `ed8cdff6`                          | composer history sync, post-process fallback, agent timeouts                                                                                                                                                                                |
| `arena/01a0816a-mausvoice`      | `761229c2`                          | `apps/preview` design-system site                                                                                                                                                                                                           |
| `arena/01a08698-mausvoice`      | `b1b48598`                          | browser mock preview runtime                                                                                                                                                                                                                |
| `session/agent_6be3…`           | `c7b33a45`                          | delta: agent tools config, audio chunking, SHA model verify, tones, mac pill feedback (conflicts ours-preferred)                                                                                                                            |
| `session/agent_b605…`           | `86c3f04c`                          | OpenAI-compatible URL builder (hands-free delay already present)                                                                                                                                                                            |
| `kilo/jade-koala-jw8`           | `33bde06e`                          | `.prompts/` + agent-prompt.md docs                                                                                                                                                                                                          |
| `kilo/bright-band-dnxggy4v`     | `63e9d908`                          | conditional: toasts/gladia already present; docs cleanup landed                                                                                                                                                                             |
| `fix/pr137-conflict-resolution` | 14 cherry-picks `1d4e6f75…3c13f20c` | branch had committed conflict markers → wholesale merge aborted; individual fix commits cherry-picked (purge-oldest, pill stdout, AssemblyAI-era fixes, launch_env, WAYLAND, matches→String, rustdoc, openrouter docs); "wip" merge skipped |
| `arena/01a07c20-mausvoice`      | **pruned (deferred→covered)**       | dashboard route transitions already present: `DashboardPage` `AnimatePresence` keyed by `location.key` (richer than 07c20's version)                                                                                                        |

## 3. Rejected — PRs to close

Close these PRs (content intentionally excluded from the consolidation):

1. **#144** — competitor docs (incl. the two doc commits that parent expansion/1; excluded during cherry-pick)
2. **#151** — meeting notes / capture
3. **#199** (`expansion/2-…`) — meeting notes / capture

Rejected branches (no PR action needed, safe to delete with the auto-safe-delete set):
`expansion/4`, `expansion/5`, `pr-131`, `kilo/dazzling-canvas-qcq`,
plus zero-unique: `arena/01a0358e`, `buoy/setup`, `convoy/…/d352b574/head`, `dev`, `prod`.

After this consolidation PR merges into `0.1.6`, the absorbed PRs above
(#63, #74, #149, #190–#198, #200–#206) can also be closed as completed.

## 4. Repair log (quality gates caught real damage)

- pr137 cherry-picks initially clobbered redesigned files via theirs-wholesale conflict picks → restored `output-routing`, `dictation.strategy`, `DictationSideEffects`, `transcribe-audio.repo`, `bindings`, `remote.types`, assemblyai session, `commands.rs` (6,595-line modular form), evolved `voice-ai` utils from pre-pick state
- rust contract-test markers lost to pr137 picks → `app.rs`, `pill_process.rs`, windows `pill.rs`/`ipc.rs` restored from `63e9d908`
- `transcribe.actions` + `toast.actions` restored from last-green `632fd6eb` (postProcess* metadata fields; duplicate toasts removed)
- resurrected `MoreSettingsDialog.{tsx,test}` + `review.types.ts` deleted (accepted deletions from #204/#201)
- duplicate `hasPendingReview` in `DictationSideEffects` deduped
- `preview` demos adapted to current component API (`variant="blue"` → `contained`, dropped `Breadcrumb separator`)
- CSP contract: `www.w3.org` (SVG xmlns) classified as non-connect
- 10 beta/changelog/update-channel i18n keys translated across 9 locales
- pipeline-overhead baseline re-recorded for this machine (`UPDATE_BASELINE=1`)

## 5. Verification

```
npm run check-types            → Tasks: 9 successful, 9 total
vitest run src                 → 144/144 files, 1520/1520 tests (post-fix)
vitest run scripts (+ node)    → 5 files/66 tests + 4/4
integration/evals              → skipped: require GROQ_API_KEY etc. (by design)
Rust/CI                        → to be validated by GitHub Actions on push
```
