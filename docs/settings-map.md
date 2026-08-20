# Settings map

> Maintained page: [Settings map](https://maus-inc.github.io/mausVoice/docs/configuration/settings-map/).

- **AI transcription → Local model**: Whisper, Parakeet, Canary, or SenseVoice.
- **AI transcription → API key → Gladia**: API key plus the `solaria-1` model; supports live dictation and batch/import transcription.
- **Style hotkeys**: one optional global shortcut per writing style.
- **More settings → Switch style while dictating**: activation key plus Left/Right Arrow cycling, opt-in.
- **More settings → Silence hallucination filter**: near-silence filtering runs only for local transcription before model inference; known-phrase filtering applies to returned text before post-processing for all providers.
- **More settings → Review before insert**: open the editable composer before paste or simulated typing.
- **Assistant mode**: configure enabled tools and maximum loop iterations. Power mode remains required for terminal commands.
- **History → Import audio**: choose a local recording, select language and style, and send the decoded 16 kHz mono audio through the normal transcription pipeline.
