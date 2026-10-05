# Agent Mode in Beta: mausVoice PR #236 and Atlas Codebase Analysis

## Part 1: mausVoice Agent Mode in Beta (PR #236 — arena/0.1.6-consolidation)

### 1.1 Type Definition and Mode Values

`AgentMode` is defined in `packages/types/src/common.types.ts` as:

```typescript
export type AgentMode = PostProcessingMode | "openclaw";
// = "none" | "api" | "openclaw"
```

The `openclaw` variant exists in the type system but is not exposed in the current settings UI. The `AIAgentModeConfiguration` segmented control only renders `"api"` (API) and `"none"` (Off). OpenClaw remains available for future activation or for users whose preferences already store it.

### 1.2 Enabling Agent Mode

Agent mode requires two independent local flags:

1. `assistantModeEnabled` (`state.local.assistantModeEnabled`) — master on/off switch.
2. `powerModeEnabled` (`state.local.powerModeEnabled`) — enables terminal command execution. When toggled on, a warning dialog confirms the user understands the risk.

Both are stored in local state, not in user preferences. The settings dialog (`AIAgentModeDialog`) exposes:
- A "Beta" chip on the dialog title.
- Assistant mode toggle with copy: "Assistant mode is disabled by default. This is a new experimental feature."
- Power mode toggle with copy: "Allow the assistant to run terminal commands on your behalf. This is a temporary guardrail that will be removed in a future update. Restart mausVoice to apply changes."
- A power mode warning dialog explaining full responsibility and experimental status.

### 1.3 Activation Flow

When the user presses the agent dictation hotkey (`AGENT_DICTATE_HOTKEY`):

1. `AgentStrategy.onBeforeStart()` creates a new conversation via `createConversation()` with title "New conversation" and stores the ID in `pillConversationId`.
2. `AgentStrategy.handleTranscript()` receives the raw transcript.
3. If `userPrefs.hallucinationFilterEnabled !== false`, the transcript passes through `filterKnownSilenceHallucinations(rawTranscript, language)`. This strips known silence hallucinations like `[blank_audio]`, `[silence]`, `(silence)`, `thank you for watching`, `thanks for watching`, and Amara/subtitle credits. Non-English audio is excluded from phrase filtering.
4. If the sanitized transcript is empty after filtering, the strategy returns `shouldContinue: false` and skips the LLM call.
5. Otherwise, `sendChatMessage(conversationId, sanitizedTranscript)` creates a user chat message and calls `runAgentForConversation(conversationId)`.

### 1.4 Agent Loop Architecture (`packages/agent`)

The `@repo/agent` package provides the generic agent loop:

- `AgentLoop` class takes an `AgentConfig` (provider, tools, systemPrompt, maxIterations).
- `run(messages)` is an async generator yielding `AgentEvent` values.
- Each iteration:
  1. Yields `iteration-start`.
  2. Builds `LlmChatInput` with system prompt + message history + tool definitions.
  3. Streams LLM response, yielding `text-delta` events.
  4. Collects `tool-call` events.
  5. If tool calls exist, processes them sequentially via `processToolCalls()`:
     - Yields `tool-call-start` for each call.
     - Executes the tool with `params` and `reason`.
     - Yields `tool-call-result` with success/failure.
     - Pushes result into history as `role: "tool"`.
  6. If no tool calls, yields `finish` with reason `"stop"`.
  7. If max iterations reached, yields `finish` with reason `"max-iterations"`.
- Abortable via `loop.abort()`.

Tool schema augmentation: the loop injects a `reason` parameter into every tool's JSON schema, requiring the LLM to explain why it is calling the tool.

### 1.5 Desktop Agent Runner (`apps/desktop/src/agents/run-agent.ts`)

`runAgent()` adapts `AgentLoop` to the desktop app:

1. Creates `AgentRunState` via `createAgentRunState(agentType, maxIterations)`.
2. Builds LLM provider from `getAgentRepo().repo.streamChat()`.
3. Builds tool list via `createAgentTools(conversationId, config)`:
   - Filters tools by `config.getToolFilter(conversationId)`.
   - Wraps each tool in `AgentTool` with `execute()` that handles permissions.
4. Iterates the loop:
   - `iteration-start`: Creates an empty assistant message in state, initializes streaming message.
   - `text-delta`: Appends text to both the persisted message and streaming state.
   - `tool-call-start`: Records tool call in agent state and streaming state.
   - `tool-call-result`: Creates a system message with the result, updates tool status. If tool name is `end_conversation`, calls `loop.abort()`.
   - `finish`: Finalizes the assistant message via `finalizeAssistantMessage()`, which persists metadata including tool calls as `{ type: "reasoning", toolCalls }`.
5. `finalizeAssistantMessage()` saves the final message with content and metadata, clears streaming state.
6. Error handling: wraps all side effects in `safeSideEffect` / `logOnRejection` so a rejected chat-message persistence does not abort the loop.
7. Cleanup: removes streaming message, deletes loop from `activeLoops`.

`abortAgentLoop(conversationId)` calls `loop.abort()` and sets `agentState.aborted = true`.

### 1.6 Tool Permission System

`executeWithPermission(info, params, reason, conversationId)`:

1. Calls `tool.getAlwaysAllow(params)`. If true, executes immediately.
2. Otherwise, calls `requestToolPermission(info.id, params, conversationId)` to create a `ToolPermission` record with status `"pending"`.
3. Updates agent state: sets `permissionId` and `status: "awaiting-permission"`.
4. Polls `getToolPermissionStatus(permissionId)` every 500ms until `"allowed"` or `"denied"`.
5. On `"allowed"`: executes tool.
6. On `"denied"` or abort: returns `{ success: false, failureReason: "Tool call was denied by user" }`.

The permission timeout defaults to 60 seconds and is now configurable via `agentPermissionTimeoutMs` (5–600 seconds).

### 1.7 Tool Registry and Enablement

`tools/index.ts` defines a declarative `TOOL_REGISTRY`:

```typescript
const TOOL_REGISTRY: ReadonlyMap<string, ToolRegistryEntry> = new Map([
  ["paste", { id: "paste", scope: undefined, factory, getInfo }],
  ["get_accessibility_info", { id: "get_accessibility_info", scope: undefined, factory, getInfo }],
  ["end_conversation", { id: "end_conversation", scope: "pill", factory, getInfo }],
  ["run_terminal_command", { id: "run_terminal_command", scope: undefined, factory, getInfo }],
]);
```

Each entry has:
- `id`: tool identifier.
- `scope?`: `"pill"` limits the tool to pill/overlay conversations; `"chat"` limits it to the full chat interface.
- `factory`: creates the `BaseTool` instance.
- `getInfo()`: returns `ToolInfo | null`. For `run_terminal_command`, returns `null` when power mode is disabled, effectively hiding the tool.

`getToolRegistryEntry(toolId)` looks up the registry. `createTool(info)` delegates to the registry entry's factory.

The `getToolFilter` in `CHAT_AGENT_CONFIG` combines scope filtering with user enablement:

```typescript
getToolFilter: (conversationId) => {
  const isPill = getAppState().pillConversationId === conversationId;
  return (tool) => {
    const registryEntry = getToolRegistryEntry(tool.id);
    if (!registryEntry) return false;
    const scope = tool.scope ?? registryEntry.scope;
    const inScope = isPill ? scope !== "chat" : scope !== "pill";
    return inScope && getRegistryEnablement(tool.id);
  };
},
```

`getRegistryEnablement(toolId)`:
- `null` / `undefined` preferences → all tools enabled (registry default).
- `[]` → explicit deny-all; never re-enabled by migration.
- `[ids]` → explicit allow-set.

### 1.8 New User Preferences for Agent Mode

The following fields were added to `UserPreferences` in `packages/types/src/preferences.types.ts`:

