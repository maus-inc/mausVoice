# Competitive Feature Research & Gap Analysis
**Product:** mausVoice (voice dictation desktop app, maus-inc/mausVoice)
**Competitors researched:** Vowen, Wispr Flow, TypeWhisper
**Date:** 2026-08-26
**Method:** 3 parallel research sub-agents crawled each competitor's docs + marketing site; 1 sub-agent extracted mausVoice's current feature set from the codebase; second wave reviewed all 7 open PRs.

---

## 1. Competitor feature compilation (combined pool)

Grouped by capability. `V`=Vowen, `W`=Wispr Flow, `T`=TypeWhisper.

### Core dictation
- System-wide dictation into any app (V, W, T) — mausVoice: **Yes**
- Push-to-talk + hands-free toggle mode (V, W, T) — mausVoice: **Partial** (hold-to-talk; hands-free delay setting only in-flight)
- Real-time streaming transcript preview (V, W, T) — mausVoice: **Yes** (Deepgram/AssemblyAI/ElevenLabs)
- Clipboard fallback when no field focused (W) — mausVoice: **Yes** (history + paste)
- Restore clipboard after paste (V) — mausVoice: **Partial** (paste/clipboard insertion exists; explicit restore not confirmed)
- Whisper-quiet / low-gain dictation (W, T "Whisper Mode") — mausVoice: **No** dedicated gain-boost mode

