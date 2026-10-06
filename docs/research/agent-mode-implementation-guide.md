# Agent Mode Full Port: Master Implementation Guide

This is the master implementation guide for porting Atlas's full agentic feature set into mausVoice's existing agent mode. It synthesizes all research into actionable steps with exact file paths, code patterns, and verification criteria.

## Document Index

1. `docs/research/agent-mode-atlas-analysis.md` — Complete analysis of mausVoice PR #236 and Atlas codebase
2. `docs/research/model-agnostic-agent-loop-architectures.md` — Research on provider abstraction, tool calling, computer use, vision loops, context caching
3. `docs/research/agent-mode-porting-plan.md` — Phased implementation plan with file inventory and timeline
4. `docs/research/agent-mode-implementation-guide.md` — This document. Master guide with exact implementation steps.

## Ground Rules (Non-Negotiable)

These rules are enforceable and must be followed without exception. Violations block merge.

### 1. Model Agnosticism Is the Primary Constraint

Every new piece of code must work with at least two different LLM providers without modification. Hardcoding provider-specific behavior in the agent loop, tool definitions, or system prompts is a defect.

- All new types go in `packages/types/src/` and must be exported from `packages/types/src/index.ts`.
- The agent loop must never reference a specific provider name (no `if (provider === "gemini")` in `packages/agent`).
- Provider-specific translation lives in adapter implementations (`GeminiComputerUseAdapter`, `AnthropicComputerUseAdapter`, etc.), never in the core loop.
- If a new provider capability is needed, add it to `ProviderCapabilities`, do not sprinkle `model.includes("gpt-4o")` checks throughout the loop.

### 2. Existing Agent Mode Must Not Break

PR #236's agent mode is already in production. Every change must preserve:
- Chat mode streaming and tool execution
- Permission gating flow (always-allow → request → poll → execute)
- Abort semantics (`loop.abort()` stops the run, does not leave dangling state)
- Message persistence (`safeSideEffect` wrapper must stay in place)
- Streaming message state machine (`iteration-start` → `text-delta` → `tool-call-start` → `tool-call-result` → `finish`)

No removing fields from `AgentRunState`, `StreamingMessageState`, or `ChatMessage` without a migration path.

### 3. Tauri Security Is Not Optional

- All shell commands must be allowlisted in `src-tauri/capabilities/*.json`. Never use `shell:allow-execute` without a `cmd` restriction.
- Screenshot and input commands must be scoped to the `main` window only. No global hotkeys or background capture without explicit user consent.
- No new `dangerousDisableAssetCspModification` entries beyond the existing `["style-src"]`.
- No secrets, API keys, or tokens in Rust logs or TypeScript console output. Use `getLogger().verbose()` with sanitized context only.
- All Rust commands must return `Result<T, String>` and never panic on user input.

### 4. Rust Is the API, TypeScript Is the Brain

- Rust commands do exactly one thing: native OS interaction (capture, input, shell).
- All agent logic, provider routing, tool orchestration, and state management stays in TypeScript.
- Do not move agent loop logic to Rust "for performance." The loop is I/O-bound, not CPU-bound.
- Rust types exposed to TypeScript must be serializable JSON only. No `Uint8Array` in objects—use base64 strings.

### 5. Permission Gating Is Mandatory for All Desktop Actions

Every tool that affects the user's system must have:
- A `risk` metadata field (`low`, `medium`, `high`, `critical`).
- A permission flow that respects the risk tier (low=auto, medium=prompt, high=confirm, critical=warning).
- A user-facing description in plain language, not a raw tool name.
- An "Always allow" option scoped to the action type, not just the session.

Tools without `risk` metadata are blocked from registration. This is enforced at build time via a lint rule or at runtime via a guard in `createTool()`.

### 6. No Electron Patterns

- No `robotjs`, `screenshot-desktop`, `electron-window-state`, or any Electron-specific dependency.
- No Node.js `child_process` in the renderer. Shell execution goes through Tauri commands only.
- No `BrowserWindow` manipulation from TypeScript. Window management stays in Rust.
- No IPC patterns that expose raw Electron APIs. All privileged calls go through `#[tauri::command]`.

### 7. Tests Are Part of "Done"

A feature is not complete until its tests pass. Specifically:
- Every new tool must have a unit test covering: happy path, error path, permission denied.
- Every new agent loop must have integration tests with a scripted provider and fake screenshots.
- Every new Rust command must have a Rust unit test (`#[cfg(test)]`) or integration test.
- Computer-use adapters must be tested against both Gemini and Anthropic response formats.
- Permission flow tests must cover all four risk tiers.

No `// TODO: add tests` comments are allowed in merged code.

### 8. Coordinate Mapping Must Use Physical Pixels

- All screenshot dimensions and coordinates are in physical pixels.
- All Rust input commands (`mouse_move`, `mouse_click`) receive physical pixel coordinates.
- The TypeScript tool layer is responsible for any user-facing logical-to-physical conversion.
- DPI scaling bugs are silent (click the wrong place, no error). Always log the coordinate transformation.

### 9. Abort Signals Propagate End-to-End

- Every `AgentLoop.run()` accepts an `AbortSignal`.
- Every tool `execute()` must check for abort before starting and during long operations.
- Every Rust command that takes >100ms must accept a cancellation token or be cancellable via `AbortController`.
- The Stop button in the UI must abort the loop, cancel in-flight LLM requests, and cancel in-flight tool execution within 500ms.

### 10. No New LLM Provider Dependencies

- Do not add a new provider SDK to `package.json` without first checking if `@maus-inc/voice-ai` already supports it.
- If a new provider is needed, it must be added to `packages/voice-ai` first, then consumed by the agent layer.
- Do not add `langchain`, `llamaindex`, or any other LLM framework. The existing `BaseGenerateTextRepo` abstraction is sufficient.
- Do not add the Vercel AI SDK unless the team explicitly approves the dependency. The existing abstraction works.

### 11. Screenshot Size and Compression Are Fixed

- Screenshots sent to the LLM must be JPEG, 1280px width, quality 80.
- PNG mode is only used for computer-use API compliance (Gemini `function_response` requires PNG).
- Uncompressed screenshots are never sent to the LLM. This is enforced in the tool implementation, not left to the caller.

### 12. Error Handling Is Non-Negotiable

- Every Rust command must return `Result<T, String>` with a descriptive error message.
- Every TypeScript tool `execute()` must catch errors and return `{ success: false, failureReason }`. Never throw.
- Every LLM stream error must yield a `finish` event with `reason: "error"` and a human-readable message.
- Every side effect in `run-agent.ts` must use `safeSideEffect()`. No exceptions.

### 13. No UI Changes Without Accessibility

- Every new dialog must have `role="dialog"`, `aria-labelledby`, and `aria-describedby`.
- Every new status indicator must have an `aria-live` region.
- Permission dialogs must trap focus and restore focus on close.
- `Esc` must dismiss every modal or stop the agent.
- All colors must pass WCAG AA contrast against their background.

### 14. Documentation Must Be Updated Before Merge

- Every new tool must be documented in `apps/desktop/src/tools/README.md` (create if missing).
- Every new Rust command must be documented in `src-tauri/src/commands/README.md` (create if missing).
- Every new agent mode must be documented in `apps/docs/src/content/docs/agent-mode.md`.
- The implementation guide (`docs/research/agent-mode-implementation-guide.md`) must be updated with actual file paths and any deviations from the plan.

### 15. No Scope Creep

