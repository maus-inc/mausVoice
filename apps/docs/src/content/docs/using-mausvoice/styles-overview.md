---
title: "Writing styles"
description: "Choose app-based or manual style selection and understand exactly when rewriting runs."
sidebar:
  order: 7
---

A writing style is an instruction for the optional post-processing stage. It can clean punctuation, remove fillers, or reshape a transcript, but it does not train speech recognition or recover audio the transcription model missed.

Open **Writing Styles** from the main navigation. Which layout appears depends on **Settings → General → More settings → Styling mode**:

- **Based on app** is the default. The page lists registered applications and lets each app have a style.
- **Manual** shows a selected set of styles. Click a row or use the style-cycle shortcuts while dictating.

Post-processing must also be configured. If **Settings → Processing → AI post processing** is **Off**, style controls are disabled and no generative rewrite runs. The built-in **Verbatim** style also skips the generative stage for that dictation, while leaving post-processing available for other styles.

## What reaches the provider

For an ordinary rewrite, mausVoice combines the active style prompt, transcript, dictionary-related context, and other processing instructions, then calls the selected generative provider. A custom prompt can therefore leave this computer. Do not store secrets in one.

Use **History** to compare **Raw** and final text. A wrong name in Raw is a recognition or dictionary problem. Correct Raw text that changes in the final result points to style/post-processing behavior. Test exact quotations, numbers, URLs, names, and uncertainty before relying on a style for high-stakes text.
