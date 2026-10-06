---
title: "Writing styles"
description: "Choose app-based or manual style selection and understand exactly when rewriting runs."
sidebar:
  order: 7
---

A writing style is an instruction for the optional post-processing stage. It can clean punctuation, remove fillers, or reshape a transcript, but it does not train speech recognition or recover audio the transcription model missed.

Open **Writing Styles** from the main navigation. Which layout appears depends on **Settings → AI and processing → Styling mode**:

- **Based on app** is the default. The page lists registered applications and lets each app have a style.
- **Manual** shows a selected set of styles. Click a row or use the style-cycle shortcuts while dictating.

Post-processing must also be configured. If **Settings → AI and processing → AI post processing** is **Off**, style controls are disabled and no generative rewrite runs. The built-in **Verbatim** style also skips the generative stage for that dictation, while leaving post-processing available for other styles.

## What reaches the provider

For an ordinary rewrite, mausVoice combines the active style prompt, transcript, dictionary-related context, and other processing instructions, then calls the selected generative provider. A custom prompt can therefore leave this computer. Do not store secrets in one.

## Short dictations are styled on your device

Post-processing is turned on by default, and it is also the slowest stage in the workflow: a provider request carries the whole style prompt, so a three-word dictation waits about as long as a paragraph does. To avoid that wait, a dictation in one of the prose styles (Polished, Chat, Concise, Formal, or Prompt) that is at most two sentences and roughly thirty words is styled by the same deterministic transforms that run when post-processing is off. Those dictations skip the post-processing request entirely, so they finish in milliseconds and the styling never leaves the computer.

Everything else goes to the provider: longer dictations, Email, Bullets, Notes, custom styles, and Verbatim (which never rewrites at all). If a short dictation reduces to nothing under the local transforms, it is sent to the provider rather than delivered blank.

Turn **Settings → AI and processing → Fast styling for short dictations** off to send every dictation to the provider.

**History** records which path a transcription took: **Fast (local)** in the post-processing row means the on-device transforms ran, and **API** means the provider did.

Use **History** to compare **Raw** and final text. A wrong name in Raw is a recognition or dictionary problem. Correct Raw text that changes in the final result points to style/post-processing behavior. Test exact quotations, numbers, URLs, names, and uncertainty before relying on a style for high-stakes text.