- Personas, memory, and fact extraction are deferred to Phase 4. Do not implement them during Phase 1-3.
- OpenAI Computer Use is deferred. Do not implement it unless the team explicitly requests it after Phase 3 is complete.
- Vercel AI SDK adoption is deferred. Do not add it unless the existing `@maus-inc/voice-ai` layer proves insufficient.
- Linux Wayland computer-use mode is disabled if `xdg-desktop-portal` is unavailable. Do not attempt to implement Wayland screen capture in Phase 1-3.

### 16. Code Review Checklist Is Mandatory

Before requesting review, the implementer must verify:
- [ ] All new Rust code compiles on Windows, macOS, and Linux (use `cargo check --target x86_64-pc-windows-msvc` etc.)
- [ ] All new TypeScript passes `check-types`, `lint`, and `test` for the desktop package
- [ ] No new `any` types in TypeScript
- [ ] No `unsafe` blocks in Rust without a comment explaining why
- [ ] No hardcoded API keys, tokens, or URLs
- [ ] No `console.log` in production code (use `getLogger()`)
- [ ] All error messages are user-facing-safe (no stack traces, no internal paths)
- [ ] All new permissions are documented in `src-tauri/capabilities/README.md`

## Implementation Roadmap

### Week 1: Foundation (Phases 1 + 2)

**Days 1-2: Provider capabilities + computer-use abstraction**
- Add `ProviderCapabilities`, `ComputerUseAction` types to `packages/types/src/ai-llm.types.ts`
- Add `AgentComputerUseAdapter` interface to `packages/agent/src/types.ts`
- Implement `GeminiComputerUseAdapter` and `AnthropicComputerUseAdapter` in `packages/agent/src/computer-use.ts`
- Implement `VisionActionAdapter` as fallback in `packages/agent/src/action-schema.ts`
- Add provider capability detection in `apps/desktop/src/utils/provider-capabilities.ts`

**Days 3-5: Tauri-native tools**
- Add Rust dependencies to `src-tauri/Cargo.toml`: `xcap`, `enigo`, `pixelcoords-core`
- Implement Rust commands in `src-tauri/src/commands.rs`:
  - `take_screenshot(display_id?) -> ScreenshotResult`
  - `mouse_move(x, y)`, `mouse_click(x, y, button)`, `mouse_scroll(direction, amount)`
  - `type_text(text)`, `press_key(key)`
  - `run_shell_command(command, args) -> CommandResult`
- Register commands in `src-tauri/src/commands/mod.rs`
- Add TypeScript wrappers in `apps/desktop/src/actions/native.actions.ts`
- Implement tools in `apps/desktop/src/tools/`:
  - `take-screenshot.tool.ts`
  - `mouse-control.tool.ts`
  - `keyboard-control.tool.ts`
  - `shell-exec.tool.ts` (extends existing)
- Register tools in `apps/desktop/src/tools/index.ts`
- Add Tauri capability configuration in `src-tauri/capabilities/agent-automation.json`

### Week 2: Agent Loop Extensions (Phases 3 + 4)

**Days 6-8: Vision-based action loop**
- Implement `ActionSchema` in `packages/agent/src/action-schema.ts`
- Implement `ActionLoop` in `packages/agent/src/action-loop.ts`
- Implement `ComputerUseLoop` in `packages/agent/src/computer-use-loop.ts`
- Add action mode configs in `apps/desktop/src/agents/agent-configs.ts`
- Add mode routing in `apps/desktop/src/agents/run-agent.ts`
- Add action system prompts (`action.md`, `computer_use.md`, `verify_action.md`)

**Days 9-10: Task planning + memory**
- Implement `TaskPlanner` in `apps/desktop/src/agents/task-planner.ts`
- Implement `MicrotaskQueue` in `apps/desktop/src/agents/microtask-queue.ts`
- Implement `FactExtractor` in `apps/desktop/src/agents/fact-extractor.ts`
- Add fact storage to Zustand state
- Fire-and-forget fact extraction in `run-agent.ts` finish handler

### Week 3: Safety + Polish (Phases 5 + 6)

**Days 11-12: Permission gating + safety**
- Add `RiskLevel` type to `packages/types/src/ai-tool.types.ts`
- Add `risk` metadata to `ToolInfo`
- Implement risk-based permission flow in `apps/desktop/src/actions/tool.actions.ts`
- Add `RiskBadge` component to settings UI
- Update `ToolPermissionCard` with risk level display
- Add autonomy mode selector (Watch/Assist/Autonomous) to header

**Days 13-14: Onboarding + feature release**
- Implement `FeatureReleaseDialog` in `apps/desktop/src/components/settings/FeatureReleaseDialog.tsx`
- Add `lastSeenAgentFeature` to preferences
- Add feature release tracking to onboarding actions
- Add confetti animation on first open

## Exact Implementation Steps

### Step 1: Add Provider Capabilities Types

**File:** `packages/types/src/ai-llm.types.ts`

Add after `LlmUsage` interface:

```typescript
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

### Step 2: Add Agent Computer-Use Types

**File:** `packages/agent/src/types.ts`

Add imports and types:

```typescript
import type {
  ComputerUseAction,
  ComputerUseEnvironment,
  JSONSchema,
  LlmChatInput,
  LlmMessage,
  LlmStreamEvent,
  ProviderCapabilities,
} from "@maus-inc/types";

export interface AgentComputerUseAdapter {
  readonly provider: ProviderCapabilities;
  readonly environment: ComputerUseEnvironment;

  buildToolDefinition(): LlmTool;
  mapResponseToActions(events: LlmStreamEvent[]): ComputerUseAction[];
  formatActionResult(action: ComputerUseAction, result: unknown): LlmMessage;
}

export interface AgentConfig {
  provider: AgentLlmProvider;
  tools: AgentTool[];
  systemPrompt: string;
  maxIterations?: number;
  providerCapabilities?: ProviderCapabilities;
  computerUseAdapter?: AgentComputerUseAdapter;
}
```

### Step 3: Add Rust Dependencies

**File:** `src-tauri/Cargo.toml`

Add to `[dependencies]`:

```toml
xcap = "0.9"
enigo = { version = "0.6", features = ["with_serde"] }
pixelcoords-core = "0.9"
```

**Note:** Check existing `Cargo.toml` first. The research indicates `enigo = "0.1"` may already exist for Linux+Windows targets, and `core-graphics` for macOS. Use the existing version if present.

### Step 4: Implement Rust Commands

**File:** `src-tauri/src/commands.rs`

Add new command module:

```rust
use tauri::State;
use xcap::Monitor;
use enigo::{Enigo, Key, Keyboard, Mouse, Settings, Button, Coordinate, Direction};
use pixelcoords_core::{space::Space, native_space, to_space};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ScreenshotResult {
  pub base64: String,
  pub width: u32,
  pub height: u32,
  pub display_id: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandResult {
  pub success: bool,
  pub output: String,
  pub error: Option<String>,
}

#[tauri::command]
pub async fn take_screenshot(display_id: Option<u32>) -> Result<ScreenshotResult, String> {
  let monitors = Monitor::all().map_err(|e| e.to_string())?;
  let monitor = if let Some(id) = display_id {
    monitors.into_iter().nth(id as usize).ok_or("Invalid display ID")?
  } else {
    monitors.into_iter().next().ok_or("No monitors found")?
  };
  
  let image = monitor.capture().map_err(|e| e.to_string())?;
  let (width, height) = image.dimensions();
  
  // Encode to PNG, then base64
  let mut buf = Vec::new();
  let mut encoder = png::Encoder::new(&mut buf, width, height);
  encoder.write_header().map_err(|e| e.to_string())?;
  let mut writer = encoder.write_text().map_err(|e| e.to_string())?;
  writer.finish().map_err(|e| e.to_string())?;
  
  let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &buf);
  
  Ok(ScreenshotResult {
    base64,
    width,
    height,
    display_id: 0,
  })
}

