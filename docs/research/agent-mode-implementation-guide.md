# Agent Mode Full Port: Master Implementation Guide

This is the master implementation guide for porting Atlas's full agentic feature set into mausVoice's existing agent mode. It synthesizes all research into actionable steps with exact file paths, code patterns, and verification criteria.

## Document Index

1. `docs/research/agent-mode-atlas-analysis.md` — Complete analysis of mausVoice PR #236 and Atlas codebase
2. `docs/research/model-agnostic-agent-loop-architectures.md` — Research on provider abstraction, tool calling, computer use, vision loops, context caching
3. `docs/research/agent-mode-porting-plan.md` — Phased implementation plan with file inventory and timeline
4. `docs/research/agent-mode-implementation-guide.md` — This document. Master guide with exact implementation steps.

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
