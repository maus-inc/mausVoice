# Competitive feature research and gap analysis

**Product:** mausVoice, the cross-platform voice dictation desktop app at maus-inc/mausVoice.
**Competitors:** Vowen, Wispr Flow, TypeWhisper.
**Snapshot date:** 2026-08-26. All feature and pricing claims are sourced from each competitor's own docs or marketing site on that date. Open-PR statuses are a snapshot and may have shifted.
**Method:** three parallel sub-agents crawled each competitor's docs and marketing site, one sub-agent extracted mausVoice's feature set from the codebase, and a second wave reviewed the seven open PRs that were in flight on 2026-08-26.

---

## 1. Combined competitor feature pool

`V` is Vowen, `W` is Wispr Flow, `T` is TypeWhisper.

### Core dictation

- System-wide dictation into any app (V, W, T). mausVoice: yes.
- Push-to-talk and hands-free toggle mode (V, W, T). mausVoice: partial. Hold-to-talk exists; hands-free delay lands via in-flight PR #137.
- Real-time streaming transcript preview (V Pro, W Pro, T). mausVoice: yes through Deepgram, AssemblyAI, ElevenLabs streaming sessions.
- Clipboard fallback when no field is focused (W). mausVoice: yes, history plus paste.
- Clipboard restore after paste (V). mausVoice: partial. Paste and clipboard insertion exist; explicit restore is unverified.
- Whisper-quiet or low-gain dictation (W whisper mode, T whisper mode). mausVoice: no dedicated gain boost.

### Speech and transcription models

- 14 cloud STT providers via BYO key (V 14 from 12 providers, T 16+). mausVoice: yes, Deepgram, OpenAI, Groq, AssemblyAI, ElevenLabs, Azure, plus others.
- Strong local model support: Parakeet, Canary, Whisper.cpp, WhisperKit, Apple Speech, Nemotron (V, T). mausVoice: yes, local sidecar runs whisper.cpp plus Parakeet and Canary ONNX.
- Custom OpenAI-compatible STT endpoint (V, T). mausVoice: yes, PR #137 adds the custom transcription path.
- GPU acceleration for local models (V NVIDIA CUDA on Windows, T Vulkan via whisper.cpp). mausVoice: partial. The whisper sidecar exposes a `ComputeMode::Gpu` flag that calls `use_gpu(true)`; Vulkan is not selected explicitly. CUDA is reachable when the `gpu` feature compiles in.

### AI and LLM text processing

- Grammar, filler, punctuation cleanup (V, W, T). mausVoice: yes, AI post-processing.
- Built-in plus custom writing styles per app (V, W, T). mausVoice: yes, custom styles per app.
- Spoken-symbol and punctuation conversion (V, mausVoice). mausVoice: yes.
- Command Mode, speak an instruction to transform selected text (V, W paid, T). mausVoice: partial, Assistant mode is experimental.
- Translations (V Pro auto-translate, T workflows, W limited). mausVoice: no dedicated translation feature.
- Auto-learn corrected words into the dictionary (T Premium correction learning, W auto-adds). mausVoice: in-flight via PR #142.

### Editing, commands, and workflows

- Voice-triggered workflows, open URL, app, or script (V, T). mausVoice: no.
- Text Expander with fill-in variables and rich snippets (V fill-in choice fields, W snippets, T `{{DATE}}` placeholders). mausVoice: partial. Snippets work via replacement rules; no fill-in choice fields.
- Webhook delivery (V, T). mausVoice: no.
- Custom utilities, reusable AI prompts (V, T workflows). mausVoice: no. Assistant covers ad-hoc.

### Meeting notes and notetaker

- Silent call capture with no bot for Zoom, Meet, Teams, Discord (V, W Notetaker). mausVoice: no.
- Speaker diarization (V Pro, W, T partial). mausVoice: no.
- AI meeting summaries with templates (V 44 templates, W summaries, T recorder plus Obsidian). mausVoice: no.
- Ask-AI across meetings and notes (V Pro, W). mausVoice: partial. Assistant chat is experimental.
- Meeting auto-detect and auto-stop (V Pro, W). mausVoice: no.
- Watch-folder transcription (V, T). mausVoice: no.

### Integrations

- Obsidian export (V Pro, T). mausVoice: no.
- Connectors for Notion, Slack, Gmail, Linear, Calendar (V Pro, W Notetaker, T). mausVoice: no.
- Cloud sync through iCloud, Drive, Dropbox, OneDrive (V Pro, W, T Premium). mausVoice: no, local-only by design in the personal fork.
- Multi-device output and pairing (T, mausVoice). mausVoice: yes, LAN pairing over unencrypted TCP, documented in `docs/desktop-architecture.md`.