#[tauri::command]
pub async fn mouse_move(x: i32, y: i32) -> Result<(), String> {
  let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
  enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mouse_click(x: i32, y: i32, button: String) -> Result<(), String> {
  let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
  enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string())?;
  
  let btn = match button.as_str() {
    "right" => Button::Right,
    "middle" => Button::Middle,
    _ => Button::Left,
  };
  
  enigo.button(btn, Direction::Click).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn type_text(text: String) -> Result<(), String> {
  let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
  enigo.text(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn press_key(key: String) -> Result<(), String> {
  let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
  // Map key string to enigo Key
  let enigo_key = map_key(&key)?;
  enigo.key(enigo_key, Direction::Click).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_shell_command(command: String, args: Vec<String>) -> Result<CommandResult, String> {
  use std::process::Command;
  
  let output = Command::new(&command)
    .args(&args)
    .output()
    .map_err(|e| e.to_string())?;
  
  Ok(CommandResult {
    success: output.status.success(),
    output: String::from_utf8_lossy(&output.stdout).to_string(),
    error: if output.status.success() {
      None
    } else {
      Some(String::from_utf8_lossy(&output.stderr).to_string())
    },
  })
}

fn map_key(key: &str) -> Result<Key, String> {
  match key.to_lowercase().as_str() {
    "enter" => Ok(Key::Return),
    "escape" => Ok(Key::Escape),
    "tab" => Ok(Key::Tab),
    "space" => Ok(Key::Space),
    "backspace" => Ok(Key::Backspace),
    "delete" => Ok(Key::Delete),
    "up" => Ok(Key::UpArrow),
    "down" => Ok(Key::DownArrow),
    "left" => Ok(Key::LeftArrow),
    "right" => Ok(Key::RightArrow),
    "ctrl" | "control" => Ok(Key::Control),
    "alt" => Ok(Key::Alt),
    "shift" => Ok(Key::Shift),
    "super" | "win" | "command" => Ok(Key::Super),
    _ => Err(format!("Unsupported key: {}", key)),
  }
}
```

### Step 5: Register Tauri Commands

**File:** `src-tauri/src/commands/mod.rs`

```rust
pub mod agent;

pub use agent::{
  take_screenshot, mouse_move, mouse_click, type_text, press_key, run_shell_command,
};
```

**File:** `src-tauri/src/main.rs` or `src-tauri/src/app.rs`

Add to invoke_handler:

```rust
.use(tauri_plugin_shell::init)
.use(tauri_plugin_screenshots::init)
.use(tauri_plugin_user_input::init)
```

### Step 6: Add TypeScript Action Wrappers

**File:** `apps/desktop/src/actions/native.actions.ts`

```typescript
import { invoke } from "@tauri-apps/api/core";
import { getLogger } from "../utils/log.utils";

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
  display_id: number;
}

export interface CommandResult {
  success: boolean;
  output: string;
  error?: string;
}

export async function takeScreenshot(displayId?: number): Promise<ScreenshotResult> {
  try {
    return await invoke<ScreenshotResult>("take_screenshot", { displayId });
  } catch (error) {
    getLogger().error(`Screenshot failed: ${error}`);
    throw error;
  }
}

export async function mouseMove(x: number, y: number): Promise<void> {
  await invoke("mouse_move", { x, y });
}

export async function mouseClick(x: number, y: number, button: string): Promise<void> {
  await invoke("mouse_click", { x, y, button });
}

export async function typeText(text: string): Promise<void> {
  await invoke("type_text", { text });
}

export async function pressKey(key: string): Promise<void> {
  await invoke("press_key", { key });
}

export async function runShellCommand(command: string, args: string[]): Promise<CommandResult> {
  return await invoke("run_shell_command", { command, args });
}
```

### Step 7: Implement Tauri-Native Tools

**File:** `apps/desktop/src/tools/take-screenshot.tool.ts`

```typescript
import type { BaseTool, ToolInfo, ToolInput, ToolOutput } from "./base.tool";
import { takeScreenshot } from "../actions/native.actions";

export class TakeScreenshotTool implements BaseTool {
  readonly info: ToolInfo = {
    id: "take_screenshot",
    description: "Take a screenshot of the user's screen",
    instructions: "Use this to see what's on the user's screen. Returns a base64-encoded PNG image.",
    schema: {
      type: "object",
      properties: {
        display_id: { type: "number", description: "Display ID to capture (optional)" },
      },
    },
    scope: undefined,
    risk: "low",
  };

  async execute(input: ToolInput): Promise<ToolOutput> {
    try {
      const result = await takeScreenshot(input.params.display_id as number | undefined);
      return {
        success: true,
        result: {
          base64: result.base64,
          width: result.width,
          height: result.height,
          display_id: result.display_id,
        },
      };
    } catch (error) {
      return {
        success: false,
        failureReason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
```

**File:** `apps/desktop/src/tools/mouse-control.tool.ts`

```typescript
import type { BaseTool, ToolInfo, ToolInput, ToolOutput } from "./base.tool";
import { mouseMove, mouseClick } from "../actions/native.actions";

export class MouseMoveTool implements BaseTool {
  readonly info: ToolInfo = {
    id: "mouse_move",
    description: "Move the mouse cursor to a position",
    instructions: "Move the mouse to the specified coordinates. Use logical pixels.",
    schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate (logical pixels)" },
        y: { type: "number", description: "Y coordinate (logical pixels)" },
      },
      required: ["x", "y"],
    },
    scope: undefined,
    risk: "high",
  };

  async execute(input: ToolInput): Promise<ToolOutput> {
    try {
      const { x, y } = input.params as { x: number; y: number };
      await mouseMove(x, y);
      return { success: true, result: { moved: true, x, y } };
    } catch (error) {
      return { success: false, failureReason: String(error) };
    }
  }
}

export class MouseClickTool implements BaseTool {
  readonly info: ToolInfo = {
    id: "mouse_click",
    description: "Click the mouse at a position",
    instructions: "Click the mouse button at the specified coordinates. Button can be left, right, or middle.",
    schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate (logical pixels)" },
        y: { type: "number", description: "Y coordinate (logical pixels)" },
        button: { type: "string", description: "Button to click", enum: ["left", "right", "middle"] },
      },
      required: ["x", "y"],
    },
    scope: undefined,
    risk: "high",
  };

  async execute(input: ToolInput): Promise<ToolOutput> {
    try {
      const { x, y, button } = input.params as { x: number; y: number; button?: string };
      await mouseClick(x, y, button || "left");
      return { success: true, result: { clicked: true, x, y, button: button || "left" } };
    } catch (error) {
      return { success: false, failureReason: String(error) };
    }
  }
}
```

**File:** `apps/desktop/src/tools/keyboard-control.tool.ts`

```typescript
import type { BaseTool, ToolInfo, ToolInput, ToolOutput } from "./base.tool";
import { typeText, pressKey } from "../actions/native.actions";

export class TypeTextTool implements BaseTool {
  readonly info: ToolInfo = {
    id: "type_text",
    description: "Type text into the currently focused field",
    instructions: "Type the specified text into the currently focused text field. Use this to enter text.",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
      },
      required: ["text"],
    },
    scope: undefined,
    risk: "medium",
  };

  async execute(input: ToolInput): Promise<ToolOutput> {
    try {
      const { text } = input.params as { text: string };
      await typeText(text);
      return { success: true, result: { typed: true, text } };
    } catch (error) {
      return { success: false, failureReason: String(error) };
    }
  }
}

export class PressKeyTool implements BaseTool {
  readonly info: ToolInfo = {
    id: "press_key",
    description: "Press a keyboard key or key combination",
    instructions: "Press a single key or key combination. Keys: enter, escape, tab, space, ctrl, alt, shift, etc.",
    schema: {
      type: "object",
      properties: {
        keys: { 
          type: "array", 
          items: { type: "string" },
          description: "Keys to press (e.g., ['ctrl', 'c'])" 
        },
      },
      required: ["keys"],
    },
    scope: undefined,
    risk: "medium",
  };

  async execute(input: ToolInput): Promise<ToolOutput> {
    try {
      const { keys } = input.params as { keys: string[] };
      if (keys.length === 1) {
        await pressKey(keys[0]);
      } else {
        // For combinations, press keys sequentially (or use a dedicated combo command)
        for (const key of keys) {
          await pressKey(key);
        }
      }
      return { success: true, result: { pressed: true, keys } };
    } catch (error) {
      return { success: false, failureReason: String(error) };
    }
  }
}
```

### Step 8: Register New Tools

**File:** `apps/desktop/src/tools/index.ts`

Add to `TOOL_REGISTRY`:

```typescript
import { TakeScreenshotTool } from "./take-screenshot.tool";
import { MouseMoveTool, MouseClickTool } from "./mouse-control.tool";
import { TypeTextTool, PressKeyTool } from "./keyboard-control.tool";

// Add to TOOL_REGISTRY Map:
[
  "take_screenshot",
  {
    id: "take_screenshot",
    factory: (info) => new TakeScreenshotTool(info),
    getInfo: () =>
      staticInfo(
        "take_screenshot",
        "Take a screenshot",
        "Capture the current screen content. Returns a base64-encoded PNG image.",
        {
          type: "object",
          properties: {
            display_id: { type: "number", description: "Display ID to capture (optional)" },
          },
        },
      ),
  },
],
[
  "mouse_move",
  {
    id: "mouse_move",
    factory: (info) => new MouseMoveTool(info),
    getInfo: () =>
      staticInfo(
        "mouse_move",
        "Move mouse cursor",
        "Move the mouse cursor to the specified coordinates.",
        {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
          },
          required: ["x", "y"],
        },
      ),
  },
],
[
  "mouse_click",
  {
    id: "mouse_click",
    factory: (info) => new MouseClickTool(info),
    getInfo: () =>
      staticInfo(
        "mouse_click",
        "Click mouse",
        "Click the mouse at the specified coordinates.",
        {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            button: { type: "string", enum: ["left", "right", "middle"] },
          },
          required: ["x", "y"],
        },
      ),
  },
],
[
  "type_text",
  {
    id: "type_text",
    factory: (info) => new TypeTextTool(info),
    getInfo: () =>
      staticInfo(
        "type_text",
        "Type text",
        "Type text into the currently focused field.",
        {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      ),
  },
],
[
  "press_key",
  {
    id: "press_key",
    factory: (info) => new PressKeyTool(info),
    getInfo: () =>
      staticInfo(
        "press_key",
        "Press key",
        "Press a keyboard key or key combination.",
        {
          type: "object",
          properties: {
            keys: { type: "array", items: { type: "string" } },
          },
          required: ["keys"],
        },
      ),
  },
],
```

### Step 9: Add Tauri Capability Configuration

**File:** `src-tauri/capabilities/agent-automation.json`

```json
{
  "identifier": "agent-automation",
  "description": "Agent mode desktop automation capabilities",
  "windows": ["main"],
  "permissions": [
    {
      "identifier": "shell:allow-execute",
      "allow": [
        {
          "name": "exec-sh",
          "cmd": "sh",
          "args": [{ "validator": "\\S+" }],
          "sidecar": false
        },
        {
          "name": "exec-pwsh",
          "cmd": "pwsh",
          "args": [{ "validator": "\\S+" }],
          "sidecar": false
        },
        {
          "name": "exec-powershell",
          "cmd": "powershell",
          "args": [{ "validator": "\\S+" }],
          "sidecar": false
        }
      ]
    },
    {
      "identifier": "screenshots:allow-capture",
      "allow": [{ "name": "capture" }]
    },
    {
      "identifier": "user-input:allow-simulate",
      "allow": [
        { "name": "key" },
        { "name": "text" },
        { "name": "button" },
        { "name": "moveMouse" },
        { "name": "scroll" }
      ]
    }
  ]
}
```

### Step 10: Add Agent Mode Configs

**File:** `apps/desktop/src/agents/agent-configs.ts`

Add new configs:

```typescript
import { HUMANIZE_SKILL_TEXT } from "../utils/humanize.utils";

export const ACTION_AGENT_CONFIG: AgentTypeConfig = {
  agentType: "action",
  systemPrompt: [
    "You are a helpful assistant controlling the user's desktop.",
    "You can see screenshots and perform actions like clicking, typing, and scrolling.",
    "Always explain what you're about to do before doing it.",
    "After completing a task, deliver the result concisely.",
    HUMANIZE_SKILL_TEXT,
  ].join(" "),
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
  get maxIterations() {
    return getConfiguredMaxIterations();
  },
};

export const COMPUTER_USE_AGENT_CONFIG: AgentTypeConfig = {
  agentType: "computer-use",
  systemPrompt: [
    "You are a helpful assistant with computer use capabilities.",
    "You can see the screen and control the mouse and keyboard.",
    "Use the computer_use tool to interact with the desktop.",
    "After completing a task, deliver the result concisely.",
    HUMANIZE_SKILL_TEXT,
  ].join(" "),
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
  get maxIterations() {
    return getConfiguredMaxIterations();
  },
};

export const AGENT_TYPE_CONFIGS: Readonly<Record<string, AgentTypeConfig>> = {
  chat: CHAT_AGENT_CONFIG,
  action: ACTION_AGENT_CONFIG,
  "computer-use": COMPUTER_USE_AGENT_CONFIG,
};
```

### Step 11: Add Action Schema

**File:** `packages/agent/src/action-schema.ts`

```typescript
import { z } from "zod";

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right", "middle"]).optional(),
  }),
  z.object({
    type: z.literal("double_click"),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("type"),
    x: z.number(),
    y: z.number(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("key"),
    keys: z.array(z.string()),
  }),
  z.object({
    type: z.literal("scroll"),
    x: z.number(),
    y: z.number(),
    direction: z.enum(["up", "down"]),
    amount: z.number(),
  }),
  z.object({
    type: z.literal("drag"),
    from: z.tuple([z.number(), z.number()]),
    to: z.tuple([z.number(), z.number()]),
  }),
  z.object({
    type: z.literal("screenshot"),
  }),
  z.object({
    type: z.literal("wait"),
    ms: z.number(),
  }),
  z.object({
    type: z.literal("done"),
    result: z.string(),
  }),
  z.object({
    type: z.literal("fail"),
    reason: z.string(),
  }),
]);

