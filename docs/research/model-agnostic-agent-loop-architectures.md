# Model-Agnostic Agent Loop Architectures: Research Summary

## 1. Tool Calling Standards

### Key Finding: No True Common Denominator, But Two Stable Clusters

There is no universal tool calling format. Providers cluster into three protocol families, with two being dominant for new development:

| Protocol Family | Providers | Wire Format |
|---|---|---|
| **OpenAI-group** | OpenAI, GLM, DeepSeek, Groq, OpenRouter, xAI, Ollama (compat mode) | `tools[].function.parameters` (JSON Schema), response in `message.tool_calls[]`, results as `role: "tool"` messages |
| **Anthropic-group** | Anthropic Claude | `tools[].input_schema` (JSON Schema), response as `content[].tool_use` blocks, results as `content[].tool_result` blocks inside next user message |
| **Gemini-group** | Google Gemini | `tools[].functionDeclarations[].parameters` (OpenAPI subset), response as `parts[].functionCall`, results as `parts[].functionResponse` |

Ollama is special: its native `/api/chat` uses OpenAI-compatible `tools` with `function.parameters` and `message.tool_calls`, but streaming emits accumulated chunks differently. Its `/v1/chat/completions` compatibility endpoint is more faithful to OpenAI's delta format.

### Streaming Tool Call Formats

| Provider | Stream Event | Arguments Format | Parallel Indices |
|---|---|---|---|
| OpenAI | `delta.tool_calls[i].function.arguments` | String fragment (append per index) | Yes, index key |
| Anthropic | `delta.input_json_delta` | String fragment (single stream per block) | No, separate content block |
| Gemini | `parts[].functionCall.args` | Partial JSON object (merged) | Yes, separate parts |
| Ollama native | `message.tool_calls` (accumulated) | Full object per chunk | Yes, index key |

### The Translation Layer Pattern

The production-grade solution is a **three-layer translation architecture**:

```
Internal Schema <-> Request Translator <-> Provider Wire Format
Internal Schema <-> Response Parser <-> Provider Wire Format
```

Define one internal `ToolDefinition[]` / `ToolCall[]` representation and write per-provider adapters. This is what `unifai-tools`, `llmstitch`, `langchain`, and `tiylabs/tiycore` all do.

**Code pattern (from Wavise OpenLLM and unifai-tools):**

```typescript
// Internal schema (portable)
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
  strict?: boolean;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// Request translator
function buildProviderTools(tools: ToolDefinition[], provider: Provider) {
  if (provider === 'anthropic') {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  if (provider === 'gemini') {
    return [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    }];
  }
  // OpenAI-group (default)
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.strict && provider === 'openai' ? { strict: true } : {}),
    },
  }));
}
```

### Critical Gotcha: `max_tokens` Requirement

Anthropic requires `max_tokens` on every Messages API request. OpenAI and Gemini default it. A naive cross-provider adapter that omits `max_tokens` will fail against Anthropic.

### Tradeoffs

| Approach | Effort | Coverage | Escape Hatch |
|---|---|---|---|
| **Thin adapter you control** | Medium | 60-80% shared, 20-40% provider-specific | Full control, explicit mapping |
| **Vercel AI SDK** | Low (adopt) | High (typed `providerOptions`) | `providerOptions` per-step |
| **LangChain** | Low (adopt) | Medium | `additional_kwargs` (untyped) |
| **LiteLLM / gateway** | Low (deploy) | Lowest common denominator | Mostly drops unique features |
| **PydanticAI (Python)** | Medium | High (typed `provider_details`) | Prefixed params, best design |

### Recommendation for mausVoice

Use a **thin adapter you control** built on top of the Vercel AI SDK's `LanguageModelV4` spec. The SDK already normalizes `tool-call` content parts and handles streaming deltas. For provider-specific features (Anthropic `computer_20251124`, Gemini `computer_use`, thinking tokens), use the SDK's `providerOptions` escape hatch. Do not use LangChain: its `additional_kwargs` bag is untyped and debugging through 6+ abstraction layers is costly. The Vercel AI SDK's `createProviderRegistry` gives you provider routing with zero runtime overhead.

---

## 2. Provider Abstraction Layers

### Vercel AI SDK (TypeScript)

The Vercel AI SDK (v6) is the strongest TypeScript option for mausVoice. It provides:

