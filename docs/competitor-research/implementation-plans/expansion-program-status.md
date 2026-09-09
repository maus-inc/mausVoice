# Expansion Program Status

**Program:** mausVoice Expansion (competitor-derived features)
**Started:** 2026-09-01
**Base PR:** #144 (competitor research)
**Branch prefix:** `expansion/`

---

## Stack

| #   | Branch                             | PR   | Title                                                                                   | Status      | Parent                                                              |
| --- | ---------------------------------- | ---- | --------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| 1   | `expansion/1-shared-foundations`   | #149 | feat(expansion): shared foundations (feature flags, privacy-safe logging, shared types) | In progress | PR #144 head (`session/agent_2605e9ee-1c1c-4742-9d36-dcfc05851daf`) |
| 2   | `expansion/2-meeting-notes`        | —    | feat(expansion): meeting notes                                                          | Planned     | expansion/1                                                         |
| 3   | `expansion/3-local-automation`     | —    | feat(expansion): local automation (HTTP API, CLI, MCP)                                  | Planned     | expansion/2                                                         |
| 4   | `expansion/4-connectors-webhooks`  | —    | feat(expansion): connectors and webhooks                                                | Planned     | expansion/3                                                         |
| 5   | `expansion/5-translation-snippets` | —    | feat(expansion): translation and interactive snippets                                   | Planned     | expansion/4                                                         |
| 6   | `expansion/6-hands-free-workflows` | —    | feat(expansion): hands-free toggle and voice-triggered workflows                        | Planned     | expansion/5                                                         |

---

## Dependency order

1. Shared foundations (feature flags, privacy-safe logging, encrypted secret storage reuse, incognito persistence suppression, shared domain types and event contracts)
2. Meeting Notes (separate meeting domain, mic recording before system audio, platform-gated system audio, timed segments, diarization, summaries, Ask AI, search, exports)
3. Local automation (loopback-only HTTP API, CLI, read-only MCP, auth, rate limits, CORS, audit redaction)
4. Connectors and webhooks (durable event pipeline, webhooks, Obsidian, Notion, Slack)
5. Translation and interactive snippets (translation as AI operation, snippet fill-ins)
6. Hands-free toggle and voice-triggered workflows (toggle dictation, command mode, structured native actions)

---

## Product principles (must preserve)

- Local-first operation
- No telemetry
- Linux support
- Privacy and security
- Accessibility
- Incognito behavior
- Existing dictation flow

---

## Blockers

| Blocker  | Evidence | Affected | Next safe action |
| -------- | -------- | -------- | ---------------- |
| None yet | —        | —        | —                |

---

## Log

- 2026-09-01: Program initialized. PR #144 verified (head branch `session/agent_2605e9ee-1c1c-4742-9d36-dcfc05851daf`, state OPEN). Expansion label confirmed to exist. Competitor research reviewed (Vowen, Wispr Flow, TypeWhisper). Architecture and existing patterns analyzed.
- 2026-09-05: PR #148 (`expansion/shared-foundations`) and PR #149 turned out to
  be competing implementations of this same pole, both registering migration
  `075`. PR #149's single `expansion_flags` JSON column won on design, so its
  non-overlapping work was ported onto #149 rather than merging both: the sixteen
  event contracts, the typed listener hook, six Rust log sanitizer rules, and
  ephemeral session support. PR #148's nine flag columns, its `packages/types`
  domain types, and its separate feature-flag service were dropped as duplicates.
