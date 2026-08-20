# mausVoice architecture walkthrough

> Authoritative, maintained pages: [`apps/docs` Desktop architecture](../apps/docs/src/content/docs/development/architecture.md) and https://maus-inc.github.io/mausVoice/docs/development/architecture/. Prefer those if this walkthrough disagrees.

A practical tour of how this repo is put together: the technology stack, the monorepo layout, the desktop app's layered design, the feature subsystems, and the personal/local build.

> As of 0.1.6 this is a local, personal build. The hosted mausVoice Cloud backend, billing, and enterprise SSO/gateway were removed (migrations `071_remove_cloud_modes` / `072_drop_is_enterprise`). There are no cloud or enterprise repos, gateways, or `enterprise/` directories in the tree. Every repo factory resolves to a local implementation.

---

## 1. The big picture

mausVoice is a cross-platform voice-typing desktop app. You hold a hotkey, speak, and the spoken text is transcribed, optionally cleaned up by an LLM, and pasted into whatever application you have focused. It also has an AI assistant ("agent") mode that can take actions on your behalf.

The desktop app is a Tauri 2 application: a Rust backend that exposes native capabilities, and a React/TypeScript frontend that holds all the product logic. The guiding principle is:

> "Rust is the API, TypeScript is the Brain."
> All business logic and decision-making live in TypeScript. Rust provides pure capabilities (record audio, run Whisper, read accessibility info, paste text, talk to SQLite) and makes no product decisions.

---

## 2. Technology stack

### Frontend (`apps/desktop/src`)

| Area | Choice |
|---|---|
| UI framework | React 19 |
| Routing | React Router 6 |
| State | Zustand 5 + Immer (single store) |
| Components / styling | MUI 9 (Material UI) + Emotion |
| Animation | Framer Motion |
| i18n | react-intl (auto-generated message IDs; always use `<FormattedMessage defaultMessage="..." />`) |
| Reactivity | RxJS for event/audio streams |
| Validation | Zod |
| Build | Vite 7 |
| Desktop bridge | `@tauri-apps/api` + Tauri plugins (sql, log, autostart, updater, http, process, os) |

### Backend (`apps/desktop/src-tauri`)

| Area | Choice |
|---|---|
| Framework | Tauri 2 |
| Async runtime | Tokio |
| Database | SQLite via `sqlx` |
| HTTP | `reqwest` |
| Audio capture / playback | `cpal` / `rodio`, `hound` for WAV |
| Global hotkeys | `rdev` (local fork at `patches/rdev`) |
| GPU (local Whisper accel) | `wgpu` (Metal on macOS, Vulkan/DirectX on Windows) |
| Serialization | `serde` / `serde_json` |
| System info | `sysinfo` 0.30 (RAM/CPU detection for model recommendations) |

### Shared AI clients (`packages/voice-ai`, `packages/agent`)

Multi-provider clients: `groq-sdk`, `openai`, `@anthropic-ai/sdk`, `@google/genai`, `@gladiaio/sdk`, `@azure/openai`, plus Azure Speech. The agent loop in `packages/agent` is provider-agnostic and drives tool use.

Supported providers (from `packages/types/src/apiKey.types.ts`): groq, openai, aldea, assemblyai, elevenlabs, deepgram, gladia, openrouter, ollama, openai-compatible, azure, deepseek, gemini, claude, cerebras, speaches, xai.

### Build system

Turborepo + pnpm workspaces. From the repo root: `pnpm run build | lint | check-types | test` (each fans out across workspaces via turbo).

---

## 3. Monorepo layout