- **`LanguageModelV4` spec**: Standardized interface for `doGenerate` and `doStream`. Any provider implementing this spec plugs into `generateText`, `streamText`, and `ToolLoopAgent` with zero adapter code.
- **`createProviderRegistry`**: Route to `providerId:modelId` with a single config change.
- **`tool()`**: Zod-validated tool definitions with automatic provider translation.
- **`Output.object({ schema })`**: Structured output generation across providers via Zod.
- **`providerOptions`**: Typed escape hatch for provider-specific settings (e.g., Anthropic `thinking`, Gemini `toolConfig`).
- **`prepareStep`**: Per-step middleware for passing state between turns (e.g., Anthropic container IDs).

**Abstraction model:**

```typescript
import { createProviderRegistry, anthropic, openai, google } from 'ai';

export const registry = createProviderRegistry({
  anthropic,
  openai: createOpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  gemini: google('vertexai'),
});

// Use any model with the same API
const result = await generateText({
  model: registry.languageModel('anthropic:claude-sonnet-5-5'),
  tools: { weather: tool({ ... }) },
  prompt: '...',
});
```

**Tradeoffs:**
- Zero abstraction cost (compile-time, not a proxy).
- Full TypeScript inference from Zod schemas to tool execution.
- Provider-specific features require `providerOptions` (not hidden, but explicit).
- Still subject to the LCD problem: features unique to one provider (e.g., Anthropic server-side tools, Gemini computer use) require provider-specific code paths.

### LangChain (TypeScript)

LangChain provides `initChatModel` with `provider:model` resolution and a unified `BaseChatModel` interface. Provider-specific features are available via class parameters but are not portable. `additional_kwargs` is an untyped escape hatch. Deep class hierarchy (`Serializable -> Runnable -> RunnableSerializable -> BaseLanguageModel -> BaseChatModel -> ChatAnthropic`) makes debugging difficult. Use only if you need LangChain's retrieval/vector-store ecosystem. For mausVoice, which already has a Tauri + Zustand architecture, LangChain is overkill.

### LlamaIndex.TS (TypeScript)

Provides `BaseLLM` with `chat()` and `complete()` methods. Supports provider-specific options via `additionalChatOptions`. The newer `@llamaindex/workflow` replaces the deprecated agent module. Focused on RAG and retrieval, not general agent loops. Not recommended for mausVoice's use case.

### `tiylabs/tiycore` (Rust)

A Rust library with 5 protocol-level implementations and 10 delegation providers behind a single `LLMProtocol` trait. Includes a stateful `Agent` runtime with tool execution loops, steering, event subscription, and thinking budgets. This is the closest thing to a production-grade, model-agnostic agent runtime in any language. If mausVoice ever moves agent loop logic to Rust (Tauri side), `tiycore` is the reference implementation. Its architecture (Types -> Protocol -> Provider -> Agent -> Transform) is worth studying.

**Architecture pattern from tiycore:**

```rust
// One trait, many providers
pub trait LLMProtocol: Send + Sync {
  async fn stream(&self, request: LLMRequest) -> Result<AssistantMessageEventStream>;
  async fn complete(&self, request: LLMRequest) -> Result<LLMResponse>;
}

// Agent owns the loop
pub struct Agent {
  model: Model,
  state: AgentState,
  tool_executor: Option<ToolExecutor>,
}

// Loop: stream LLM -> detect tool calls -> execute tools -> re-prompt -> repeat
```

### `unifai-tools` (TypeScript, 19 KB)

Define tools once with Zod, run on OpenAI/Anthropic/Gemini. Built-in agentic loop with `maxIterations`. Zero runtime dependencies beyond Zod. Hand-rolled Zod-to-JSON-Schema converter. Not a full framework, but a clean reference for the "thin adapter" pattern.

### `agent-toolbelt` (TypeScript, zero deps beyond Zod)

Framework-agnostic tool registry: `defineTool` with Zod, `registry.toJSONSchema()` for any function-calling API, runtime validation, middleware (`logging`, `requireScopes`). Bring-your-own-model-loop. This is the right primitive if you want to own the loop but not rebuild tool plumbing.

### `@narimangardi/agent-loop` (TypeScript)

One-class agent loop: `Agent.run()` sends messages + tools, executes tool calls, feeds results back, repeats. Provider interface is a single `complete({ messages, tools }) -> CompletionResponse` function. No streaming, no retries, no argument validation. Useful as a minimal reference, but too thin for production.

### Comparison Matrix

