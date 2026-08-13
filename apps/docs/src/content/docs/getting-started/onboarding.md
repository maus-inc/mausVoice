---
title: "Onboarding walkthrough"
description: "Understand each first-run decision and how to revisit it later."
sidebar:
  order: 6
---

Onboarding establishes the permissions and processing path needed for a useful first recording. It is a guided setup, not a permanent lock-in: its choices can be revisited from **Settings**.

## What onboarding covers

The current desktop build initializes a local personal profile automatically. It does not require or connect to a mausVoice cloud account. Some account-oriented screens and labels remain in the source tree for compatibility, but they are not an active authentication path.

The reachable first-run flow is:

1. **Local profile.** Continue from the initialized personal profile into onboarding. No email address, password, or hosted account is required.
2. **API credentials.** Add an optional Deepgram key for streaming transcription and/or a Groq key for transcription and AI post-processing. Either field can be skipped and configured later.
3. **Profile.** Enter a display name and optional role/company details, followed by a referral-source question.
4. **Permissions.** macOS receives dedicated Microphone and Accessibility screens. Other platforms proceed to the shortcut test and rely on their platform-specific input setup.
5. **Shortcut test.** Confirm that the hold-to-dictate combination can be observed outside the main window.
6. **Microphone test.** Select an input and check that a signal reaches the recorder.
7. **Tutorial recording.** Practice the hold, speak, release cycle and observe the recording pill.

Do not rush through a failed permission check. A shortcut can appear valid in the settings UI while the operating system still blocks global capture, and a listed microphone can be unavailable to the app because its privacy permission was denied. Local models that have not yet been downloaded are prepared later inside **AI transcription**.

## Changing a decision later

Open **Settings** from the bottom of the left navigation. **Microphone**, **Hotkey shortcuts**, **AI transcription**, and **AI post processing** reopen the important choices individually. Local model downloads are managed inside **AI transcription** rather than through a separate installer.
