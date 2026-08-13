---
title: "Transcript not inserted"
description: "Use History and the clipboard to separate correct processing from target-application input failure."
sidebar:
  order: 4
---

First look at **History** and paste the clipboard manually. If correct text exists, do not rotate provider keys or redownload a model: the failure happened after processing.

Keep the target caret focused until insertion completes. Start with a normal, non-elevated plain text editor. An elevated Windows app may reject input from a non-elevated process; terminals and remote desktop tools can use different paste shortcuts; password fields may intentionally block paste.

Open **Settings → General → Text insertion options**. Try clipboard paste, verify the configured paste sequence, then try simulated typing. Increase the default 5 ms typing delay if characters are missing or reordered. Create a per-app override only when the problem is isolated to that target.

On Wayland, verify `ydotool`, `/dev/uinput` access, group membership after a new login, and any `wtype` fallback. Clipboard managers can also replace or transform output, so disable them briefly during testing.
