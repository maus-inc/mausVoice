#!/usr/bin/env node

import { spawn } from "node:child_process";

import { resolveDesktopDevScript } from "./platform-dev-config.mjs";

const platformOverride = process.env.MAUSVOICE_DESKTOP_PLATFORM?.trim();
const resolved = resolveDesktopDevScript(platformOverride);

if (!resolved) {
  console.error(
    `Unable to determine desktop dev script for platform "${platformOverride || process.platform}". ` +
      "Set MAUSVOICE_DESKTOP_PLATFORM to darwin, linux, or win32 to override.",
  );
  process.exit(1);
}

const { selectedScript } = resolved;

const npmNodeExecPath = process.env.npm_node_execpath || process.execPath;
const npmExecPath = process.env.npm_execpath;

// Prefer invoking the npm CLI the same way npm itself would spawn lifecycle scripts.
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const child = npmExecPath
  ? spawn(npmNodeExecPath, [npmExecPath, "run", selectedScript], {
      stdio: "inherit",
      env: process.env,
    })
  : spawn(npmBin, ["run", selectedScript], {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`Failed to start ${selectedScript}:`, error);
  process.exit(1);
});
