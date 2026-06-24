# Voquill Architecture Walkthrough

A practical tour of how this repo is put together: the technology stack, the monorepo layout, the desktop app's layered design, the feature subsystems, and the customizations that make this fork a personal/local build.

> This describes the **personal local build**. Where upstream behavior differs (cloud accounts, billing, enterprise SSO), it is called out as "mostly unused here."

---

## 1. The big picture

Voquill is a cross-platform **voice-typing desktop app**. You hold a hotkey, speak, and the spoken text is transcribed, optionally cleaned up by an LLM, and pasted into whatever application you're using. It also has an AI assistant ("agent") mode that can take actions on your behalf.

The desktop app is a **Tauri 2** application: a Rust backend that exposes native capabilities, and a React/TypeScript frontend that holds all the product logic. The guiding principle is:

> **"Rust is the API, TypeScript is the Brain."**
> All business logic and decision-making live in TypeScript. Rust provides pure capabilities (record audio, run Whisper, read accessibility info, paste text, talk to SQLite) and makes no product decisions.

This is documented upstream in [`docs/desktop-architecture.md`](desktop-architecture.md); this file expands on it and folds in the personal-build specifics.

---

## 2. Technology stack

### Frontend (`apps/desktop/src`)

| Area | Choice |
| --- | --- |
| UI framework | React 19 |
| Routing | React Router 6 |
| State | Zustand 4 + Immer (single store) |
| Components / styling | MUI 7 (Material UI) + Emotion |
| Animation | Framer Motion |
| i18n | react-intl (auto-generated message IDs; always use `<FormattedMessage defaultMessage="..." />`) |
| Reactivity | RxJS for event/audio streams |
| Validation | Zod |
| Build | Vite 7 |
| Desktop bridge | `@tauri-apps/api` + Tauri plugins (sql, log, autostart, updater, http, process, os) |

### Backend (`apps/desktop/src-tauri`)

| Area | Choice |
| --- | --- |
| Framework | Tauri 2 |
| Async runtime | Tokio |
| Database | SQLite via `sqlx` |
| HTTP | `reqwest` |
| Audio capture / playback | `cpal` / `rodio`, `hound` for WAV |
| Global hotkeys | `rdev` |
| GPU (local Whisper accel) | `wgpu` (Metal on macOS, Vulkan/DirectX on Windows) |
| Serialization | `serde` / `serde_json` |

### Shared AI clients (`packages/voice-ai`, `packages/agent`)

Multi-provider clients: `groq-sdk`, `openai`, `@anthropic-ai/sdk`, `@google/genai`, `@azure/openai`, plus Azure Speech. The agent loop in `packages/agent` is provider-agnostic and drives tool use.

### Build system

Turborepo + pnpm workspaces. From the repo root: `pnpm run build | lint | check-types | test` (each fans out across workspaces via `turbo`).

---

## 3. Monorepo layout

```
apps/
  desktop/             # THE app — Tauri (Rust) + React/TS frontend
  docs/                # documentation site
  windows-installer/   # Windows MSI installer build
packages/
  types/               # shared TS domain models (User, Transcription, ApiKey, Tone, ...)
  functions/           # Firebase callable-function signatures + helpers (cloud; mostly unused here)
  voice-ai/            # audio chunking + multi-provider LLM/transcription clients
  agent/               # provider-agnostic agentic loop with tool support
  utilities/           # date/async/error helpers
  desktop-utils/       # platform detection + desktop helpers
  desktop-native-apis/ # generated bindings to Tauri commands
  pricing/             # pricing-plan definitions (cloud; unused here)
  firemix/             # Firebase helpers (cloud; unused here)
  rust_transcription/  # local Whisper sidecar (CPU/GPU REST server)
  rust_macos_pill/     # macOS dictation overlay process
  rust_windows_pill/   # Windows dictation overlay process
  eslint-config/, typescript-config/  # shared tooling configs
enterprise/
  gateway/             # Express API gateway (enterprise; unused here)
  admin/               # enterprise admin dashboard (unused here)
cli/                   # Rust CLI tool
config/, release/, scripts/, docs/
```

