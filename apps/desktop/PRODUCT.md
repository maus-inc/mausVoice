# PRODUCT

## Who uses this

Individual knowledge workers who dictate more than they can type: one person dictating into any **macOS, Windows, or Linux** app. No heavy team or admin surface — local-first, bring-your-own-key. Default register: **Operate** (tool that disappears into the task).

## Product purpose

mausVoice turns speech into text and inserts it into whatever app has focus — then optionally cleans it up with an LLM in a chosen writing style. Hotkey-first. A small native overlay “pill” shows state; the system tray keeps it resident.

## Product truth (do not invent or hype)

- Hybrid: recognition can be fully local (Whisper GGML / ONNX Parakeet, Canary, SenseVoice) or API (Deepgram `nova-3` streaming is the personal default; Groq and others are batch). **Post-processing is a separate API/Off choice.** Local STT does not imply offline cleanup.
- BYO keys entered in-app, encrypted at rest (XChaCha20-Poly1305), never baked into the build. Rotate in Settings.
- Features that exist: dictation overlay, global hotkeys, personal dictionary (glossary + replacements), writing styles/tones (including per-app and hotkey cycle), experimental Assistant / Chats, history, multi-device remote output.
- This tree is a personal/local build: paywall and Flutter mobile were removed; Linux desktop is retained (GTK pill + Linux packaging).

## Brand / tone

- Name: **mausVoice**. Display face TAN-PARADISO only on logo + welcome; body/UI is Satoshi / Plus Jakarta.
- UI copy: direct, task-named. Buttons name the action (“Save and continue”, not “Proceed”).
- Nothing gimmicky. It is a tool a professional uses all day.

## Anti-references (never)

- Loud or “AI-company-purple” aesthetics. No decorative glass, no gradient text, no emoji-as-icons, no generic 3-equal-card grids.
- Do not make the pill more playful than it already is — Operate, not Experience.
- Never hide a destructive action behind a single hover.

## Constraints

- MUI React shell + native Rust pill. Density matters. Fast is a feature: pill, trails, and paste must feel immediate.
- Reduced-motion must be honored.
