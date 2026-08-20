# mausVoice Architecture Walkthrough

> Authoritative, maintained pages: [`apps/docs` Desktop architecture](../apps/docs/src/content/docs/development/architecture.md) and https://maus-inc.github.io/mausVoice/docs/development/architecture/. Prefer those if this historical walkthrough disagrees.

A practical tour of how this repo is put together: the technology stack, the monorepo layout, the desktop app's layered design, the feature subsystems, and the personal/local build.

> As of 0.1.6 this is a **local, personal build**. The hosted mausVoice Cloud backend, billing, and enterprise SSO/gateway were removed (migrations `071_remove_cloud_modes` / `072_drop_is_enterprise`). There are no cloud or enterprise repos, gateways, or `enterprise/` directories in the tree — every repo factory resolves to a local implementation.

---

## 1. The big picture

mausVoice is a cross-platform **voice-typing desktop app**. You hold a hotkey, speak, and the spoken text is transcribed, optionally cleaned up by an LLM, and pasted into whatever application you're using. It also has an AI assistant ("agent") mode that can take actions on your behalf.

The desktop app is a **Tauri 2** application: a Rust backend that exposes native capabilities, and a React/TypeScript frontend that holds all the product logic. The guiding principle is:

> **"Rust is the API, TypeScript is the Brain."**
> All business logic and decision-making live in TypeScript. Rust provides pure capabilities (record audio, run Whisper, read accessibility info, paste text, talk to SQLite) and makes no product decisions.

This is documented upstream in [`docs/desktop-architecture.md`](desktop-architecture.md); this file expands on it and folds in the personal-build specifics.

---

## 2. Technology stack

### Frontend (`apps/desktop/src`)

| Area                 | Choice                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| UI framework         | React 19                                                                                        |
| Routing              | React Router 6                                                                                  |
| State                | Zustand 4 + Immer (single store)                                                                |
| Components / styling | MUI 7 (Material UI) + Emotion                                                                   |
| Animation            | Framer Motion                                                                                   |
| i18n                 | react-intl (auto-generated message IDs; always use `<FormattedMessage defaultMessage="..." />`) |
| Reactivity           | RxJS for event/audio streams                                                                    |
| Validation           | Zod                                                                                             |
| Build                | Vite 7                                                                                          |
| Desktop bridge       | `@tauri-apps/api` + Tauri plugins (sql, log, autostart, updater, http, process, os)             |

### Backend (`apps/desktop/src-tauri`)

| Area                      | Choice                                             |
| ------------------------- | -------------------------------------------------- |
| Framework                 | Tauri 2                                            |
| Async runtime             | Tokio                                              |
| Database                  | SQLite via `sqlx`                                  |
| HTTP                      | `reqwest`                                          |
| Audio capture / playback  | `cpal` / `rodio`, `hound` for WAV                  |
| Global hotkeys            | `rdev`                                             |
| GPU (local Whisper accel) | `wgpu` (Metal on macOS, Vulkan/DirectX on Windows) |
| Serialization             | `serde` / `serde_json`                             |

### Shared AI clients (`packages/voice-ai`, `packages/agent`)

Multi-provider clients: `groq-sdk`, `openai`, `@anthropic-ai/sdk`, `@google/genai`, `@gladiaio/sdk`, `@azure/openai`, plus Azure Speech. The agent loop in `packages/agent` is provider-agnostic and drives tool use.

### Build system

Turborepo + pnpm workspaces. From the repo root: `pnpm run build | lint | check-types | test` (each fans out across workspaces via `turbo`).

---

## 3. Monorepo layout

```
apps/
  desktop/             # THE app — Tauri (Rust) + React/TS frontend
  docs/                # Astro + Starlight documentation site (authoritative docs)
  windows-installer/   # Windows MSI/NSIS installer build
packages/
  types/               # shared TS domain models (User, Transcription, ApiKey, Tone, ...)
  voice-ai/            # audio chunking + multi-provider LLM/transcription clients
  agent/               # provider-agnostic agentic loop with tool support
  utilities/           # date/async/error helpers
  desktop-utils/       # platform detection + desktop helpers
  desktop-native-apis/ # Specta-generated bindings to Tauri commands
  firemix/             # Firebase path helpers (peer dep; no apps/firebase service here)
  rust_transcription/  # local transcription sidecar (whisper.cpp GGML + ONNX Parakeet/Canary; CPU/GPU HTTP server)
  rust_macos_pill/     # macOS dictation overlay (linked in-process)
  rust_windows_pill/   # Windows dictation overlay (subprocess)
  rust_gtk_pill/       # Linux dictation overlay (subprocess, GTK/layer-shell)
  rust_pill_shared/    # shared geometry/ring math for the pills
  shared-fonts/        # Satoshi and TAN Paradiso font assets
  eslint-config/, typescript-config/  # shared tooling configs
config/, release/, scripts/, docs/
```