| Field | Type | Default | Description |
|---|---|---|---|
| `agentEnabledTools` | `string[] | null` | `null` | Tools enabled for agent mode; null means use the built-in registry defaults. |
| `agentMaxIterations` | `number` | `20` | Maximum agent loop iterations, clamped 1–100. |
| `agentPermissionTimeoutMs` | `number` | `60000` | Time allowed for a user permission response, clamped 5000–600000 ms. |

Normalization functions in `preferences.repo.ts`:
- `normalizeAgentMaxIterations(value)`: clamps to 1–100, defaults to 20.
- `normalizeAgentPermissionTimeout(value)`: clamps to 5000–600000 ms, defaults to 60000.

Actions in `user.actions.ts`:
- `setAgentEnabledTools(toolIds: string[] | null)`: sets the allow-set. When all tools are enabled, stores `null` instead of the full array.
- `setAgentToolEnabled(toolId, enabled)`: toggles a single tool. Derives the new set from current preferences inside a serialized mutation.
- `setAgentMaxIterations(iterations)`: clamps and persists.
- `setAgentPermissionTimeoutMs(timeoutMs)`: clamps and persists.

### 1.9 Agent Settings UI Changes

`AIAgentModeConfiguration` now exposes (when mode is `"api"`):

1. **API key picker** (`ApiKeyList` with context `"post-processing"`).
2. **Maximum iterations** — numeric field, 1–100, persisted on blur/Enter via `setAgentMaxIterations`. Local draft prevents out-of-order writes.
3. **Permission timeout (seconds)** — numeric field, 5–600, persisted on blur/Enter via `setAgentPermissionTimeoutMs`. Local draft prevents out-of-order writes.
4. **Enabled tools** — toggle list of all registered tools. Each shows description and tool ID. Toggle state reflects `agentEnabledTools` preference.

`AIAgentModeDialog` changes:
- Replaced inline close IconButton with `DialogTitleWithClose` component.
- Replaced inline toggle rows with `ToggleRow` component using `SettingSection`.
- Em dash in power mode warning replaced with semicolon: "dangerous; commands run".
- Added `aria-labelledby` for accessibility.

### 1.10 Agent Strategy Changes

`AgentStrategy.handleTranscript()` now applies `filterKnownSilenceHallucinations()` before sending to the LLM. If `userPrefs.hallucinationFilterEnabled === false`, the raw transcript passes through unfiltered. Empty results after filtering skip the LLM call entirely.

### 1.11 System Prompt

`CHAT_AGENT_CONFIG.systemPrompt` now appends `HUMANIZE_SKILL_TEXT` at the end of the base instructions. The full prompt:

```
You are a helpful assistant running on the user's desktop with access to tools.
Use the available tools when needed to help the user.
When the user refers to something on their screen, read the context using your tools — don't ask them to paste it.
After completing a task, deliver the result using the appropriate tool (e.g. paste text into their field) and respond concisely.
Iteratively solve larger tasks, break them down into smaller steps and use your tools to complete each step, delivering results as you go.
Humanize the text: remove AI-slop markers while preserving meaning, structure, and facts.
Replace em-dashes (—) with commas, periods, or colons, or restructure the sentence.
Replace "delve" with "explore"; "seamless" with "smooth"; "unlock" with "enable"; "game-changer"/"transformative" with the actual benefit; "leveraging" with "using"; "utilize" with "use"; "in order to" with "to"; "a wide range of" with "many"; "cutting-edge"/"state-of-the-art" with "modern"; "robust" with "reliable"; "realm" with "area"; "in terms of" remove or rephrase; "it is important to note that"/"it is worth mentioning that" remove or condense.
Write in plain, direct, active-voice language. One idea per sentence. Avoid hedging (may/might/could) unless the uncertainty is real. Avoid clichés, buzzwords, and corporate jargon. Prefer concrete examples over abstract claims.
Do NOT alter code, data, or structured output (JSON, markdown tables, etc.) except the banned markers embedded in their text. Do NOT change meaning, factual accuracy, or technical specificity.
```

### 1.12 Humanize / De-slop System

`humanize.utils.ts` provides a two-layer de-slop pipeline:

**Layer 1 — Prompt artifact (`HUMANIZE_SKILL_TEXT`)**:
Injected into the agent system prompt. Instructs the LLM to avoid AI markers at the source.

**Layer 2 — Post-hoc scrubber (`humanizeScrub()`)**:
Conservative mechanical cleanup of residual markers. Protected segments pass through untouched:
- Fenced code blocks (``` ... ```)
- Tilde code blocks (~~~ ... ~~~)
- Indented code blocks
- GitHub Flavored Markdown tables
- Inline code spans (`...`)
- Standalone JSON

Prose transformations:
- Em-dashes (—) → comma + space, or `,<newline>` if followed by a newline.
- Word replacements: `delve` → `explore`, `seamless` → `smooth`, `unlock` → `enable`, `leveraging` → `using`, `utilize`/`utilizes`/`utilized`/`utilizing` → `use`/`uses`/`used`/`using`, `in order to` → `to`, `a wide range of` → `many`, `cutting-edge` → `modern`, `let's dive` → `let's look`.
- Hedge removal: `it is important to note that`, `it is worth mentioning that`, `it should be noted that` → empty string.
- Double-space cleanup: collapses horizontal space/tab runs to single space. Newlines preserved.

### 1.13 Hallucination Filtering

`hallucination.utils.ts` provides:

**`KNOWN_SILENCE_HALLUCINATIONS`**:
`[blank_audio]`, `[blank audio]`, `[silence]`, `(silence)`, `thank you for watching`, `thanks for watching`, `subtitles by the amara.org community`, `subtitles by the amara.org community.`

**`filterKnownSilenceHallucinations(text, language?)`**:
- Returns empty string if the entire text is a known hallucination.
- Non-English `language` disables the phrase filter entirely.
- Splits text by sentence boundaries (`[.!?。！？]` followed by whitespace).
- Removes known hallucinations and subtitle-companion phrases (`best regards.`) when a subtitle hallucination is present.
- Rebuilds kept parts with single-space joining.

**`applyHallucinationFiltering()`** (used in transcription pipeline):
- Probability gate: drops segments with `noSpeechProb >= 0.9` AND (`avgLogprob < -1` OR `audioSilent === true` OR no `avgLogprob`).
- Then applies phrase filter.

`filterKnownSilenceHallucinations` is used in `AgentStrategy` with the user's dictation language for English-gated filtering.

### 1.14 Agent State Shape

```typescript
type AgentRunState = {
  status: "idle" | "calling-llm" | "processing-tools" | "done" | "error";
  agentType: string;
  iteration: number;
  maxIterations: number;
  toolCalls: AgentToolCallState[];
  currentToolIndex: number;
  aborted: boolean;
  error?: string;
};

type AgentToolCallState = {
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  permissionId?: string;
  result?: Record<string, unknown>;
  status: "pending" | "awaiting-permission" | "executing" | "done" | "denied";
};
```

Stored in `state.agentStateByConversationId[conversationId]`.

### 1.15 Streaming Message State

```typescript
type StreamingMessageState = {
  toolCalls: StreamingToolCall[];
  reasoning: string;
  isStreaming: boolean;
};
```

Stored in `state.streamingMessageById[messageId]`. Only exists while the message is actively streaming.

### 1.16 Chat UI Components

New/updated components for agent mode rendering:

- `AgentLiveAnnouncer`: Accessible live region announcing assistant state transitions and new messages. Uses `aria-live="polite"`. Handles identical messages by padding with invisible hair-space characters.
- `ChatMessageParts`: Renders `ChatPart[]` which includes `text`, `reasoning` (collapsible), `tool`, `tool-result`, `permission`, `status`, `error`.
- `ChatMessageBubble`: Renders full message with parts, tool status icons, and reasoning toggle.
- `ChatMessageContent`: Extracted content renderer.
- `ChatPromptBox`: Input component for sending messages.
- `ToolPermissionCard`: Renders allow/deny/always-allow actions for pending permissions.
- `PendingPasteReviewBubble`: Review-before-insert bubble for agent-generated paste content.
- `ConversationLayout` / `ConversationListLayout` / `ConversationListItem`: Chat history UI.
- `AgentActivity`: Agent status indicator in conversation list.

