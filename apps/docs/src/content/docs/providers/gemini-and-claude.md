---
title: "Gemini and Claude"
description: "Compare Gemini's dual-task integration with Claude's generative-only route and current defaults."
sidebar:
  order: 8
---

Gemini and Claude are not interchangeable in mausVoice. [Gemini](../gemini/) has both batch transcription and generative routes. **Claude** is exposed only in post-processing and Assistant key lists; it cannot receive microphone audio through the transcription dispatcher.

Add a Claude key under **Settings → Processing → AI post processing** or **Assistant mode**, then select the saved entry for that task. Both task selectors can reference the same record, but they store their selections independently. **Test** asks Anthropic's `/v1/models` endpoint to list models; it checks authentication, not a complete style or tool call.

Claude generation calls `https://api.anthropic.com/v1/messages` with the `anthropic-version: 2023-06-01` header. When no model is saved, mausVoice uses `claude-sonnet-4-20250514`. The request supports a separate system instruction, conversation messages, and tool definitions/results, so Claude can participate in Assistant flows as well as transcript rewriting.

There is no custom Anthropic base URL in the current form and no Claude transcription model picker. A successful key test can still be followed by quota, model-access, policy, context, or provider-side failures. Diagnose those with a short non-sensitive request and retain the error text, provider name, and selected model, never the key itself.
