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

| Spoken phrase                                                    | Effect / insertion                                                                                                                         |
| :--------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `"new line"`, `"next line"`, `"line break"`, or `"newline"`      | Inserts a single line break (`\n`).                                                                                                        |
| `"new paragraph"` or `"next paragraph"`                          | Inserts a double line break (`\n\n`).                                                                                                      |
| `"scratch that"`                                                 | Removes speech after the previous sentence boundary; if there is no earlier boundary, removes the preceding text in the current dictation. |
| `"comma"`                                                        | Inserts a comma (`,`).                                                                                                                     |
| `"period"` or `"full stop"`                                      | Inserts a period (`.`).                                                                                                                    |
| `"colon"`                                                        | Inserts a colon (`:`).                                                                                                                     |
| `"semicolon"`                                                    | Inserts a semicolon (`;`).                                                                                                                 |
| `"question mark"`                                                | Inserts a question mark (`?`).                                                                                                             |
| `"exclamation mark"` or `"exclamation point"`                    | Inserts an exclamation mark (`!`).                                                                                                         |
| `"dot dot dot"`                                                  | Inserts an ellipsis (`...`).                                                                                                               |
| `"open parenthesis"`, `"left parenthesis"`, or `"open paren"`    | Inserts an opening parenthesis (`(`).                                                                                                      |
| `"close parenthesis"`, `"right parenthesis"`, or `"close paren"` | Inserts a closing parenthesis (`)`).                                                                                                       |
| `"open quote"` or `"open quotes"`                                | Inserts an opening double quote (`"`).                                                                                                     |
| `"close quote"` or `"close quotes"`                              | Inserts a closing double quote (`"`).                                                                                                      |

Commas, periods, colons, semicolons, question marks, exclamation marks, and closing parentheses or quotes are attached to the preceding word; their following spacing is preserved. An ellipsis preserves its surrounding transcription spacing. Line and paragraph breaks, as well as opening parentheses and quotes, absorb the following spacing so that the next dictated word starts immediately after the inserted character or break.

## Matching behavior

Commands are matched case-insensitively as complete, whitespace-delimited words; punctuation immediately around a command phrase is ignored. A command can occur anywhere in a longer recognized utterance, so saying `first item new line second item` inserts a line break rather than requiring `new line` to be the entire dictation.

Commands apply when the dictation language is English (an `en` or `en-*` locale) or **Auto**. They do not apply for a non-English language, and the recognized phrase remains literal text. A few common collocations are intentionally left untouched, including `new line of credit`, `Oxford comma`, `billing period`, and `colon cancer`. A command word right after a determiner is treated as an ordinary noun, so `read the next line` and `put a comma after the name` stay as spoken. That covers articles and possessives (`a`, `the`, `my`, `their`), demonstratives (`this`, `those`), and words like `each`, `every`, `some`, `no`, `which`, `per`, `same`, `last`, and `next`.

`"period"` and `"scratch that"` are also everyday words, so they only apply where they close a clause: at the end of the dictation, set off by punctuation, or followed by a capitalized word or another command. `the sprint period ends Friday` and `let's scratch that idea` stay literal. A few compound nouns that end in `period` also stay literal at the end of a sentence, such as `notice period`, `trial period`, `grace period`, and `billing period`, unless punctuation separates the two words (`The notice. Period.`). A capitalized word counts as a new sentence only when it commonly opens one, such as `I`, `The`, `Then`, `See`, or `Best`, so `the difficult period Apple faced` stays literal while `I finished period Then I left` becomes `I finished. Then I left`. If you say `period` mid-sentence without pausing, it may stay as a word; the transcription usually adds a comma or capital when you pause, which lets the command apply. Turn the feature off when you need to dictate a command phrase literally.

## How it works

Spoken commands are evaluated against the recognized audio output before final post-processing and text insertion. If you turn spoken commands off, phrases like `"new line"` or `"period"` will be transcribed as literal text rather than converted into formatting or punctuation.
