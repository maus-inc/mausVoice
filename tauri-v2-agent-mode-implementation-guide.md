# Tauri v2 Agent Mode Backend Implementation Guide

Sources verified against official Tauri v2 docs at v2.tauri.app, docs.rs, and plugin registries.

---

## 1. Command Registration Patterns

### 1.1 Module Organization (mod.rs pattern)

Commands should live in `src-tauri/src/commands/` as separate files, not bloating `lib.rs`.

src-tauri/src/commands/mod.rs

```rust
pub mod screenshot;
pub mod input;
pub mod agent;
```

src-tauri/src/commands/screenshot.rs

```rust
use tauri::{AppHandle, Runtime, WebviewWindow, command};

#[command]
pub async fn capture_window<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<String, String> {
    let label = window.label();
    let screenshot = app
        .screenshot()
        .capture_window(label)
        .await
        .map_err(|e| e.to_string())?;
    let base64 = screenshot.to_base64();
    Ok(base64)
}
```

src-tauri/src/lib.rs

```rust
mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::screenshot::capture_window,
            commands::input::send_keys,
            commands::agent::run_agent_step,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Rule: command names must be unique across all modules. The `commands::` prefix is for Rust resolution only; the JS command name stays `capture_window`.

### 1.2 State<T> Pattern

State is registered once in `Builder::setup` and injected into commands.

src-tauri/src/lib.rs

```rust
use std::sync::Mutex;
use tauri::{Builder, Manager, State};

struct AgentState {
    pub session_id: String,
    pub step_count: usize,
}

