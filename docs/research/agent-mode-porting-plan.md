# Atlas-to-mausVoice Agent Mode Port: Full Implementation Plan

## Objective

Port Atlas's complete agentic feature set into mausVoice's existing agent mode (PR #236), keeping the implementation model-agnostic and streamlined for the Tauri + React + TypeScript + Zustand stack.

## Current State (mausVoice PR #236 — arena/0.1.6-consolidation)

### What Already Exists

**Core agent loop (`packages/agent`):**
- `AgentLoop` — generic async-generator loop with abort, streaming, and sequential tool execution
- Types: `AgentConfig`, `AgentEvent`, `AgentTool`, `AgentLlmProvider`, `AgentFinishReason`
- Tests: 12 cases covering tool execution, abort semantics, large batches, error recovery

**Desktop adapter (`apps/desktop/src/agents`):**
- `run-agent.ts` — bridges `AgentLoop` to Zustand state, chat persistence, streaming UI
- `agent-configs.ts` — `CHAT_AGENT_CONFIG` with system prompt and tool filter
- `agent.strategy.ts` — dictation-triggered activation, hallucination filtering

**Tool system:**
- 4 registered tools: `paste`, `get_accessibility_info`, `end_conversation`, `run_terminal_command`
- Declarative `TOOL_REGISTRY` with scope filtering (`pill` vs `chat`)
- Permission flow: always-allow → request permission → poll → execute
- Permission timeout configurable via `agentPermissionTimeoutMs`

**State and persistence:**
- `AgentRunState` — status, iteration, tool calls, aborted flag
- `StreamingMessageState` — live streaming assistant messages
- Chat messages persisted with metadata for tool results and reasoning

**Provider layer:**
- `@maus-inc/voice-ai` already supports 10+ providers (OpenAI, Anthropic, Gemini, Groq, Ollama, OpenRouter, Azure, DeepSeek, Claude, Cerebras)
- `getAgentRepo()` returns any `BaseGenerateTextRepo` with `streamChat()`
- Model discovery and fallback chains already implemented

**User preferences:**
- `agentEnabledTools` — tool allow-set
- `agentMaxIterations` — 1–100, default 20
- `agentPermissionTimeoutMs` — 5s–600s, default 60s

### What's Missing (Atlas Feature Gaps)

| # | Atlas Feature | mausVoice Status | Priority |
|---|---|---|---|
| 1 | Screen capture tool | Missing | P0 |
| 2 | Mouse/keyboard simulation | Missing | P0 |
| 3 | Vision-based action loop | Missing | P0 |
| 4 | Computer-use API integration | Missing | P0 |
| 5 | Task planning / microtask decomposition | Missing | P1 |
| 6 | Intent classification (chat/direct/action) | Missing | P1 |
| 7 | Long-term memory / fact extraction | Missing | P1 |
| 8 | Persona system | Missing | P2 |
| 9 | Hybrid accessibility + screenshot perception | Partial (a11y exists, no screenshot) | P1 |
| 10 | Set-of-marks (SOM) element indexing | Missing | P2 |
| 11 | Loop stuck-detection | Missing | P1 |
| 12 | Context caching per provider | Missing | P1 |
| 13 | Tauri-native shell/screen/input commands | Missing | P0 |
| 14 | Onboarding / feature release dialog | Missing | P2 |
| 15 | Permission risk tiers (low/medium/high/critical) | Missing | P1 |

## Model-Agnostic Architecture Decisions

### Provider Abstraction Strategy

**Do NOT replace the existing provider layer.** The `generate-text.repo.ts` already provides a clean abstraction over 10+ providers via `@maus-inc/voice-ai`. The agent mode consumes any repo implementing `streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent>`.

**What IS needed at the agent layer:**

1. **Provider capabilities declaration** — a runtime type describing what each provider/model supports, so the agent loop can route intelligently without hardcoding provider names
2. **Computer-use adapter interface** — a portable action schema that maps to Gemini `computer_use` / Anthropic `computer_toolset_20260801` / vision+structured-output fallback
3. **Context assembly hints** — per-provider cache configuration for system prompts and tool definitions

### Tool Abstraction Strategy

**Extend the existing `TOOL_REGISTRY` pattern.** Each new tool is a `BaseTool` subclass with the same permission flow. No new permission paradigm needed.

New tools:
- `take_screenshot` — capture screen via Tauri plugin/Rust sidecar
- `mouse_move`, `mouse_click`, `mouse_scroll` — input simulation
- `type_text`, `press_key` — keyboard input
- `run_shell_command` — shell execution with permission gating
- `get_accessibility_info` — extend for computer-use hybrid mode

### Agent Mode Routing

Add mode routing at the strategy level (`agent.strategy.ts`):
- `chat` — existing text-only mode (already implemented)
- `action` — new vision-based mode (screenshot → LLM → structured action → execute → verify)
- `computer-use` — native provider computer-use API when available, falls back to `action`

The existing `AgentLoop` handles all modes. Mode-specific logic lives in:
- `agent-configs.ts` — system prompts, tool filters, max iterations per mode
- `run-agent.ts` — mode-specific event handling
- New `action-loop.ts` — vision-based observe-decide-act cycle

## Phased Implementation Plan

### Phase 1: Provider Capabilities + Computer-Use Abstraction

**Goal:** Make the agent aware of provider capabilities and add a portable computer-use abstraction.

**New files:**
- `packages/types/src/ai-llm.types.ts` — add `ProviderCapabilities`, `ComputerUseAction`, `ComputerUseEnvironment`
- `packages/agent/src/computer-use.ts` — adapter interface + no-op fallback

**Modified files:**
- `packages/agent/src/types.ts` — extend `AgentConfig` with `providerCapabilities` and `computerUseAdapter`
- `packages/agent/src/index.ts` — export new types
- `apps/desktop/src/agents/agent-configs.ts` — add action/computer-use configs
- `apps/desktop/src/agents/run-agent.ts` — add mode routing

**Key types:**

```typescript
// packages/types/src/ai-llm.types.ts
export type ComputerUseEnvironment = "browser" | "desktop" | "mobile";

export type ComputerUseAction =
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { type: "double_click"; x: number; y: number }
  | { type: "type"; x: number; y: number; text: string }
  | { type: "key"; keys: string[] }
  | { type: "scroll"; x: number; y: number; direction: "up" | "down"; amount: number }
  | { type: "drag"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: "screenshot" }
  | { type: "wait"; ms: number }
  | { type: "done"; result: string }
  | { type: "fail"; reason: string };

export type ProviderCapabilities = {
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsVision: boolean;
  supportsComputerUse: boolean;
  supportsStructuredOutput: boolean;
  supportsThinking: boolean;
  computerUseEnvironment?: ComputerUseEnvironment;
};
```

**Provider capability detection:**
- Detect from model name patterns (e.g., `gemini-*-computer-use*`, `claude-*-computer-use`)
- Detect from provider metadata (`@maus-inc/voice-ai` model catalogs)
- Fall back to feature probes (vision capability test, structured output test)

**Computer-use adapter interface:**

```typescript
// packages/agent/src/computer-use.ts
export interface AgentComputerUseAdapter {
  readonly provider: ProviderCapabilities;
  readonly environment: ComputerUseEnvironment;

  buildToolDefinition(): LlmTool;
  mapResponseToActions(events: LlmStreamEvent[]): ComputerUseAction[];
  formatActionResult(action: ComputerUseAction, result: unknown): LlmMessage;
}
```

**Implementations:**
- `GeminiComputerUseAdapter` — maps `functionCall` parts to `ComputerUseAction[]`
- `AnthropicComputerUseAdapter` — maps `tool_use` blocks with `toolset_name: "computer"` to `ComputerUseAction[]`
- `VisionActionAdapter` — maps `Output.object({ schema: ActionSchema })` to `ComputerUseAction[]` (fallback)

### Phase 2: Tauri-Native Tool Implementations

**Goal:** Expose screen capture, input simulation, and shell execution as agent tools.

**New Rust commands (`src-tauri/src/commands.rs`):**

```rust
#[tauri::command]
async fn take_screenshot(display_id: Option<u32>) -> Result<ScreenshotResult, String>;

#[tauri::command]
async fn mouse_move(x: i32, y: i32) -> Result<(), String>;

#[tauri::command]
async fn mouse_click(x: i32, y: i32, button: MouseButton) -> Result<(), String>;

#[tauri::command]
async fn mouse_scroll(direction: ScrollDirection, amount: i32) -> Result<(), String>;

#[tauri::command]
async fn type_text(text: String) -> Result<(), String>;

#[tauri::command]
async fn press_key(key: String) -> Result<(), String>;

#[tauri::command]
async fn run_shell_command(command: String, args: Vec<String>) -> Result<CommandResult, String>;
```

**New Tauri commands (`apps/desktop/src/actions/native.actions.ts`):**
- Wrap each Rust command with error handling and logging

**New tool files (`apps/desktop/src/tools/`):**
- `take-screenshot.tool.ts` — `TakeScreenshotTool`
- `mouse-control.tool.ts` — `MouseMoveTool`, `MouseClickTool`, `MouseScrollTool`
- `keyboard-control.tool.ts` — `TypeTextTool`, `PressKeyTool`
- `shell-exec.tool.ts` — `RunShellCommandTool` (extends existing, adds risk tier)

**Tool registration (`apps/desktop/src/tools/index.ts`):**
- Register all new tools in `TOOL_REGISTRY`
- Scope: `take_screenshot`, mouse/keyboard tools are `undefined` (both pill and chat)
- `run_shell_command` already scoped to power mode

**Rust dependencies (`src-tauri/Cargo.toml`):**
```toml
xcap = "0.9"                    # screen capture (Windows/macOS/Linux X11)
enigo = { version = "0.6", features = ["with_serde"] }  # input simulation
pixelcoords-core = "0.9"        # multi-monitor coordinate mapping
```

**Tauri plugins (`src-tauri/Cargo.toml` + `src-tauri/src/commands.rs`):**
```toml
tauri-plugin-screenshots = "2"   # TypeScript screenshot API
tauri-plugin-user-input = "0.1"  # TypeScript input simulation
tauri-plugin-shell = "2"         # TypeScript shell execution
```

**Coordinate mapping:**
- Use `pixelcoords-core` for monitor-local to global physical coordinate conversion
- Use `winit::dpi` for logical ↔ physical pixel conversion
- Return both logical and physical coordinates in `ScreenshotResult` so the agent can map actions correctly

**Screenshot format:**
- JPEG at 1280px width (matching Atlas's `screenshotMaxWidth`)
- Quality 80 (matching Atlas)
- PNG mode for computer-use API compliance (Gemini requires PNG in `function_response`)

### Phase 3: Vision-Based Action Loop

**Goal:** Add a new agent mode that sees the screen and acts on it.

**New files:**
- `packages/agent/src/action-loop.ts` — vision-based agent loop
- `packages/agent/src/action-schema.ts` — `ActionSchema` Zod definition
- `apps/desktop/src/agents/action-runner.ts` — desktop adapter for action mode

**Architecture:**

```
action-loop.ts:
  1. Take screenshot (via take_screenshot tool or direct Tauri call)
  2. Build messages: system prompt + task + screenshot image + action history
  3. Call LLM with Output.object({ schema: ActionSchema }) or computer-use adapter
  4. Parse structured action(s)
  5. Execute action via tools (mouse, keyboard, shell)
  6. Take verification screenshot (optional, configurable)
  7. Check if action succeeded:
     - Heuristic: screen changed significantly?
     - LLM verifier: "Did this action achieve the goal?"
  8. Detect stuck loops:
     - Exact repeat: same action 3x in a row
     - Category dominance: same action type 5x in a row
     - Time stall: no progress for N iterations
  9. Repeat until done/fail/max iterations
```

**Action schema:**

```typescript
// packages/agent/src/action-schema.ts
import { z } from "zod";

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number(), y: z.number(), button: z.enum(["left", "right", "middle"]).optional() }),
  z.object({ type: z.literal("double_click"), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("type"), x: z.number(), y: z.number(), text: z.string() }),
  z.object({ type: z.literal("key"), keys: z.array(z.string()) }),
  z.object({ type: z.literal("scroll"), x: z.number(), y: z.number(), direction: z.enum(["up", "down"]), amount: z.number() }),
  z.object({ type: z.literal("drag"), from: z.tuple([z.number(), z.number()]), to: z.tuple([z.number(), z.number()]) }),
  z.object({ type: z.literal("screenshot") }),
  z.object({ type: z.literal("wait"), ms: z.number() }),
  z.object({ type: z.literal("done"), result: z.string() }),
  z.object({ type: z.literal("fail"), reason: z.string() }),
]);

export type Action = z.infer<typeof ActionSchema>;
```

**System prompt for action mode:**
- Load from `action.md` (similar to Atlas's prompt system)
- Include rules: JSON only, one step per response, use existing windows, risk self-assessment
- Append `HUMANIZE_SKILL_TEXT` for slop-free output

**Computer-use routing in `run-agent.ts`:**

```typescript
if (config.mode === "computer-use" && config.computerUseAdapter) {
  // Use native computer-use API (Gemini/Anthropic)
  yield* runComputerUseLoop(loop, messages, config);
} else if (config.mode === "action") {
  // Use vision + structured output fallback
  yield* runActionLoop(loop, messages, config);
} else {
  // Existing chat mode
  yield* loop.run(messages);
}
```

### Phase 4: Task Planning + Memory

**Goal:** Add Atlas's task decomposition and long-term memory.

**New files:**
- `apps/desktop/src/agents/task-planner.ts` — decompose task into steps
- `apps/desktop/src/agents/microtask-queue.ts` — queue of pending steps
- `apps/desktop/src/agents/fact-extractor.ts` — fire-and-forget fact extraction

**Task planner:**

```typescript
// apps/desktop/src/agents/task-planner.ts
export interface TaskStep {
  id: string;
  description: string;
  status: "queued" | "active" | "done" | "failed";
  createdAt: number;
}

export class TaskPlanner {
  async planSteps(task: string, context?: string): Promise<TaskStep[]> {
    // LLM structured call decomposes task into 2–5 steps
    // Falls back to empty array on failure
  }

  activateNextStep(steps: TaskStep[]): TaskStep | null {
    // Activate next queued step or create ad-hoc step
  }

  markStep(steps: TaskStep[], stepId: string, status: TaskStep["status"]): TaskStep[] {
    // Mark step done/failed, emit update
  }
}
```

**Memory:**
- Short-term: existing chat history (sufficient for conversation context)
- Long-term: fire-and-forget fact extraction after each agent response
  - Secondary LLM call with `extract_facts.md` prompt
  - Deduplicate against existing facts
  - Store in `state.factsByPersonaId[personaId]`
  - Max 2 facts per conversation

**Fact extraction prompt categories:**
- Identity (name, role)
- Preferences (favorite tools, preferred workflow)
- Context (current project, active window)
- Never extract: specific numbers, temporary states, conversation mechanics

### Phase 5: Permission Gating + Safety

**Goal:** Add risk-tiered permissions for desktop actions.

**New types (`packages/types/src/ai-tool.types.ts`):**

```typescript
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ToolInfo {
  id: string;
  description: string;
  instructions: string;
  schema: JSONSchema;
  scope?: ToolScope;
  risk?: RiskLevel;
}
```

**Risk mapping:**
- `low` — reading screen info, taking screenshots, getting accessibility info
- `medium` — typing text, pressing keys, running read-only shell commands
- `high` — mouse clicks, scrolling, running shell commands with side effects
- `critical` — running arbitrary shell, modifying system settings, deleting files

**Permission flow extension:**
- Low-risk tools: auto-approve (no permission dialog)
- Medium-risk: show permission dialog with "Always allow" option
- High-risk: show permission dialog, require explicit approval each time
- Critical: show warning dialog with confirmation, log to audit trail

**UI components:**
- `ToolPermissionCard` — already exists, extend with risk level indicator
- `RiskBadge` — small colored badge showing risk level
- `PowerModeWarning` — already exists, extend for high/critical tools

### Phase 6: Onboarding + Feature Release

**Goal:** Introduce agent mode to existing users.

**New files:**
- `apps/desktop/src/components/settings/FeatureReleaseDialog.tsx`
- `apps/desktop/src/actions/onboarding.actions.ts` — add feature release tracking

**Feature release flow:**
- Triggered for users created before `CURRENT_FEATURE_DATE` who have not dismissed it
- Community plan: 4 pages — Intro → Processor (select AI provider) → Hotkey → Try It
- Non-community: 3 pages — Intro → Hotkey → Try It
- Confetti on first open
- Track dismissal in `preferences.types.ts` (`lastSeenAgentFeature`)

## Dependencies to Add

### Tauri Plugins (TypeScript)

```bash
pnpm add tauri-plugin-screenshots-api
pnpm add tauri-plugin-user-input-api
pnpm add @tauri-apps/plugin-shell
```

### Rust Crates

```toml
# src-tauri/Cargo.toml
[dependencies]
xcap = "0.9"                    # screen capture
enigo = { version = "0.6", features = ["with_serde"] }  # input simulation
pixelcoords-core = "0.9"        # multi-monitor coordinate mapping
tauri-plugin-screenshots = "2"  # screenshot plugin
tauri-plugin-user-input = "0.1" # input plugin
tauri-plugin-shell = "2"        # shell plugin
```

### NPM Packages

```bash
pnpm add zod  # if not already present (for ActionSchema)
```

## Testing Strategy

### Unit Tests

- **New tools:** Mock Tauri commands, verify tool execution, permission flow, error handling
- **Action schema:** Zod validation, edge cases, invalid actions
- **Computer-use adapters:** Mock LLM responses, verify action mapping for Gemini/Anthropic formats
- **Task planner:** Mock LLM structured output, verify step decomposition
- **Fact extractor:** Mock LLM response, verify deduplication

### Integration Tests

- **Action loop:** Mock screenshot + mock LLM + mock tool execution, verify full observe-decide-act cycle
- **Computer-use loop:** Mock native computer-use API, verify tool definition building, response mapping
- **Permission flow:** Extend existing tests for risk tiers, timeout, always-allow
- **Provider routing:** Verify correct adapter selected for provider/model combination

### E2E Tests (manual, not in CI)

- Full agent mode with vision: user triggers agent, agent captures screen, clicks button, types text
- Computer-use mode with Gemini: agent uses native `computer_use` tool
- Permission dialogs: user approves/denies high-risk actions
- Onboarding flow: new user sees feature release dialog

## Verification Gate

Before pushing any branch:
```bash
pnpm --filter desktop check-types
pnpm --filter desktop lint
pnpm --filter desktop test
pnpm --filter @repo/agent test
pnpm --filter @maus-inc/voice-ai test
```

## File Inventory

### New Files to Create

```
packages/types/src/ai-llm.types.ts          # Add ComputerUseAction, ProviderCapabilities
packages/agent/src/computer-use.ts           # Adapter interface + adapters
packages/agent/src/action-schema.ts          # ActionSchema Zod definition
packages/agent/src/action-loop.ts            # Vision-based agent loop
apps/desktop/src/agents/action-runner.ts     # Desktop adapter for action mode
apps/desktop/src/agents/task-planner.ts      # Task decomposition
apps/desktop/src/agents/microtask-queue.ts   # Step queue
apps/desktop/src/agents/fact-extractor.ts    # Fact extraction post-processing
apps/desktop/src/tools/take-screenshot.tool.ts
apps/desktop/src/tools/mouse-control.tool.ts
apps/desktop/src/tools/keyboard-control.tool.ts
apps/desktop/src/actions/native.actions.ts   # Tauri command wrappers
src-tauri/src/commands.rs                    # Native capture/input/shell commands
apps/desktop/src/components/settings/FeatureReleaseDialog.tsx
docs/research/atlas-feature-gap-analysis.md   # This file
```

### Existing Files to Modify

```
packages/agent/src/types.ts                  # Add providerCapabilities, computerUseAdapter
packages/agent/src/index.ts                  # Export new types
packages/agent/src/agent-loop.ts             # No changes needed (already mode-agnostic)
apps/desktop/src/agents/run-agent.ts         # Add mode routing, action loop integration
apps/desktop/src/agents/agent-configs.ts     # Add action/computer-use configs
apps/desktop/src/agents/agent.strategy.ts    # Add action mode activation
apps/desktop/src/tools/index.ts              # Register new tools
packages/types/src/ai-tool.types.ts          # Add RiskLevel
packages/types/src/preferences.types.ts      # Add lastSeenAgentFeature
apps/desktop/src/actions/onboarding.actions.ts # Add feature release tracking
src-tauri/Cargo.toml                         # Add new dependencies
src-tauri/src/commands.rs                    # Register new commands
```

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Linux Wayland screen capture not supported | Fall back to `xdg-desktop-portal` with user consent prompt; disable computer-use mode on Wayland |
| macOS TCC permissions (Screen Recording, Accessibility) | Detect and request permissions on first use; graceful degradation with user guidance |
| Coordinate mapping bugs on multi-monitor mixed-DPI | Use `pixelcoords-core` for monitor-aware mapping; log coordinate transformations for debugging |
| Provider-specific tool calling differences | Adapter layer isolates provider quirks; test each provider's tool calling path |
| Action loop stuck in infinite loop | Max iterations, stuck-detection (exact repeat, category dominance, time stall), abort button |
| Shell command security | Allowlist in Tauri capabilities; never expose `shell:allow-execute` without `cmd` restriction; risk-tiered permissions |
| Computer-use API cost | Cache screenshots, use cheaper models for planning, rate-limit iterations |

## Open Questions

1. **Should we use `tauri-plugin-user-input` or direct `enigo`?** Plugin provides cleaner TS API but adds dependency; direct `enigo` gives more control. Recommendation: start with plugin, fall back to direct if needed.

2. **Should action loop live in TypeScript or Rust?** TypeScript keeps it consistent with existing agent code; Rust would be faster for image processing. Recommendation: TypeScript for v1, move to Rust if performance becomes an issue.

3. **Should we support OpenAI Computer Use (Responses API)?** Requires different API surface; Gemini/Anthropic cover most use cases. Recommendation: defer to Phase 7 unless user demand.

4. **Should persona system be ported from Atlas?** Atlas's persona system is tightly coupled to its Electron architecture. Recommendation: defer; use existing chat history + fact extraction instead.

## Success Criteria

- [ ] Agent can capture screenshot and describe screen content
- [ ] Agent can click, type, scroll, and press keys on any desktop app
- [ ] Agent can run shell commands with permission gating
- [ ] Vision-based action loop works with any vision-capable provider
- [ ] Native computer-use API works with Gemini and Anthropic
- [ ] Task planning decomposes complex tasks into steps
- [ ] Fact extraction remembers user preferences across conversations
- [ ] Permission system prevents unauthorized desktop control
- [ ] Onboarding dialog introduces agent mode to existing users
- [ ] All existing tests pass, new tests cover new functionality

## Timeline Estimate

| Phase | Effort | Dependencies |
|---|---|---|
| 1: Provider capabilities + computer-use abstraction | 2–3 days | None |
| 2: Tauri-native tools | 3–4 days | Phase 1 |
| 3: Vision-based action loop | 3–4 days | Phase 2 |
| 4: Task planning + memory | 2–3 days | Phase 1 |
| 5: Permission gating + safety | 2–3 days | Phase 2 |
| 6: Onboarding + feature release | 2–3 days | None |
| **Total** | **14–20 days** | |

## References

- Atlas codebase analysis: `docs/research/agent-mode-atlas-analysis.md`
- Model-agnostic agent loop architectures: `docs/research/model-agnostic-agent-loop-architectures.md`
- mausVoice PR #236: arena/0.1.6-consolidation
- Tauri desktop automation crates: `xcap`, `enigo`, `pixelcoords-core`, `tauri-plugin-user-input`
- Reference implementations: `suitedaces/computer-agent`, `shlawgathon/Computer-Use`, `pipi-shrimp-agent`
