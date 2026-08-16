# Accuracy and output safeguards

The **Silence hallucination filter** is enabled by default. Local transcription applies a small RMS gate before model inference, while every transcription provider uses a conservative shared phrase filter to remove known silence-only results such as `[BLANK_AUDIO]` before post-processing.

The RMS gate is local-engine only and is controlled by the same setting as the phrase filter. Cloud/API transcription still receives the complete audio and only applies the returned-text filter. Disable the setting in **Settings → More settings** if a recording intentionally consists of very quiet speech or if a provider's result is being over-filtered. The phrase filter never removes a known phrase when it is part of a longer sentence.
