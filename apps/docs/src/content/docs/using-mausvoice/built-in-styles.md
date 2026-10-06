---
title: "Built-in styles"
description: "Polished, Verbatim, Email, Chat, Formal, Prompt, Bullets, Concise, and Notes. What each does and when to use it."
sidebar:
  order: 8
---

mausVoice ships these built-in writing styles. Select one in the style picker before dictating, assign it per app, or bind it to a style hotkey.

## Current built-in styles

- **Polished** fixes grammar, punctuation, formatting, filler, false starts, repetitions, spoken symbols, dates, and lists while instructing the model to preserve meaning and word choice. This is the default.
- **Verbatim** disables post-processing for that dictation. Replacement rules and symbol conversion in the normal dictation pipeline can still apply, but no style prompt is sent to a generative model.
- **Email** formats dictated content as a complete email with greeting, body, closing, and signature.
- **Chat** keeps messages casual and concise, like typing in a chat app.
- **Formal** rewrites in a polished, professional register suitable for documents and correspondence.
- **Prompt** condenses rambling dictation into a concise one-to-three-sentence, intent-preserving prompt ready to paste into an AI assistant.
- **Bullets** turns separate ideas into a scannable bulleted list.
- **Concise** removes unnecessary words while preserving all important meaning.
- **Notes** organizes dictated content into compact notes, decisions, and next steps.

## Deprecated styles

Older installations may still show a deprecated built-in such as Light, Casual, Business, Punny, or Disabled when it remains referenced by user or app preferences. Deprecated styles stay visible only while something references them. New choices should use the current set or a custom style.

## Verbatim vs. turning post-processing off

Verbatim and globally turning **AI post processing** Off both avoid the generative rewrite, but their scope differs: Verbatim is a selectable style, so another app or the next manual selection can still use post-processing. The global Off setting disables rewriting for every style.

## Local styling for short dictations

Polished, Chat, Concise, Formal, and Prompt have deterministic local transforms. When post-processing is on and the dictation is at most two sentences and roughly thirty words, those transforms style it directly instead of calling the provider, so the result is instant and the post-processing step runs on the computer. The transform handles filler, false starts, repetitions, self-corrections, spoken symbols and domains, spoken dates, times, numbers, currency and percentages, and capitalizes day and month names. Longer dictations still use the provider, which is where grammar rewriting and restructuring happen. Turn this off under **Settings → AI and processing → Fast styling for short dictations**.

## Output accuracy

Model output for Polished, Email, Chat, and custom styles is probabilistic. Compare Raw and final text in History before trusting a style with legal wording, code, names, dates, or quotations.
