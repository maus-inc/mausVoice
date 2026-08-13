---
title: "Focus and delivery model"
description: "Understand target detection, completion-time focus, paste fallback, simulated typing, and app-target overrides."
sidebar:
  order: 9
---

mausVoice records globally, but output is delivered to whichever control is focused at delivery time. That can differ from the app focused when recording began: local inference, an API round trip, post-processing, or a long recording all widen the handoff window.

With **Paste**, the backend probes the focused target for up to 500 ms. A clearly non-editable target receives no synthetic paste keystroke; mausVoice puts the completed text on the clipboard instead. An editable or unknown target goes through the platform paste implementation with the configured key sequence. Clipboard managers, terminals, elevated windows, remote sessions, and application-specific shortcuts can still intercept it.

With **Simulate typing**, mausVoice emits text into the current field over time using the selected per-character delay. Focus can move midway through a long result, and cancellation can stop the remaining synthetic events. Rich editors may transform individual keystrokes differently from one clipboard insertion.

Focused executable identity also selects app-target overrides for insertion method, paste binding, typing delay, and style. Browser tabs usually share one browser identity; Store/sandboxed and conventional builds of the “same” app can resolve differently. App styling and insertion selection use that identity, not the page title alone.

For predictable delivery, keep the intended caret active until the pill returns to idle. If output lands elsewhere, retry in a plain editor with post-processing off, then compare Paste and Simulate typing. A successful transcription visible in History points to focus/delivery rather than microphone recognition; no History record points earlier in the pipeline. See [Text was produced but not inserted](../../troubleshooting/text-not-inserted/) for the decision path.