### Platforms

- macOS plus Windows for V, W, T. mausVoice: yes, plus Linux.
- Linux (V coming soon, W roadmap, T no). mausVoice: yes, shipping.
- iOS and Android (W yes, T iOS alpha, V coming). mausVoice: no.

### Developer and API surface

- Local HTTP API (T on 127.0.0.1:8978, V OpenAPI). mausVoice: no.
- CLI (V `vowen`, T `typewhisper`). mausVoice: no.
- MCP server (V 23 tools outbound, W read-only Notetaker MCP). mausVoice: no.

### Privacy and security

- Local-first with no telemetry (V partial because PostHog has no opt-out, T none, W cloud-only). mausVoice: yes, local-only with no analytics.
- Encrypted API keys at rest (V, W, T). mausVoice: yes, XChaCha20-Poly1305 in `apps/desktop/src-tauri/src/system/crypto.rs`.
- HIPAA, SOC 2, ISO compliance (W). mausVoice: no, not targeted.
- Compliance certification gap noted.

### Pricing

- Vowen: free plus $49 one-time lifetime Pro.
- Wispr Flow: free with 2,000 words per week on desktop, Pro $12 per month annual or $15 monthly, Enterprise custom.
- TypeWhisper: free GPLv3 core, Commercial from €5 per month or €99 lifetime, Lifetime tiers at €99, €299, €999, Supporter tiers at €10, €25, €50.
- mausVoice: free, AGPL-3.0, no account or subscription (personal fork removed cloud gating in 0.1.6).

---

## 2. mausVoice feature inventory

Have: global system-wide dictation, hold-to-talk, live streaming via Deepgram, AssemblyAI, ElevenLabs, fully local transcription through the whisper.cpp plus Parakeet and Canary sidecar, AI post-processing with built-in Polished, Verbatim, Email, Chat styles plus custom per-app styles, spoken-symbol conversion, Assistant mode with voice commands, tool approvals, Power Mode terminal tool, accessibility context reading, multi-provider LLM routing (Groq, OpenAI, OpenRouter, Ollama, Azure, DeepSeek, Gemini, Claude, Cerebras), replacement rules plus snippets plus personal glossary, per-app style and insertion overrides, add-to-dictionary from selection, history with raw, after-replacements, and final views, retranscribe, ZIP export, multi-device LAN output pairing, clipboard and simulated-typing insertion, macOS, Windows, and Linux builds, auto-launch, tray, 10 UI languages (de, en, es, fr, it, ko, pt, pt-BR, zh-CN, zh-TW), encrypted keys, incognito, local-only data, diagnostics export with sanitization, home dashboard with stats and streaks, floating pill overlay.

Honest gaps: no meeting notes, no external API, MCP, or CLI, no cloud sync, no mobile, the in-app auto-update UI exists but the delivery endpoint is unpublished, the multi-device TCP channel is unencrypted (documented), Assistant, Power Mode, and real-time output are flagged experimental.

---

## 3. Open PR review at snapshot date

| PR   | Title                                                                                         | Effect on mausVoice                                                                                                                                                                                         | Status on 2026-08-26 |
| ---- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| #142 | auto-learn corrected words as glossary terms                                                  | Editable history plus auto-learn proper nouns into the dictionary (closes voquill #229)                                                                                                                     | open                 |
| #138 | thock volume slider, agent continuation, review cleanup, style default, serde-null onboarding | Interaction feedback volume slider, mid-dictation style persistence, composer recovery from blank page, agent continuation, onboarding serde fix                                                            | changes requested    |
| #137 | triage voquill issues, 25 fixes                                                               | 250 MB log cap, preserve audio on failure, OpenRouter STT, custom transcription path, Windows hotkey after sleep, Linux super-key, Whisper silence filter, pill placement, hands-free delay, incognito docs | open                 |
| #132 | e2e review findings for 1.6                                                                   | Thock volume clamp, Cerebras 402 handling and post-process attribution, agent-loop continuation, assistant pill markdown safety, style-snapshot-at-start, composer reliability, logo sharpness              | open                 |
| #131 | redesign README feature showcase                                                              | Docs and imagery only (5 banners)                                                                                                                                                                           | open                 |
| #74  | unify desktop UI: silver chrome, sonner, seekable audio, durable undo                         | New silver and ink theme, sonner toasts, seekable audio player, 5-second durable delete undo                                                                                                                | open                 |
| #63  | superfixer pre-1.6 release                                                                    | Integration of 5 PRs plus review remediation: CSP narrowing, model-download integrity, ONNX runtime check, i18n, updater manifest                                                                           | open                 |

