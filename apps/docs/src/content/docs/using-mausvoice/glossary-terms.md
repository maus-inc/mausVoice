---
title: "Glossary terms"
description: "Add names and specialist vocabulary without treating hints as guaranteed substitutions."
sidebar:
  order: 12
---

A glossary term tells supported transcription paths that a token is likely to occur. Good entries include `mausVoice`, a colleague's surname, a project codename, or a domain term whose spelling matters.

Enter the canonical spelling you want the recognizer to favor. Do not add several speculative misspellings as separate "correct" terms; replacement rules are better suited to correcting a stable wrong output. Keep entries short unless the phrase genuinely functions as one unit.

Provider behavior differs. Some APIs expose prompt, keyword, or vocabulary features with different limits, and local models may consume context differently. mausVoice passes the available hints through its transcription layer where implemented, but cannot promise identical weighting across providers.

After adding a term, make three normal-speed test recordings with it in different sentence positions. If the raw transcript still returns a consistent alternative, add a replacement rule from that observed alternative to the canonical text.
