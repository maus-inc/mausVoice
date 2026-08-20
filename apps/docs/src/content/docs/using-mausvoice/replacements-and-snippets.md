---
title: "Replacements and snippets"
description: "Correct predictable recognition errors or expand deliberate spoken triggers."
sidebar:
  order: 13
---

A replacement rule has an input phrase and an output string. The application applies rules to the raw transcript before optional post-processing, so the language model receives the corrected or expanded text.

Typical correction:

| Recognized input | Replacement |
| ---------------- | ----------- |
| `deep gram`      | `Deepgram`  |
| `mouse voice`    | `mausVoice` |

A snippet uses the same mechanism with a deliberate trigger:

| Spoken trigger           | Expansion                                        |
| ------------------------ | ------------------------------------------------ |
| `insert support closing` | `Thanks for your patience,` then `Best regards,` |

Choose an input phrase that is unlikely to appear accidentally. Test capitalization and punctuation around the match; not every variant is normalized. The post-processing model may reformat the expansion afterward; use Verbatim or turn post-processing off when the snippet must remain exact.

Never store passwords, private keys, or API tokens in snippets. Dictionary entries live in the local database, so a copy of `mausvoice.db` contains them. The current diagnostic export does not include that database.
