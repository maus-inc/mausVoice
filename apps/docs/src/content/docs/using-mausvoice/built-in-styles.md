---
title: "Built-in styles"
description: "Use Polished, Verbatim, Email, and Chat, including the exact no-rewrite behavior of Verbatim."
sidebar:
  order: 8
---

The current non-deprecated built-in styles are:

- **Polished** fixes grammar, punctuation, formatting, filler, false starts, repetitions, spoken symbols, dates, and lists while instructing the model to preserve meaning and word choice.
- **Verbatim** disables post-processing for that dictation. Replacement rules and symbol conversion in the normal dictation pipeline can still apply, but no style prompt is sent to a generative model.
- **Email** asks for greeting, body, closing, and an appropriate signature while applying the cleanup rules.
- **Chat** favors concise, casual message text while retaining meaning.

Older installations may still show a deprecated built-in such as Formal, Business, Punny, or Disabled when it remains referenced by user or app preferences. New choices should use the current set or a custom style.

Verbatim and globally turning **AI post processing** Off both avoid the generative rewrite, but their scope differs: Verbatim is a selectable style, so another app or the next manual selection can still use post-processing. The global Off setting disables rewriting for every style.

Model output for Polished, Email, Chat, and custom styles is probabilistic. Compare Raw and final text in History before trusting a style with legal wording, code, names, dates, or quotations.