```
apps/
  desktop/             # The app. Tauri (Rust) + React/TS frontend
  docs/                # Astro + Starlight documentation site (authoritative docs)
  windows-installer/   # Windows MSI/NSIS installer build
packages/
  types/               # Shared TS domain models (User, Transcription, ApiKey, Tone, Preferences)
  voice-ai/            # Multi-provider LLM and transcription clients
  agent/               # Provider-agnostic agentic loop with tool support
  utilities/           # Date, async, string, math helpers
  desktop-utils/       # Platform detection, hotkey formatting, updater helpers
  desktop-native-apis/ # Specta-generated bindings to Tauri commands
  firemix/             # Firebase path helpers (peer dep; no live backend in this build)
  rust_transcription/  # Local transcription sidecar (whisper.cpp GGML + ONNX Parakeet/Canary/SenseVoice)
  rust_macos_pill/     # macOS dictation overlay (in-process via mpsc)
  rust_windows_pill/   # Windows dictation overlay (subprocess, stdio IPC)
  rust_gtk_pill/       # Linux dictation overlay (subprocess, GTK/layer-shell)
  rust_pill_shared/    # Shared geometry and ring math for the pills
  shared-fonts/        # Satoshi and TAN Paradiso font assets
  eslint-config/, typescript-config/  # Shared tooling configs
scripts/, docs/, release/, branding/, patches/
```

The mobile Flutter app, Rust CLI, hosted `packages/functions`/`packages/pricing`, and the `enterprise/` gateway/admin apps were all removed in earlier work. Linux desktop support is retained (`src-tauri/src/platform/linux`, `packages/rust_gtk_pill`, Linux CI/packaging). The Astro site under `apps/docs/` is the maintained documentation; the files at the repo-root `docs/` are compact reference docs kept in sync with the codebase.

---

## 4. Desktop app architecture

### 4.1 Data flow

Every user or native event flows through the same layered path:

```
User / Native event
      |
      v
Actions      (src/actions/*.ts)        orchestration: what should happen
      |
      v
Repos        (src/repos/*.ts)          data access: local SQLite and AI providers
      |
      v
Tauri cmds   (src-tauri/src/commands.rs)  native capability surface
      |
      v
SQLite  /  rust_transcription sidecar  /  external AI APIs
```

State changes are written back into the Zustand store, and React re-renders. Rust never decides what to do. It only does what TypeScript asks.

### 4.2 State management

There is a single Zustand store (`src/store/index.ts`) created with `persist` (the `local` slice persists to `localStorage` under `mausvoice-local-state`). State is organized as slices in `src/state/` (`app.state.ts`, `onboarding.state.ts`, `agent.state.ts`, `settings.state.ts`, transcriptions, etc.). Mutations go through an Immer-style `produceAppState(draft => ...)` helper so updates stay immutable and ergonomic.

### 4.3 Actions (`src/actions/`)

Actions are the orchestration layer. They call repos, mutate the store via `produceAppState`, and trigger side effects (network, analytics, file IO). Notable ones:

- `transcribe.actions.ts` recording + transcription pipeline
- `personal-use.actions.ts` personal API key setup and default preferences
- `tone.actions.ts`, `dictionary.actions.ts` writing styles and glossary
- `chat.actions.ts` assistant/agent conversations
- `remote-output.actions.ts`, `remote-pairing.actions.ts` multi-device output

### 4.4 Repos (`src/repos/`)

Repos abstract where data lives. Each family has an abstract base plus a local implementation, and the factory in `src/repos/index.ts` resolves directly to it:

```ts
export const getAuthRepo = (): BaseAuthRepo => {
  return new PersonalAuthRepo();
};
```

There are no cloud or enterprise repos in this build. Main repo families:

| Family | Implementation | Stores / talks to |
|---|---|---|
| Auth | `PersonalAuthRepo` | Hardcoded local user |
| User / Member | `LocalUserRepo` / `LocalMemberRepo` | Profile, stats |
| Transcription (records) | `LocalTranscriptionRepo` | SQLite history |
| Transcribe audio (engine) | `LocalTranscribeAudioRepo` | `rust_transcription` sidecar |
| API transcription | Provider-specific repos | Deepgram, Groq, OpenAI, Azure, Gladia, AssemblyAI, ElevenLabs, Speaches |
| Generate text (LLM) | Provider-specific repos | Groq, OpenAI, Claude, Gemini, OpenRouter, Ollama, Azure, DeepSeek, Cerebras, xAI |
| Preferences | `LocalUserPreferencesRepo` | SQLite |
| Terms | `LocalTermRepo` | SQLite |
| Tones | `LocalToneRepo` | SQLite |
| Hotkeys | `LocalHotkeyRepo` | SQLite + Rust keyboard listener |
| App targets | `LocalAppTargetRepo` | SQLite |
| Paired remote devices | `LocalPairedRemoteDeviceRepo` | SQLite |