### 1.17 Chat Action Types

`chat.actions.ts` exports:
- `loadConversations()`
- `createConversation(conversation)`
- `updateConversation(conversation)`
- `deleteConversation(id)`
- `loadChatMessages(conversationId)`
- `createChatMessage(message)`
- `updateChatMessage(message)`
- `deleteChatMessages(conversationId, ids)`
- `runAgentForConversation(conversationId)` — wraps `runAgent()` + cleans up agent state in `finally`.
- `sendChatMessage(conversationId, text)` — creates user message then calls `runAgentForConversation`.
- `abortAgent(conversationId)` — calls `abortAgentLoop()`.

`tool.actions.ts` exports:
- `loadTools()`
- `requestToolPermission(toolId, params, conversationId)` — creates pending permission record.
- `resolveToolPermission(permissionId, status)` — resolves to allowed/denied, generates token on allow.
- `getToolPermissionStatus(permissionId)` — returns status, auto-denies after timeout.
- `consumeToolToken(toolId, token)` — one-time token consumption for always-allow.
- `executeTool(toolId, params)` — creates tool via registry and executes.
- `setToolAlwaysAllow(opts)` — configures per-tool always-allow rules.

### 1.18 Onboarding / Feature Release

`FeatureReleaseDialog` introduces agent mode to existing users:
- Triggered for users created before `CURRENT_FEATURE_DATE` who have not dismissed it.
- **Community plan**: 4 pages — Intro → Processor (select AI provider) → Hotkey → Try It.
- **Non-community**: 3 pages — Intro → Hotkey → Try It.
- Tips: "Run Agent Mode multiple times to keep refining! It remembers what's in the text box."
- Confetti on first open.

---

## Part 2: Atlas Codebase — Complete Agentic Architecture

### 2.1 Repository Status

Atlas (`dortanes/atlas`) is archived at v0.2.3. Development stopped because:
- No Windows device for testing (Windows-only app).
- Major AI assistants now ship native computer use.

It remains available under Apache 2.0. The codebase is an Electron app with Vue 3 renderer and TypeScript main process.

### 2.2 Overall Architecture

**Electron Main vs Renderer**:
- **Main process** (`electron/main/`): All privileged operations — LLM calls, screen capture, robotjs motor control, file I/O, Vosk STT, TTS, memory, search, persona management.
- **Renderer** (`src/`): Vue 3 UI. Cannot touch OS APIs directly. All privileged calls go through tRPC over Electron IPC.
- **Preload** (`electron/preload/index.ts`): Sole responsibility is `exposeElectronTRPC()` from `electron-trpc/main`. No raw Electron APIs exposed.

**IPC / tRPC Bridge**:
- tRPC router merges 7 sub-routers: `system`, `agent`, `audio`, `settings`, `personas`, `memory`, `facts`.
- Renderer client (`src/api.ts`): `createTRPCProxyClient<AppRouter>({ links: [ipcLink()] })`.

**Event Bus** (`electron/main/utils/eventBus.ts`):
Central pub/sub with namespaced events:
- `agent:state`, `agent:action`, `agent:response`, `agent:microtasks`, `agent:permission`, `agent:permission-response`, `agent:warning`, `agent:command`, `agent:newSession`, `agent:action-log`, `agent:action-steps`, `agent:cursor-animation`, `agent:search-results`
- `hotkey:toggle-atlas`
- `audio:transcript`, `audio:listening`, `stt:model-status`
- `persona:switched`, `prompt:saved`
- `tts:status`, `tts:format`, `tts:audio`, `tts:speak`, `tts:stop`
- `agent-visibility`, `system:open-settings`, `system:close-settings`

**ServiceRegistry** (`electron/main/services/ServiceRegistry.ts`):
Simple IoC container. Services register by name, init in dependency order, dispose in reverse. All extend `BaseService` with `init()`/`dispose()`.

**Main Entry** (`electron/main/index.ts`):
- Registers custom `stt-model://` protocol for Vosk models.
- Creates services in dependency order: Intelligence → Persona → Memory → Facts → TTS → Vision → Motor → Search → STT → Agent → Hotkey.
- Wires cross-service deps (persona→memory/facts, tts→persona).
- Wires routers to services via module-level setters.
- Registers `hotkey:toggle-atlas` → `toggleWindow()`.
- Creates transparent frameless BrowserWindow with `skipTaskbar`, `alwaysOnTop(true, 'screen-saver')`, click-through enabled by default.

**WindowManager**:
- Window starts hidden (`setOpacity(0)`), shown via tray click or hotkey.
- Click-through: `setIgnoreMouseEvents(true, { forward: true })` by default; disabled for settings.
- `blurForAction()` / `restoreAfterAction()`: Blurs Atlas before motor actions so hotkeys/clicks target the foreground app, then restores always-on-top.
- `moveToDisplay(displayIndex)`: Moves overlay to specific monitor.

**TrayManager**:
- Left-click toggles window.
- Context menu: Show/Hide Atlas, Personas submenu (radio items), Settings, Toggle DevTools, Reset Position, Quit.
- Rebuilds menu on persona switch.

### 2.3 Agent State Machine

`AgentState.ts` — Finite state machine with 5 states:

| State | Meaning |
|---|---|
| `idle` | Agent is off, waiting for command. |
| `listening` | Wake word detected, listening for command. |
| `processing` | Command received, LLM is thinking. |
| `acting` | Executing actions on screen. |
| `warning` | High-risk action pending user confirmation. |

Valid transitions:
- `idle` → `processing` on COMMAND_RECEIVED
- `idle` → `listening` on START_LISTENING
- `listening` → `processing` on SPEECH_RECOGNIZED
- `processing` → `acting` on LLM_RESPONDING
- `processing` → `idle` on TASK_DONE (early abort)
- `acting` → `idle` on TASK_DONE
- `acting` → `warning` on HIGH_RISK
- `acting` → `processing` on NEXT_STEP
- `warning` → `acting` on USER_CONFIRM
- `warning` → `idle` on USER_CANCEL

Emits `agent:state` on every transition. `reset()` forces `idle`.

### 2.4 Agent Service Orchestration

`AgentService.ts` — Top-level orchestrator:
- Listens to `agent:command` from tRPC.
- Manages conversation history via MemoryService.
- Drives AgentStateMachine transitions.
- Invokes AgentLoop for LLM processing.
- Manages MicrotaskQueue for sequential task execution while busy.
- Handles persona switching (saves/loads per-persona history, recreates AgentLoop).
- Handles permission responses and warning dismissals.
- Maintains `actionLogs` (max 50 per persona) and `actionSteps` for MicrotaskIsland.
- Command deduplication: drops identical commands within 2s.
- Creates `SessionLogger` when `config.ui.debugLog` is enabled.

### 2.5 Agent Loop Routing

`AgentLoop.ts` — Thin facade:
1. Guards: intelligence must be ready.
2. Classifies intent via `IntentClassifier`.
3. Routes:
   - **`direct`** → `DirectActionLoop` (shell/hotkey, no vision). If LLM returns `needsVision`, falls back to action mode.
   - **`action`** → `runActionMode`: prefers `ComputerUseLoop` if model supports `computer_use`, else falls back to `ActionLoop`.
   - **`chat`** (default) → `ChatMode`.
4. Falls back to chat if vision/motor unavailable in action mode.

### 2.6 Action Loop (Vision-Based)

