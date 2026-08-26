# Competitor Research — TypeWhisper

Source: https://github.com/TypeWhisper/typewhisper-win/tree/main/docs and typewhisper.com (crawled 2026-08-26)

TypeWhisper is a local-first, open-source (GPLv3) speech-to-text family: Windows (stable v1.0.8), macOS (stable v1.6.0), iOS (alpha). Made in Germany; no telemetry, no account for core use. Free OSS core + Commercial Premium (€5/mo or €99 lifetime).

## Platforms
- Windows 10/11 64-bit (x64 + ARM64; MS Store, WinGet, GitHub installers).
- macOS 14+ (Apple Silicon recommended; some features need 15/26+).
- iOS alpha via TestFlight.
- "Start with Windows" default.

## Core dictation
- System-wide, auto-paste into active field.
- Hotkey modes: Hybrid, Toggle, Hold (push-to-talk), workflow-specific; macOS modifier + prompt palette.
- Non-blocking queue; recording overlays (LED/timer/waveform/live preview); sound feedback; silence detection; Whisper Mode gain boost; audio normalization; media pause/ducking.
- Live transcript updates to field (macOS 1.6).

## File & recorder transcription
- Drag-drop batch audio/video; recorder for long sessions.
- Export TXT/SRT/VTT; watch folders with auto-delete + Markdown sidecars.
- Calendar-aware meeting automation (macOS Premium).
- Input: WAV/MP3/M4A/AAC/OGG/FLAC/WMA/MP4/MKV/AVI/MOV/WebM.

## Local engines / models
- whisper.cpp (CPU/CUDA/Vulkan/ROCm), sherpa-onnx (Parakeet/Canary), WhisperKit (Apple Silicon), Apple Speech/SpeechAnalyzer, Qwen3 ASR, Voxtral, Gemma 4, IBM Granite, Cohere Transcribe, Marian ONNX (translation).

## Cloud providers (add-ons)
- Groq, OpenAI, Deepgram, AssemblyAI, ElevenLabs, Soniox, Speechmatics, Gladia, Reson8, Smallest, Cartesia, Cloudflare, Google, Mistral, Sber, xAI, OpenAI-Compatible, OpenRouter (300+ LLMs).

## AI / LLM workflows
- Reusable workflows transform text before insertion; templates: Cleaned, Translation, Email Reply, Meeting Notes, Checklist, JSON, Summary, Custom.
- Providers: Apple Intelligence, Groq, OpenAI, Gemini, Claude, Cerebras, Cohere, Mistral, Fireworks, xAI, OpenRouter, Gemma 4, local.
- Fillers post-processor, Script Runner, Webhook post-processor, regex dictionary rules, number formatting.

## Editing, dictionary & snippets
- Dictionary terms + corrections (find/replace); vocabulary boosting (Parakeet).
- Snippets with `{{DATE}}`/`{{TIME}}`/`{{CLIPBOARD}}`/`{{DATETIME}}` + format variants.
- Automatic Correction Learning (Premium): learns single-word manual edits via Accessibility.
- Community/industry term packs.

## Translation
- Apple Translate (macOS 15+) or LLM Prompt; WhisperKit speech→English; Marian ONNX fallback (Windows).

## Workflows, triggers & automation
- Triggers: App, Website, Hotkey, Always, Manual; app+website combined matching.
- Per-workflow overrides; output to field/action plugin/Enter.

## History & dashboard
- Searchable history (raw/final, app/engine/word count/duration); standalone History window.
- Home Dashboard stats; Statistics & Backup/Restore (macOS).

## Integrations (plugins & apps)
- Obsidian (Markdown + live sync), Linear (action plugin), Live Transcript window, MCP Client (marketplace), Webhook, Calendar automation, Memory providers.

## Automation: HTTP API, CLI, plugin SDK
- Local HTTP API on 127.0.0.1:8978, loopback only, optional auth token; endpoints for status/models/transcribe/history/rules/profiles/dictation/dictionary.
- CLI `typewhisper` talking to the API.
- Plugin SDK (.NET Windows / Swift macOS): engines, LLM, post-processors, memory, TTS, events, actions; marketplace + trust validation.

## Privacy & security
- No telemetry/analytics; local-first; cloud only when user configures.
- API token protected at rest; plugin package verification/rollback.

## Accessibility
- macOS Correction Learning via Accessibility; Windows UI Automation; iOS keyboard a11y.
- Locales: de, en, ja, ru, zh-Hans.

## Pricing
- Free GPLv3 core (dictation, local engines, workflows, history, snippets, APIs).
- Commercial Premium: Cloud Folder Sync, Correction Learning, commercial terms. Monthly €5/€19/€99; Lifetime €99/€299/€999. Supporter tiers €10–50.

## Known limitations
- Windows-focused docs; Apple-only features are Windows non-goals.
- Browser microphone integration not shipped (research only).
- iOS alpha, not on App Store.
- Some local models need license acceptance; Parakeet Realtime EOU not on Windows.
