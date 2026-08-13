---
title: "Groq"
description: "Use Groq for batch speech recognition, post-processing, or the API-backed Assistant."
sidebar:
  order: 3
---

Groq is available for both transcription and generation. Get a key from the [Groq console](https://console.groq.com/keys), then either use the top-level **Settings → Processing → Groq API key** row or add a named Groq record inside a task dialog.

## Quick personal record

The quick row creates or updates **Personal Groq**. Its current defaults are `whisper-large-v3-turbo` for transcription and `openai/gpt-oss-20b` for generation. If your processing choices are unset or already point at a managed personal key, saving can select Groq for post-processing and the Assistant backend and use it as the transcription fallback. A configured Personal Deepgram key takes priority for transcription. Explicit unrelated selections are left alone.

That convenience does not enable the separate Assistant feature switch. Reopen **AI transcription**, **AI post processing**, and **Assistant mode** to verify the selected cards and models.

## Task behavior

Groq transcription records the full clip, uploads it after release, and then returns text; it does not feed the real-time segment-output path. Post-processing sends the raw transcript plus the generated style/system instructions to a Groq chat model. Assistant use sends conversation context and tool schemas through the generation path.

The generic model pickers query Groq's OpenAI-compatible `/openai/v1/models` list. Transcription keeps IDs containing `whisper`; generation excludes them. You can type a model ID, but it still must exist for the account and support the task.

**Test** performs a small generation using a fixed integration-test model, so it primarily proves the key can reach Groq. A successful test does not prove the selected speech model, quota, or audio request will succeed. If dictation fails, turn post-processing Off and compare the raw History result; if raw text is present, investigate the later generative call instead.
