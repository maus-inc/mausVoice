---
title: "Data flow by mode"
description: "Trace what leaves the computer for Local and API transcription with post-processing On or Off."
sidebar:
  order: 1
---

Privacy depends on the combination of two independent modes.

| Transcription | Post-processing | Network content                                                                      |
| ------------- | --------------- | ------------------------------------------------------------------------------------ |
| Local         | Off             | No provider request is required for the core dictation after the model is downloaded |
| Local         | API             | Transcript text and style/context go to the generative provider                      |
| API           | Off             | Audio goes to the selected transcription endpoint                                    |
| API           | API             | Audio goes to transcription; transcript text/context goes to the generative endpoint |

Self-hosted endpoints can keep requests on a machine or network you control, but the transport and server configuration are your responsibility. Multi-device output adds a separate delivery path after processing; its current shared-secret-authenticated TCP protocol does not encrypt the final text, so keep it on a trusted network.

Local history, dictionary, preferences, and optional audio are separate from provider transmission. Incognito suppresses new history and audio snapshots, while usage-statistics inclusion has its own toggle. Clipboard insertion can also expose output to the operating system and clipboard managers.

Make privacy claims about a concrete configuration, not the product in the abstract. “Local transcription” is accurate for the audio-to-text stage; “nothing leaves the device” is accurate only when all enabled network-backed stages and remote output are also excluded.
