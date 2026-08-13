---
title: "Text insertion"
description: "Choose paste or simulated typing and tune behavior for applications that handle input differently."
sidebar:
  order: 15
---

After processing, mausVoice places output on the clipboard and delivers it with the configured insertion strategy. Open **Settings → General → Text insertion options** to choose between clipboard paste and simulated typing.

Defaults are clipboard **paste**, **Shift+Insert** as the paste key sequence, and a **5 ms** delay for simulated typing. These are operational defaults, not guarantees for every target. Terminals, remote desktops, password fields, games, browser canvases, and elevated windows can intercept or reject synthetic input.

Use paste for normal editors because it is fast and preserves a single atomic block. Try simulated typing when an application refuses programmatic paste, and increase its delay if characters arrive out of order or go missing. Per-application overrides can preserve a special choice for a troublesome target without slowing every other app.

Insertion failure does not imply transcription failure. Check History or the clipboard. If the correct text exists there, keep the provider settings unchanged and troubleshoot focus, permissions, paste shortcut, or typing delay.
