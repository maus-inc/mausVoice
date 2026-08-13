---
title: "Text insertion options"
description: "Set global and per-application paste or simulated-typing behavior."
sidebar:
  order: 9
---

Open **Settings → General → Text insertion options**. The global insertion mode defaults to clipboard paste, with **Shift+Insert** as the paste keystroke. Simulated typing defaults to a **5 ms** delay between events.

Prefer paste for ordinary editors. It is fast and gives the target one coherent clipboard payload. Prefer simulated typing for an app that refuses synthetic paste, but raise the delay when characters disappear or reorder.

Per-application overrides are persisted. Create one only after reproducing the problem in a specific target, and record the exact executable/application identity shown by mausVoice. An override for a similarly named app may not match another channel, packaged variant, browser PWA, or elevated process.

The clipboard is part of the data path. Another clipboard manager can observe or transform dictated text, and a previous clipboard item may be replaced. If the target is empty, paste manually once: correct clipboard content proves that recording, processing, and clipboard write all completed.
