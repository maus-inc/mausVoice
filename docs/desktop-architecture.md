# Desktop architecture

> **Maintained page:** [Desktop architecture](https://maus-inc.github.io/mausVoice/docs/development/architecture/). Prefer that document.

The desktop app is [Tauri](https://tauri.app/) v2: Rust native capabilities + TypeScript/React product logic.

## Philosophy

**Rust is the API, TypeScript is the Brain.**

- Single source of truth: Zustand + Immer in TypeScript
- Repos in this build are local (SQLite / PersonalAuth). Flavor names `enterprise` / `enterprise-dev` are leftovers, not live backends.
- Rust handles audio, hotkeys, insertion, SQLite, crypto, sidecars, and overlays. It makes no provider or style decisions.

## Data flow

```
User / native event
        |
        v
TypeScript actions + Zustand
        |-- provider sessions (browser WebSocket / @maus-inc/voice-ai HTTP)
        +-- local persistence + sidecar (Tauri commands -> SQLite / rust_transcription)
        |
        v
optional replacements + LLM cleanup
        |
        v
paste / simulate_type / remote receiver
```

1. Rust emits a hotkey or pill event.
2. `DictationSideEffects` / dictation strategy starts capture and a `TranscriptionSession` (Deepgram stream, Gladia stream, other API batch, or local sidecar).
3. Dictionary replacements run in TypeScript.
4. If post-processing is **API**, a generate-text repo calls the configured LLM. **Off** skips the network rewrite.
5. If `reviewBeforeInsert` is on, the composer opens for editing before insertion.
6. History and audio persist unless Incognito mode is enabled.
7. Insertion uses `paste` (clipboard) or `simulate_type` (simulated keystrokes).

## Layers

| Layer | Owns |
|---|---|
| TypeScript | State, routing, styles, provider selection, prompts, spoken commands |
| `@maus-inc/voice-ai` | Provider HTTP/WebSocket clients (17 providers) |
| `@repo/agent` | Assistant tool loop |
| `@maus-inc/desktop-native-apis` | Specta bindings (`pnpm gen:bindings`) |
| Rust | Commands in `commands.rs`, registered in `app.rs` |

New command: annotate in `commands.rs`, register in `app.rs`, add to `examples/gen_bindings.rs`, run `pnpm gen:bindings`, wrap in a repo, call from an action.
