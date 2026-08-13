---
title: "Onboarding walkthrough"
description: "Understand each first-run decision and how to revisit it later."
sidebar:
  order: 6
---

Onboarding establishes the permissions and processing path needed for a useful first recording. It is a guided setup, not a permanent lock-in: its choices can be revisited from **Settings**.

## What onboarding covers

The exact branch depends on the build and whether you choose account sign-in or local/personal setup:

1. **Setup path.** The opening screen can continue an existing sign-in or start a local setup. An account is not required for the local, bring-your-own-key path.
2. **Processing choices.** The general local-setup branch presents transcription and post-processing choices. The personal-use branch instead offers optional Deepgram and Groq credential fields; either key can be skipped and configured later.
3. **Profile.** The flow records a display name and optional role/company details, followed by a referral-source question.
4. **Permissions.** macOS receives dedicated Microphone and Accessibility screens. Other platforms proceed to the shortcut test and rely on their platform-specific input setup.
5. **Shortcut test.** Confirm that the hold-to-dictate combination can be observed outside the main window.
6. **Microphone test.** Select an input and check that a signal reaches the recorder.
7. **Tutorial recording.** Practice the hold, speak, release cycle and observe the recording pill.

Do not rush through a failed permission check. A shortcut can appear valid in the settings UI while the operating system still blocks global capture, and a listed microphone can be unavailable to the app because its privacy permission was denied. Local models that have not yet been downloaded are prepared later inside **AI transcription**.

## Changing a decision later

Open **Settings** from the bottom of the left navigation. **Microphone**, **Hotkey shortcuts**, **AI transcription**, and **AI post processing** reopen the important choices individually. Local model downloads are managed inside **AI transcription** rather than through a separate installer.
