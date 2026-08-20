---
title: "Custom styles"
description: "Create, test, edit, and safely remove focused transcript-transformation prompts."
sidebar:
  order: 9
---

Open **Writing Styles** and choose **New style** or **Add Style → New style**. A style needs a name (up to 120 characters) and a non-empty prompt (up to 8,000 characters). In Based on app mode, creating from an app row immediately assigns the new style to that target.

A useful prompt says what to preserve as well as what to change:

```text
Turn the transcript into a short project update. Keep every person, date,
number, URL, and uncertainty exactly as spoken. Use a heading followed by
three to five bullets. Do not add facts or a greeting.
```

Avoid "make this better." It leaves tone, length, factual preservation, and format undefined. Do not include passwords, customer secrets, or private boilerplate: the style prompt can be sent with every applicable transcript to the selected post-processing provider.

## Test before reuse

Dictate representative names, numbers, a direct quote, uncertainty, and a correction. In **History**, compare Raw with the final text. If Raw is wrong, adjust language, microphone, dictionary, or transcription provider. If only the final text is wrong, tighten the prompt or choose a different generation model.

Use the row menu to view the full prompt. User-created styles can be edited or deleted; system and organization-managed styles cannot. Deletion is local and does not retract prompts previously sent to providers. If a deleted style was referenced by an app or selection, revisit that configuration and choose a current style.
