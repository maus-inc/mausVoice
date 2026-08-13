---
title: "AI post-processing"
description: "Configure the optional rewrite stage without conflating it with speech recognition."
sidebar:
  order: 5
---

Open **Settings → Processing → AI post processing**. The mode selector offers **API** and **Off**.

With **API**, select a generative provider key and model where that provider supports model choice. mausVoice sends the raw transcript plus applicable style instructions and context to that endpoint and uses the returned text as the processed result.

With **Off**, no generative rewrite runs on new transcripts. This is the deterministic choice for exact quotations, code-like content, provider isolation, or diagnosing speech-to-text quality.

Post-processing can improve punctuation and structure, but it can also omit, reinterpret, or invent text. Styles should explicitly preserve names, numbers, URLs, and uncertainty when those details matter. Always compare raw and processed history during setup.

A transcription provider and post-processing provider need not be the same. A Groq entry, for example, can participate in supported tasks, while Deepgram is exposed as the quick streaming transcription key. The active key in each task-specific dialog determines the route.