`ActionLoop.ts` — The act → observe → decide cycle:
1. Builds system prompt (stable, for caching) + action prompt (`action.md`).
2. Takes initial screenshot.
3. Decomposes command into 2–5 plan steps via `TaskPlanner.planSteps()`.
4. Main loop (up to `maxIterations`, breaks on `maxConsecutiveFailures`):
   - Calls `intelligence.chatWithVisionStructured()` with screenshot + `AgentActionSchema`.
   - Parses response via Zod schema, falls back to legacy `parseAction()`.
   - **`done`**: Breaks loop, streams final response.
   - **`screenshot`**: Captures requested display, appends to messages, continues.
   - **`search`**: Calls `SearchService.searchWeb()`, appends results.
   - **`searchFiles`**: Calls `SearchService.searchFiles()` with progressive streaming.
   - Activates next planned step in MicrotaskIsland.
   - **Risk check**: `high`/`critical` actions emit `agent:permission`, wait for response. User denial → idle. Allowance → acting.
   - Executes action via `motorService.executeAction()`.
   - On failure: increments `consecutiveFailures`, appends `action_failed.md` prompt, continues.
   - On success: resets failures, auto-screenshots for verification on visual actions, appends `verify_action.md` or `action_success.md`.
5. Cleanup: emits `agent:action(null)`, hides cursor, emits final steps and action log, warns on limits, streams final response, transitions to `TASK_DONE`.

### 2.7 Computer Use Loop (Native Gemini)

`ComputerUseLoop.ts` — Native Gemini `computer_use` alternative:
1. Builds system prompt + `computer_use.md` addon.
2. Sets MotorService dimensions 1:1.
3. Takes initial screenshot, builds Gemini-native `contents` array.
4. Main loop:
   - Calls `geminiProvider.chatWithComputerUse()` with `computer_use` tool config.
   - Extracts `functionCall` parts and text parts.
   - No function calls → model is done.
   - For each function call:
     - Auto-acknowledges Gemini's `safety_decision: require_confirmation`.
     - Maps to `AgentAction` via `computerUseMapper.mapFunctionCallToAction()`.
     - Special handling for `type_text_at` (in-place typing or click-then-type), `hover_at`.
     - Web search / file search bypass browser, use `SearchService` directly.
     - Executes via `motorService.executeAction()`.
     - Post-action screenshot (PNG for Computer Use API compliance).
     - Sends `function_response` parts back to model.
5. Cleanup same as ActionLoop.

Computer Use loop does NOT use context caching (Gemini forbids `cachedContent` + `tools/tool_config` in same request).

### 2.8 Direct Action Loop (No Vision)

`DirectActionLoop.ts` — Fast path for shell/hotkey actions:
1. Loads `direct_action.md` prompt.
2. Single LLM call with `DirectActionSchema`.
3. Actions: `runCommand`, `hotkey`, `keyPress`, `search`, `searchFiles`, `done`, `needsVision`.
4. Special intercepts:
   - `needsVision` → returns flag for AgentLoop fallback.
   - `search` → calls `SearchService.searchWeb()`, asks LLM to summarize.
   - `searchFiles` / PowerShell patterns → proper `SearchService.searchFiles()` with progressive UI streaming.
   - `SendKeys` text input blocked → redirected to `needsVision` (avoids Cyrillic/encoding garbling). Allows single-char media keys.
5. Risk check same as ActionLoop.
6. On failure: asks LLM to explain error in natural language.

### 2.9 Chat Mode

`ChatMode.ts` — Conversational streaming:
1. Builds system prompt (stable) + dynamic context (time + user facts).
2. Calls `intelligence.streamWithThoughts()` yielding typed chunks (`thought` or `text`).
3. Emits thoughts to `agent:response` with `kind: 'thoughts'`.
4. On first text chunk after thoughts: emits `done: true` for thoughts, waits `thoughtsTransitionDelay` ms, then emits response chunks.
5. On completion: emits `done: true` for response, triggers `tts:speak`, fires async `FactExtractor.extract()`.

### 2.10 Task Planning and Microtask Queue

`TaskPlanner.ts`:
- `planSteps()`: LLM structured call decomposes command into 2–5 high-level steps (same language as user command). Falls back to empty array on failure.
- `createStepTasks()`: Creates `StepTask[]` with status `queued` only when multiple steps.
- `activateStep()`: Activates next queued step or creates ad-hoc step, emits `agent:action-steps`.
- `markStep()`: Marks step `done` or `failed`, emits update.
- `emitSteps()`: Emits full step list to event bus.

`MicrotaskQueue.ts`:
- `Microtask`: `id`, `text`, `status` (`queued`|`active`|`done`|`failed`), `createdAt`.
- Enqueue while agent busy → auto-processed via `processQueue()` after current task completes.
- Emits `agent:microtasks` on every state change.

### 2.11 Response Streaming

`ResponseStreamer.ts`:
- Splits text by whitespace, emits chunks of `streamWordsPerChunk` words with `streamChunkDelay` ms between.
- Triggers `tts:speak` and async `factExtractor.extract()` after completion.

### 2.12 Fact Extraction

`FactExtractor.ts`:
- After each agent response, sends exchange to secondary LLM call with `extract_facts.md` prompt.
- Uses structured output (`ExtractedFactsSchema`) for clean `{ facts: string[] }`.
- Deduplicates against existing facts via `FactService.addFacts()`.
- Fire-and-forget: errors logged but not thrown.

Fact categories: Identity, Preferences, Context. Max 2 facts per conversation. Empty array is valid.

### 2.13 Agent Types and Schemas

`types.ts`:
- `ActionType`: `click`, `doubleClick`, `rightClick`, `type`, `hotkey`, `keyPress`, `scroll`, `runCommand`, `screenshot`, `search`, `searchFiles`, `wait`, `done` (ActionLoop); `runCommand`, `hotkey`, `keyPress`, `search`, `searchFiles`, `done`, `needsVision` (DirectActionLoop).
- `RiskLevel`: `low`, `medium`, `high`, `critical`.
- `AgentAction`: `{ type, x?, y?, text?, command?, key?, keys?, direction?, amount?, query?, path?, displayId?, waitMs?, risk? }`.
- `ActionResult`: `{ success, error?, output? }`.

`schemas.ts`:
- `AgentActionSchema` (Zod): validates all action types with optional fields.
- `ExtractedFactsSchema`: `{ facts: string[] }`.
- `IntentClassificationSchema`: `{ intent: "chat" | "direct" | "action" }`.

`parseAction.ts`:
- Legacy fallback parser for non-structured LLM responses.
- Strips markdown fences, finds JSON boundaries.

`agentUtils.ts`:
- `buildDynamicContext(userFacts)`: prepends `[Context: Time: ... | Known facts: ...]` to user messages. Must NOT be cached.

`computerUseMapper.ts`:
- `denormalize(normalized, screenSize)`: `Math.round(normalized / 999 * screenSize)`.
- `mapFunctionCallToAction(name, args, screen)`: Maps Gemini function names to `AgentAction`.
- Handles: `click_at`, `type_text_at`, `hover_at`, `key_combination`, `scroll_at`, `scroll_document`, `drag_and_drop` (simplified), `open_web_browser`, `navigate`, `go_back`, `go_forward`, `search`, `wait_5_seconds`, `search_files`.
- `extractSafetyDecision(args)`: Extracts `safety_decision` from function call args.

### 2.14 Intelligence Service

`IntelligenceService.ts` — Manages LLM providers for 3 roles:
- **text**: `textProvider` — main chat, streaming, thoughts.
- **vision**: `visionProvider` — screenshot analysis. Falls back to `textProvider` if no separate vision model configured.
- **classifier**: `classifierProvider` — cheap intent detection. Falls back to `textProvider`.
- **cuProvider**: `GeminiProvider` for computer_use if model supports it.

Provider creation: `createProvider(name, apiKey, model, baseURL)` → `GeminiProvider` or `OpenAIProvider`. Falls back to Gemini on unknown provider.

Hot-reload: Listens to `config:changed`, reinitializes all providers.

Computer Use detection: Checks vision model name against known list (`computer-use`, `gemini-3-flash`, `gemini-3-pro`, `gemini-3.1-flash`, `gemini-3.1-pro`). Lite models excluded.

