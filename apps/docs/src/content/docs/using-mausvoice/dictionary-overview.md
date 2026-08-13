---
title: "Dictionary overview"
description: "Use glossary hints for recognition and replacement rules for deterministic text changes."
sidebar:
  order: 11
---

Open **Dictionary** from the left navigation. Its two mechanisms run at different points and solve different problems.

**Glossary terms** provide vocabulary context to transcription where the selected provider path supports it. Add proper names, technical terms, acronyms, or product names that speech recognition frequently misses. A glossary is a hint, not a guaranteed replacement.

**Replacement rules** match recognized text and replace it before optional post-processing. They are useful for stable corrections and can expand a short spoken trigger into a longer snippet. Because replacement happens after recognition, the input side must resemble what the transcriber actually returns.

Start narrowly. A common word used as a replacement trigger can alter legitimate sentences, and a huge glossary can add noise or hit provider-specific context limits. Review History to learn the exact recurring error, then add the smallest rule or hint that addresses it.
