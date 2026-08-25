#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

const tauriArgs = process.argv.slice(2);
const tauriCommand = tauriArgs[0];
const requestedTarget = readOptionValue(tauriArgs, "--target");

if (tauriCommand === "build" || tauriCommand === "dev") {
  const targets = resolveTargets(requestedTarget);
  const sidecarProfile =
    process.env.MAUSVOICE_SIDECAR_PROFILE ||
    (tauriCommand === "build" ? "release" : "debug");

  for (const target of targets) {
    const prepareEnv = {
      ...process.env,
      MAUSVOICE_SIDECAR_PROFILE: sidecarProfile,
    };

    if (target) {
      prepareEnv.CARGO_BUILD_TARGET = target;
    } else {
      delete prepareEnv.CARGO_BUILD_TARGET;
    }

    run("node", ["scripts/prepare-sidecars.mjs"], prepareEnv);
  }

  if (requestedTarget === "universal-apple-darwin") {
    composeUniversalMacSidecars();
  }
}

if (tauriCommand === "build") {
  // Turbo caches the desktop `build` task, but the NSIS sidebar bitmap is
  // gitignored and is not a task output, so a cache hit would restore
  // neither the bitmap nor its regeneration - and the Tauri bundle step
  // would then fail on the missing `sidebarImage` (or ship a stale one).
  // This wrapper is never cached, so regenerate here, immediately before
  // every Tauri bundle. `--windows-only` keeps non-Windows hosts, which
  // never bundle NSIS, a fast no-op.
  run("node", ["../../scripts/generate-windows-installer-sidebar.mjs", "--windows-only"], process.env);
}

// §5.7: `CI=false` is a truthy string, so bare truthiness would misclassify
// it as CI. Compare explicitly against "true".
const inCi = process.env.CI === "true";
const isReleaseBuild = process.env.RELEASE_BUILD === "true";
if (tauriCommand === "build" && !inCi && !isReleaseBuild) {
  // The committed config ships createUpdaterArtifacts: false; the release
  // pipeline flips it on via workflow. A local `tauri build` therefore makes
  // an installer that can never self-update — say so loudly instead of
  // letting the build look shippable.
  try {
    const { readFileSync } = await import("node:fs");
    const config = JSON.parse(
      readFileSync(join(process.cwd(), "src-tauri", "tauri.conf.json"), "utf8"),
    );
    if (config?.bundle?.createUpdaterArtifacts === false) {
      console.warn(
        "\n⚠ createUpdaterArtifacts is false in src-tauri/tauri.conf.json —\n" +
          "  this local build CANNOT self-update. Release builds enable it in CI.\n" +
          "  To produce an updating build locally, flip the flag (and provide\n" +
          "  TAURI_SIGNING_PRIVATE_KEY) or run the release workflow.\n",
      );
    }
  } catch {
    // Config probe is advisory; never block the build on it.
  }
}

run("tauri", tauriArgs, process.env);

function resolveTargets(requestedTarget) {
  if (!requestedTarget) {
    return [null];
  }

  if (requestedTarget === "universal-apple-darwin") {
    return ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  }

  return [requestedTarget];
}

function readOptionValue(args, optionName) {
  const exactIndex = args.indexOf(optionName);
  if (exactIndex >= 0) {
    return args[exactIndex + 1] || null;
  }

  const inlinePrefix = `${optionName}=`;
  const inlineArg = args.find((arg) => arg.startsWith(inlinePrefix));
  if (!inlineArg) {
    return null;
  }

  const value = inlineArg.slice(inlinePrefix.length).trim();
  return value.length > 0 ? value : null;
}

function composeUniversalMacSidecars() {
  if (process.platform !== "darwin") {
    fail(
      "universal-apple-darwin sidecar composition requires a macOS runner with lipo",
    );
  }

  const binariesDir = join(process.cwd(), "src-tauri", "binaries");
  const sidecars = ["rust-transcription-cpu", "rust-transcription-gpu"];

  for (const sidecarName of sidecars) {
    const arm64Path = join(binariesDir, `${sidecarName}-aarch64-apple-darwin`);
    const x64Path = join(binariesDir, `${sidecarName}-x86_64-apple-darwin`);
    const universalPath = join(
      binariesDir,
      `${sidecarName}-universal-apple-darwin`,
    );

    if (!existsSync(arm64Path) || !existsSync(x64Path)) {
      fail(
        `Missing architecture-specific sidecars for universal build: ${arm64Path}, ${x64Path}`,
      );
    }

    run(
      "lipo",
      ["-create", "-output", universalPath, arm64Path, x64Path],
      process.env,
    );
    chmodSync(universalPath, 0o755);

    process.stdout.write(
      `[tauri-sidecar] Prepared ${sidecarName} for universal-apple-darwin: ${universalPath}\n`,
    );
  }
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env,
    shell: true,
  });

  if (result.status !== 0) {
    const rendered = [command, ...args].join(" ");
    process.stderr.write(
      `[tauri-sidecar] Command failed (${result.status ?? "unknown"}): ${rendered}\n`,
    );
    process.exit(result.status ?? 1);
  }
}

function fail(message) {
  process.stderr.write(`[tauri-sidecar] ${message}\n`);
  process.exit(1);
}