API surface:
- `chat()`, `stream()`, `streamWithThoughts()` — text role
- `vision()`, `chatWithVision()` — vision role
- `chatStructured()`, `chatWithVisionStructured()` — structured output role (JSON schema constraint)
- `classify()`, `classifyStructured()` — classifier role
- `getCache()`, `invalidateCache()` — context caching

### 2.15 Context Caching

`ContextCacheService.ts` — Gemini explicit context caching:
- Caches system prompt + stable action prompt. Dynamic parts (time, user facts) NOT cached.
- Cache key: `personaId:promptType` (chat, direct, action, cu, default).
- Fingerprint: SHA-256 of model + systemInstruction + stableContent. Detects staleness.
- TTL: 24 hours.
- Invalidation triggers: `prompt:saved`, `persona:switched`, `config:changed`.
- Graceful degradation: on failure (min token count, API error, non-Gemini), returns null → caller uses regular `systemInstruction`.

### 2.16 Prompt System

`PromptLoader.ts` — 2-tier prompt storage:
1. Per-persona: `userData/Prompts/{personaId}/{name}.md` (overrides).
2. Bundled defaults: `intelligence/prompts/{name}.md`.

`load(name, vars?, personaId?)`: Resolves with persona override first, falls back to bundled. Replaces `{{key}}` placeholders.
`save(name, content, personaId)`: Writes to persona dir, emits `prompt:saved`.
`reset(name, personaId)`: Deletes persona override.
`list(personaId?)`: Merges bundled + persona prompts, deduplicates.
`ensureDefaults(personaId?)`: Creates `Prompts/` dir if missing.

### 2.17 Prompt Files

| Prompt | Purpose |
|---|---|
| `system.md` | Base system prompt. Injects `{{persona_name}}`, `{{os}}`, `{{resolution}}`, `{{personality}}`. Rules: respond in user's language, be concise, never fake actions, never lie about screen content. |
| `action.md` | Action loop instructions. Defines all JSON action schemas (shell, GUI, search, file search, control). Rules: JSON only, one step per response, use existing windows, risk self-assessment, never open browser to search, never use SendKeys for text input, multi-monitor bounds filtering, exclude Atlas/electron from bulk ops. |
| `direct_action.md` | Direct mode instructions. JSON only. Actions: runCommand, hotkey, keyPress, done, needsVision. PowerShell quick reference. Rules: prefer runCommand, never close Atlas, redirect typing needs to needsVision. |
| `computer_use.md` | Computer Use addon appended to system prompt. Concise step labels in user's language. Tips: clear_before_typing, Ctrl+F first, use search_files/search tools, never open browser/explorer, wait_5_seconds for loading, stop when goal achieved. |
| `action_success.md` | Injected after successful action. Shows execution branch, tells LLM to continue or done. |
| `action_failed.md` | Injected after failed action. Shows error + branch, tells LLM to try different approach. |
| `verify_action.md` | Post-action verification protocol. Compare screenshots, describe changes, decide if goal achieved, recover with Escape + shifted coords if wrong element activated. |
| `screenshot_attached.md` | Injected after screenshot action. Tells LLM to analyze and respond with next action. |
| `extract_facts.md` | Fact extraction instructions. 3 categories only: Identity, Preferences, Context. Never extract: specific numbers, specific names, temporary states, conversation mechanics, task content confused with preferences, info from external sources, third parties, duplicates. Max 2 facts per conversation. Empty array is valid. |
| `intent_classifier.md` | Intent classification prompt. 3 categories: direct (shell/hotkey/web search/file search), action (screen interaction), chat (small talk/general knowledge). Priority: if question could benefit from current/factual data → direct, not chat. |

### 2.18 LLM Providers

**GeminiProvider** (`GeminiProvider.ts`):
- Uses `@google/genai` SDK.
- `StreamChunk`: `{ type: 'thought'|'text', content: string }`.
- `streamWithThoughts()`: Sets `thinkingConfig: { includeThoughts: true }`, yields typed chunks by inspecting `part.thought`.
- `chatWithComputerUse()`: Sends `computer_use` tool config with `Environment.ENVIRONMENT_BROWSER`. Returns full response for `functionCall` extraction.
- All methods support `cachedContent` OR `systemInstruction` (mutually exclusive).

**OpenAIProvider** (`OpenAIProvider.ts`):
- Works with any OpenAI-compatible API (LMStudio, Ollama, vLLM, etc.).
- Default baseURL: `http://localhost:1234/v1`, default API key: `lm-studio`.
- `streamWithThoughts()`: All chunks emitted as `{ type: 'text' }` (no native thinking mode).
- `chatStructured()` / `chatWithVisionStructured()`: Uses `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }`.
- Does NOT support `cachedContent`.

### 2.19 Computer Use / Vision

**VisionService** — Facade combining ScreenCapture + CoordinateMapper + LLM vision:
- `takeScreenshot(format?)` → `ScreenCapture.captureFullScreen()`.
- `takeScreenshotOfDisplay(displayId)`.
- `listDisplays()`.
- `analyzeScreen(prompt)` → screenshot + `intelligence.vision()`.
- `getScreenInfo()` / `getResolutionString()`.
- `toLogicalCoords()`.

**ScreenCapture**:
- Uses `screenshot-desktop` npm package.
- Captures at native resolution, resizes to `screenshotMaxWidth` (default 1280px), compresses to JPEG (quality 80).
- PNG mode for Computer Use API (`image/png` required in `function_response`).
- `resolveDisplayId()`: Matches Atlas window's display bounds to `screenshot-desktop` display IDs.

**CoordinateMapper**:
- `getScreenInfo()`: Returns `{ width, height, scaleFactor }` for display under Atlas window.
- `toLogical(physicalX, physicalY)`: Divides by scaleFactor.
- `toPhysical(logicalX, logicalY)`: Multiplies by scaleFactor.

**computerUseMapper**:
- `denormalize(normalized, screenSize)`: `Math.round(normalized / 999 * screenSize)`.
- `mapFunctionCallToAction(name, args, screen)`: Maps Gemini function names to `AgentAction`.
- `extractSafetyDecision(args)`: Extracts `safety_decision`.

### 2.20 Motor / Control

**MotorService** — Facade over MouseController + KeyboardController + ShellController:
- `setDimensions(screen, screenshot)`: Sets actual vs screenshot dimensions for coordinate rescaling.
- `scaleCoords(x, y)`: `Math.round(x * screenWidth / screenshotWidth)`.
- `executeAction(action)`: Routes by action type:
  - `click`/`doubleClick`/`rightClick`: Scales coords, emits cursor animation, calls `mouse.*`.
  - `type`: Emits cursor animation, calls `keyboard.type()`.
  - `hotkey`: Calls `keyboard.hotkey()`.
  - `keyPress`: Calls `keyboard.keyPress()`.
  - `scroll`: Emits cursor animation, calls `mouse.scroll()`.
  - `runCommand`: Calls `shell.exec()`, returns `{ success, error, output }`.
  - `navigate`: Ctrl+L → type URL → Enter.
  - `wait`: `sleep(amount)`.
  - `screenshot`/`done`: No-op.
- `hideCursor()`: Emits `agent:cursor-animation` with `type: 'hide'`.

**MouseController** — Wraps `@hurdlegroup/robotjs`:
- `click(x, y)`: `robot.moveMouse()` + `robot.mouseClick()`.
- `doubleClick(x, y)`: `robot.mouseClick('left', true)`.
- `rightClick(x, y)`: `robot.mouseClick('right')`.
- `moveTo(x, y)`: `robot.moveMouse()`.
- `drag(fromX, fromY, toX, toY)`: `mouseToggle('down')` + `dragMouse()` + `mouseToggle('up')`.
- `scroll(direction, amount)`: Multiplies by 120 (WHEEL_DELTA).

