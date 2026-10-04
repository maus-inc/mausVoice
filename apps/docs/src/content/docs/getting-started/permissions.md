---
title: "Permissions by platform"
description: "Map microphone, global shortcut, overlay, and insertion failures to the relevant permission."
sidebar:
  order: 7
---

mausVoice crosses several operating-system security boundaries. Grant the narrow permissions needed for the behavior you use, and distinguish them when diagnosing a problem.

| Capability                  | Why it is needed                                       | Typical failure when blocked                                |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| Microphone                  | Capture speech audio                                   | No level, empty recording, or immediate failure             |
| Global input                | Observe the hold-to-dictate shortcut outside mausVoice | Shortcut works only while the app is focused, or not at all |
| Accessibility/input control | Insert the final text into another application         | Transcript succeeds but never reaches the target            |
| Overlay/window access       | Show and position the native recording pill            | Dictation works without a visible indicator                 |
| `/dev/uinput` on Wayland    | Drive `ydotool` simulated keys                         | Clipboard may update but paste is not triggered             |

On macOS, review mausVoice under **System Settings → Privacy & Security**, especially Microphone and the input/accessibility categories presented by that macOS release. On Windows, use the input setup offered inside Settings and accept the UAC prompt when appropriate. On Linux, desktop and compositor configuration takes the place of a single universal permission panel.

After changing an operating-system permission, quit and reopen mausVoice. Native audio streams and event taps are often created at process start and do not always recover in-place.

:::caution
Never work around an input problem by granting broad privileges to an unrelated script or binary. Use the installed mausVoice app and distribution-supported tools only.
:::