| Library | Language | Abstraction Cost | Feature Fidelity | Scope | Type Safety |
|---|---|---|---|---|---|
| Vercel AI SDK | TypeScript | Zero (compile-time) | High (`providerOptions`) | LLM calls + UI streaming | Full (Zod/TypeScript) |
| LangChain | TypeScript/JS | Medium (in-process) | Medium (`additional_kwargs`) | Full framework | Partial |
| LlamaIndex.TS | TypeScript | Medium | Medium | RAG-focused | Partial |
| tiycore | Rust | Zero (trait-based) | High (protocol layer) | Agent runtime | Full (Rust types) |
| unifai-tools | TypeScript | Low (~19 KB) | Medium | Tool loop only | Full (Zod) |
| agent-toolbelt | TypeScript | Low | High (you own loop) | Tool registry only | Full (Zod) |
| LiteLLM | Any (HTTP) | Network hop | LCD | LLM calls only | None |

### Recommendation for mausVoice

Adopt the **Vercel AI SDK** as the primary abstraction layer. Use `createProviderRegistry` for multi-provider routing, `tool()` with Zod for tool definitions, `generateText`/`streamText` for the core loop, and `ToolLoopAgent` for autonomous agents. For computer use, use the SDK's `provider`-defined tool support (Anthropic `computer_20251124` is available in `@ai-sdk/anthropic`). For the Tauri backend, mirror the same provider registry logic in Rust using `tiycore` as a reference.

---

## 3. Computer Use API Integration

### Gemini Computer Use

Gemini's Computer Use is a **first-class tool type** (`computer_use`) passed in the `tools` array. It is not a regular `functionDeclaration`. The model returns `function_call` steps with normalized coordinates on a 1000x1000 grid.

**Request format:**

```typescript
{
  tools: [{
    type: "computer_use",
    environment: "ENVIRONMENT_BROWSER", // or ENVIRONMENT_MOBILE, ENVIRONMENT_DESKTOP
    enable_prompt_injection_detection: true,
    excluded_predefined_functions: ["click"] // optional
  }]
}
```

**Response format (function_call step):**

```json
{
  "steps": [{
    "type": "function_call",
    "name": "click_at",
    "arguments": { "x": 450, "y": 120, "intent": "Click the search box" }
  }]
}
```

**Loop:** Send screenshot + prompt -> receive function_call -> execute action -> capture new screenshot -> send as `function_result` -> repeat.

**Safety:** Responses include `safety_decision`: `regular` (allowed), `require_confirmation` (needs HITL), `blocked` (halt).

**Key details:**
- No need to specify display size; model predicts pixel coordinates scaled to viewport.
- `enable_prompt_injection_detection: true` checks screenshots for hidden adversarial instructions.
- `previous_interaction_id` enables stateful mode where the server manages `id` and `signature` fields automatically.
- Custom user-defined functions can be combined with `computer_use` in the same request.
- Supported models: `gemini-2.5-computer-use-preview-10-2025`, `gemini-3-flash-preview`, `gemini-3.8-flash`.

### Anthropic Computer Use

Anthropic's Computer Use is a **client toolset** (`computer_toolset_20260801`) that declares 17 member tools (`screenshot`, `left_click`, `type`, `scroll`, `zoom`, etc.) in a single `tools` entry. Your application executes every call.

**Request format:**

```json
{
  "tools": [{
    "type": "computer_toolset_20260801",
    "configs": {
      "screenshot": { "enabled": true },
      "zoom": { "enabled": true }
    }
  }]
}
```

**Response format:**

```json
{
  "stop_reason": "tool_use",
  "content": [{
    "type": "tool_use",
    "name": "screenshot",
    "toolset_name": "computer",
    "input": {},
    "id": "toolu_01..."
  }]
}
```

**Key details:**
- Dispatch on `toolset_name: "computer"` + `name` pair.
- Each `tool_use` block is a member tool call; multiple in one turn = batch action.
- Results must echo `toolset_name: "computer"` in the `tool_result` block.
- Earlier beta versions: `computer_20251124` (requires `computer-use-2025-11-24` header) and `computer_20250124`.
- 17 member tools: `screenshot`, `cursor_position`, `mouse_move`, `left_click`, `left_click_drag`, `right_click`, `middle_click`, `double_click`, `triple_click`, `scroll`, `type`, `key`, `hold_key`, `wait`, `zoom`, `list_apps`, `focus_app`.
- No pixel coordinates; uses accessibility tree / screenshot + element indices or raw coordinates.

**In Vercel AI SDK:**

