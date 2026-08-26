# Competitor Research — Vowen

Source: https://docs.vowen.ai/ and https://vowen.ai/ (crawled 2026-08-26)

Vowen is a desktop voice interface (macOS 14+ Apple Silicon/Intel, Windows 10+ x64) for dictation, AI command execution, meeting capture, and voice workflows. Free tier + $49 one-time lifetime Pro licence. Local-first, privacy-focused, no subscription.

## Platforms
- macOS 14.0+ (Apple Silicon + Intel x64; signed/notarized), Windows 10+ x64 (unsigned build), Linux "coming soon", iOS "coming soon".
- Runs in menu bar (macOS) / system tray (Windows).

## Core dictation
- System-wide dictation into any app via global hotkey; unlimited on Free.
- Push-to-Talk and Hands-Free modes.
- Auto-paste with Paste or Direct insertion; clipboard restore on by default.
- Silero VAD silence stripping; Escape cancel with undo; real-time streaming preview (Pro).
- Floating pill / Notch indicator; idle pill with quick buttons.

## Transcription models
- Local: Parakeet TDT V2/V3/Japanese/Mandarin/CTC, Whisper.cpp (Tiny–Large v3 Turbo, 99 langs), NVIDIA Nemotron EN/Multilingual, custom OpenAI-compatible server.
- Cloud (BYO key, audio direct to provider): Groq, Deepgram, ElevenLabs Scribe, AssemblyAI, Mistral Voxtral, Sarvam, Soniox, xAI, Cartesia, Speechmatics, OpenAI, Google Gemini.
- Per-situation / per-Tone / per-file model selection; NVIDIA CUDA GPU for local Whisper on Windows.

## AI / LLM features
- AI Enhancement: grammar, punctuation, filler, formatting, number conversion; 10+ providers BYO key; custom instructions; per-shortcut override.
- Command Mode: speak instructions to transform selected text or run real actions (file conversions, timers); context from selection/files/screenshots/Memory/clipboard.
- Memory: persistent context notes/files (Free 3, Pro unlimited).
- Ask AI: chat with a transcript/meeting note (Pro).
- Connectors (MCP-style, Pro): Linear, Notion, Vercel, Gmail, Google Drive/Docs/Calendar, GitHub, LinkedIn, Computer Use, + Composio.

## Editing, commands & workflows
- Voice-triggered workflows (open URL/search/app/script); Webhook and Custom script actions (Pro).
- Custom Utilities (Pro): shortcut-triggered AI prompts with `{{selected_text}}`/`{{clipboard}}` vars.
- Built-in utilities: file/config/PDF conversions, timers, translations.

## Text expansion / snippets / vocabulary
- Dictionary with misspelling correction, CSV bulk import, 100+ languages.
- Threads (snippets): phrase → text replacement.
- Text Expander: `:shortcut` global expansion with fill-in variables (text/multiline/choice/multiselect/date), `{{DATE}}`/`{{TIME}}` tokens.

## Meeting notes
- Silent capture (no bot) of Zoom/Teams/Meet/Slack/Discord/Webex/browser/system audio; macOS echo cancellation.
- Auto-detect meetings (Pro); six start methods; watch folders.
- Speaker diarization (Pro): on-device or cloud; 44 summary templates + custom.
- Live transcript, "Mark important", Ask AI, export PDF/TXT/MD/SRT/VTT/audio.
- 100 stored notes cap; Free = 10 saved.

## Integrations
- Obsidian (Pro): writes Markdown + YAML frontmatter.
- Webhooks (Pro): POST with HMAC-SHA256 signing, Slack/Discord embeds.
- Cloud Sync (Pro): iCloud/Drive/Dropbox/OneDrive.

## Shortcuts & input
- Rebindable global shortcuts (Transcription, Command Mode, Hands-Free, etc.); mouse buttons; per-app/website Tones; Command palette.

## Languages
- Whisper 99, Parakeet V3 25 EU, Nemotron 31, Nova 3 50, Soniox 60+; marketed "100+". Three independent language settings; 18 UI languages.

## Privacy & security
- Local-by-default; cloud audio direct to provider; API keys encrypted on device; no Vowen servers.
- Caveat: PostHog analytics not opt-out-able (includes name/email if set).

## Pricing
- Free $0; Pro $49 one-time lifetime (unlimited meetings/notes/Command Mode, diarization, connectors, cloud sync, export); Enterprise custom (SSO/HIPAA/audit).

## Developer
- Vowen CLI (history/search/export/notes/models/vocab/settings/record/mcp).
- MCP server (`vowen mcp`, 23 tools, stdio).
- OpenAPI spec at `/api-reference/openapi.json`.
