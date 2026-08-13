---
title: "Poor accuracy or unwanted rewriting"
description: "Identify whether recognition, replacement rules, or a style changed the words."
sidebar:
  order: 8
---

Inspect raw and processed text in History. Raw errors belong to the microphone, language, glossary, transcription provider, or local model. Processed-only errors belong to replacement rules, the selected style, model behavior, or post-processing provider.

For recognition, choose the intended dictation language, reduce background noise, use normal pacing, and add focused glossary terms for names. Compare model sizes with the same sample. A larger model is not a substitute for a clipped or wrong microphone.

For deterministic recurring mistakes, create a narrow replacement rule from the observed raw phrase. Avoid common triggers that can alter unrelated sentences.

For rewriting errors, use Verbatim or turn post-processing Off. Strengthen custom prompts to preserve names, numbers, URLs, quotations, and uncertainty. Models remain probabilistic; exact legal, code, credential, or quotation work should use raw output and manual review.
