---
title: "Spoken formatting commands"
description: "Use hands-free voice commands to insert punctuation, line breaks, paragraphs, quotes, and parentheses during dictation."
sidebar:
  order: 17
---

Spoken formatting commands allow you to control layout and punctuation hands-free while dictating. Instead of typing punctuation or manually pressing return, speak common formatting phrases during dictation to insert structural elements directly.

## Enable or disable spoken commands

1. Open **Settings → General → More settings**.
2. Locate the **Spoken commands** switch.
3. Toggle the switch to turn hands-free formatting commands on or off. By default, spoken commands are enabled.

## Recognized commands

When spoken commands are enabled, mausVoice recognizes the following phrases:

| Spoken phrase | Effect / insertion |
| :--- | :--- |
| `"new line"`, `"next line"`, `"line break"`, or `"newline"` | Inserts a single line break (`\n`). |
| `"new paragraph"` or `"next paragraph"` | Inserts a double line break (`\n\n`). |
| `"scratch that"` | Removes speech after the previous sentence boundary; if there is no earlier boundary, removes the preceding text in the current dictation. |
| `"comma"` | Inserts a comma (`,`). |
| `"period"` or `"full stop"` | Inserts a period (`.`). |
| `"colon"` | Inserts a colon (`:`). |
| `"semicolon"` | Inserts a semicolon (`;`). |
| `"question mark"` | Inserts a question mark (`?`). |
| `"exclamation mark"` or `"exclamation point"` | Inserts an exclamation mark (`!`). |
| `"dot dot dot"` | Inserts an ellipsis (`...`). |
| `"open parenthesis"`, `"left parenthesis"`, or `"open paren"` | Inserts an opening parenthesis (`(`). |
| `"close parenthesis"`, `"right parenthesis"`, or `"close paren"` | Inserts a closing parenthesis (`)`). |
| `"open quote"` or `"open quotes"` | Inserts an opening double quote (`"`). |
| `"close quote"` or `"close quotes"` | Inserts a closing double quote (`"`). |

Commas, periods, colons, semicolons, question marks, exclamation marks, and closing parentheses or quotes are attached to the preceding word; their following spacing is preserved. An ellipsis preserves its surrounding transcription spacing. Line and paragraph breaks, as well as opening parentheses and quotes, absorb the following spacing so that the next dictated word starts immediately after the inserted character or break.

## Matching behavior

Commands are matched case-insensitively as complete, whitespace-delimited words; punctuation immediately around a command phrase is ignored. A command can occur anywhere in a longer recognized utterance, so saying `first item new line second item` inserts a line break rather than requiring `new line` to be the entire dictation.

Commands apply only when the dictation language is explicitly set to English (an `en` or `en-*` locale). They do not apply when the language is set to **Auto** or to a non-English language, and the recognized phrase remains literal text. A few common collocations are intentionally left untouched, including `new line of credit`, `Oxford comma`, `time period`, and `colon cancer`; other uses of a recognized phrase are transformed. Turn the feature off when you need to dictate a command phrase literally.

## How it works

Spoken commands are evaluated against the recognized audio output before final post-processing and text insertion. If you turn spoken commands off, phrases like `"new line"` or `"period"` will be transcribed as literal text rather than converted into formatting or punctuation.