```typescript
import { anthropic } from '@ai-sdk/anthropic';
import { computer_20251124 } from '@ai-sdk/anthropic';

const computerTool = computer_20251124({
  displayWidthPx: 1024,
  displayHeightPx: 768,
  execute: async (action) => {
    // execute action, return base64 screenshot
  },
});
```

### OpenAI Computer Use

OpenAI's Computer Use is available through the **Responses API** (not Chat Completions) using the `computer-use-preview` model. It uses a different action schema (`computer_call` / `computer_call_output`) and requires `truncation: "auto"`. LangChain wraps this as `tools.computerUse()`. For mausVoice, OpenAI computer use is the least portable option because it requires the Responses API specifically.

### Model-Agnostic Computer Use Abstraction

The common denominator across all three providers is:

1. **Tool definition** in the request (declares the computer-use capability).
2. **Function/tool call** in the response (model requests an action).
3. **Execution + screenshot** in your code.
4. **Result feedback** sent back to the model.

**Abstraction pattern:**

```typescript
interface ComputerUseAction {
  type: 'click' | 'type' | 'scroll' | 'screenshot' | 'wait' | 'drag' | 'key';
  x?: number;
  y?: number;
  text?: string;
  keys?: string[];
  scrollX?: number;
  scrollY?: number;
  path?: { x: number; y: number }[];
}

interface ComputerUseTool {
  provider: 'gemini' | 'anthropic' | 'openai';
  environment: 'browser' | 'desktop';
  displayWidth: number;
  displayHeight: number;
  execute: (action: ComputerUseAction) => Promise<string>; // base64 screenshot
}
```

**Fallback pattern when computer use is unavailable:**

```typescript
const hasComputerUse = providerSupportsComputerUse(model);
if (!hasComputerUse) {
  // Fallback: vision-only loop with structured action output
  const { output } = await generateText({
    model,
    output: Output.object({ schema: ActionSchema }),
    messages: [{ role: 'user', content: [{ type: 'image', image: screenshot }] }],
  });
  // output is { actions: ComputerUseAction[] }
}
```

### Recommendation for mausVoice

Use Gemini's `computer_use` as the primary computer-use backend (most mature, most documented, explicit API). Keep an Anthropic `computer_toolset_20260801` fallback. Abstract the action schema to a portable `ComputerUseAction` type. Wrap provider-specific tool definitions behind a factory function. Do not use OpenAI Responses API computer use unless the user explicitly requires it.

---

## 4. Vision + Action Loops

### Core Pattern: Observe-Decide-Act

All vision-based agent loops follow the same cycle:

1. **Capture state** — Screenshot (and optionally DOM/accessibility tree).
2. **Send to LLM** — Screenshot + task description + action history.
3. **Parse structured action** — LLM returns a structured action: click at coordinates, type text, scroll, navigate, done, fail.
4. **Execute action** — Playwright or native automation executes the action.
5. **Verify + loop** — Check if action succeeded, detect stuck loops, repeat or terminate.

### Key Libraries

| Library | Language | Screenshot Source | Action Parsing | Loop Detection |
|---|---|---|---|---|
| **browser-use** (webllm) | TypeScript | Playwright viewport | Zod-validated structured JSON | `maxRepeats`, heuristic |
| **@omxyz/lumen** | TypeScript | Chrome CDP | ActionDecoder (normalized viewport px) | 3-layer: exact repeat, category dominance, URL stall |
| **@rajpra808/browser-agent** | TypeScript | Playwright | Simple JSON action parse | CSV logging |
| **@agentium/browser** | TypeScript | Playwright + optional DOM | Structured JSON | `maxRepeats` |
| **agentbrowser** | TypeScript | Playwright | Structured JSON | `maxFailures` |
| **Open-Interface** | Python | Various | PowerShell commands | State machine |
| **NousResearch/hermes-agent** | Python | macOS cua-driver | SOM (set-of-marks) element indices preferred over pixel coordinates | N/A |

### Structured Output for Actions

The cleanest pattern is Zod schema + Vercel AI SDK `Output.object()`:

```typescript
import { z } from 'zod';
import { generateText, Output } from 'ai';

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('type'), x: z.number(), y: z.number(), text: z.string() }),
  z.object({ type: z.literal('scroll'), direction: z.enum(['up', 'down']), amount: z.number() }),
  z.object({ type: z.literal('done'), result: z.string() }),
  z.object({ type: z.literal('fail'), reason: z.string() }),
]);

const { output: action } = await generateText({
  model: 'anthropic/claude-sonnet-5-5',
  output: Output.object({ schema: ActionSchema }),
  messages: [
    { role: 'user', content: [
      { type: 'text', text: 'Task: Search for TypeScript tutorials' },
      { type: 'image', image: screenshotB64 },
    ]},
  ],
});
```

