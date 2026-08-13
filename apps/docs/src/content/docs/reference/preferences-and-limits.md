---
title: "Preference defaults and limits"
description: "Reference the effective defaults for processing, insertion, privacy, and optional behavior."
sidebar:
  order: 7
---

These are effective defaults in the current source. An upgraded profile keeps its stored values, and onboarding can intentionally write a different initial value where noted.

## Processing

| Preference                     | Effective default           |
| ------------------------------ | --------------------------- |
| Transcription                  | Local                       |
| Local GPU enumeration          | Off                         |
| Post-processing                | Off                         |
| Assistant backend              | Off                         |
| Assistant feature / power mode | Off / Off                   |
| Active dictation language      | Follow the primary language |
| Microphone                     | Operating-system default    |
| Dictation limit                | 5 minutes                   |

A nonzero limit stops recording at that many minutes. Limits longer than one minute produce a warning one minute before stopping; `0` disables both timers. The maximum accepted value is constrained by the JavaScript timer range.

## Output and interface

| Preference                                    | Effective default                    |
| --------------------------------------------- | ------------------------------------ |
| Insertion method                              | Paste                                |
| Paste keystroke                               | Shift+Insert                         |
| Simulated typing delay                        | 5 ms per character                   |
| Real-time output                              | Off                                  |
| Remote output / receiver auto-start           | Off / Off                            |
| Receiver port                                 | Automatic                            |
| System playback level while dictating         | 100% of its prior level (no dimming) |
| Interaction chime                             | On                                   |
| Menu-bar/tray icon                            | Shown                                |
| Pill reset monitor                            | Current pill monitor                 |
| Streak celebrations / automatic style loading | On / On                              |
| Windows always-request-admin                  | Off                                  |

The general default-preference factory uses **While active** for pill visibility, while successful first-run onboarding currently writes **Persistent**. The displayed Settings value is authoritative for an installed profile.

## Privacy and updates

Incognito is off, inclusion of Incognito words in statistics is off, and automatic presentation of an available update is on. Real-time output currently requires Manual styling with Verbatim selected and a transcription session that emits committed segments. API credentials are encrypted at rest with XChaCha20-Poly1305 and a fresh per-record nonce, but provider requests and multi-device transport have separate security boundaries.

Application targets can override paste keystroke, insertion method, typing delay, and style. `null` in a target record means “inherit the current global setting,” not necessarily the hard-coded default above.
