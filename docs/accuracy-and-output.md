# Accuracy and output safeguards

The **Silence hallucination filter** is enabled by default. A small RMS gate rejects near-silent audio before local or cloud transcription, and a conservative shared phrase filter removes known silence-only results such as `[BLANK_AUDIO]` or `Thank you for watching` before post-processing.

Disable the setting in **Settings → More settings** if a recording intentionally consists of very quiet speech or if a provider's result is being over-filtered. The filter never removes a known phrase when it is part of a longer sentence.
