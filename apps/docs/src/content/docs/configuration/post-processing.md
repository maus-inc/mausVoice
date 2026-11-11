---
title: "AI post-processing"
description: "Configure the optional rewrite stage without conflating it with speech recognition."
sidebar:
  order: 5
---

Open **Settings → AI and processing → AI post processing**. The mode selector offers **API** and **Off**.

With **API**, select a generative provider key and model where that provider supports model choice. mausVoice sends the raw transcript plus applicable style instructions and context to that endpoint and uses the returned text as the processed result.

With **Off**, no generative rewrite runs on new transcripts. This is the deterministic choice for exact quotations, code-like content, provider isolation, or diagnosing speech-to-text quality.

Post-processing can improve punctuation and structure, but it can also omit, reinterpret, or invent text. Styles should explicitly preserve names, numbers, URLs, and uncertainty when those details matter. Always compare raw and processed history during setup.

When the styling model returns a list of edits and one of them cannot be applied to the transcript, the whole edit batch is discarded rather than inserted half-applied. The complete raw transcript stays in History, nothing is pasted, and a notification explains why. If the same History item fails this way three times, mausVoice retranscribes its audio once, with the same style and language as the failed run, and updates the existing History item instead of creating a second one.

A transcription provider and post-processing provider need not be the same. A Groq entry, for example, can participate in supported tasks, while Deepgram is exposed as the quick streaming transcription key. The active key in each task-specific dialog determines the route.
