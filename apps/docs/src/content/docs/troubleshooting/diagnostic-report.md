---
title: "Prepare a useful bug report"
description: "Collect minimal, sanitized evidence that maintainers can reproduce."
sidebar:
  order: 10
---

Before filing, reproduce on the latest relevant release and search existing [GitHub issues](https://github.com/maus-inc/mausVoice/issues). Then include:

- operating system/version, and compositor plus X11/Wayland on Linux;
- mausVoice version and package type;
- Local or API transcription, model/provider, and post-processing On/Off;
- target application and insertion method;
- expected result, actual result, and exact steps;
- whether raw text reached History or clipboard;
- sanitized diagnostics and non-secret error text.

Replace private speech with a neutral sentence that still reproduces the bug. Inspect diagnostics for account or user metadata. Never include API keys, encrypted database blobs as if they were harmless, or private audio.

One report should describe one failure boundary. “Nothing works” is hard to act on; “History has correct raw text, clipboard is correct, Shift+Insert does not fire on KDE Wayland with ydotool 1.x” is testable.