#[derive(Default)]
struct AppState {
    pub counter: usize,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(AgentState {
                session_id: "session-001".into(),
                step_count: 0,
            });
            app.manage(Mutex::new(AppState::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agent::increment_step,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

src-tauri/src/commands/agent.rs

```rust
use tauri::{State, command};

#[command]
fn increment_step(state: State<'_, AgentState>) -> usize {
    state.step_count + 1
}

#[command]
async fn async_increment(
    state: State<'_, Mutex<AppState>>,
) -> Result<u32, String> {
    let mut data = state.lock().map_err(|e| e.to_string())?;
    data.counter += 1;
    Ok(data.counter)
}
```

State rules from docs:
- Must be `Send + Sync + 'static`
- Use interior mutability (`Mutex`, `tokio::sync::Mutex`) for mutable state
- Tauri wraps state in `Arc`; do not wrap it yourself
- Mismatched types cause runtime panic, not compile error. Use a type alias if needed.

### 1.3 Returning Complex Types

Screenshots as base64:

```rust
#[derive(serde::Serialize)]
struct ScreenshotResult {
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub format: String,
}

#[command]
async fn capture_screenshot<R: Runtime>(
    app: AppHandle<R>,
) -> Result<ScreenshotResult, String> {
    let screenshot = app
        .screenshot()
        .capture_window("main")
        .await
        .map_err(|e| e.to_string())?;

    Ok(ScreenshotResult {
        base64: screenshot.to_base64(),
        width: screenshot.width(),
        height: screenshot.height(),
        format: "png".into(),
    })
}
```

Optimized binary via `tauri::ipc::Response` (bypasses JSON serialization):

```rust
use tauri::ipc::Response;

#[command]
fn read_screenshot_file() -> Response {
    let data = std::fs::read("/path/to/screenshot.png").unwrap();
    Response::new(data)
}
```

Frontend receives `Uint8Array` for `Response` types.

Coordinates as struct:

```rust
#[derive(serde::Serialize, serde::Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(serde::Serialize)]
pub struct BoundingBox {
    pub top_left: Point,
    pub bottom_right: Point,
}

#[command]
fn get_element_bounds() -> Result<BoundingBox, String> {
    Ok(BoundingBox {
        top_left: Point { x: 100, y: 200 },
        bottom_right: Point { x: 300, y: 400 },
    })
}
```

### 1.4 Error Handling

Recommended pattern with `thiserror` + explicit `Serialize`:

```rust
use thiserror::Error;

#[derive(Debug, Error)]
enum AgentError {
    #[error("screenshot capture failed: {0}")]
    ScreenshotFailed(String),
    #[error("invalid window label: {0}")]
    InvalidWindow(String),
    #[error("input injection denied: {0}")]
    InputDenied(String),
}

impl serde::Serialize for AgentError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

#[command]
async fn run_agent_step(
    window: WebviewWindow,
) -> Result<String, AgentError> {
    let label = window.label();
    if label != "main" {
        return Err(AgentError::InvalidWindow(label.into()));
    }
    // ... logic
    Ok("step-complete".into())
}
```

Frontend:

```typescript
import { invoke } from '@tauri-apps/api/core';

try {
  const result = await invoke<string>('run_agent_step');
} catch (error) {
  // error is the serialized string from AgentError
  console.error(error);
}
```

For richer error objects on the frontend:

```rust
#[derive(serde::Serialize)]
#[serde(tag = "kind", content = "message")]
enum ErrorKind {
    ScreenshotFailed(String),
    InputDenied(String),
}

impl serde::Serialize for AgentError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        let kind = match self {
            AgentError::ScreenshotFailed(msg) => ErrorKind::ScreenshotFailed(msg.clone()),
            AgentError::InputDenied(msg) => ErrorKind::InputDenied(msg.clone()),
            AgentError::InvalidWindow(msg) => ErrorKind::InputDenied(msg.clone()),
        };
        kind.serialize(serializer)
    }
}
```

Frontend type:

```typescript
type AgentError = { kind: 'screenshotFailed' | 'inputDenied'; message: string };
```

---

## 2. Plugin Initialization

### 2.1 Screenshots Plugin

Cargo.toml:

```toml
[dependencies]
tauri-plugin-screenshots = "2"
```

src-tauri/src/lib.rs:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_screenshots::init())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

Capability:

```json
{
  "identifier": "agent-capability",
  "windows": ["main"],
  "permissions": [
    "screenshots:default"
  ]
}
```

Frontend (verified from lib.rs registry):

```typescript
import {
  getScreenshotableWindows,
  getWindowScreenshot,
} from "tauri-plugin-screenshots-api";

const windows = await getScreenshotableWindows();
const path = await getWindowScreenshot(windows[0].id);
```

Note: `tauri-plugin-screenshots` stores screenshots to disk and returns a path. For base64 in-memory transfer, call the Rust command directly and convert there.

### 2.2 Shell Plugin

Cargo.toml:

```toml
[dependencies]
tauri-plugin-shell = "2"
```

src-tauri/src/lib.rs:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

JavaScript usage:

```typescript
import { Command } from '@tauri-apps/plugin-shell';

const result = await Command.create('my-cli', ['--flag', 'value'])
  .execute();
console.log(result);
```

Rust usage:

```rust
use tauri_plugin_shell::ShellExt;
let shell = app_handle.shell();
let output = shell
    .command("echo")
    .args(["Hello from Rust!"])
    .output()
    .await
    .unwrap();
```

### 2.3 Plugin Configuration Pattern

Plugins accept typed config via `Builder`:

```rust
use serde::Deserialize;
use tauri::{plugin::Builder, plugin::TauriPlugin, Runtime};

#[derive(Deserialize)]
pub struct AgentConfig {
    pub max_steps: usize,
    pub screenshot_format: String,
}

pub fn init<R: Runtime>() -> TauriPlugin<R, AgentConfig> {
    Builder::<R, AgentConfig>::new("agent")
        .setup(|app, api| {
            let config = api.config();
            println!("max_steps = {}", config.max_steps);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agent::run_agent_step,
        ])
        .build()
}
```

tauri.conf.json:

```json
{
  "plugins": {
    "agent": {
      "max_steps": 50,
      "screenshot_format": "png"
    }
  }
}
```

---

## 3. Capabilities System

### 3.1 Capability File Layout

src-tauri/capabilities/agent.json:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "agent-capability",
  "description": "Capability for the agent mode window",
  "windows": ["agent"],
  "permissions": [
    "core:default",
    "core:window:default",
    "core:app:default",
    "screenshots:default",
    "shell:allow-execute",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        {
          "name": "xdotool",
          "cmd": "xdotool",
          "args": [
            "key", { "validator": "\\S+" }
          ],
          "sidecar": false
        },
        {
          "name": "osascript",
          "cmd": "osascript",
          "args": [
            "-e", { "validator": "\\S+" }
          ],
          "sidecar": false
        }
      ]
    }
  ]
}
```

### 3.2 Reference Capabilities in tauri.conf.json

src-tauri/tauri.conf.json:

```json
{
  "app": {
    "security": {
      "capabilities": [
        "agent",
        "main-capability"
      ]
    },
    "windows": [
      {
        "label": "agent",
        "title": "Agent Mode",
        "width": 400,
        "height": 600,
        "resizable": true
      }
    ]
  }
}
```

Capabilities in `src-tauri/capabilities/` are auto-discovered. Once explicitly listed in `tauri.conf.json`, only those are active.

### 3.3 Scope Capabilities to Specific Windows

By `windows` field (exact match or glob):

```json
{
  "identifier": "admin-capability",
  "windows": ["admin-*"],
  "permissions": ["shell:allow-execute"]
}
```

By `webviews` field for sub-webviews inside a window:

```json
{
  "identifier": "sub-view-capability",
  "windows": ["main"],
  "webviews": ["agent-webview"],
  "permissions": ["core:default"]
}
```

### 3.4 Restrict Shell Commands to Allowed Programs

Use permission entries with `allow` array. Each entry scopes the command:

```json
{
  "identifier": "shell:allow-execute",
  "allow": [
    {
      "name": "xdotool",
      "cmd": "xdotool",
      "args": ["key", { "validator": "\\S+" }],
      "sidecar": false
    },
    {
      "name": "adb",
      "cmd": "adb",
      "args": ["shell", "input", "tap", { "validator": "\\d+" \\d+" }],
      "sidecar": false
    }
  ]
}
```

Validator uses regex. `\\S+` matches any non-whitespace. Combine entries for multiple allowed programs.

### 3.5 Platform-Specific Capabilities

```json
{
  "identifier": "desktop-agent",
  "windows": ["agent"],
  "platforms": ["linux", "macOS", "windows"],
  "permissions": [
    "global-shortcut:allow-register",
    "screenshots:default"
  ]
}
```

---

## 4. IPC Patterns

### 4.1 Calling Rust from TypeScript

Install guest bindings or use the core `invoke`:

```typescript
import { invoke } from '@tauri-apps/api/core';

// Basic invocation
const result = await invoke<string>('capture_window');
```

With arguments:

```typescript
interface CaptureArgs {
  windowLabel: string;
  format: 'png' | 'jpeg';
}

const result = await invoke<ScreenshotResult>('capture_window', {
  windowLabel: 'main',
  format: 'png',
});
```

### 4.2 Handling Binary Data

For screenshots, prefer returning a base64 string from Rust to avoid binary IPC pitfalls:

```rust
#[command]
async fn capture_window_base64<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<String, String> {
    let screenshot = app
        .screenshot()
        .capture_window(window.label())
        .await
        .map_err(|e| e.to_string())?;
    Ok(screenshot.to_base64())
}
```

TypeScript:

```typescript
const base64 = await invoke<string>('capture_window_base64');
const binary = atob(base64);
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) {
  bytes[i] = binary.charCodeAt(i);
}
```

If raw bytes are required, use `tauri::ipc::Response`:

```rust
use tauri::ipc::Response;

#[command]
fn read_binary() -> Response {
    let data = std::fs::read("screenshot.png").unwrap();
    Response::new(data)
}
```

TypeScript:

```typescript
const buffer = await invoke<Uint8Array>('read_binary');
const blob = new Blob([buffer], { type: 'image/png' });
```

Note: On Android, `InvokeBody::Raw` is not supported. Base64 is the safe cross-platform choice.

### 4.3 Error Handling in TypeScript

All `Result<T, E>` errors arrive as rejected promises:

```typescript
import { invoke } from '@tauri-apps/api/core';

async function safeStep() {
  try {
    const result = await invoke<string>('run_agent_step');
    return result;
  } catch (error) {
    // error is the serialized error value
    console.error('Agent step failed:', error);
    throw error;
  }
}
```

### 4.4 invoke Type Safety

Use generics for return types:

```typescript
interface Point { x: number; y: number; }

const point = await invoke<Point>('get_cursor_position');
```

For plugin commands, use the plugin namespace:

```typescript
import { invoke } from '@tauri-apps/api/core';

// App command
await invoke('run_agent_step');

// Plugin command (if plugin exposes commands)
await invoke('plugin:agent|run_step');
```

---

## 5. Build and Configuration Patterns

### 5.1 tauri.conf.json for Desktop Automation

src-tauri/tauri.conf.json:

```json
{
  "build": {
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build",
    "devUrl": "http://localhost:5173",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": false,
    "security": {
      "csp": "default-src 'self'; connect-src ipc: http://ipc.localhost https://api.openai.com https://api.anthropic.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline';",
      "capabilities": ["agent", "main-capability"]
    },
    "windows": [
      {
        "label": "agent",
        "title": "Agent Mode",
        "width": 400,
        "height": 600,
        "resizable": true,
        "fullscreen": false
      }
    ]
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/icon.icns", "icons/icon.ico"],
    "externalBin": [
      "binaries/xdotool",
      "binaries/osascript"
    ],
    "resources": [
      "binaries/**"
    ]
  },
  "plugins": {
    "shell": {
      "open": true,
      "execute": true
    }
  }
}
```

### 5.2 Bundling External Binaries for Shell Commands

Place platform-specific binaries in `src-tauri/binaries/`:

```
src-tauri/binaries/
  xdotool-x86_64-unknown-linux-gnu
  xdotool-x86_64-apple-darwin
  xdotool-x86_64-pc-windows-msvc.exe
```

Tauri resolves them by pattern `binary-name{-target-triple}{.system-extension}`.

Reference in `tauri.conf.json`:

```json
{
  "bundle": {
    "externalBin": [
      "binaries/xdotool"
    ]
  }
}
```

Use in capability:

```json
{
  "identifier": "shell:allow-execute",
  "allow": [
    {
      "name": "xdotool",
      "cmd": "xdotool",
      "args": ["key", { "validator": "\\S+" }],
      "sidecar": true
    }
  ]
}
```

### 5.3 CSP for Agent UI

`dangerousDisableAssetCspModification` is only for `style-src` to allow Emotion/MUI. Do not expand it.

Correct CSP for an agent UI that calls APIs:

```json
{
  "security": {
    "csp": "default-src 'self'; connect-src ipc: http://ipc.localhost https://api.openai.com https://api.anthropic.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:;"
  }
}
```

Directives:
- `default-src 'self'`: only local assets
- `connect-src ipc:`: required for Tauri IPC
- `img-src 'self' data:`: for screenshot display
- `style-src 'self' 'unsafe-inline'`: required for Emotion/MUI runtime styles

### 5.4 Multi-Platform Builds

Platform-specific config overrides are merged:

src-tauri/tauri.macos.conf.json:

```json
{
  "bundle": {
    "macOS": {
      "minimumSystemVersion": "12.0",
      "hardenedRuntime": true,
      "entitlements": "./ entitlements.mac.plist"
    }
  }
}
```

src-tauri/tauri.linux.conf.json:

```json
{
  "bundle": {
    "linux": {
      "appimage": {
        "bundleMediaFramework": false
      }
    }
  }
}
```

src-tauri/tauri.windows.conf.json:

```json
{
  "bundle": {
    "windows": {
      "webviewInstallMode": {
        "type": "downloadBootstrapper",
        "silent": true
      },
      "wix": {
        "upgradeCode": "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
      }
    }
  }
}
```

Environment variables available in build hooks:

- `TAURI_ENV_PLATFORM`
- `TAURI_ENV_ARCH`
- `TAURI_ENV_FAMILY`
- `TAURI_ENV_PLATFORM_VERSION`
- `TAURI_ENV_TARGET_TRIPLE`
- `TAURI_ENV_DEBUG`

Use them in `beforeBuildCommand` to produce platform-specific artifacts.

---

## Quick Reference: File Layout

```
src-tauri/
  Cargo.toml
  tauri.conf.json
  tauri.macos.conf.json
  tauri.linux.conf.json
  tauri.windows.conf.json
  capabilities/
    agent.json
    main-capability.json
  src/
    lib.rs
    commands/
      mod.rs
      screenshot.rs
      input.rs
      agent.rs
    db/
      mod.rs
      migrations/
  gen/
    schemas/
      desktop-schema.json
      mobile-schema.json
  binaries/
    xdotool-x86_64-unknown-linux-gnu
    xdotool-x86_64-apple-darwin
    xdotool-x86_64-pc-windows-msvc.exe
```

---

## Verification Commands

```bash
pnpm --filter desktop check-types
pnpm --filter desktop lint
pnpm --filter desktop test
pnpm --filter @maus-inc/voice-ai test
pnpm --filter @repo/agent test
```