---

## 5. Feature subsystems

### Transcription

Two modes stored in `transcriptionMode`:

- **`"local"`** The `rust_transcription` sidecar runs whisper.cpp (GGML) or an ONNX model (Parakeet, Canary, SenseVoice) on CPU or GPU. The sidecar listens on a local HTTP port and accepts streamed audio. Session idle TTL is 10 minutes; a sweep task cleans every 60 seconds.
- **`"api"`** A browser WebSocket (Deepgram `nova-3` streaming, Gladia `solaria-1` streaming) or HTTP batch call (Groq, OpenAI, Azure, AssemblyAI, ElevenLabs, Speaches) to a cloud transcription provider.

The hallucination filter (`hallucinationFilterEnabled`) applies an RMS gate before local inference and a phrase filter on returned text for all providers.

### Post-processing (AI cleanup)

After transcription, text can be cleaned up by an LLM through a Generate-Text repo. The active writing style/tone becomes the system prompt. Personal build default: Groq. Set `postProcessingMode` to `"none"` to skip the network rewrite.

### Dictation overlay ("pill")

A separate native implementation per platform renders the floating recording indicator: `rust_macos_pill` (macOS, in-process via mpsc channels), `rust_windows_pill` (Windows, subprocess), and `rust_gtk_pill` (Linux, subprocess, GTK/layer-shell). All three exchange the same `InMessage`/`OutMessage` IPC vocabulary through `pill_process.rs`.

Monitor selection: while the user drags, the pill follows the cursor across monitors. Once dropped, it stays anchored to the drop monitor and does not chase the cursor.

The pill operates on the visible footprint inside an oversized transparent canvas, so edge clamping works flush against real screen edges.

`pillResetMonitorStrategy` controls reset behavior: `"current"` resets to the pill's current monitor, `"cursor"` resets to the monitor under the mouse.

### Hotkeys

Global shortcuts registered through `LocalHotkeyRepo` into Rust `platform/keyboard.rs` (`rdev`), persisted in SQLite. Can be scoped per app target. Style hotkeys allow one global shortcut per writing style. In-dictation style switching (activation key + arrow cycling) is opt-in via `inDictationStyleSwitchingEnabled`.

### Dictionary / glossary and writing styles

Terms and tones live in SQLite (`LocalTermRepo`, `LocalToneRepo`). Terms improve transcription accuracy and support glossary entries plus text replacements. Tones shape post-processing output. Tones support optional structured fields for category, output-length, and input/output example guidance (migration `075_tone_structured_fields`).

### AI assistant / agent mode

A provider-agnostic agent loop (`packages/agent` + `src/agents/`) drives tool calls. Tools live in `src/tools/` and are declared in the `TOOL_REGISTRY` map:

- **paste** inserts text into the focused field
- **get_accessibility_info** reads screen context (focused element, selection, cursor position)
- **end_conversation** closes a pill-scope conversation
- **run_terminal_command** executes a restricted, allow-listed terminal command (power mode required)

Conversations persist via `LocalChatMessageRepo`; state lives in `src/state/agent.state.ts`. Users configure enabled tools and max iterations in settings. Permission prompts expire after `agentPermissionTimeoutMs`.

### Spoken commands

When `spokenCommandsEnabled` is on (default), deterministic commands like "new line" and "scratch that" are executed directly from the transcript without LLM processing.

### App targets and remote output

App targets customize hotkey, insertion method, and tone per application. Remote output lets a paired device receive dictation via Rust `remote_sender`/`remote_receiver`. Both are local-repo backed.

### Text insertion

Two methods controlled by `insertionMethod`: `paste` (clipboard-based, default) and `simulate_type` (simulated keystrokes via Rust platform layer). The typing speed for `simulate_type` is set by `typingSpeedMs`.

### Composer (review before insert)

When `reviewBeforeInsert` is enabled, the editable composer opens after transcription and LLM cleanup, before text is inserted. The user can edit the result, then confirm or cancel.

---

## 6. Personal-use / local mode

### Build flavors (`src/utils/env.utils.ts`)