export type Action = z.infer<typeof ActionSchema>;
```

### Step 12: Add Risk Level Types

**File:** `packages/types/src/ai-tool.types.ts`

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

## Verification Checklist

### Before Each Phase

- [ ] `pnpm --filter @repo/agent test` — all agent package tests pass
- [ ] `pnpm --filter desktop check-types` — no TypeScript errors
- [ ] `pnpm --filter desktop lint` — no lint errors
- [ ] New files follow existing naming conventions (kebab-case for files, PascalCase for classes)
- [ ] New types are exported from `packages/types/src/index.ts` if shared

### Before Push

- [ ] All new tools have unit tests
- [ ] All new agent loops have integration tests
- [ ] Permission flow tests cover new risk tiers
- [ ] Provider capability detection tests pass
- [ ] Computer-use adapter tests pass for both Gemini and Anthropic formats
- [ ] Rust code compiles on all target platforms (Windows, macOS, Linux)
- [ ] Tauri capabilities configuration is valid JSON
- [ ] No hardcoded API keys or secrets
- [ ] Documentation updated (this file + README if needed)

## Cross-Cutting Concerns

### Error Handling

All new Rust commands must:
- Return `Result<T, String>` with descriptive error messages
- Never panic on user input
- Log errors via Tauri's logger

All new TypeScript tools must:
- Catch errors and return `{ success: false, failureReason }`
- Never throw from `execute()` — the agent loop handles failures gracefully
- Log errors via `getLogger()`

### Security

- All shell commands are allowlisted in Tauri capabilities
- Never expose `shell:allow-execute` without `cmd` restriction
- Risk-tiered permissions prevent unauthorized desktop control
- Screenshot data is never persisted unless user opts in
- No secrets in logs (use `safeSideEffect` pattern)

### Performance

- Screenshots are compressed to JPEG (1280px width, quality 80)
- PNG mode only for computer-use API compliance
- Coordinate mapping is cached per display
- Tool execution is sequential (one at a time) to avoid race conditions
- Abort signals propagate to all in-flight operations

### Accessibility

- Agent status changes announced via `aria-live="polite"`
- Permission dialogs have `role="dialog"`, `aria-labelledby`, `aria-describedby`
- Focus trap in modals
- `Esc` key dismisses dialogs
- Keyboard navigation for all UI elements

## Open Decisions

1. **Vercel AI SDK adoption:** Should we adopt the Vercel AI SDK for provider abstraction, or continue with the existing `@maus-inc/voice-ai` layer? Recommendation: defer to Phase 7. Existing layer works and is already tested.

2. **Persona system:** Atlas's persona system is complex and tightly coupled to Electron. Recommendation: defer. Use existing chat history + fact extraction instead.

3. **OpenAI Computer Use:** Requires Responses API, not Chat Completions. Recommendation: defer unless user demand.

4. **Linux Wayland support:** `xcap` doesn't work on Wayland. Recommendation: detect at runtime, fall back to `xdg-desktop-portal` with user consent, disable computer-use mode if portal unavailable.

## Next Steps After This Branch

1. Review this research with the team
2. Get approval on phased approach
3. Create GitHub project with phases as milestones
4. Start Phase 1 implementation in feature branches
5. CI/CD for Rust + TypeScript cross-platform builds
6. Dogfood agent mode internally before user release

---

## Appendix A: Tauri v2 Implementation Details

### Command Organization Pattern

```rust
// src-tauri/src/commands/mod.rs
pub mod agent;
pub mod native;

