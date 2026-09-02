# Expansion Program Status

**Program:** mausVoice Expansion (competitor-derived features)
**Started:** 2026-09-01
**Base PR:** #144 (competitor research)
**Branch prefix:** `expansion/`

---

## Stack

| # | Branch | PR | Title | Status | Parent |
|---|--------|----|-------|--------|--------|
| 1 | `expansion/1-shared-foundations` | #149 | feat(expansion): shared foundations (feature flags, privacy-safe logging, shared types) | All CI green | PR #144 head (`session/agent_2605e9ee-1c1c-4742-9d36-dcfc05851daf`) |
| 2 | `expansion/2-meeting-notes` | #151 | feat(expansion): meeting notes domain (DB, Tauri commands, repos, actions) | PR open, CI running | expansion/1-shared-foundations |
| 3 | `expansion/3-local-automation` | — | feat(expansion): local automation (HTTP API, CLI, MCP) | Planned | expansion/2 |
| 4 | `expansion/4-connectors-webhooks` | — | feat(expansion): connectors and webhooks | Planned | expansion/3 |
| 5 | `expansion/5-translation-snippets` | — | feat(expansion): translation and interactive snippets | Planned | expansion/4 |
| 6 | `expansion/6-hands-free-workflows` | — | feat(expansion): hands-free toggle and voice-triggered workflows | Planned | expansion/5 |

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

| Blocker | Evidence | Affected | Next safe action |
|---------|----------|----------|------------------|
| None yet | — | — | — |

---

## Log

- 2026-09-01: PR #149 created (expansion/1-shared-foundations). All CI green after fixes: clippy chunks_exact→as_chunks, redaction utils complexity reduction, SonarCloud codePointAt/Math.trunc, optional parseExpansionFlags parameter. Ready for Meeting Notes PR.
