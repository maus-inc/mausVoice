# TypeWhisper

Source: github.com/TypeWhisper/typewhisper-win/tree/main/docs and typewhisper.com. Crawled 2026-08-26.

TypeWhisper is a local-first, open-source speech-to-text family under GPLv3. Windows stable at v1.0.8, macOS stable at v1.6.0, iOS in alpha. Made in Germany. No telemetry, no account for core use. Free OSS core plus Commercial Premium at €5 per month or €99 lifetime.

## Platforms

- Windows 10 and 11 64-bit on x64 and ARM64. MS Store, WinGet, and GitHub installers.
- macOS 14 plus with Apple Silicon recommended. Some features need macOS 15 or 26 plus.
- iOS alpha via TestFlight.
- Start with Windows is on by default.

## Core dictation

- System-wide with auto-paste into the active field.
- Hotkey modes: Hybrid, Toggle, Hold (push-to-talk), and workflow-specific. macOS modifier plus prompt palette.
- Non-blocking queue. Recording overlays for LED, timer, waveform, and live preview. Sound feedback. Silence detection. Whisper Mode gain boost. Audio normalization. Media pause and ducking.
- Live transcript updates to the field on macOS 1.6.

## File and recorder transcription

- Drag-drop batch audio and video. Recorder for long sessions.
- Export TXT, SRT, and VTT. Watch folders with auto-delete and Markdown sidecars.
- Calendar-aware meeting automation on macOS Premium.
- Input formats: WAV, MP3, M4A, AAC, OGG, FLAC, WMA, MP4, MKV, AVI, MOV, and WebM.

## Local engines and models

- whisper.cpp on CPU, CUDA, Vulkan, and ROCm.
- sherpa-onnx for Parakeet and Canary.
- WhisperKit on Apple Silicon.
- Apple Speech plus SpeechAnalyzer.
- Qwen3 ASR, Voxtral, Gemma 4, IBM Granite, Cohere Transcribe, Marian ONNX for translation.

## Cloud providers as add-ons

- Groq, OpenAI, Deepgram, AssemblyAI, ElevenLabs, Soniox, Speechmatics, Gladia, Reson8, Smallest, Cartesia, Cloudflare, Google, Mistral, Sber, xAI, OpenAI-Compatible, OpenRouter with 300 plus LLMs.

## AI and LLM workflows

- Reusable workflows transform text before insertion. Templates include Cleaned, Translation, Email Reply, Meeting Notes, Checklist, JSON, Summary, and Custom.
- Providers: Apple Intelligence, Groq, OpenAI, Gemini, Claude, Cerebras, Cohere, Mistral, Fireworks, xAI, OpenRouter, Gemma 4, and local.
- Fillers post-processor, Script Runner, Webhook post-processor, regex dictionary rules, number formatting.

## Editing, dictionary, and snippets

- Dictionary terms plus corrections (find and replace). Vocabulary boosting for Parakeet.
- Snippets support `{{DATE}}`, `{{TIME}}`, `{{CLIPBOARD}}`, `{{DATETIME}}` and format variants.
- Automatic Correction Learning on Premium learns single-word manual edits through Accessibility.
- Community and industry term packs.

## Translation

- Apple Translate on macOS 15 plus or LLM Prompt. WhisperKit for speech to English. Marian ONNX fallback on Windows.

## Workflows, triggers, and automation

- Triggers: App, Website, Hotkey, Always, Manual. App plus website combined matching.
- Per-workflow overrides. Output to field, action plugin, or Enter.

## History and dashboard

- Searchable history with raw and final views, app, engine, word count, and duration. Standalone History window.
- Home Dashboard stats. Statistics plus Backup and Restore on macOS.

## Integrations (plugins and apps)

- Obsidian with Markdown plus live sync.
- Linear as an action plugin.
- Live Transcript window.
- MCP Client marketplace.
- Webhook, Calendar automation, Memory providers.

## Automation, HTTP API, CLI, plugin SDK

- Local HTTP API on 127.0.0.1:8978. Loopback only. Optional auth token. Endpoints for status, models, transcribe, history, rules, profiles, dictation, and dictionary.
- CLI `typewhisper` talks to the API.
- Plugin SDK in .NET on Windows and Swift on macOS. Plugins for engines, LLM, post-processors, memory, TTS, events, and actions. Marketplace plus trust validation.

## Privacy and security

- No telemetry or analytics. Local-first. Cloud only when configured.
- API token protected at rest. Plugin package verification and rollback.

## Accessibility

- macOS Correction Learning through Accessibility. Windows UI Automation. iOS keyboard accessibility.
- Locales: de, en, ja, ru, zh-Hans.

## Pricing

- Free GPLv3 core covers dictation, local engines, workflows, history, snippets, and APIs.
- Commercial Premium adds Cloud Folder Sync, Correction Learning, and commercial terms.
- Monthly: €5, €19, €99 for Individual, Team, and Enterprise.
- Lifetime: €99, €299, €999 for Individual, Team, and Enterprise.
- Supporter tiers: €10, €25, €50.

## Known limitations

- Windows-focused docs. Apple-only features are Windows non-goals.
- Browser microphone integration is not shipped. Research only.
- iOS alpha, not on the App Store.
- Some local models need license acceptance. Parakeet Realtime EOU is not on Windows.
