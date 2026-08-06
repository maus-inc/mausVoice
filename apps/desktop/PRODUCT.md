# PRODUCT

## Who uses this
Individual knowledge workers who dictate more than they can type: one person dictating into any macOS or Windows app. No heavy team or admin surface — the personal local-first compute person. Default register: **Operate** (tool that disappears into the task).

## Product purpose
mausVoice turns speech into text and pastes it into whatever app they are focused on — then optionally cleans it up with an LLM in their chosen writing style, drive hotkey-first, all while staying out of the way (a small overlay "pill" shows state; system tray keeps it resident).

## Product truth (do not invent or hype)
- Local + cloud hybrid: transcript audio stays on device; keys are entered in-app, encrypted (XChaCha20-Poly1305) and never baked into the build.
- BYO keys: Deepgram (streaming transcription) + Groq (AI post-processing), or a fully-local Whisper model with no network.
- Broader product: the reality free of sentences is: dictation overlay, hotkeys, personal dictionary, writing styles (tones), voice assistant ("agent mode"), conversation log, and remote pairing to a click-once receiver.
- It is a fork that strips the paywall + Flutter mobile; Linux desktop is retained (GTK pill + Linux CI).

## Brand / tone
- Name: **mausVoice**. Wordmark uses a display face (TAN-PARADISO) only on logo + welcome/name; all body/UI is a single workhorse sans (Satoshi / Plus Jakarta).
- Voice in-UI copy: direct, plain, task-named. Buttons name the action ("Save and continue", not "Proceed").
- Nothing gimmicky. It is a tool a professional uses all day.

## Anti-references (never)
- Whet, loud, or "AI-company-purple" aesthetics. No decorative glass, no gradient text, no emoji-as-icons, no generic 3-equal-card grids.
- Do not make the pill or chrome any more playful than the app already is — this is Operate, not Experience.
- Never hide a destructive/unmistakeable action behind a single hover.

## Constraints
- MUI-based React desktop shell + native Rust pill channels. Density matters (dictation is a power tool). Fast is a feature: the pill, trails, and paste need to feel immediate.
- Reduced-motion must be honored (movement is decoration on a tool).