This works across Anthropic, OpenAI, and Gemini because the AI SDK handles the provider-specific structured-output mechanisms (Anthropic post-formats, Gemini zeroes logits, OpenAI strict mode).

### Hybrid Mode: Screenshot + DOM

The most reliable vision-loop pattern in production is **hybrid mode**: send both a screenshot and a simplified accessibility tree. The model uses element indices (preferred) with coordinates as fallback.

```typescript
// Agentium / browser-use pattern
const domTree = await extractAccessibilityTree(page);
const message = {
  role: 'user' as const,
  content: [
    { type: 'text' as const, text: `DOM:\n${domTree}` },
    { type: 'image' as const, image: screenshotB64 },
  ],
};
```

### Set-of-Marks (SOM)

SOM overlays numbered badges on every interactable element. The model clicks by element index (`@e1`, `@submit`) rather than pixel coordinates. This is dramatically more reliable than raw coordinates. Gemini's `computer_use` does this internally; NousResearch/hermes-agent exposes it as `mode='som'`.

### Loop Detection and Safety

Production loops need three safety layers:

1. **Max steps / max turns** — Hard ceiling (e.g., 30 steps).
2. **Repeat detection** — Auto-fail after N identical consecutive actions.
3. **Verifier gate** — When model says "done", a verifier (heuristic or LLM) confirms by checking the screenshot.

```typescript
// From @omxyz/lumen
const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  maxSteps: 15,
  verifier: async ({ screenshot }) => {
    const check = await generateText({
      model: "anthropic/claude-sonnet-4-6",
      prompt: `Did the task complete? Screenshot:`,
      images: [screenshot],
    });
    return check.text.includes('complete');
  },
});
```

### Recommendation for mausVoice

