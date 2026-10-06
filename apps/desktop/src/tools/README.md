# Tools

A tool is one thing the agent can do on the user's behalf. This folder holds the registry that decides which ones exist, which ones are enabled, and what a tool is allowed to say about itself.

## Registering a tool

Add an entry to `TOOL_REGISTRY` in `index.ts`:

```ts
[
  TOOL_REGISTRY.set("my_thing", {
    id: "my_thing",
    scope: "chat",
    factory: () => new MyThingTool(),
    getInfo: () => MyThingTool.info,
  }),
];
```

Four fields, all required. Note there is no `risk` on the entry: the tier belongs to the `ToolInfo` that `getInfo` returns, so it is passed to `staticInfo` where the rest of the description is written.

**`risk` is required and enforced.** It is a `ToolRisk`: `low`, `medium`, `high`, `critical`. `createTool()` and `listRegisteredToolInfos()` both call `assertRateable`, which throws when `info.risk` is not a tier the app recognises. There is no way to register an unrated tool, which means there is no tool whose permission prompt nobody decided how to phrase.

**`scope`** is `pill`, `chat`, or omitted for both. The pill is the always-on-top voice window, the chat is the full window. A tool that types into the focused field is useful in both; one that ends the conversation only makes sense in the pill.

**`description` and `instructions`** are what the model reads, and they are also what a permission dialog shows. Write the instruction in plain language: "paste text into whatever field has focus", not "invoke paste". The model picks a tool from its description, and a user grants permission to a description, not to a name.

**`schema`** is a JSON Schema. The agent loop injects a required `reason` string into it before sending, so do not declare one yourself.

## The four risk tiers

`TOOL_RISK` in `packages/types` maps each tier to how it is handled:

| Tier       | Behaviour                                      | Example                                             |
| ---------- | ---------------------------------------------- | --------------------------------------------------- |
| `low`      | Runs without asking                            | Reading accessibility info, ending the conversation |
| `medium`   | Asks once, with an always-allow                | Pasting text into the focused field                 |
| `high`     | Asks, and always-allow is scoped to the action | Running a terminal command                          |
| `critical` | Warns, then confirms                           | Anything that cannot be undone or loses data        |

Low-risk tools run immediately. That is not a shortcut: prompting on every turn trains a user to click Allow without reading, and a user who clicks Allow without reading has no permission system at all. The tier is where that judgement is written down, so the cost of getting it wrong is visible in review.

Assign a tier by asking what happens if this runs unasked and is wrong. Reading the screen cannot break anything. Typing into a field can overwrite text, and the user can undo it by typing again. Running a command spawns a process that may be impossible to interrupt.

## Always allow

`getAlwaysAllow` and `setToolAlwaysAllow` in `base.tool.ts` store grants in `localStorage` under a scope. A grant made in a conversation is written at that conversation's scope. For a `computer_use:*` tool it is written at the action type as well, because that tool id names an action rather than a conversation. Every other tool gets one scope. `getToolAlwaysAllow` also honours a global grant and a legacy unscoped key, so grants made by older builds keep working.

Revoking removes every scope, not just the one asked about. The alternative is a revoke that reports the tool is no longer always allowed while a live grant from another scope keeps running it, which is worse than not having the revoke at all.

## Permission flow

`executeWithPermission` in `src/agents/run-agent.ts` is the only path to `execute()`. In order:

1. Bail if the loop is no longer active. A permission prompt that outlives the run would otherwise resume a tool call nobody is waiting for.
2. Run immediately when `TOOL_RISK[info.risk].prompt` is false.
3. Check always-allow.
4. Otherwise request a permission, mark the tool call `awaiting-permission`, and poll for the resolution.
5. Run it, or return a failure the model can read and react to.

`execute()` itself never throws. It returns `{ success: false, failureReason }`, because an exception from a tool becomes an unhandled rejection somewhere upstream and the run ends without the model learning what happened.

## Current tools

| Tool                     | Risk   | Scope | What it does                                           |
| ------------------------ | ------ | ----- | ------------------------------------------------------ |
| `paste`                  | medium | both  | Pastes text into the focused field                     |
| `get_accessibility_info` | low    | both  | Reads the focused field and surrounding screen context |
| `end_conversation`       | low    | pill  | Closes the assistant turn                              |
| `run_terminal_command`   | high   | both  | Runs a command from the Rust allowlist                 |

`run_terminal_command` validates against `ALLOWED_COMMANDS` in `src-tauri/src/commands.rs` and rejects forbidden shell characters. It returns `{ stdout, stderr, exitCode }` and returns null when power mode is off, which is what makes the tool disappear rather than fail.

## Testing a tool

Three cases, minimum: the happy path, a failure the tool can produce itself, and the case where permission is denied. A tool that can throw needs an error-path test; a tool that touches the system needs the denied test, because the denial path is where a tool usually leaks state.
