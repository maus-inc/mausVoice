#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Generating @maus-inc/desktop-native-apis bindings..."

cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --example gen_bindings

# Post-process: tauri-specta (2.0.0-rc.21) unconditionally emits event scaffolding
# (Channel/TAURI_CHANNEL, TAURI_API_EVENT, WebviewWindow, __EventObj__, __makeEvents__)
# even when the project registers no events. Those unused exports fail the desktop
# tsc build under noUnusedLocals. Strip them deterministically so the generated file
# matches the committed output (and future regenerations stay clean).
if command -v python3 >/dev/null 2>&1; then
  PY_BIN="python3"
elif command -v python >/dev/null 2>&1 && python --version 2>&1 | grep -q "Python 3"; then
  PY_BIN="python"
else
  echo "ERROR: gen:bindings post-process requires Python 3 (python3 or python)." >&2
  exit 1
fi
"$PY_BIN" - <<'PY'
import pathlib
p = pathlib.Path("packages/desktop-native-apis/src/bindings.ts")
s = p.read_text(encoding="utf-8")

# 1. Drop the unused Channel/event/WebviewWindow imports.
s = s.replace('\tChannel as TAURI_CHANNEL,\n', "")
s = s.replace('import * as TAURI_API_EVENT from "@tauri-apps/api/event";\n', "")
s = s.replace('import { type WebviewWindow as __WebviewWindow__ } from "@tauri-apps/api/webviewWindow";\n', "")

# 2. Drop the __EventObj__ type block (situation before `export type Result`).
start = s.find("type __EventObj__<T> = {")
if start != -1:
    end = s.find("\n};\n", start)
    if end != -1:
        s = s[:start] + s[end + len("\n};\n"):]

# 3. Drop the __makeEvents__ helper (last item, to end of file).
start = s.find("function __makeEvents__<T extends Record<string, any>>(")
if start != -1:
    s = s[:start]

p.write_text(s, encoding="utf-8")
print("Stripped unused specta event scaffolding from bindings.ts")
PY
