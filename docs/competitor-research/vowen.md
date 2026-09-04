# Vowen

Source: docs.vowen.ai and vowen.ai. Crawled 2026-08-26.

Vowen is a desktop voice interface for macOS 14 plus (Apple Silicon and Intel x64) and Windows 10 plus (x64 unsigned build). It handles dictation, AI command execution, meeting capture, and voice workflows. Free tier plus $49 one-time lifetime Pro. Local-first and privacy-focused, with no subscription.

## Platforms

- macOS 14.0 plus on Apple Silicon and Intel x64. Signed and notarized.
- Windows 10 plus on x64. Unsigned build.
- Linux: coming soon.
- iOS: coming soon.
- Menu bar on macOS, system tray on Windows.

## Core dictation

- System-wide dictation into any app via global hotkey. Unlimited on Free.
- Push-to-Talk and Hands-Free modes.
- Auto-paste with Paste or Direct insertion. Clipboard restore on by default.
- Silero VAD silence stripping. Escape cancel with undo. Real-time streaming preview on Pro.
- Floating pill or Notch indicator, with an idle pill carrying quick buttons.

## Transcription models

- Local: Parakeet TDT V2, V3, Japanese, Mandarin, CTC, Whisper.cpp from Tiny to Large v3 Turbo across 99 languages, NVIDIA Nemotron English plus multilingual, custom OpenAI-compatible server.
- Cloud BYO key, audio direct to provider: Groq, Deepgram, ElevenLabs Scribe, AssemblyAI, Mistral Voxtral, Sarvam, Soniox, xAI, Cartesia, Speechmatics, OpenAI, Google Gemini.
- Per-situation, per-Tone, and per-file model selection. NVIDIA CUDA GPU for local Whisper on Windows.

## AI and LLM features

- AI Enhancement for grammar, punctuation, filler, formatting, number conversion. 10 plus providers BYO key. Custom instructions and per-shortcut override.
- Command Mode: speak instructions to transform selected text or run real actions such as file conversions and timers. Context from selection, files, screenshots, Memory, and clipboard.
- Memory: persistent context notes and files. Free 3, Pro unlimited.
- Ask AI: chat with a transcript or meeting note on Pro.
- Connectors in MCP style on Pro: Linear, Notion, Vercel, Gmail, Google Drive, Docs, Calendar, GitHub, LinkedIn, Computer Use, plus Composio.

## Editing, commands, and workflows

- Voice-triggered workflows: open URL, search, app, or script.
- Webhook and Custom script actions on Pro.
- Custom Utilities on Pro: shortcut-triggered AI prompts with `{{selected_text}}` and `{{clipboard}}` variables.
- Built-in utilities: file, config, and PDF conversions, timers, translations.

## Text expansion, snippets, and vocabulary

- Dictionary with misspelling correction, CSV bulk import, 100 plus languages.
- Threads are snippets: phrase to text replacement.
- Text Expander uses `:shortcut` global expansion with fill-in variables for text, multiline, choice, multiselect, and date, plus `{{DATE}}` and `{{TIME}}` tokens.

## Meeting notes

- Silent capture with no bot for Zoom, Teams, Meet, Slack, Discord, Webex, browser, and system audio. macOS echo cancellation.
- Auto-detect meetings on Pro. Six start methods. Watch folders.
- Speaker diarization on Pro. On-device or cloud. 44 summary templates plus custom.
- Live transcript, Mark important, Ask AI, export PDF, TXT, MD, SRT, VTT, and audio.
- 100 stored notes cap. Free plan keeps 10 saved.

## Integrations

- Obsidian on Pro: writes Markdown plus YAML frontmatter.
- Webhooks on Pro: POST with HMAC-SHA256 signing, Slack and Discord embeds.
- Cloud Sync on Pro: iCloud, Drive, Dropbox, OneDrive.

## Shortcuts and input

- Rebindable global shortcuts for Transcription, Command Mode, Hands-Free, and others. Mouse buttons. Per-app and per-website Tones. Command palette.

## Languages

- Whisper 99, Parakeet V3 25 EU, Nemotron 31, Nova 3 50, Soniox 60 plus, marketed at 100 plus.
- Three independent language settings. 18 UI languages.

## Privacy and security

- Local by default. Cloud audio goes direct to provider. API keys encrypted on device. No Vowen servers.
- Caveat: PostHog analytics is not opt-out and includes name and email if set.

## Pricing

- Free at $0.
- Pro at $49 one-time lifetime. Unlimited meetings, notes, Command Mode, diarization, connectors, cloud sync, export.
- Enterprise custom with SSO, HIPAA, and audit.

## Developer

- Vowen CLI covers history, search, export, notes, models, vocab, settings, record, and mcp.
- MCP server `vowen mcp` over stdio with 23 tools for search, history, reading items, stats, notes, transcription, tags, vocab, replacements, expansions, settings, and recording control.
- OpenAPI spec at `/api-reference/openapi.json`.