The `mobile/` Flutter app, `packages/flutter_video_looper`, the Rust CLI (`cli/`), the hosted `packages/functions`/`packages/pricing`, and the `enterprise/` gateway/admin apps were all removed in earlier work. Linux desktop support is retained (`src-tauri/src/platform/linux`, `packages/rust_gtk_pill`, Linux CI/packaging). The Astro site under `apps/docs/` is the maintained documentation; the files at the repo-root `docs/` are looser notes and historical specs.

---

## 4. Desktop app architecture

### 4.1 The data flow

Every user or native event flows through the same layered path:

```
User / Native event
      │
      ▼
Actions      (src/actions/*.ts)        orchestration: what should happen
      │
      ▼
Repos        (src/repos/*.ts)          data access: local SQLite and AI providers
      │
      ▼
Tauri cmds   (src-tauri/src/commands.rs)  native capability surface
      │
      ▼
SQLite  /  rust_transcription sidecar  /  external AI APIs
```

State changes are written back into the Zustand store, and React re-renders. Rust never decides _what_ to do — it only does what TypeScript asks.

### 4.2 State management — `src/store/` and `src/state/`

There is a **single Zustand store** (`src/store/index.ts`) created with `persist` (the `local` slice is persisted to `localStorage` under `mausvoice-local-state`). State is organized as slices in `src/state/` (`app.state.ts`, `onboarding.state.ts`, `agent.state.ts`, `settings.state.ts`, transcriptions, etc.). Mutations go through an Immer-style `produceAppState(draft => ...)` helper so updates stay immutable and ergonomic.

### 4.3 Actions — `src/actions/`

Actions are the orchestration layer. They call repos, mutate the store via `produceAppState`, and trigger side effects (network, analytics, file IO). Examples:

- `transcribe.actions.ts` — recording + transcription pipeline
- `personal-use.actions.ts` — personal API key setup (Deepgram + Groq) and default preferences (fork-specific)
- `login.actions.ts`, `onboarding.actions.ts` — auth and onboarding progression
- `chat.actions.ts` — assistant/agent conversations
- `tone.actions.ts`, `dictionary.actions.ts` — writing styles and glossary

### 4.4 Repos — `src/repos/`

Repos abstract _where_ data lives. Each family has an abstract base plus a local implementation, and the factory in `src/repos/index.ts` resolves directly to it:

```ts
export const getAuthRepo = (): BaseAuthRepo => {
  return new PersonalAuthRepo();
};

export const getUserRepo = (): BaseUserRepo => {
  return new LocalUserRepo();
};
```

There are no cloud or enterprise repos in this build — `getAuthRepo`, `getUserRepo`, `getUserPreferencesRepo`, `getTranscriptionRepo`, and the rest all return their local implementations. (The flavor type still lists `enterprise` / `enterprise-dev` as legacy values, but there is no `isEnterpriseFlavor()` helper, no `getIsEnterpriseEnabled()`, and no `src/utils/enterprise.utils.ts`.)

Main repo families:

| Family                     | Implementation                                                   | Stores / talks to            |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------- |
| Auth                       | `PersonalAuthRepo`                                               | hardcoded local user         |
| User / Member              | `LocalUserRepo` / `LocalMemberRepo`                              | profile, stats               |
| Transcription (records)    | `LocalTranscriptionRepo`                                         | SQLite history               |
| Transcribe audio (engine)  | `LocalTranscribeAudioRepo`                                       | `rust_transcription` sidecar |
| API transcription          | Groq / Deepgram / OpenAI / Azure / AssemblyAI / ElevenLabs / ... | provider API                 |
| Generate text (LLM)        | Groq / OpenAI / Claude / Gemini / OpenRouter / Ollama / ...      | post-processing + agent      |
| Preferences                | `LocalUserPreferencesRepo`                                       | SQLite                       |
| Tone (writing styles)      | `LocalToneRepo`                                                  | SQLite                       |
| Term (dictionary)          | `LocalTermRepo`                                                  | SQLite                       |
| ApiKey                     | `LocalApiKeyRepo`                                                | encrypted SQLite             |
| Hotkey / AppTarget         | `LocalHotkeyRepo` / `LocalAppTargetRepo`                         | SQLite                       |
| Conversation / ChatMessage | `LocalConversationRepo` / `LocalChatMessageRepo`                 | SQLite                       |
| Paired remote device       | `LocalPairedRemoteDeviceRepo`                                    | SQLite                       |

