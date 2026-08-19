# Desktop Architecture

> **Maintained page:** [Desktop architecture](https://maus-inc.github.io/mausVoice/docs/development/architecture/). Prefer that document.

The desktop app is [Tauri](https://tauri.app/) v2: Rust native capabilities + TypeScript/React product logic.

## Philosophy

**Rust is the API, TypeScript is the Brain.**

- Single source of truth: Zustand + Immer in TypeScript
- Repos in this build are **local** (SQLite / PersonalAuth). Flavor names `enterprise` / `enterprise-dev` are leftovers, not live backends
- Rust: audio, hotkeys, insertion, SQLite, crypto, sidecars, overlays — no provider/style decisions

## Data flow

```
User / native event
        ↓
TypeScript actions + Zustand
        ├─ provider sessions (browser WebSocket / @maus-inc/voice-ai HTTP)
        └─ local persistence + sidecar (Tauri commands → SQLite / rust_transcription)
        ↓
optional replacements + LLM cleanup
        ↓
paste / simulate_type / remote receiver
```

1. Rust emits a hotkey or pill event.
2. `DictationSideEffects` / dictation strategy starts capture and a `TranscriptionSession` (Deepgram stream, other API, or local sidecar).
3. Dictionary replacements run in TypeScript.
4. If post-processing is **API**, a generate-text repo calls the configured LLM (personal default Groq `openai/gpt-oss-20b`). **Off** skips the network rewrite.
5. History/audio persist unless Incognito.
6. Insertion uses `paste` or `simulate_type`.

## Layers

| Layer | Owns |
| --- | --- |
| TypeScript | State, routing, styles, provider selection, prompts |
| `@maus-inc/voice-ai` | Provider HTTP/WebSocket clients |
| `@repo/agent` | Assistant tool loop |
| `@maus-inc/desktop-native-apis` | Specta bindings (`pnpm gen:bindings`) |
| Rust | Commands in `commands.rs`, registered in `app.rs` |

New command: annotate in `commands.rs`, register in `app.rs`, add to `examples/gen_bindings.rs`, run `pnpm gen:bindings`, wrap in a repo, call from an action.