**KeyboardController**:
- `type(text)`: Clipboard-paste method (Ctrl+V). Saves/restores original clipboard.
- `typeNative(text)`: Character-by-character via `robot.typeStringDelayed()` with 30ms delay. Handles newlines as Enter.
- `hotkey(...keys)`: Resolves key aliases, separates modifiers from main keys, calls `robot.keyTap(key, modifiers)`.
- `keyPress(key)`: Single key tap.
- `KEY_ALIASES`: `ctrl→control`, `win→command`, `super→command`, `meta→command`, `cmd→command`, `esc→escape`, `return→enter`, `del→delete`, `pgup→pageup`, `pgdn→pagedown`.

**ShellController**:
- `exec(command)`: Runs PowerShell via `node:child_process.exec`. UTF-8 encoding, 30s timeout (configurable), `windowsHide: true`.
- `patchUserFolderPaths(command)`: Replaces `$HOME\Desktop`, `$env:USERPROFILE\Documents`, etc. with `[Environment]::GetFolderPath()` calls (OneDrive-safe).

### 2.21 Search

**SearchService**:
- **Web search**: Uses DuckDuckGo HTML endpoint (`https://html.duckduckgo.com/html/`) with POST + cheerio parsing. Extracts results from `.result__body`, unwraps `uddg=` redirect URLs. Returns `SearchResult[]` (`title`, `url`, `snippet`).
- **File search**: Uses PowerShell `Get-ChildItem -Recurse -Filter` on user directories (Desktop, Documents, Downloads, Pictures, Videos, Music, OneDrive). Builds search variants (joined, hyphenated, underscored) from keywords. Progressive streaming via `onResult` callback. Deduplicates across variants. Max depth 5. Timeout 15s. Max buffer 1MB. Returns `FileSearchResult[]` (`name`, `path`, `isDirectory`, `size`, `modified`).

### 2.22 Memory and Facts

**MemoryService** — Per-persona conversation persistence:
- Storage: `userData/Memory/{personaId}/{sessionId}.json`.
- `getActiveSession(personaId)`: Checks in-memory cache. On cold start, creates new session (never reuses old non-empty sessions). Reuses empty sessions.
- `getContextMessages(personaId)`: Trims to `maxContextMessages` (default 40).
- `appendMessages(personaId, userMsg, modelMsg)`: Auto-saves, auto-titles from first user message.
- `newSession(personaId)`: Saves previous, creates fresh UUID session.
- `listSessions()` / `getSession()` / `deleteSession()` / `clearSessions()` / `deletePersonaMemory()`.

**FactService** — Per-persona long-term knowledge:
- Storage: `userData/Facts/{personaId}.json` — flat `Fact[]`.
- `Fact`: `id`, `text`, `createdAt`, `source` (`extracted`|`manual`).
- `getFactsText(personaId)`: Returns bullet-list string or "No known facts about the user yet."
- `addFacts(personaId, texts)`: Dedupes against existing by lowercase text.

**MemoryTypes**:
- `ConversationSession`: `id`, `personaId`, `title`, `messages: LLMMessage[]`, `createdAt`, `updatedAt`.
- `SessionMeta`: lightweight listing (no messages).

### 2.23 Persona System

**AgentProfile**:
- `id`, `name`, `avatar` (single emoji), `personality` (string injected into system prompt), `ttsVoiceId?` (optional per-persona TTS voice), `createdAt`, `isDefault`.
- `DEFAULT_PERSONA`: id=`atlas-default`, name=`Atlas`, avatar=`🛸`, personality = helpful/concise/proactive/natural.

**PersonaService**:
- CRUD for personas. Storage: `userData/Personas` (flat JSON array).
- `getActive()`: Returns config's `activePersonaId` persona.
- `create(data)`: Generates UUID, creates per-persona prompts dir.
- `update(id, partial)`: Emits `persona:switched` if active persona changed.
- `delete(id)`: Cannot delete default. Cleans up prompts dir, memory, facts.
- `switch(id)`: Saves to config, emits `persona:switched`.

### 2.24 Intent Classification

**ClassifierService** — Registry & facade. `register(classifier)`, `get<T>(name)`, `has(name)`.

**IntentClassifier** — Registered as `'intent'`:
- `classify({ command, recentHistory? })`: Loads `intent_classifier.md` prompt with context + command. Uses `intelligence.classifyStructured()` with `IntentClassificationSchema`.
- Falls back to `'chat'` on any error.

**Classifier intents**: `chat`, `direct`, `action`.

### 2.25 Voice: STT and TTS

**STTService** — Backend orchestrator for speech-to-text. Actual recognition runs in renderer via `vosk-browser` (WebAssembly).
- `getModelStatus()`, `downloadModel(language)`, `getModelPath()`, `getAvailableLanguages()`.
- `setListening(active)`: Sets state, emits `audio:listening`.
- Model status checked on init. If not downloaded, warns user.

**ModelManager**:
- 27 Vosk model URLs (en, en-in, ru, cn, de, fr, es, pt, tr, vn, it, nl, ca, uk, kz, sv, ja, eo, hi, cs, pl, uz, ko, fa, gu, tg, te, ky, ar).
- Models stored at `userData/Models/stt/{language}.zip`.
- `downloadModel()`: Downloads with progress tracking via `stt:model-status` events. Extracts zip (PowerShell `Expand-Archive` on Windows, `unzip` elsewhere). Flattens nested directories.

**TTSService** — Manages TTS provider lifecycle:
- Listens for `tts:speak`, `tts:stop`, `persona:switched`, `config:changed`.
- Providers: `elevenlabs` (ElevenLabsProvider), `yandex-alice` (YandexAliceProvider). Falls back to elevenlabs on unknown.
- Per-persona voice override: persona's `ttsVoiceId` > global `config.tts.voiceId`.
- `speak(text)`: Stops current speech, streams audio chunks via `tts:audio` events, emits `tts:status`/`tts:format`.
- Auto-disables on quota exhaustion, surfaces dismissable warning.
- Audio formats: `mpeg` (ElevenLabs), `opus` (Yandex Alice).

**BaseTTSProvider**: `synthesize(text) → Promise<Buffer>`, `streamSpeech(text) → AsyncGenerator<Buffer>`.

**ElevenLabsProvider**:
- Uses `@elevenlabs/elevenlabs-js` SDK.
- Default voice: `JBFqnCBsd6RMkjVDRZzb`, model: `eleven_flash_v2_5`.
- `streamSpeech()`: Streams mp3 chunks via ReadableStream.

**YandexAliceProvider**:
- Uses `yandex-alice-client`. No API key required.
- Lazy connection via `client.connect()`.
- `streamSpeech()`: Synthesizes full buffer, yields as single chunk (no streaming).

### 2.26 Renderer Composables

**useAgent** — Singleton state: `state: AgentState`, `currentAction: ActionData | null`. Subscribes to `agent.onStateChange` + `agent.onAction`. `sendCommand(text)` → `api.agent.sendCommand.mutate()`.

**useAgentCursor** — Singleton state: `visible`, `x`, `y`, `animationType`, `typingText`, `scrollDirection`, `clicking`, `doubleClicking`. Subscribes to `agent.onCursorAnimation`. First appearance: starts at viewport center, then glides to target via double `requestAnimationFrame`. Click ripple triggers after 350ms. Double-click: two ripples 80ms apart.

**useMicrotasks** — Singleton `tasks: Microtask[]`. Subscribes to `agent.onMicrotasks`. `addTask(text)` → `api.agent.sendCommand.mutate()`. Computed: `completedCount`, `progressPercent`, `progressLabel` ("2/5").

**usePermissions** — Singleton `permissions: PermissionRequest[]`. Subscribes to `agent.onPermission`. `respond(id, allowed)` → removes from local queue + `api.agent.respondPermission.mutate()`.

**useResponse** — Singleton `response: AgentResponse | null`, `dismissing`. Subscribes to `agent.onResponse`. Chunk protocol: new ID creates response, same ID appends text, `done: true` marks streaming finished. On `processing` state: stops TTS, clears old response. `dismiss()`: 400ms animation then clear.