At the Tauri boundary, repos convert with `toLocalXxx()` / `fromLocalXxx()` helpers (see `repos/preferences.repo.ts` for a clear example). Every factory in this build returns the **Local/Personal** implementation.

### 4.5 Rust side — `src-tauri/src/`

| File / dir                       | Responsibility                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.rs` / `lib.rs`             | entry point, library exports                                                                                                                                                                   |
| `app.rs`                         | Tauri builder: plugins (sql, log, autostart, updater, single-instance), window setup, **`invoke_handler` command registration**                                                                |
| `commands.rs`                    | all `#[tauri::command]` functions — the TS↔Rust API (recording, DB CRUD, API-key encryption, accessibility dumps, paste, model/GPU ops)                                                        |
| `db/mod.rs`                      | SQLite pool + migration runner                                                                                                                                                                 |
| `db/migrations/NNN_*.sql`        | sequential schema migrations, run on startup; new ones are added here and registered in `db/mod.rs`                                                                                            |
| `db/*_queries.rs`                | per-domain SQL helpers                                                                                                                                                                         |
| `domain/`                        | Rust structs mirroring the TS domain models                                                                                                                                                    |
| `platform/`                      | OS-specific code: `macos/` (AXUIElement a11y, keyboard, Core Audio), `windows/` (UIAutomation, Win32 hooks, WASAPI); cross-platform `audio.rs`, `keyboard.rs`, `app_info.rs`                   |
| `system/`                        | services: `crypto.rs` (API-key encryption), `gpu.rs`, `models.rs`/`paths.rs` (Whisper model paths and on-demand download), machine identity, `tray.rs`, remote sender/receiver, audio feedback |
| `pill_process.rs` / `overlay.rs` | spawn and talk to the overlay "pill" subprocess over stdio                                                                                                                                     |

**Adding a new native capability** (per repo conventions): define the command in `commands.rs`, register it in `app.rs`'s `invoke_handler`, wrap it in a repo, and call it from an action.

---

## 5. Feature subsystems

### Transcription

Two paths, selected by user preferences:

- **Local transcription** — the `rust_transcription` sidecar runs a small HTTP server (CPU and GPU builds) that the desktop app drives via a transcription _session_ (`src/sessions/`). It supports the whisper.cpp GGML models (tiny, base, small, medium, large-v3, large-v3-turbo) plus ONNX Parakeet 0.6B (CTC/TDT) and Canary 1B. Models are downloaded on demand into the app-data `transcription-models/` directory; GPU acceleration uses Metal/Vulkan via `wgpu`/`ort`.
- **Cloud / API providers** — Deepgram, Gladia, Groq, OpenAI, Azure, ElevenLabs, AssemblyAI, etc., routed through `src/sessions/` and `src/repos/transcribe-audio.repo.ts`. Gladia uses a live SDK session for microphone PCM and an upload/create/poll/delete flow for batch audio; both paths request provider-side deletion and preserve cleanup failures as warnings. The **personal build defaults to Deepgram** (`nova-3`), which **streams audio over a websocket during recording** so the transcript is ready almost as soon as you stop (`DeepgramTranscriptionSession`). If no Deepgram key is configured it falls back to Groq (`whisper-large-v3-turbo`, batch).

The personal dictionary is injected as a Whisper `initialPrompt` on compatible routes. Gladia maps canonical terms to custom vocabulary and source→destination replacements to custom spelling, then the shared deterministic replacement pass still runs locally.

**Streaming session lifecycle** — `rust_transcription`'s in-memory streaming-session registry evicts a session after **10 minutes** with no appended audio (`SESSION_IDLE_TTL`), so a client that connects but never finalizes can't accumulate buffered audio in RAM indefinitely. An independent background task sweeps the registry every **60 seconds** (`SWEEP_INTERVAL`) and removes anything past the TTL; appending samples to a session refreshes its activity timestamp and cancels the countdown.

### Post-processing (AI cleanup)