Net effect of in-flight work: #137 and #142 move mausVoice from no to in-flight on auto-learn dictionary, hands-free delay, pill placement, custom transcription path, and Windows hotkey resilience. None of the open PRs add meeting notes, MCP or API, connectors, cloud sync, or mobile.

> Snapshot note. Statuses above were captured on 2026-08-26. As of this writing PR #138 has merged and PR #131 remains open with no review approvals. Anything that depends on this table should re-check GitHub.

---

## 4. Gap analysis

Legend: ✅ have, 🟡 partial or WIP, 🔜 in-flight via open PR, ❌ lack.

| Capability                         | mausVoice    | Vowen       | Wispr Flow    | TypeWhisper | Priority gap      |
| ---------------------------------- | ------------ | ----------- | ------------- | ----------- | ----------------- |
| System-wide dictation              | ✅           | ✅          | ✅            | ✅          | —                 |
| Local and offline models           | ✅           | ✅          | ❌ cloud-only | ✅          | —                 |
| Streaming live preview             | ✅           | ✅ Pro      | ✅ Pro        | ✅          | —                 |
| Per-app styles                     | ✅           | ✅          | ✅            | ✅          | —                 |
| AI cleanup and post-process        | ✅           | ✅          | ✅            | ✅          | —                 |
| Auto-learn dictionary              | 🔜 #142      | ✅          | ✅            | ✅ Premium  | low, shipping     |
| Hands-free toggle                  | 🟡           | ✅          | ✅            | ✅          | med               |
| Command Mode, transform text       | 🟡 Assistant | ✅          | ✅ paid       | ✅          | med               |
| Text Expander with fill-ins        | 🟡           | ✅          | 🟡            | 🟡          | med               |
| Meeting notes and notetaker        | ❌           | ✅ Pro      | ✅            | 🟡          | **high**          |
| Speaker diarization                | ❌           | ✅ Pro      | ✅            | 🟡          | **high**          |
| AI meeting summaries               | ❌           | ✅ Pro      | ✅            | 🟡          | **high**          |
| Watch-folder transcription         | ❌           | ✅          | ❌            | ✅          | med               |
| Translations                       | ❌           | ✅ Pro      | 🟡            | ✅          | med               |
| Webhooks                           | ❌           | ✅ Pro      | ❌            | ✅          | med               |
| Obsidian, Notion, Slack connectors | ❌           | ✅ Pro      | ✅            | ✅          | med               |
| Cloud sync                         | ❌ by design | ✅ Pro      | ✅            | ✅ Premium  | low, policy       |
| Local HTTP API                     | ❌           | ✅          | ❌            | ✅          | med               |
| CLI                                | ❌           | ✅          | ❌            | ✅          | low               |
| MCP server                         | ❌           | ✅ 23 tools | ✅ read-only  | ✅ client   | med               |
| Voice-triggered workflows          | ❌           | ✅          | ❌            | ✅          | med               |
| Mobile iOS and Android             | ❌           | 🔜          | ✅            | 🔜          | med               |
| HIPAA, SOC 2, ISO                  | ❌           | ❌          | ✅            | ❌          | low, not targeted |
| Multi-device output                | ✅           | ❌          | ❌            | ✅          | strength          |
| Local-only, no telemetry           | ✅           | 🟡 PostHog  | ❌ cloud-only | ✅          | strength          |
| Free, no subscription              | ✅           | 🟡 $49 Pro  | ❌ $/mo       | ✅ GPLv3    | strength          |

---

## 5. Build priorities

1. Meeting Notes suite, high priority. Silent system-audio plus microphone capture, speaker diarization, AI summary templates, Ask-AI over notes. This is the largest gap versus Vowen and Wispr, both of which lead with it.
2. External automation surface, medium priority. A local HTTP API, a CLI, and a read-only MCP server. TypeWhisper and Vowen both ship this. It is low risk and unblocks power users and agent integrations.
3. Connectors and webhooks, medium priority. Obsidian, Notion, Slack, and webhook delivery for transcriptions and notes.
4. Translations and Text Expander fill-ins, medium priority. A dedicated translation path and snippet fill-in variables.
5. Hands-free toggle plus voice-triggered workflows, medium priority. True toggle mode and "open app, URL, or run script" voice flows.
6. Low priority or by design. Cloud sync and compliance certifications are explicit non-goals for the personal and local fork. Mobile is a separate product decision.

Strengths to preserve: local-first with no telemetry, free with no subscription, Linux shipping, multi-device LAN output, strong local model support.