**useSearch** — Singleton `searchData: SearchData | null`, `dismissing`. Subscribes to `agent.onSearchResults`. Shows loading animation while `searching: true`. On state `processing`: clears search. `openFile(path)` / `revealFile(path)` → `api.agent.openFileResult.mutate()`.

**useWarnings** — Singleton `warnings: Warning[]`. Subscribes to `agent.onWarning` + `agent.onWarningDismiss`. Deduplicates by ID. `dismiss(id)` → local remove + `api.agent.dismissWarning.mutate()`.

**useMemory** — Singleton `sessions: SessionMeta[]`, `loading`. CRUD via tRPC.

**useFacts** — Singleton `facts: Fact[]`, `loading`. CRUD via tRPC.

**usePersonas** — Singleton `personas: AgentProfile[]`, `activePersona`, `loading`. Subscribes to `personas.onSwitch`. CRUD + switch via tRPC.

**useSettings** — Reactive `config: AppConfig`. `loadConfig()` from backend. Debounced auto-save (800ms) on any change via deep watch on JSON.stringify(config). Prompt editing: `listPrompts`, `loadPrompt`, `savePrompt`, `resetPrompt`.

**useSTT** — Voice-first STT composable:
- Phases: `off` → `idle` (wake word detection) → `activated` (Atlas shown, listening for command) → `listening` (transcript building).
- Wake word: active persona name (lowercase).
- Mic: `navigator.mediaDevices.getUserMedia` → AudioWorklet (preferred) or ScriptProcessor → `vosk-browser` KaldiRecognizer.
- Silence timer: 700ms base, 1500ms max for short text (≤2 words). Auto-submits on silence.
- Duplicate submission guard: 3s cooldown + text match.
- TTS coordination: does NOT suspend mic during TTS (needs wake word for interrupt). Skips feeding audio to recognizer when `ttsSpeaking && phase !== 'idle'`.
- Visibility auto-activate: when Atlas shown via tray/hotkey and phase is `idle` → `activateWithoutWakeWord()`.

**useTTS** — Dual-format audio playback:
- **mpeg** (ElevenLabs): MediaSource Extensions (MSE) pipeline. `sourceBuffer.appendBuffer()` for chunks. `mediaSource.endOfStream()` on done.
- **opus** (Yandex Alice): Blob URL pipeline. Collects all chunks, merges into single Uint8Array, creates `Blob` → `URL.createObjectURL` → `Audio.play()`.
- `stopPlayback()`: Aborts MSE, clears chunks, pauses audio.
- Subscribes to `audio.onTTSFormat`, `audio.onTTSStatus`, `audio.onTTSAudio`.

**useSounds** — 8 sound effects, preloaded on first call. Each play clones the cached Audio element for overlap.

### 2.27 UI Components

**App.tsx** — Routes between `MainView` and `SettingsView`. Listens to `system.onOpenSettings` (tray) → shows settings, disables click-through. `closeSettings()` → re-enables click-through, hides window if agent wasn't visible before.

**MainView** — Layout (top → bottom): Notifications → spacer → Task Queue → Orb → InputBar (on demand).
- Islands in priority order: Permission (P1), Warning (P2), Action (P3).
- Response/Thoughts above task queue. Search results between response and task queue. ListeningIsland shows live voice transcript when STT activated.
- Click-through: `onMouseenter` disables ignore-mouse-events, `onMouseleave` re-enables.
- Escape key: closes InputBar or hides Atlas.
- State sound triggers: `processing` from `idle` → `sfx.processing()`. `idle` from `processing`/`acting` → `sfx.responseReady()`, auto-shows InputBar after 1.5s (if STT off). `warning` → `sfx.warning()`.
- Agent visibility toggle from tray: `sfx.activate()` on show, `sfx.deactivate()` on hide.

**SettingsView Tabs**:

**AgentTab**: Max Iterations, Max Consecutive Failures. Advanced: Pre-Action Delay, Post-Action Delay, Max Context Messages, Command Timeout, Screenshot Max Width, JPEG Quality. Reset to defaults.

**LLMTab**: Provider (Gemini / OpenAI-compatible), Base URL (OpenAI only), API Key, Models (Text, Vision, Classifier). Advanced: Chat Temperature, Chat Top P, Top K, Max Tokens, Vision Temperature, Vision Max Tokens.

**PromptsTab**: Horizontal prompt pills + full-width textarea editor. Warning banner about editing risks. Reset to bundled default.

**GeneralTab**: Position (left/right/center), Global Hotkey (record new combo via keydown listener), Sound Effects toggle + volume, Log Level, Debug Logging, Open DevTools. Open Log File / Open Logs Folder buttons.

**PersonasTab**: Card-based persona selector → sub-tabs (Profile, Prompts, Facts, Memory, Actions). Profile: read-only card with Edit button, emoji picker, name, personality, voice override.

**MemoryTab**: Session list with expand/collapse, delete, new conversation, clear all.

**FactsTab**: Add fact input, fact list with edit/delete, clear all. Source indicator (extracted / manual).

**VoiceTab**: TTS (enable, provider: ElevenLabs/Yandex Alice, API key, voice ID, model) + STT (enable, language dropdown, model download with progress bar).

**AboutTab**: Logo, version, Electron/Chromium/Node runtime pills, links.

**AgentCursor** — Animated overlay cursor (ring, not arrow):
- Move: smooth CSS transition (350ms cubic-bezier).
- Click: ring contracts + ripple pulse.
- Double-click: two ripples 80ms apart.
- Type: glass bubble shows text being typed.
- Scroll: directional arrow (▼/▲).
- Hide: fades out + shrinks.
- Click-through: `pointer-events: none`.

**AgentOrb** — SVG blob cluster. State-driven:
- Color palettes via CSS `orb--{state}` classes.
- Animation speed interpolation via `playbackRate`:
  - `idle`: 1x
  - `listening`: 1.4x
  - `processing`: 2.2x
  - `acting`: 1.2x
  - `warning`: 2.8x
- Smooth 1200ms ease-out cubic lerp between speeds.

### 2.28 Permission Flow and Risky-Action Gating

1. LLM self-assesses risk in every action response: `low`, `medium`, `high`, `critical`.
2. ActionLoop / DirectActionLoop: if `risk === 'high' || risk === 'critical'`:
   - Generates UUID permission ID.
   - Transitions state to `HIGH_RISK` → `warning`.
   - Emits `agent:permission` with `{ id, message, riskLevel }`.
   - Shows PermissionIsland (Allow / Deny).
   - Waits for `agent:permission-response` event.
3. User allows → transitions to `USER_CONFIRM` → `acting`.
4. User denies → transitions to `USER_CANCEL` → `idle`.
5. ComputerUseLoop: Gemini's `safety_decision: require_confirmation` is auto-acknowledged (Atlas uses its own risk gating instead).

### 2.29 Keyboard Shortcuts

| Shortcut | Effect |
|---|---|
| `Ctrl+Space` (default global hotkey) | Toggle Atlas visibility. Configurable in GeneralTab. |
| `Escape` | Close InputBar or hide Atlas window. |
| `/` or `Ctrl+K` | Toggle InputBar (commented in MainView). |
| Wake word (persona name) | Activate STT listening when in idle phase. |

### 2.30 Sound Effects

| Sound | File | Trigger |
|---|---|---|
| `activate` | `activate.ogg` | Agent activated (wake word / orb click / tray toggle). |
| `deactivate` | `deactivate.ogg` | Agent deactivated / window hidden. |
| `processing` | `processing.ogg` | State transition: `idle` → `processing` (command received). |
| `responseReady` | `response_ready.ogg` | State transition: `processing`/`acting` → `idle` (task complete). |
| `warning` | `warning.ogg` | State transition to `warning`. |
| `permission` | `permission.ogg` | Permission request emitted. |
| `taskComplete` | `task_complete.ogg` | Microtask completed. |
| `error` | `error.ogg` | Error occurred. |