**Removed in this fork:** `mobile/` (Flutter app), `packages/flutter_video_looper`, and Linux desktop support (`src-tauri/src/platform/linux`, `packages/rust_gtk_pill`, Linux CI/packaging).

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
Repos        (src/repos/*.ts)          data access: local vs cloud vs enterprise
      │
      ▼
Tauri cmds   (src-tauri/src/commands.rs)  native capability surface
      │
      ▼
SQLite  /  Whisper sidecar  /  external APIs
```

State changes are written back into the Zustand store, and React re-renders. Rust never decides *what* to do — it only does what TypeScript asks.

### 4.2 State management — `src/store/` and `src/state/`

There is a **single Zustand store** (`src/store/index.ts`) created with `persist` (the `local` slice is persisted to `localStorage` under `voquill-local-state`). State is organized as slices in `src/state/` (`app.state.ts`, `onboarding.state.ts`, `agent.state.ts`, `settings.state.ts`, transcriptions, etc.). Mutations go through an Immer-style `produceAppState(draft => ...)` helper so updates stay immutable and ergonomic.

### 4.3 Actions — `src/actions/`

Actions are the orchestration layer. They call repos, mutate the store via `produceAppState`, and trigger side effects (network, analytics, file IO). Examples:

- `transcribe.actions.ts` — recording + transcription pipeline
- `personal-use.actions.ts` — personal Groq key setup and default preferences (fork-specific)
- `login.actions.ts`, `onboarding.actions.ts` — auth and onboarding progression
- `chat.actions.ts` — assistant/agent conversations
- `tone.actions.ts`, `dictionary.actions.ts` — writing styles and glossary

### 4.4 Repos — `src/repos/`

Repos abstract *where* data lives. Each family has an abstract base plus implementations, and a selector function picks the implementation at runtime:

```ts
export const getAuthRepo = (): BaseAuthRepo => {
  if (isPersonalUse()) return new PersonalAuthRepo();
  return isEnterprise() ? new EnterpriseAuthRepo() : new CloudAuthRepo();
};
```

The selection guards live at the top of `src/repos/index.ts`:

```ts
const isEnterprise   = () => getIsEnterpriseEnabled();
const isPersonalUse  = () => isPersonalUseEnabled();   // shared guard (see §6)
```

Main repo families (base / local / cloud / enterprise as applicable):

| Family | Local | Cloud / Enterprise | Stores / talks to |
| --- | --- | --- | --- |
| Auth | `PersonalAuthRepo` | Cloud / Enterprise | local stub vs Firebase/SSO |
| User | `LocalUserRepo` | Cloud / Enterprise | profile, stats |
| Transcription (records) | `LocalTranscriptionRepo` | — | SQLite history |
| Transcribe audio (engine) | `Local` (Whisper sidecar) | Groq / OpenAI / Azure / ... | sidecar vs provider API |
| Generate text (LLM) | — | Cloud / Enterprise / API key | post-processing + agent |
| Preferences | `LocalUserPreferencesRepo` | — | SQLite |
| Tone (writing styles) | `LocalToneRepo` | Cloud / Enterprise | SQLite / sync |
| Term (dictionary) | `LocalTermRepo` | Cloud / Enterprise | SQLite / sync |
| ApiKey | `LocalApiKeyRepo` | — | encrypted SQLite |
| Hotkey | `LocalHotkeyRepo` | — | SQLite |
| ChatMessage | `LocalChatMessageRepo` | — | SQLite |

At the Tauri boundary, repos convert with `toLocalXxx()` / `fromLocalXxx()` helpers (see `repos/preferences.repo.ts` for a clear example).

In this personal build the **Local/Personal** implementations are what run; Cloud and Enterprise repos exist but are not reached.

### 4.5 Rust side — `src-tauri/src/`

| File / dir | Responsibility |
| --- | --- |
| `main.rs` / `lib.rs` | entry point, library exports |
| `app.rs` | Tauri builder: plugins (sql, log, autostart, updater, single-instance), window setup, **`invoke_handler` command registration** |
| `commands.rs` | all `#[tauri::command]` functions — the TS↔Rust API (recording, DB CRUD, API-key encryption, accessibility dumps, paste, model/GPU ops, Groq key reading) |
| `db/mod.rs` | SQLite pool + migration runner |
| `db/migrations/NNN_*.sql` | sequential schema migrations, run on startup; new ones are added here and registered in `db/mod.rs` |
| `db/*_queries.rs` | per-domain SQL helpers |
| `domain/` | Rust structs mirroring the TS domain models |
| `platform/` | OS-specific code: `macos/` (AXUIElement a11y, keyboard, Core Audio), `windows/` (UIAutomation, Win32 hooks, WASAPI); cross-platform `audio.rs`, `keyboard.rs`, `app_info.rs` |
| `system/` | services: `crypto.rs` (API-key encryption), `gpu.rs`, `models.rs` (Whisper model download), OAuth/OIDC, `tray.rs`, remote sender/receiver, audio feedback |
| `pill_process.rs` / `overlay.rs` | spawn and talk to the overlay "pill" subprocess over stdio |

**Adding a new native capability** (per repo conventions): define the command in `commands.rs`, register it in `app.rs`'s `invoke_handler`, wrap it in a repo, and call it from an action.

---

## 5. Feature subsystems

### Transcription
Two paths, selected by user preferences:
- **Local Whisper** — the `rust_transcription` sidecar runs a small REST server (CPU and GPU builds) that the desktop app drives via a transcription *session* (`src/sessions/`). Models (tiny…large, turbo) are downloaded on demand; GPU acceleration uses Metal/Vulkan/DirectX.
- **Cloud / API providers** — Groq, OpenAI, Azure, Deepgram, ElevenLabs, AssemblyAI, etc., each with a session in `src/sessions/`. The **personal build defaults to Groq** (`whisper-large-v3-turbo`) using your key.

The personal dictionary is injected as the Whisper `initialPrompt` to bias recognition toward your terms.

### Post-processing (AI cleanup)
After transcription, text can be cleaned up (remove filler, fix formatting) by an LLM through a Generate-Text repo. The active **writing style/tone** becomes the system prompt. Personal build default: Groq `openai/gpt-oss-20b`.

### Dictation overlay ("pill")
A separate native process renders the floating recording indicator: `rust_macos_pill` (macOS) and `rust_windows_pill` (Windows). The desktop app spawns it (`pill_process.rs`) and streams overlay-phase events over stdio.

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
`VITE_FLAVOR` selects a build flavor: `emulators` (default in dev), `dev`, `prod`, `enterprise`, `enterprise-dev`. `isEnterpriseFlavor()` is true only for the two enterprise flavors and is a reliable **build-time** signal (unlike the runtime enterprise target, which loads asynchronously).

### The shared guard — `src/utils/personal-use.utils.ts`
`isPersonalUseProEnabled()` returns `true` in this fork (that is the paywall/Pro-gating removal). The canonical guard combines it with both enterprise signals:

```ts
export const isPersonalUseEnabled = (): boolean =>
  isPersonalUseProEnabled() &&
  !isEnterpriseFlavor() &&     // build-time: never personal in enterprise builds
  !getIsEnterpriseEnabled();   // runtime: never personal once an enterprise target loads
```

**Every personal-flow decision point routes through this single guard:** repo selection (`repos/index.ts`), onboarding sign-in routing (`SignInForm.tsx`), Google sign-in (`login.actions.ts`), the mic-permission gate (`MicPermsForm.tsx`), and the Groq defaults action. This keeps "am I in personal mode?" answered in exactly one place.

### Local sign-in — `PersonalAuthRepo` (`src/repos/auth.repo.ts`)
In personal mode `getAuthRepo()` returns `PersonalAuthRepo`, which signs you in as a hardcoded local user (`local-user-id` / `personal@voquill.local`) with no Firebase account. The rest of the app sees a normal "logged in" user.

### Groq defaults — `src/actions/personal-use.actions.ts`
- The Groq key is read **only from runtime sources** — env vars or a runtime `.env.local` — via the Rust command `read_personal_groq_api_key` (`commands.rs`). It is never embedded in the build (no `option_env!` fallback), so no key ships inside a distributed binary.
- `savePersonalGroqApiKey()` (explicit user action in onboarding/Settings) upserts an encrypted `personal-groq` API key and points transcription, post-processing, and agent modes at it.
- `configurePersonalGroqDefaults()` runs on app load. It is guarded by `isPersonalUseEnabled()` and only **fills missing/legacy** preferences — it never overrides an explicit local/cloud/other-key choice the user already made.

Net effect: on first run with a Groq key present, the app auto-configures `whisper-large-v3-turbo` for transcription and `openai/gpt-oss-20b` for post-processing, all against your personal key — while still letting you switch to fully-local Whisper or another provider afterward.

---

## 7. Onboarding & routing

### Top-level routing — `src/router.tsx` + `src/components/routing/Guard.tsx`
Routing is modeled as a small directed graph of nodes (`welcome`, `onboarding`, `routing`, `dashboard`, `notFound`). Edges have conditions over app state (`isLoggedIn`, `isOnboarded`, `isEnterpriseFlavor`) and the guard walks to the first matching destination. Dashboard sub-routes: home, settings, transcriptions, dictionary, styling, chats, apps.

### Onboarding steps — `src/components/onboarding/`
The ordered page keys (`src/state/onboarding.state.ts`):

```
signIn → groqApiKey → chooseTranscription → chooseLlm → userDetails
→ referralSource → micPerms → a11yPerms → keybindings → micCheck
→ unlockedPro → tutorial
```

In personal mode the sign-in step auto-advances (local user), and `didSignUpWithAccount` is **not** set, so the flow routes through the Groq-key setup and skips the cloud "Pro trial" path (`unlockedPro` → `setAllModesToCloud`) that would otherwise overwrite your local/Groq choices. In enterprise builds the same screens route to `userDetails`/`routing` instead.

---

## 8. Cloud & enterprise pieces (mostly unused here)

The repo still contains the upstream backend integration points:
- `packages/functions` — Firebase callable-function signatures; cloud repos call these.
- `enterprise/gateway` — an Express API gateway; the desktop talks to it via `invokeEnterprise()` (`src/utils/enterprise.utils.ts`) when an enterprise target is configured.
- `packages/pricing`, `packages/firemix`, Stripe/Mixpanel deps — billing and analytics.

In the personal local build none of these are reached: the guard keeps you on Local/Personal repos, and there is no account, billing, or gateway in the path.

---

## 9. Where to look first

| If you want to… | Start here |
| --- | --- |
| Understand a user action end-to-end | `src/actions/` → the relevant `src/repos/*.ts` → `src-tauri/src/commands.rs` |
| Add a native capability | `commands.rs` + register in `app.rs`, then a repo + action |
| Change the DB schema | new `src-tauri/src/db/migrations/NNN_*.sql`, register in `db/mod.rs` |
| Adjust personal/local behavior | `src/utils/personal-use.utils.ts`, `src/actions/personal-use.actions.ts`, `src/repos/auth.repo.ts` |
| Tweak transcription engines | `src/sessions/`, `src/repos/transcribe-audio.repo.ts`, `packages/rust_transcription` |
| Work on the overlay | `src-tauri/src/pill_process.rs`, `packages/rust_macos_pill` / `rust_windows_pill` |

For upstream design notes see [`docs/desktop-architecture.md`](desktop-architecture.md) and [`docs/getting-started.md`](getting-started.md).
