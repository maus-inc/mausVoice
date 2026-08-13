---
title: Post-Processing
description: How mausVoice uses AI to clean up your transcriptions.
---

After your speech is transcribed, mausVoice runs a post-processing step that uses a large language model to clean up the raw text.

## How It Works

1. You record audio and it gets transcribed to raw text (via local Whisper or your configured API provider).
2. The raw transcript is combined with your active [style](../styles/) prompt and any [dictionary](../dictionary/) glossary terms.
3. This combined prompt is sent to a language model that rewrites the text according to your style.
4. The cleaned-up result is what you see (and what gets pasted if auto-paste is enabled).

Both the raw transcript and the post-processed version are saved, so you can always see the original.

## Post-Processing Modes

Post-processing is configured independently of your transcription mode:

- **API** — Uses a large language model through your selected provider (for example Groq, OpenAI, or a local model via Ollama).
- **Off** — No post-processing runs. Raw transcripts are returned as-is.

## Disabling Post-Processing

If you prefer raw transcriptions without any AI cleanup, you can select the **Light** style, which makes minimal changes, or disable post-processing entirely in settings.