pub use agent::*;
pub use native::*;
```

### Plugin Initialization

```rust
// src-tauri/src/app.rs or src-tauri/src/main.rs
fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_screenshots::init())
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![
      take_screenshot,
      mouse_move,
      mouse_click,
      type_text,
      press_key,
      run_shell_command,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
```

### TypeScript IPC Pattern

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { ScreenshotResult, CommandResult } from "./actions/native.actions";

export async function takeScreenshot(displayId?: number): Promise<ScreenshotResult> {
  return await invoke<ScreenshotResult>("take_screenshot", { displayId });
}
```

### Error Handling Pattern

```rust
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AgentError {
  #[error("screenshot failed: {0}")]
  ScreenshotError(String),
  #[error("input simulation failed: {0}")]
  InputError(String),
  #[error("shell command failed: {0}")]
  ShellError(String),
}

impl Serialize for AgentError {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error> where S: Serializer {
    serializer.serialize_str(self.to_string().as_ref())
  }
}
```

### Binary Data Handling

**Critical:** Tauri v2 has a bug with `Uint8Array` properties inside objects. Use base64 strings for binary data (screenshots):

```rust
// Rust: encode to base64
let base64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);

// TypeScript: decode from base64
const binary = atob(result.base64);
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) {
  bytes[i] = binary.charCodeAt(i);
}
```

### Capability Configuration

```json
{
  "identifier": "agent-automation",
  "description": "Agent mode desktop automation",
  "windows": ["main"],
  "permissions": [
    {
      "identifier": "shell:allow-execute",
      "allow": [
        {
          "name": "exec-sh",
          "cmd": "sh",
          "args": [{ "validator": "\\S+" }],
          "sidecar": false
        }
      ]
    }
  ]
}
```

Reference in `tauri.conf.json`:

```json
{
  "app": {
    "withGlobalTauri": true
  },
  "plugins": {
    "shell": {
      "scope": [
        { "name": "sh", "cmd": "sh", "args": true },
        { "name": "pwsh", "cmd": "pwsh", "args": true }
      ]
    }
  }
}
```

---

## Appendix B: mausVoice Integration Points

### Strategy Registration

**File:** `apps/desktop/src/components/root/DictationSideEffects.tsx`

```typescript
// Around line 150:
const strategy =
  mode === "action"
    ? new ActionStrategy()
    : mode === "agent"
      ? new AgentStrategy()
      : new DictationStrategy();
```

### Recording Mode Type

**File:** `packages/types/src/common.types.ts`

```typescript
export type RecordingMode = "dictate" | "agent" | "action" | "computer-use";
```

### Agent Configs

**File:** `apps/desktop/src/agents/agent-configs.ts`

```typescript
export const AGENT_TYPE_CONFIGS: Readonly<Record<string, AgentTypeConfig>> = {
  chat: CHAT_AGENT_CONFIG,
  action: ACTION_AGENT_CONFIG,
  "computer-use": COMPUTER_USE_AGENT_CONFIG,
};

export const getAgentTypeConfig = (agentType = "chat"): AgentTypeConfig =>
  AGENT_TYPE_CONFIGS[agentType] ?? CHAT_AGENT_CONFIG;
```

### Action Loop Entry Point

**File:** `apps/desktop/src/actions/chat.actions.ts`

```typescript
export async function sendChatMessage(conversationId: string, text: string): Promise<void> {
  const message = await createChatMessage({
    id: createId(),
    conversationId,
    role: "user",
    content: text,
    createdAt: new Date().toISOString(),
    metadata: null,
  });
  
  const config = getAgentTypeConfig(getAppState().settings.agentMode.mode);
  if (config.agentType === "action" || config.agentType === "computer-use") {
    await runActionForConversation(conversationId, config);
  } else {
    await runAgentForConversation(conversationId);
  }
}
```

### Provider Capabilities Detection

**File:** `apps/desktop/src/repos/generate-text.repo.ts`

```typescript
export abstract class BaseGenerateTextRepo extends BaseRepo {
  abstract generateText(input: GenerateTextInput): Promise<GenerateTextOutput>;
  abstract streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent>;
  
  detectCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsVision: this.modelSupportsVision(),
      supportsComputerUse: this.modelSupportsComputerUse(),
      supportsStructuredOutput: true,
      supportsThinking: this.modelSupportsThinking(),
    };
  }
  
  protected modelSupportsVision(): boolean {
    const model = (this.constructor as typeof BaseGenerateTextRepo).modelName ?? "";
    return model.includes("vision") || model.includes("gpt-4o") || model.includes("claude");
  }
  
  protected modelSupportsComputerUse(): boolean {
    const model = (this.constructor as typeof BaseGenerateTextRepo).modelName ?? "";
    return model.includes("computer-use") || model.includes("computer_use");
  }
  
  protected modelSupportsThinking(): boolean {
    const model = (this.constructor as typeof BaseGenerateTextRepo).modelName ?? "";
    return model.includes("thinking") || model.includes("reasoning");
  }
}
```

---

## Appendix C: UI Component Specifications

### Agent Status Indicator

**States:**
- `idle` — dimmed gray dot
- `thinking` — soft blue pulse (1.5s ease-in-out)
- `tool-calling` — sequential blue flash
- `streaming` — blue wave motion
- `complete` — animated green checkmark
- `error` — red shake animation

**Implementation:** Use `phaseKey = `${state}-${tool ?? ""}`` for identity. Apply `minDwell` latch (150ms) to prevent flicker.

### Permission Dialog Anatomy

1. Risk badge (Critical/High/Medium/Low) at top
2. Action description in plain language
3. Exact command/args in code block
4. Estimated impact (if computable)
5. Countdown auto-deny timer
6. Action buttons: Allow / Deny / Always Allow

**Risk colors:**
- Critical: `#d04437` (red)
- High: `#ffd351` (yellow/amber)
- Medium: `#4a6785` (blue)
- Low: `#cccccc` (gray)

### Action Timeline

Each timeline entry:
- Screenshot thumbnail (60px square, click to expand)
- Action type icon (click, type, scroll, drag, wait)
- Target element description
- Outcome (success/failure/no change)
- Timestamp with elapsed time

### Autonomy Modes

| Mode | User Role | Agent Behavior | Approval Gates |
|---|---|---|---|
| Watch | Observer | Agent runs fully | All risky actions prompt |
| Assist | Co-pilot | Agent suggests, user confirms | Every action |
| Autonomous | Delegator | Agent executes independently | Only critical/high-risk |

---

## Appendix D: Testing Patterns

### Unit Test Structure

```
packages/agent/src/agent-loop.test.ts          # Existing - 12 tests
packages/agent/src/action-loop.test.ts         # New - action loop tests
packages/agent/src/computer-use-loop.test.ts   # New - computer-use adapter tests
packages/agent/src/action-schema.test.ts       # New - Zod validation tests
apps/desktop/src/tools/*.test.ts               # New - tool unit tests
apps/desktop/src/agents/run-agent.test.ts      # Existing - extend for action mode
```

### Mocking Tauri Commands

```typescript
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

beforeEach(() => {
  clearMocks();
});

test("mocked screenshot command", async () => {
  mockIPC((cmd, args) => {
    if (cmd === "take_screenshot") {
      return { base64: TINY_PNG_BASE64, width: 1920, height: 1080, display_id: 0 };
    }
  });
  
  const tool = new TakeScreenshotTool({ id: "take_screenshot" } as ToolInfo);
  const result = await tool.execute({ params: {}, reason: "test", toolCallId: "test" });
  expect(result.success).toBe(true);
});
```

### Mocking LLM Providers

```typescript
function scriptedProvider(script: Array<LlmStreamEvent[]>) {
  let i = 0;
  return {
    async *streamChat() {
      for (const chunk of script[i++] ?? []) {
        yield chunk;
      }
    },
  };
}
```

### Integration Test Pattern

```typescript
test("action loop completes task", async () => {
  const mockProvider = scriptedProvider([
    [{ type: "tool-call", id: "c1", name: "take_screenshot", arguments: "{}" }],
    [{ type: "tool-call", id: "c2", name: "mouse_click", arguments: '{"x":100,"y":200}' }],
    [{ type: "text-delta", text: "Done" }],
    [{ type: "finish", finishReason: "stop" }],
  ]);
  
  const loop = new ActionLoop({
    provider: mockProvider,
    tools: [screenshotTool, clickTool],
    systemPrompt: "act on screen",
  });
  
  const events = await collectEvents(loop.run([]));
  expect(events).toContainEqual(expect.objectContaining({ type: "finish", reason: "stop" }));
});
```

---

## Appendix E: Risk and Mitigation Summary

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Linux Wayland screen capture blocked | Medium | High | Detect at runtime, fall back to portal, disable computer-use mode |
| macOS TCC permission denial | Low | High | Detect and request on first use, graceful degradation |
| Coordinate mapping bugs on multi-monitor | Medium | Medium | Use `pixelcoords-core`, log transformations |
| Provider-specific tool calling differences | Low | Medium | Adapter layer, test each provider |
| Action loop infinite loop | Low | High | Max iterations, stuck-detection, abort button |
| Shell command injection | Low | Critical | Tauri capabilities allowlist, never expose unrestricted shell |
| Computer-use API cost | Medium | Low | Cache screenshots, use cheaper models, rate-limit |

---

## Appendix F: Open Questions and Decisions

| Question | Decision | Rationale |
|---|---|---|
| Use `tauri-plugin-user-input`? | Implement custom commands | Plugin doesn't exist in Tauri v2 registry; use `enigo` directly |
| Action loop in TS or Rust? | TypeScript for v1 | Keeps consistency with existing agent code; move to Rust only if performance demands |
| Support OpenAI Computer Use? | Defer to Phase 7 | Requires Responses API; Gemini/Anthropic cover most use cases |
| Port Atlas persona system? | Defer | Tightly coupled to Electron; use chat history + fact extraction instead |
| Vercel AI SDK adoption? | Defer | Existing `@maus-inc/voice-ai` works and is tested |
| Context caching abstraction? | Phase 1 | Stable system prompt + tool definitions benefit most from caching |

---

## Appendix G: Reference Implementations

| Project | Language | Relevance |
|---|---|---|
| `suitedaces/computer-agent` | Tauri + React + Rust | Closest reference — 700 stars, similar stack |
| `shlawgathon/Computer-Use` | Tauri 2 + React + Rust | macOS-focused, uses `xcap` + `enigo` |
| `pipi-shrimp-agent` | Tauri + Rust + React | Multi-provider, tool execution, workflows |
| `windows-computer-use-mcp` | Tauri + Python + FastAPI | Windows-specific, 22 MCP tools |
| Atlas (archived) | Electron + Vue 3 | Source of features being ported |

## Appendix H: Key Research Documents

| Document | Location | Description |
|---|---|---|
| Atlas analysis | `docs/research/agent-mode-atlas-analysis.md` | Complete analysis of mausVoice PR #236 and Atlas codebase |
| Model-agnostic architectures | `docs/research/model-agnostic-agent-loop-architectures.md` | Provider abstraction, tool calling, computer use, vision loops, caching |
| Porting plan | `docs/research/agent-mode-porting-plan.md` | Phased implementation plan with file inventory and timeline |
| Implementation guide | `docs/research/agent-mode-implementation-guide.md` | This document — exact implementation steps |
| Tauri integration guide | `temp/AGENT_MODE_TAURI_INTEGRATION_GUIDE.md` | Rust command patterns, plugin init, capabilities, IPC |
| UI/UX design guide | Research output | Agent status, permission dialogs, computer-use UI patterns |
| Testing patterns | Research output | Unit/integration/E2E testing patterns for agent mode |
| mausVoice integration | Research output | Exact hook points in mausVoice codebase |
| Computer-use action mapping | Research output | Gemini/Anthropic action mapping, verification, stuck-loop detection |

---

## Appendix I: Computer-Use Action Mapping Reference

### Portable Action Schema

```typescript
export type ActionType =
  | "click" | "double_click" | "triple_click" | "right_click" | "middle_click"
  | "hover" | "mouse_down" | "mouse_up" | "drag"
  | "type" | "press_key" | "key_down" | "key_up" | "hotkey"
  | "scroll" | "scroll_document"
  | "navigate" | "go_back" | "go_forward" | "open_browser"
  | "wait" | "take_screenshot" | "search" | "list_apps" | "focus_app";

export interface PortableAction {
  type: ActionType;
  x?: number; y?: number; endX?: number; endY?: number;
  text?: string; keys?: string[];
  direction?: "up" | "down" | "left" | "right";
  magnitude?: number; url?: string; appName?: string; seconds?: number;
  safetyDecision?: "regular" | "require_confirmation" | "blocked";
  safetyExplanation?: string;
  raw?: unknown;
}
```

### Provider Mapping Tables

| Portable Action | Gemini fn | Anthropic member |
|---|---|---|
| `click` | `click_at` | `left_click` |
| `double_click` | `double_click` | `double_click` |
| `triple_click` | `triple_click` | `triple_click` |
| `right_click` | `right_click` | `right_click` |
| `middle_click` | `middle_click` | `middle_click` |
| `hover` | `hover_at` / `move` | — |
| `type` | `type_text_at` / `type` | `type` |
| `scroll` | `scroll_at` / `scroll` | `scroll` |
| `scroll_document` | `scroll_document` | — |
| `drag` | `drag_and_drop` | `left_click_drag` |
| `hotkey` | `key_combination` / `hotkey` | — |
| `press_key` | `press_key` | `key` |
| `wait` | `wait` / `wait_5_seconds` | `wait` |
| `take_screenshot` | `take_screenshot` | `screenshot` / `zoom` |
| `list_apps` | — | `list_apps` |
| `focus_app` | — | `focus_app` |

### Coordinate Normalization

```typescript
// Gemini: 1000x1000 grid → physical pixels
function geminiToPhysical(x: number, y: number, displayWidth: number, displayHeight: number) {
  return {
    x: Math.round((x / 1000) * displayWidth),
    y: Math.round((y / 1000) * displayHeight),
  };
}

// Anthropic: screenshot pixel space → physical pixels
function anthropicToPhysical(x: number, y: number, screenshotWidth: number, screenshotHeight: number, displayWidth: number, displayHeight: number) {
  return {
    x: Math.round((x / screenshotWidth) * displayWidth),
    y: Math.round((y / screenshotHeight) * displayHeight),
  };
}
```

### Stuck-Loop Detection

```typescript
const EXACT_REPEAT_THRESHOLD = 3;
const CATEGORY_DOMINANCE_RATIO = 0.8;
const CATEGORY_WINDOW_SIZE = 10;
const TIME_STALL_SECONDS = 60;

function detectStuckLoop(history: PortableAction[][], currentBatch: PortableAction[], loopStartTime: number): StuckDecision {
  const now = Date.now();
  const stallSeconds = (now - loopStartTime) / 1000;

  const sequenceCount = history.filter((h) => arraysEqual(h, currentBatch)).length;
  if (sequenceCount >= EXACT_REPEAT_THRESHOLD) {
    return { stuck: true, reason: "exact_repeat", suggestion: `...` };
  }

  const recent = history.flat().slice(-CATEGORY_WINDOW_SIZE);
  const categoryCounts = new Map<ActionType, number>();
  for (const a of recent) categoryCounts.set(a.type, (categoryCounts.get(a.type) ?? 0) + 1);
  const [dominant, maxCount] = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (dominant && maxCount / recent.length >= CATEGORY_DOMINANCE_RATIO && recent.length >= CATEGORY_WINDOW_SIZE) {
    return { stuck: true, reason: "category_dominance", suggestion: `...` };
  }

  if (stallSeconds > TIME_STALL_SECONDS && recent.length > 5) {
    return { stuck: true, reason: "time_stall", suggestion: `...` };
  }

  return { stuck: false, reason: null, suggestion: "" };
}
```

### Key Implementation Rules

1. **Safety decisions only come from Gemini.** Anthropic's `computer_toolset_20260801` has no `safety_decision` field.
2. **Every Anthropic `tool_result` must echo `"toolset_name": "computer"`.** Missing it causes `invalid_request_error`.
3. **Always run Anthropic batch actions sequentially.** Stop at first failure; still return `tool_result` for all remaining blocks.
4. **Always attach a screenshot at the end of each Anthropic batch.** Saves a round trip.
5. **Gemini coordinates are 1000x1000 grid.** Always denormalize with `physical_x = round(x / 1000 * displayWidth)`.
6. **Anthropic coordinates are screenshot pixel space.** If downscaled, scale back by `physicalWidth / screenshotWidth`.
7. **Pixel comparison must never block an action.** Always return `{ valid: true, skipped: true }` on any internal error.
8. **`NoObjectGeneratedError`** is thrown by Vercel AI SDK when `Output.object()` schema validation fails. Catch it and invoke fallback parser.
9. **Partial outputs from `streamText` cannot be validated.** Use `Output.object()` only with `generateText` for fully validated schemas.
10. **Stuck-loop detection should run before each action batch**, not after. If `stuck: true`, interrupt the loop and surface to the user.

---

## Appendix J: Code Review Checklist

Before any PR in this feature area:

- [ ] New tools have `risk` metadata set correctly
- [ ] All new Rust commands return `Result<T, String>` with descriptive errors
- [ ] Tauri capabilities JSON is valid and scoped to `main` window
- [ ] No `unsafe-inline` or `unsafe-eval` added to CSP
- [ ] Screenshots are compressed to JPEG (1280px, quality 80) before LLM context
- [ ] PNG mode only used for computer-use API compliance
- [ ] Coordinate mapping uses physical pixels, not logical
- [ ] Permission flow respects risk tiers (low=auto, medium=prompt, high=confirm, critical=warning)
- [ ] Abort signals propagate to all in-flight operations
- [ ] Errors are logged via `getLogger()` with context
- [ ] No secrets or API keys in logs
- [ ] All new types exported from `packages/types/src/index.ts`
- [ ] Tests cover: happy path, error path, abort, permission denied
- [ ] Rust code compiles on Windows, macOS, Linux
- [ ] TypeScript types pass `check-types`
- [ ] Lint passes with no new warnings

---

## Appendix K: Research Sources

All research was verified against primary sources:

| Source | URL | Verified |
|---|---|---|
| Google Gemini Computer Use API | `https://ai.google.dev/gemini-api/docs/interactions/computer-use.md` | Function names, argument structures, safety_decision format |
| Anthropic Computer Use Toolset | `https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool` | 17 member tools, toolset_name requirement, coordinate semantics |
| Vercel AI SDK Output.object | `https://ai-sdk.dev/docs/reference/ai-sdk-core/output` | Structured output with Zod schemas |
| xcap crate | `https://crates.io/crates/xcap` | Cross-platform screen capture, Windows/macOS/Linux support |
| enigo crate | `https://crates.io/crates/enigo` | Input simulation, keyboard/mouse |
| pixelcoords-core crate | `https://crates.io/crates/pixelcoords-core` | Multi-monitor coordinate mapping |
| tauri-plugin-screenshots | Tauri v2 plugin registry | Screenshot API for TypeScript |
| Tauri v2 capabilities | `https://v2.tauri.app/security/capabilities/` | Permission system, shell allowlist |
| Atlas codebase | `https://github.com/dortanes/atlas` (archived v0.2.3) | Source of agentic features being ported |
| suitedaces/computer-agent | `https://github.com/suitedaces/computer-agent` | Tauri + React + Rust reference |
| shlawgathon/Computer-Use | `https://github.com/shlawgathon/Computer-Use` | Tauri 2 + xcap + enigo |
| pipi-shrimp-agent | `https://github.com/mammut001/pipi-shrimp-agent` | Multi-provider agent runtime |
| tiylabs/tiycore | Rust agent runtime | Protocol-based LLM abstraction |

---

## Appendix L: As-built reality

This appendix records what was actually built, where each piece lives, and where the build diverges from the plan above. It is written after the fact, from the committed code, so the paths and names here are the ones to grep.

### Files created

| Path | Purpose |
|---|---|
| `packages/types/src/ai-computer-use.types.ts` | The portable vocabulary. `ComputerUseAction` (15 members), `ComputerUseScreenshot`, `ComputerUseTurn`, `ComputerUseSession`, `ComputerUseSessionFactory`, `ProviderCapabilities`, `COMPUTER_USE_ACTION_TYPES`. |
| `packages/voice-ai/src/computer-use/coordinate-scale.ts` | Grid and capture-space coordinate conversion. |
| `packages/voice-ai/src/computer-use/argument-readers.ts` | Shared readers that never default a missing field. |
| `packages/voice-ai/src/computer-use/computer-use-transport.ts` | HTTP plus retry, turn termination guards, PNG assertion. |
| `packages/voice-ai/src/computer-use/gemini-computer-use.ts` | Gemini `ComputerUseSession` adapter. |
| `packages/voice-ai/src/computer-use/anthropic-computer-use.ts` | Anthropic `ComputerUseSession` adapter. |
| `packages/voice-ai/src/computer-use/computer-use-registry.ts` | `COMPUTER_USE_PROVIDERS`, keyed by provider id. |
| `apps/desktop/src-tauri/src/platform/computer_use/` | Capture and input per platform: `mod.rs`, `capture.rs`, `capture_linux.rs`, `capture_macos.rs`, `capture_windows.rs`, `input.rs`. |
| `apps/desktop/src/agents/computer-use/computer-use-executor.ts` | Turns a portable action into native calls. |
| `apps/desktop/src/agents/computer-use/computer-use-risk.ts` | Risk tier and plain-language summary per action. |
| `apps/desktop/src/agents/computer-use/computer-use-loop.ts` | The turn loop and the stuck detector. |
| `apps/desktop/src/agents/computer-use/computer-use-approval.ts` | Approval through the existing permission store. |
| `apps/desktop/src/agents/computer-use/run-computer-use.ts` | Session construction from agent-mode prefs. |
| `apps/desktop/src/agents/computer-use/run-computer-use-for-conversation.ts` | Maps loop events onto `AgentRunState` and chat messages. |
| `apps/desktop/src/agents/computer-use/route-agent-run.ts` | Chooses computer use or the existing chat run. |
| `apps/desktop/src/agents/computer-use/tauri-computer-use.host.ts` | The native host over the generated bindings. |
| `apps/desktop/src/agents/finalize-assistant-message.ts` | Extracted from `run-agent.ts` so both runners finalize a message the same way. |
| `apps/desktop/src/tools/README.md`, `apps/desktop/src-tauri/src/commands/README.md`, `apps/desktop/src-tauri/capabilities/README.md` | Documentation required before merge. |

### Files changed

`packages/types/src/ai-tool.types.ts` (added `ToolRisk`, `TOOL_RISK`, and a required `risk` on `ToolInfo`), `apps/desktop/src/tools/index.ts` (`assertRateable` guard, `staticInfo` takes a risk), `apps/desktop/src/utils/tool-permission.utils.ts` (action-scoped always-allow, revoke removes every scope), `apps/desktop/src/agents/run-agent.ts` (risk-tier-aware `executeWithPermission`, shared finalizer), `apps/desktop/src/actions/chat.actions.ts` (delegates to the router, aborts both runs, reports both as running), `apps/desktop/src/state/local.state.ts` and `apps/desktop/src/utils/assistant-mode.utils.ts` (the `computerUseEnabled` toggle), `apps/desktop/src/components/settings/AIAgentModeDialog.tsx` (the toggle and its own warning dialog), `apps/desktop/src-tauri/src/commands.rs`, `apps/desktop/src-tauri/src/app.rs`, `apps/desktop/src-tauri/src/platform/mod.rs`, `apps/desktop/src-tauri/examples/gen_bindings.rs`, `apps/desktop/src-tauri/Cargo.toml`, and `packages/desktop-native-apis/src/bindings.ts`.

### Deviations from the plan

**Three dependencies were rejected after reading their sources.**

`xcap` was dropped in favour of platform APIs already in the crate. `windows` already exposes GDI through a feature another file imports, `core-graphics` is already a dependency, and `x11` is already there for the windowing work. Adding `xcap` would have meant a new crate plus a new fetch.

`enigo` was rejected because the pinned 0.1.3 exposes only a string DSL, `eval(&mut Enigo, "click(100,200)")`, with no typed event. Input goes through `rdev`, which was already a dependency and already used by the hotkey code.

`pixelcoords-core` was rejected because the crate already computes display geometry per platform. The only genuinely new arithmetic was converting between the three coordinate spaces, which is a small amount of testable arithmetic and belongs next to the capture code rather than behind a crate.

**Capture is JPEG by default, with PNG where the provider demands it.** Ground rule 11 fixed JPEG at 1280 pixels and quality 80. Both providers also reject a non-PNG screenshot. The loop therefore always captures PNG at 1280 pixels wide, and the JPEG path exists for callers that want it. The two requirements are reconciled in one place rather than being left to the caller.

**Screen capture is refused on Wayland rather than approximated.** Ground rule 15 removed Wayland from Phases 1 to 3, so the Linux backend returns a message naming the missing portal service instead of falling back to a path that would not work.

**Computer use is a session-local switch, not a stored preference.** The toggle lives in `LocalState` next to `powerModeEnabled`, which already gates the terminal-command tool the same way. A stored preference would silently re-arm pointer control on the next launch.

**There is no new agent status.** The computer-use runner writes into the existing `AgentRunState`, `StreamingMessageState` and chat-message shapes, so the current chat list, permission card and stop button work unchanged. Adding a status to the union would have touched every consumer for no user-visible gain.

**The provider list is a registry, not a branch.** The plan described one adapter per provider. The build instead keys `COMPUTER_USE_PROVIDERS` by provider id and asks `supportsComputerUse` before routing, so adding a provider means adding one registration. Nothing above the registry knows a provider's name.

### Verification notes

The Linux build cannot see the Windows or macOS capture files. `cargo clippy --all-targets -D warnings` on Linux exits 0 without compiling them, and the CI job on `windows-2022` is the only authority there. Everything Windows-specific was written against the `windows` crate's own signatures and needs that job to confirm.

Several defects in the first pass were only visible by running the code rather than reading it: a key parser that never called its named-key branch, a JPEG encoder handed a pixel format it rejects, a zoom that assumed the previous frame was PNG when the default capture is JPEG, and a coordinate helper used in the opposite direction from the one it converts.