After transcription, text can be cleaned up (remove filler, fix formatting) by an LLM through a Generate-Text repo. The active **writing style/tone** becomes the system prompt. Personal build default: Groq `openai/gpt-oss-20b`.

### Dictation overlay ("pill")

A separate native implementation renders the floating recording indicator, one per platform: `rust_macos_pill` (macOS), `rust_windows_pill` (Windows), and `rust_gtk_pill` (Linux, GTK). macOS runs it embedded in-process over `mpsc` channels (`platform/macos/overlay.rs`); Windows and Linux spawn it as a subprocess and talk to it over stdio (`pill_process.rs`, `platform/linux/overlay.rs`). All three exchange the same `InMessage`/`OutMessage` IPC vocabulary.

**Monitor selection** follows one rule on all three platforms: while the user is actively dragging, the pill's owning monitor is whichever display the cursor is currently over; once parked (drag released), the pill stays anchored to the monitor that contains its saved footprint position and does not follow the cursor across screen edges. Windows falls back to `MonitorFromPoint`'s nearest-monitor behavior, macOS looks up the screen containing the saved anchor point, and GTK/X11 combines an X11 anchor with the exact drop-position persisted from the last drag; GTK's LayerShell backend only re-homes the surface to a different output on first placement or while a drag is active.

**Visible-footprint clamping** — the native window itself is a fixed, oversized transparent canvas (the pill is drawn somewhere inside it, not centered on it). Dragging and edge/monitor clamping operate on the pill's _visible footprint_ inside that canvas, not the canvas bounds, so the pill can be pushed flush against a real screen edge instead of stopping short (or overshooting) by the canvas margin. Non-dictation panel modes still clamp the whole window, since the panel content fills it.