### 2.31 Configuration Schema

`AppConfig` sections:
- `UIConfig`: `positionSide` (left/right/center), `openDevTools`, `logLevel` (debug/info/warn/error), `debugLog`, `soundEnabled`, `soundVolume` (0–1).
- `LLMConfig`: `provider`, `baseURL`, `apiKey`, `textModel`, `visionModel`, `classifierModel`.
- `GenerationConfig`: `chatTemperature` (0–2), `chatTopP` (0–1), `chatTopK`, `chatMaxTokens`, `visionTemperature`, `visionMaxTokens`.
- `TTSConfig`: `provider`, `apiKey`, `voiceId`, `model`, `enabled`.
- `AgentConfig`: `maxIterations`, `maxConsecutiveFailures`, `preActionDelay`, `postActionDelay`, `maxContextMessages`, `commandTimeout`, `screenshotMaxWidth`, `screenshotQuality`, `thoughtsTransitionDelay`, `streamWordsPerChunk`, `streamChunkDelay`.
- `STTConfig`: `enabled`, `language`.
- Root: `hotkey` (string, e.g. "Ctrl+Space"), `activePersonaId`.

### 2.32 Defaults

- Default text model: `gemini-3.1-flash-lite-preview`.
- Default TTS: ElevenLabs, voice `JBFqnCBsd6RMkjVDRZzb`, model `eleven_flash_v2_5`.
- STT disabled by default, language `en`.
- Hotkey: `Ctrl+Space`.
- Agent: maxIterations 15, maxConsecutiveFailures 3, preActionDelay 200ms, postActionDelay 800ms, maxContextMessages 40, commandTimeout 30000ms, screenshotMaxWidth 1280, screenshotQuality 80, thoughtsTransitionDelay 500ms, streamWordsPerChunk 3, streamChunkDelay 30ms.

### 2.33 Config Migration

`migrateFlat(parsed)`: Moves legacy flat keys (e.g. `apiKey` → `llm.apiKey`, `textModel` → `llm.textModel`, `ttsProvider` → `tts.provider`, etc.) into nested structure. Safe to call on already-migrated configs.

### 2.34 IPC / API Surface

**agent.router**: Mutations (`sendCommand`, `respondPermission`, `dismissWarning`, `openFileResult`). Subscriptions: `onStateChange`, `onAction`, `onResponse`, `onMicrotasks`, `onSearchResults`, `onPermission`, `onWarning`, `onWarningDismiss`, `onCursorAnimation`. Queries: `getActionLogs`, `clearActionLogs`.

**system.router**: `getSystemInfo`, `getAccentColor`, `onAccentColorChange`, `onAgentVisibility`, `setIgnoreMouseEvents`, `onOpenSettings`, `closeSettings`, `hideWindow`, `showWindow`, `openExternal`.

**settings.router**: `getConfig`, `saveConfig` (partial, ignores `activePersonaId` from frontend), `onConfigChange`, `listPrompts`, `getPrompt`, `savePrompt`, `resetPrompt`, `openSessionLogs`, `openLogFile`, `resetSection`, `getAppVersion`.

**personas.router**: CRUD + `switch`, `onSwitch` subscription. Emits current active persona immediately on subscribe.

**memory.router**: `listSessions`, `getSession`, `deleteSession`, `clearSessions` (emits `agent:newSession`), `newSession` (emits `agent:newSession`).

**facts.router**: CRUD + `clear`.

**audio.router**: STT (`startListening`, `stopListening`, `onTranscript`, `getSTTModelStatus`, `getSTTModelPath`, `getSTTLanguages`, `downloadSTTModel`, `onSTTModelStatus`). TTS (`speak`, `stopSpeaking`, `onTTSStatus`, `onTTSFormat`, `onTTSAudio`).

---

## Part 3: Cross-Cutting Observations

### 3.1 Architectural Comparison

| Dimension | mausVoice | Atlas |
|---|---|---|
| Framework | Tauri (Rust + React) | Electron (Node + Vue 3) |
| IPC | Tauri commands + Zustand | tRPC over Electron IPC |
| Agent Loop | `@repo/agent` package, async generator | Internal `AgentLoop` facade, event-driven |
| LLM Providers | voice-ai package (OpenAI, Anthropic, Gemini, Groq, Deepgram, etc.) | Gemini + OpenAI-compatible only |
| Computer Use | Not yet implemented | Native Gemini Computer Use API + vision-based fallback |
| Screen Control | Accessibility API (get_accessibility_info) | robotjs (mouse + keyboard) + Computer Use API |
| Voice Input | Not in agent mode | Wake word + Vosk STT |
| Voice Output | Not in agent mode | ElevenLabs / Yandex Alice TTS |
| Memory | Conversation log + transcriptions | Per-persona session files + extracted facts |
| Personas | Not present | Full persona system with per-persona prompts, memory, facts, TTS voice |
| Permission UI | `ToolPermissionCard` in chat | `PermissionIsland` overlay |
| Risk Gating | Not yet implemented | LLM self-assessed risk levels (low/medium/high/critical) |
| Context Caching | Not present | Gemini explicit caching with SHA-256 fingerprinting |
| Fact Extraction | Not present | Post-response LLM call with structured output |
| Task Planning | Not present | 2–5 step decomposition with MicrotaskQueue |
| Humanize / De-slop | Prompt + post-hoc scrubber | Not present |
| Hallucination Filtering | Silence phrase filtering in agent strategy | Not present |
| Platform | macOS, Windows, Linux | Windows only |
| Status | Active, in beta | Archived at v0.2.3 |

### 3.2 Key Innovation Differences

**mausVoice innovations**:
- Shared tool registry with scope-based filtering and user enablement.
- Humanize skill as first-class prompt component with post-hoc safety net.
- Silence hallucination filtering applied selectively per language.
- Safe side-effect wrapping (`safeSideEffect` / `logOnRejection`) preventing agent loop termination on persistence failures.
- Review-before-insert workflow (`PendingPasteReviewBubble`).

**Atlas innovations**:
- Native Gemini Computer Use API integration with coordinate normalization.
- Vision-based action loop with post-action screenshot verification.
- Intent classification routing (chat / direct / action) before agent loop.
- Per-persona context caching with fingerprint-based invalidation.
- Fact extraction from conversations (Identity, Preferences, Context).
- Microtask queue for sequential task visualization.
- Wake-word-activated voice input with silence timers.
- Dual-format TTS pipeline (MSE for ElevenLabs, Blob URL for Alice).
- Agent cursor animation with click/type/scroll effects.
- Orb status indicator with speed interpolation.

### 3.3 Applicability to mausVoice

Concepts from Atlas that could enhance mausVoice agent mode:
1. **Intent classification**: Route commands to direct/action/chat before agent loop.
2. **Computer Use API**: Gemini native computer_use for precise screen interaction.
3. **Context caching**: Gemini prompt caching for token optimization.
4. **Fact extraction**: Mine user preferences and identity from conversations.
5. **Task planning**: Decompose complex commands into visible steps.
6. **Voice output**: TTS for agent responses (ElevenLabs + local fallback).
7. **Voice input**: Wake word + local STT for hands-free activation.
8. **Risk gating**: LLM self-assessed risk with permission prompts.
9. **Post-action verification**: Screenshot comparison after visual actions.
10. **Persona system**: Per-persona prompts, memory, and voices.

Concepts from mausVoice that could enhance Atlas:
1. **Tool registry pattern**: Declarative registration with scope and enablement.
2. **Humanize skill**: Two-layer de-slop (prompt + scrubber).
3. **Safe side-effect wrapping**: Prevent agent loop termination on infrastructure failures.
4. **Hallucination filtering**: Language-aware silence phrase stripping.
5. **Review-before-insert**: User confirmation of agent-generated text.

---

*Document generated from analysis of mausVoice PR #236 (arena/0.1.6-consolidation) and Atlas commit history. Both repositories are public under open-source licenses.*