### Speech / transcription models
- 14+ cloud STT providers BYO key (V, T) — mausVoice: **Yes** (Deepgram, OpenAI, Groq, AssemblyAI, ElevenLabs, Azure, etc.)
- Strong local models: Parakeet, Canary, Whisper.cpp, WhisperKit, Apple Speech, Nemotron (V, T) — mausVoice: **Yes** (local sidecar: whisper.cpp + Parakeet/Canary)
- Custom OpenAI-compatible endpoint (V, T) — mausVoice: **Yes** (PR #137 adds custom transcription path)
- GPU acceleration for local models (V, T) — mausVoice: **Partial** (Vulkan detection mentioned in docs)

### AI / LLM text processing
- Grammar/filler/punctuation cleanup (all) — mausVoice: **Yes** (post-processing)
- Built-in + custom writing styles per app (all) — mausVoice: **Yes** (custom styles per app)
- Spoken-symbol/punctuation conversion (V, mausVoice) — mausVoice: **Yes**
- Command Mode (speak instruction to transform selected text) (V, W, T) — mausVoice: **Partial** (Assistant mode, experimental)
- Translations (V auto-translate, T workflows, W limited) — mausVoice: **No** dedicated translation feature
- Auto-learn corrected words as dictionary (T Premium "Correction Learning", W auto-adds) — mausVoice: **In-flight** (PR #142)

### Editing, commands & workflows
- Voice-triggered workflows (open URL/app/run script) (V, T) — mausVoice: **No**
- Text Expander with fill-in variables / rich snippets (V, W snippets, T `{{DATE}}` placeholders) — mausVoice: **Partial** (snippets via replacement rules; no fill-in choice fields)
- Webhook delivery (V, T) — mausVoice: **No**
- Custom Utilities / reusable AI prompts (V, T workflows) — mausVoice: **No** (Assistant covers ad-hoc)

### Meeting notes / notetaker
- Silent call capture (no bot) of Zoom/Meet/Teams/Discord (V, W) — mausVoice: **No**
- Speaker diarization (V, W, T partial) — mausVoice: **No**
- AI meeting summaries + templates (V 44 templates, W summaries, T recorder+Obsidian) — mausVoice: **No**
- Ask-AI across meetings/notes (V, W) — mausVoice: **Partial** (Assistant chat, experimental)
- Meeting auto-detect & auto-stop (V, W) — mausVoice: **No**
- Watch-folder transcription (V, T) — mausVoice: **No**

### Integrations
- Obsidian export (V, T) — mausVoice: **No**
- Connectors: Notion, Slack, Gmail, Linear, Calendar (V, W, T) — mausVoice: **No**
- Cloud sync (iCloud/Drive/Dropbox/OneDrive) (V, W, T Premium) — mausVoice: **No** (local-only by design in personal fork)
- Multi-device output / pairing (T, mausVoice) — mausVoice: **Yes** (LAN pairing; unencrypted TCP, documented)

### Platforms
- macOS + Windows (all) — mausVoice: **Yes** (+ Linux)
- Linux (V "coming soon", W roadmap, T no) — mausVoice: **Yes** (shipping)
- iOS / Android (W yes, T iOS alpha, V coming) — mausVoice: **No**

### Developer / API
- Local HTTP API (T `:8978`, V OpenAPI) — mausVoice: **No**
- CLI (V, T) — mausVoice: **No**
- MCP server (V 23 tools, W read-only, T client) — mausVoice: **No**

### Privacy & security
- Local-first / no telemetry (V partial-PostHog, T none, W cloud-only) — mausVoice: **Yes** (local-only, no analytics)
- Encrypted API keys at rest (all) — mausVoice: **Yes** (XChaCha20-Poly1305)
- HIPAA/SOC2/ISO (W) — mausVoice: **No** (not targeted)
- Compliance certs gap noted

### Pricing
- Vowen: $49 one-time lifetime. Wispr: $12–15/mo subscription (+ free tier). TypeWhisper: free GPLv3 + Premium €5/mo or €99 lifetime. mausVoice: **Free, AGPL-3.0, no account/subscription** (personal fork removed cloud gating).

---

## 2. mausVoice current feature inventory (from codebase)

**Have:** global system-wide dictation; hold-to-talk; live streaming (Deepgram/AssemblyAI/ElevenLabs); fully local transcription (whisper.cpp + Parakeet/Canary sidecar); AI post-processing with built-in (Polished/Verbatim/Email/Chat) + custom per-app styles; spoken-symbol conversion; Assistant mode (experimental: voice commands, tool approvals, Power Mode terminal tool, reads accessibility context); multi-provider LLM routing (Groq/OpenAI/OpenRouter/Ollama/Azure/DeepSeek/Gemini/Claude/Cerebras); replacement rules + snippets + personal glossary; per-app style/insertion overrides; add-to-dictionary from selection; history with raw/after-replacements/final, retranscribe, ZIP export; multi-device LAN output pairing; clipboard + simulated-typing insertion; macOS/Windows/Linux builds; auto-launch, tray; 10 UI languages; encrypted keys; incognito; local-only data; diagnostics export with sanitization; home dashboard + stats + streaks; floating pill overlay.

**Honest gaps / WIP:** no meeting notes; no external API/MCP/CLI; no cloud sync; no mobile; in-app auto-update UI exists but delivery endpoint unpublished; multi-device TCP is unencrypted (documented); Assistant/Power Mode/real-time output flagged experimental.

---

## 3. Second wave — open PR review (7 PRs)

| PR | Title | What it adds to mausVoice | Status |
|----|-------|---------------------------|--------|
| #142 | auto-learn corrected words as glossary terms | Editable history + auto-learn proper nouns into dictionary (closes voquill#229) | OPEN |
| #138 | deep-review: thock click+volume, agent continuation, review cleanup, style default, serde-null onboarding | Interaction-feedback volume slider; mid-dictation style persistence; composer recovery from blank page; agent continuation; onboarding serde fix | CHANGES_REQUESTED |
| #137 | Triage voquill issues, 25 fixes | Log rotation (25MB/10), preserve audio on failure, OpenRouter STT, custom transcription path, Windows hotkey-after-sleep, Linux super-key, Whisper silence filter, pill placement, hands-free delay, incognito docs | OPEN |
| #132 | e2e review findings for 1.6 | Thock volume clamp, Cerebras 402 handling + post-process attribution, agent-loop continuation, assistant pill markdown safety, style-snapshot-at-start, composer reliability, logo sharpness | OPEN |
| #131 | Redesign README feature showcase | Docs/imagery only (5 banners) | APPROVED |
| #74 | Unify desktop UI: silver chrome, sonner, seekable audio, durable undo | New silver/ink theme, sonner toasts, seekable audio player, 5s durable delete undo | OPEN |
| #63 | superfixer pre-1.6 release | Integration of 5 PRs + review remediation: CSP narrowing, model-download integrity, ONNX runtime check, i18n, updater manifest | OPEN |

**Net effect of in-flight work:** #137/#142 move us from *No* → *In-flight* on auto-learn dictionary, hands-free delay, pill placement, custom transcription path, Windows hotkey resilience. None of the open PRs add meeting notes, MCP/API, connectors, cloud sync, or mobile.

---

## 4. Gap analysis table (what we lack)

Legend: ✅ Have · 🟡 Partial/WIP · 🔜 In-flight (open PR) · ❌ Lack

| Capability | mausVoice | Vowen | Wispr Flow | TypeWhisper | Priority gap |
|------------|-----------|-------|------------|-------------|--------------|
| System-wide dictation | ✅ | ✅ | ✅ | ✅ | — |
| Local/offline models | ✅ | ✅ | ❌ (cloud) | ✅ | — |
| Streaming live preview | ✅ | ✅ | ✅ | ✅ | — |
| Per-app styles | ✅ | ✅ | ✅ | ✅ | — |
| AI cleanup / post-process | ✅ | ✅ | ✅ | ✅ | — |
| Auto-learn dictionary | 🔜 #142 | ✅ | ✅ | ✅ | Low (shipping) |
| Hands-free toggle | 🟡 | ✅ | ✅ | ✅ | Med |
| Command Mode (transform text) | 🟡 (Assistant) | ✅ | ✅ | ✅ | Med |
| Text Expander w/ fill-ins | 🟡 | ✅ | 🟡 | 🟡 | Med |
| **Meeting notes / notetaker** | ❌ | ✅ | ✅ | 🟡 | **High** |
| **Speaker diarization** | ❌ | ✅ | ✅ | 🟡 | **High** |
| **AI meeting summaries** | ❌ | ✅ | ✅ | 🟡 | **High** |
| **Watch-folder transcription** | ❌ | ✅ | ❌ | ✅ | Med |
| **Translations** | ❌ | ✅ | 🟡 | ✅ | Med |
| **Webhooks** | ❌ | ✅ | ❌ | ✅ | Med |
| **Obsidian / Notion / Slack connectors** | ❌ | ✅ | ✅ | ✅ | Med |
| **Cloud sync** | ❌ (by design) | ✅ | ✅ | ✅ | Low (policy) |
| **Local HTTP API** | ❌ | ✅ | ❌ | ✅ | Med |
| **CLI** | ❌ | ✅ | ❌ | ✅ | Low |
| **MCP server** | ❌ | ✅ | ✅ | ✅ | Med |
| **Voice-triggered workflows** | ❌ | ✅ | ❌ | ✅ | Med |
| **Mobile (iOS/Android)** | ❌ | 🔜 | ✅ | 🔜 | Med |
| **HIPAA/SOC2/ISO** | ❌ | ❌ | ✅ | ❌ | Low (not targeted) |
| Multi-device output | ✅ | ❌ | ❌ | ✅ | — (strength) |
| Local-only / no telemetry | ✅ | 🟡 | ❌ | ✅ | — (strength) |
| Free / no subscription | ✅ | 🟡 ($49) | ❌ ($/mo) | ✅ | — (strength) |

---

## 5. Recommended build priorities (closing the gaps)

1. **Meeting Notes suite (High):** silent system-audio + mic capture, speaker diarization, AI summary templates, Ask-AI over notes. This is the single largest gap vs Vowen and Wispr, both of which lead with it.
2. **External automation surface (Med):** a local HTTP API + CLI + read-only MCP server (TypeWhisper and Vowen both ship this; it is low-risk and unblocks power users and agent integrations).
3. **Connectors & webhooks (Med):** Obsidian/Notion/Slack/webhook delivery for transcriptions and notes.
4. **Translations & Text Expander fill-ins (Med):** dedicated translation path; snippet fill-in variables.
5. **Hands-free toggle + voice-triggered workflows (Med):** true toggle mode and "open app/URL/run script" voice flows.
6. **Low-priority / by-design:** cloud sync and compliance certs are explicit non-goals for the personal/local fork; mobile is a separate product decision.

**Strengths to preserve:** local-first/no-telemetry, free/no-subscription, Linux shipping, multi-device LAN output, strong local model support.