**Reset / position IPC** — the pill IPC protocol carries `InMessage::ResetPosition` (desktop → pill: forget the saved position and re-center) and `OutMessage::PositionChanged { has_saved_position: bool }` (pill → desktop: report after a drag ends or a reset that a saved position now does/doesn't exist). The desktop relays `PositionChanged` as the `pill-position-changed` Tauri event, which the frontend uses to enable/disable the tray's **Reset Pill Position** menu item; selecting that item invokes the `reset_pill_position` command, which sends `ResetPosition` back down to the pill.

### Hotkeys

Global shortcuts registered through `LocalHotkeyRepo` → Rust `platform/keyboard.rs` (`rdev`), persisted in SQLite. Can be scoped per app target.

### Dictionary / glossary & writing styles

Terms and tones live in SQLite (`LocalTermRepo`, `LocalToneRepo`). Terms improve transcription accuracy; tones shape post-processing output.

### AI assistant / agent mode

A provider-agnostic agent loop (`packages/agent` + `src/agents/`) drives tool calls. Tools live in `src/tools/` (paste text, read accessibility info, run terminal command, end conversation). Conversations persist via `LocalChatMessageRepo`; state in `src/state/agent.state.ts`.

### App targets & remote output

**App targets** customize hotkey + insertion behavior per application. **Remote output** lets a paired device receive dictation (Rust `remote_sender`/`remote_receiver`). Both are local-repo backed.

---

## 6. Personal-use / local mode (this fork's core customization)

### Build flavors — `src/utils/env.utils.ts`

`VITE_FLAVOR` selects a build flavor: `emulators` (default in dev), `dev`, `prod`, and the legacy `enterprise` / `enterprise-dev` values. The enterprise flavors are not wired to any backend in this build; use the `emulators` / `dev` / `prod` flavors.

### The shared guard — `src/utils/personal-use.utils.ts`

`isPersonalUseProEnabled()` returns `true` in this build (the paywall/Pro gating is removed), and the guard is intentionally simple:

```ts
export const isPersonalUseEnabled = (): boolean => isPersonalUseProEnabled();
```

There is no enterprise flavor/runtime signal to combine here anymore. `isPersonalUseEnabled()` is the single guard used by the personal-flow decision points — onboarding sign-in routing (`components/onboarding/SignInForm.tsx`), the mic-permission gate (`MicPermsForm.tsx`), and the Groq/Deepgram defaults action. Repo factories don't consult it; they always return the local implementations.

### Local sign-in — `PersonalAuthRepo` (`src/repos/auth.repo.ts`)

In personal mode `getAuthRepo()` returns `PersonalAuthRepo`, which signs you in as a hardcoded local user (`local-user-id` / `personal@mausvoice.local`) with no Firebase account. The rest of the app sees a normal "logged in" user.

### Personal API-key defaults — `src/actions/personal-use.actions.ts`

- Keys are **entered by the user** — the onboarding "Connect your API keys" step (`PersonalCredentialsForm`) and the Settings dialogs collect a Deepgram key (transcription) and a Groq key (post-processing/agent). They are stored as encrypted `personal-deepgram` / `personal-groq` API keys. There is **no** environment/`.env.local` key reading and nothing is baked into the build, so no key ships inside a distributed binary. (At rest, keys are sealed with XChaCha20-Poly1305 in `system/crypto.rs`.)
- `savePersonalDeepgramApiKey()` upserts the Deepgram key and points **transcription** at it; `savePersonalGroqApiKey()` upserts the Groq key and points **post-processing + agent** at it.
- `configurePersonalDefaults()` runs on app load, guarded by `isPersonalUseEnabled()`. It reads only the already-stored keys and applies the selection via the pure `resolvePersonalTranscriptionTarget()` (prefer Deepgram, else Groq) — it never overrides an explicit local/cloud/other-key choice the user already made.

Net effect: after you enter your keys, transcription uses Deepgram `nova-3` (streaming) and post-processing uses Groq `openai/gpt-oss-20b` — while still letting you switch to fully-local Whisper or another provider afterward. Keys are rotatable in Settings without a rebuild.

---

## 7. Onboarding & routing

### Top-level routing — `src/router.tsx` + `src/components/routing/Guard.tsx`

Routing is modeled as a small directed graph of nodes (`welcome`, `onboarding`, `routing`, `dashboard`, `notFound`). Edges have conditions over app state (`isLoggedIn`, `isOnboarded`) and the guard walks to the first matching destination. Dashboard sub-routes: home, settings, transcriptions, dictionary, styling, chats, apps.

### Onboarding steps — `src/components/onboarding/`

The ordered page keys (`src/state/onboarding.state.ts`):

```
signIn → personalCredentials → chooseTranscription → chooseLlm → userDetails
→ referralSource → micPerms → a11yPerms → keybindings → micCheck
→ unlockedPro → tutorial
```

In personal mode the sign-in step auto-advances (local user) and routes to `personalCredentials` (the Deepgram + Groq key entry), then straight to `userDetails` — skipping `chooseTranscription`/`chooseLlm`. `didSignUpWithAccount` is **not** set, so the flow also skips the cloud "Pro trial" path (`unlockedPro`) that would otherwise overwrite your local/API-key choices.

---

## 8. What was removed (Cloud / Enterprise)

The hosted mausVoice Cloud backend and enterprise self-hosted path were removed in 0.1.6:

- `packages/functions`, `packages/pricing`, and the `enterprise/gateway` / `enterprise/admin` apps are gone from the tree.
- There is no `invokeEnterprise()` / `src/utils/enterprise.utils.ts`, no `getIsEnterpriseEnabled()`, and no Cloud/Enterprise auth or user repos.
- Migrations `071_remove_cloud_modes` rewrites any stored `cloud` transcription/post-processing/agent modes to `local`/`none`, and `072_drop_is_enterprise` drops the enterprise preference column.

A few traces remain intentionally: the `Flavor` type still lists `enterprise`/`enterprise-dev`, `packages/firemix` ships Firebase path helpers with Firebase as a peer dependency, and some dependencies (Stripe, Mixpanel, Firebase) are still in the desktop manifest. They are not wired to an account, billing, or gateway in this build. The docs site's development pages describe the current, all-local layout.

---

## 9. Where to look first

| If you want to…                     | Start here                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| Understand a user action end-to-end | `src/actions/` → the relevant `src/repos/*.ts` → `src-tauri/src/commands.rs`                       |
| Add a native capability             | `commands.rs` + register in `app.rs`, then a repo + action                                         |
| Change the DB schema                | new `src-tauri/src/db/migrations/NNN_*.sql`, register in `db/mod.rs`                               |
| Adjust personal/local behavior      | `src/utils/personal-use.utils.ts`, `src/actions/personal-use.actions.ts`, `src/repos/auth.repo.ts` |
| Tweak transcription engines         | `src/sessions/`, `src/repos/transcribe-audio.repo.ts`, `packages/rust_transcription`               |
| Work on the overlay                 | `src-tauri/src/pill_process.rs`, `packages/rust_macos_pill` / `rust_windows_pill`                  |

For upstream design notes see [`docs/desktop-architecture.md`](desktop-architecture.md) and [`docs/getting-started.md`](getting-started.md).