`VITE_FLAVOR` selects a build flavor: `emulators` (default in dev), `dev`, `prod`, and the legacy `enterprise` / `enterprise-dev` values. The enterprise flavors are not wired to any backend in this build; use `emulators` / `dev` / `prod`.

### Local sign-in (`PersonalAuthRepo`)

In personal mode `getAuthRepo()` returns `PersonalAuthRepo`, which signs you in as a hardcoded local user (`local-user-id` / `personal@mausvoice.local`) with no Firebase account.

### Personal API-key defaults (`src/actions/personal-use.actions.ts`)

Keys are entered by the user in the onboarding "Connect your API keys" step and the Settings dialogs. They are stored as encrypted `personal-deepgram` / `personal-groq` API keys. No key ships inside a distributed binary. At rest, keys are sealed with XChaCha20-Poly1305 in `system/crypto.rs`.

`configurePersonalDefaults()` runs on app load, reads the stored keys, and selects providers via `resolvePersonalTranscriptionTarget()` (prefer Deepgram, else Groq). It never overrides an explicit user choice.

### `debug-assist` feature gate

The `debug-assist` Cargo feature in `src-tauri/Cargo.toml` compiles Tauri's `devtools` capability. Local dev and CI opt in with `--features debug-assist`. Stable release builds omit it. The runtime `MAUSVOICE_ENABLE_DEVTOOLS` env var only takes effect when the feature is compiled in.

---

## 7. Onboarding and routing

### Top-level routing (`src/router.tsx` + Guard.tsx)

Routing is modeled as a small directed graph of nodes (`welcome`, `onboarding`, `routing`, `dashboard`, `notFound`). Edges have conditions over app state. Dashboard sub-routes: home, settings, transcriptions, dictionary, styling, chats, apps.

### Onboarding steps (`src/components/onboarding/`)

The ordered page keys (`src/state/onboarding.state.ts`):

```
signIn -> personalCredentials -> chooseTranscription -> chooseLlm -> userDetails
-> referralSource -> micPerms -> a11yPerms -> keybindings -> micCheck
-> unlockedPro -> tutorial
```

In personal mode the sign-in step auto-advances (local user) and routes to `personalCredentials` (the Deepgram + Groq key entry), then straight to `userDetails`, skipping `chooseTranscription`/`chooseLlm`.

---

## 8. What was removed (Cloud / Enterprise)

The hosted mausVoice Cloud backend and enterprise self-hosted path were removed in 0.1.6:

- `packages/functions`, `packages/pricing`, and the `enterprise/` apps are gone.
- There is no `invokeEnterprise()` / `src/utils/enterprise.utils.ts` or `getIsEnterpriseEnabled()`.
- Migrations `071_remove_cloud_modes` rewrites stored `cloud` modes to `local`/`none`, and `072_drop_is_enterprise` drops the enterprise preference column.

A few traces remain intentionally: the `Flavor` type still lists `enterprise`/`enterprise-dev`, `packages/firemix` ships Firebase path helpers, and some npm dependencies (Stripe, Mixpanel, Firebase) are still in the desktop manifest. They are not wired to an account, billing, or gateway.

---

## 9. Where to look first

| If you want to... | Start here |
|---|---|
| Understand a user action end-to-end | `src/actions/` then the relevant `src/repos/*.ts` then `src-tauri/src/commands.rs` |
| Add a native capability | `commands.rs` + register in `app.rs`, then a repo + action |
| Change the DB schema | New `src-tauri/src/db/migrations/NNN_*.sql`, register in `db/mod.rs` |
| Adjust personal/local behavior | `src/utils/personal-use.utils.ts`, `src/actions/personal-use.actions.ts`, `src/repos/auth.repo.ts` |
| Tweak transcription engines | `src/sessions/`, `src/repos/transcribe-audio.repo.ts`, `packages/rust_transcription` |
| Work on the overlay | `src-tauri/src/pill_process.rs`, `packages/rust_macos_pill` / `rust_windows_pill` / `rust_gtk_pill` |
| Add a provider | `packages/voice-ai/src/`, `packages/types/src/apiKey.types.ts`, CSP in `tauri.conf.json` |
| Add an agent tool | Implement `BaseTool`, register in `TOOL_REGISTRY` in `src/tools/index.ts` |
