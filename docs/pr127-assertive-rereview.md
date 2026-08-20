# PR #127 — assertive re-review (post-merge head 2c32238)

**Profile:** CodeRabbit assertive persona per `REVIEW.md` on `main` (the full
659-line handbook — personas §1.1/§1.2, ten-point audit protocol §2.4, report
structure §2.5).

**Reviewed against:** `fix/superfix-review-findings` base @ `30e7af0` → branch
head `2c32238`. The branch comprises the four-round fix set on top of the
superfix head, the workflow patch (applied by the scoped downstream agent in
`817fd46`), the bindings regen, the docs-overhaul merge, the SonarCloud fixes,
and the three kilocode re-review corrections, closing with the duplicate-test
repair `2c32238`.

**Method:** re-read the full final-state surface per area (private HTTP stack,
reaper, model pinning, humanize scrubber, Gemini transport, dictation queue,
elevation preflight, tone rollback, pickers, context menus, dialogs, CI
workflows, scripts), traced the ten checklist points mechanically (not
recited), swept the branch diff for `.only` markers, `transition: all`, stray
hex colors, duplicate test-item names, and stacked `#[test]` headers.

## Verdict: **Ready**

`Confidence: High` · `Mergeable: Yes` (GitHub: `MERGEABLE`, 0 conflicts with
base) · `CI Verification: Pending` — Windows Build is the only job still
running; Linux/macOS builds, all lint legs, Desktop Rust Unit Tests
(incl. the two TcpListener redirect-chain tests), Desktop TS Unit Tests
(825 samples incl. 29 humanize tests), i18n sync converges no-op, SonarCloud
quality gate passes with **0 open issues**, Socket, Secret Scan, and
integrations are green.

## Major findings

None. The loop iterated until nothing survived the §2.2 four-check gate
(Cause/Action/Reaction/Necessity). The last genuine defects:

- Duplicate `#[test]` header stacking (E0428) — fixed in `2c32238`,
  verified 1 definition, balanced braces, no adjacent headers, only legal
  cfg-exclusive name pairs elsewhere.
- Credential re-attachment on redirect chains (initial per-hop comparison)
  — fixed with an initial-origin latch plus TcpListener chain tests.
- Fence info-string/CRLF/indentation/em-dash regressions in the humanize
  rewrite — all fixed with exact-output regression tests.

## Minor findings

- **🟡 `docs` drift note, not a bug:** `AGENTS.md` now contains a union of the
  #125 style rewrite and the downstream agent's Rust-toolchain section; the
  styles differ slightly between the two halves. Intentional union from the
  conflict resolution; harmonizing wording is a style edit, deferred per the
  necessity gate.
- **🟡 Windows build still pending** at review time (mechanical, not a code
  risk — same compile unit as the green Linux leg and Rust unit matrix).

## Nitpick findings

None open. Prior rounds closed the trailing-whitespace, EOF-blank-line, and
formatting-drift items; `git diff --check` is clean on the head.

## UI review findings

No outstanding items. Prior rounds closed portal positioning, Escape nesting,
confirmless destructive actions, preference-pair exclusivity, throwaway-void
rejections, and the 86-string i18n rollout across nine locales; the picker
single-flight/stale-drop behavior is under regression tests.

## Missing important test coverage

Where the reviews asked for coverage, it now exists (enumerated in
`docs/pr63-pr109-review-findings-audit.md`). The only honest gap left: a
live-response streaming e2e test for the private-HTTP bridge requires a real
Tauri runtime environment, which no CI leg in this repo provides today — and
that was already the case before this branch. Not introduced here.

## What is working correctly

- Manual redirect loop now implements every hop rule end-to-end: per-hop
  URL validation, DNS resolution + address-set policy check, connection
  pinned to the validated answers, redirect semantics mirrored from reqwest
  (307/308 keep method/body, else GET), credential latch, proxy bypass for
  plaintext policies, and per-hop 5-redirect cap.
- Humanize scrubber is now fully structure-sound: fenced and inline code even
  under CRLF, indented blocks, em-dash folding that never merges lines, and
  horizontal-run collapse with exact-output tests on multi-block documents.
- Dictation backlog lifecycle races are closed by construction (serialized
  queue + per-cleanup nonce increments) rather than by comment.
- Pinning uniformity: ONNX and whisper.cpp model downloads now share one
  verified-artifact pipeline with immutable revisions and LFS digests.
- The four-round review history (assertive reports → implementation →
  self-review loop → bot-verification loop) is documented in
  `docs/pr63-pr109-review-findings-audit.md` and
  `docs/pr63-pr109-followup-review.md`.

## Handoff state

No handoff patch is outstanding: the only previously deferred item — the
`.github/workflows/*` hardening — was already applied in-tree by the scoped
agent (`817fd46`), and this round's fixes touch no workflow files. The
remaining out-of-band item is unchanged: revoking/rotating the historical
`.ghtoken` credential and purging its history, which requires the repository
owner, not code.
