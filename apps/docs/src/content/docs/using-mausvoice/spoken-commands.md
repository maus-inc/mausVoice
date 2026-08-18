---
title: "Spoken formatting commands"
description: "Use hands-free voice commands to insert punctuation, line breaks, paragraphs, and list formatting during dictation."
sidebar:
  order: 17
---

Spoken formatting commands allow you to control layout and punctuation hands-free while dictating. Instead of typing punctuation or manually pressing return, speak common formatting phrases during dictation to insert structural elements directly.

## Enable or disable spoken commands

1. Open **Settings → General → More settings**.
2. Locate the **Spoken commands** switch.
3. Toggle the switch to turn hands-free formatting commands on or off. By default, spoken commands are enabled.

## Recognized commands

When spoken commands are enabled, mausVoice parses recognized speech for the following formatting rules:

| Spoken Phrase | Effect / Insertion |
| :--- | :--- |
| `"new line"` | Inserts a single line break (`\n`). |
| `"new paragraph"` | Inserts a double line break (`\n\n`). |
| `"scratch that"` | Erases the preceding spoken segment in the current recording. |
| `"bullet point"` | Inserts a new bullet point list item (`• `). |
| `"period"` / `"full stop"` | Inserts a period (`.`) followed by a space. |
| `"comma"` | Inserts a comma (`,`) followed by a space. |
| `"colon"` | Inserts a colon (`:`) followed by a space. |
| `"semicolon"` | Inserts a semicolon (`;`) followed by a space. |
| `"question mark"` | Inserts a question mark (`?`) followed by a space. |
| `"exclamation mark"` / `"exclamation point"` | Inserts an exclamation mark (`!`) followed by a space. |

## Matching behavior

Commands are matched case-insensitively as complete, whitespace-delimited words; punctuation immediately around a command phrase is ignored. A command can occur anywhere in a longer recognized utterance, so saying `first item new line second item` inserts a line break rather than requiring `new line` to be the entire dictation.

Commands apply only when the dictation language is explicitly set to English (an `en` or `en-*` locale). They do not apply when the language is set to **Auto** or to a non-English language, and the recognized phrase remains literal text. A few common collocations are intentionally left untouched, including `new line of credit`, `Oxford comma`, `time period`, and `colon cancer`; other uses of a recognized phrase are transformed. Turn the feature off when you need to dictate a command phrase literally.

## How it works

Spoken commands are evaluated against the recognized audio output before final post-processing and text insertion. If you turn spoken commands off, phrases like `"new line"` or `"period"` will be transcribed as literal text rather than converted into formatting or punctuation.
