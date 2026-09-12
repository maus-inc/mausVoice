#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TAURI_DEV_CONFIG = "src-tauri/tauri.local.conf.json";

export const tauriDevArguments = (config) => [
  fileURLToPath(new URL("./run-tauri-with-sidecars.mjs", import.meta.url)),
  "dev",
  "--features",
  "debug-assist",
  "--config",
  config,
];

export const runTauriDev = ({
  config = process.env.TAURI_DEV_CONFIG || DEFAULT_TAURI_DEV_CONFIG,
  env = process.env,
  spawn = spawnSync,
} = {}) => {
  const result = spawn(process.execPath, tauriDevArguments(config), {
    cwd: process.cwd(),
    stdio: "inherit",
    env,
    // TAURI_DEV_CONFIG is developer-controlled input. Pass it as its own
    // argument to the wrapper instead of interpolating it into a shell command.
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runTauriDev();
}