Build the vision loop on top of the Vercel AI SDK. Use `generateText` with `Output.object({ schema: ActionSchema })` for structured action parsing. Capture screenshots via Playwright (or Tauri's native screenshot APIs on desktop). Implement hybrid mode (screenshot + accessibility tree) for reliability. Add a 3-layer stuck detector (exact repeat, category dominance, URL stall). Keep the loop bounded (`maxSteps`, `maxTurns`).

---

## 5. Context Caching

### How Each Provider Caches

**Anthropic:**
- Explicit `cache_control: { type: "ephemeral" }` on content blocks.
- Automatic caching: top-level `cache_control` field moves breakpoint automatically.
- Cache order: `tools` -> `system` -> `messages`.
- 5-minute TTL, refreshed on each use.
- Pre-warm with `max_tokens: 0`.
- Minimum 1,024 tokens for explicit, 2,048 for automatic (varies by model).
- Lookback window: 20 blocks.

**OpenAI (GPT-5.6+):**
- Implicit caching: breakpoint at latest eligible message (user or last tool response).
- Explicit caching: `prompt_cache_breakpoint: { mode: "explicit" }` on content blocks.
- `prompt_cache_key` for separate cache accounting (required on GPT-5.6+ for reliable matching).
- `prompt_cache_options.mode`: `implicit` (default) or `explicit`.
- `prompt_cache_options.ttl`: `30m` (default and only supported value).
- Cache writes cost 1.25x on GPT-5.6+, reads at 0.1x.
- Earlier models: automatic caching, no explicit breakpoints, hash-based routing.

**OpenAI (GPT-5.5 and earlier):**
- Automatic best-effort reuse of matching prefixes.
- `prompt_cache_retention`: `in_memory` (5-10 min) or `24h`.
- No explicit breakpoints.

**Gemini:**
- Implicit caching: **enabled by default** for Gemini 2.5+ and Gemini 3.x.
- Minimum: 4,096 tokens for Gemini 3.x, 2,048 for Gemini 2.5.
- Nothing to enable; cost savings apply automatically on cache hit.
- Explicit caching: manual `cachedContent` resource management (only in `generateContent` API, not Interactions API).
- `usage.total_cached_tokens` reports cache hits.

### Abstraction Strategy

Cache invalidation differs fundamentally:
- Anthropic: block-level `cache_control` markers.
- OpenAI: message-level breakpoints + `prompt_cache_key`.
- Gemini: automatic prefix matching, no configuration.

A model-agnostic abstraction should:

1. **Always place stable content first**: system prompt, tool definitions, background context.
2. **Always place variable content last**: user message, per-request data.
3. **Never reorder chunks between requests** if you want cache hits.
4. **Keep tool definitions stable**: any change to tool names, descriptions, schemas, or ordering invalidates the cache.

**CAL (Context Assembly Layer) pattern** (Python, `cal-context`):

```python
# Two-zone architecture
Zone 1 (Stable): identity, tools, rules — fixed order, always cache hit.
Zone 2 (Dynamic): selected chunks, sorted alphabetically by chunk ID — deterministic ordering maximizes cache hits.
User Message: always last, never cached.
```

This is the most important insight: **cache-friendly context assembly is a sorting problem, not a selection problem**. If you sort dynamic chunks by relevance score, the same chunk lands at different positions between requests, breaking the prefix match. Sort by a stable key instead.

### Provider-Aware Caching Code

```typescript
interface CacheConfig {
  provider: 'anthropic' | 'openai' | 'gemini';
  breakpoint?: { mode: 'explicit' };
  cacheKey?: string;
  ttl?: '30m';
}

function applyCacheHints(options: CacheConfig, messages: Message[]) {
  if (options.provider === 'anthropic') {
    return {
      ...options,
      cache_control: { type: 'ephemeral' }, // top-level auto-cache
    };
  }
  if (options.provider === 'openai') {
    return {
      prompt_cache_options: {
        mode: options.breakpoint ? 'explicit' : 'implicit',
        ttl: options.ttl || '30m',
        ...(options.cacheKey && { prompt_cache_key: options.cacheKey }),
      },
    };
  }
  // Gemini: nothing to configure, implicit is automatic
  return options;
}
```

### Recommendation for mausVoice

For the desktop app's agent loops, caching is most valuable for:
1. **System prompt** (stable across all requests).
2. **Tool definitions** (stable within a session).
3. **Conversation history** (grows but prefix is stable).

Use the Vercel AI SDK's provider routing and configure caching per provider:
- Anthropic: top-level `cache_control` for automatic caching on the agent loop's system prompt.
- OpenAI: `prompt_cache_options` with `mode: 'implicit'` for conversation history, explicit breakpoints for the system prompt if needed.
- Gemini: nothing to configure; implicit is automatic.

For the Tauri backend, implement a two-zone context assembler: Zone 1 (system, tools, rules) in fixed order, Zone 2 (conversation history, retrieved context) appended deterministically. Never sort Zone 2 by relevance score if cache efficiency matters.

---

## Cross-Cutting Recommendations for mausVoice

### Architecture

```
apps/desktop/src/
  agent/
    loop.ts              # ToolLoopAgent or custom loop using Vercel AI SDK
    tools/
      computerUse.ts     # Abstraction over Gemini/Anthropic computer use
      index.ts           # Tool registry (agent-toolbelt pattern)
    providers/
      registry.ts        # createProviderRegistry with all configured providers
      adapters.ts        # Provider-specific tool format adapters
    context/
      assembler.ts       # Two-zone context assembly (cache-friendly)
      cache.ts           # Per-provider cache hint configuration
    vision/
      screenshot.ts      # Playwright / Tauri native screenshot
      actionLoop.ts      # Observe-decide-act loop
      actionDecoder.ts   # Normalize provider action formats
```

### Dependencies

- **Primary**: `ai` (Vercel AI SDK) for core LLM abstraction, tool calling, structured output.
- **Tools**: `agent-toolbelt` or hand-rolled `defineTool` with Zod for the tool registry.
- **Vision**: `playwright` for browser automation, or Tauri plugins for desktop screenshot/control.
- **Backend (Rust)**: `tiycore` as reference; implement `LLMProtocol` trait for Tauri commands.

### What to Avoid

- LangChain: too many abstraction layers, untyped escape hatches.
- LiteLLM gateway: adds network hop, drops provider-specific features.
- Raw provider SDKs: you will rewrite the translation layer three times.
- MCP for internal tool calling: MCP is for exposing tools to external clients, not for internal agent loops.

### Provider Priority

1. **Anthropic**: Best tool-use design, cleanest content-block model, extended thinking.
2. **Gemini**: Best computer-use API, implicit caching, Google Search grounding.
3. **OpenAI**: Largest ecosystem, strict mode, Responses API for stateful agents.
4. **Ollama**: Local fallback, OpenAI-compatible format, zero cost.

Use provider routing for cost/latency optimization. Use `providerOptions` for provider-specific features. Keep the core loop provider-agnostic.
