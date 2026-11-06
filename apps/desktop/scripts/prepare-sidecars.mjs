#!/usr/bin/env node

import { randomInt } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copySherpaWindowsRuntime } from "./copy-sherpa-runtime.mjs";
import { buildSidecarArtifact } from "./build-sidecar-artifact.mjs";
import { sleepSync } from "./sidecar-sleep.mjs";
import { runSidecarCommand } from "./sidecar-command.mjs";
import { prepareNativePill } from "./prepare-native-pill.mjs";
import {
  resolveHostTargetTriple,
  isWindowsTarget,
  isAppleTarget,
  resolveGpuBuildState,
} from "./sidecar-target.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "../..");
const sidecarManifestPath = join(
  repoRoot,
  "packages",
  "rust_transcription",
  "Cargo.toml",
);
const cargoTargetDirOverride = process.env.CARGO_TARGET_DIR?.trim() || null;
const rustTargetDir = cargoTargetDirOverride
  ? isAbsolute(cargoTargetDirOverride)
    ? cargoTargetDirOverride
    : resolve(repoRoot, cargoTargetDirOverride)
  : join(repoRoot, "packages", "rust_transcription", "target");
const tauriBinariesDir = join(desktopDir, "src-tauri", "binaries");

const buildTarget =
  process.env.CARGO_BUILD_TARGET?.trim() ||
  process.env.TAURI_ENV_TARGET_TRIPLE?.trim() ||
  null;
let targetTriple = buildTarget;
if (!targetTriple) {
  try {
    targetTriple = resolveHostTargetTriple({ cwd: repoRoot });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
const buildProfile =
  process.env.MAUSVOICE_SIDECAR_PROFILE === "release" ? "release" : "debug";
const requireNativeGpuSidecar =
  process.env.MAUSVOICE_REQUIRE_GPU_SIDECAR === "true";
const executableSuffix = isWindowsTarget(targetTriple) ? ".exe" : "";

if (!existsSync(sidecarManifestPath)) {
  fail(`Missing sidecar manifest at ${sidecarManifestPath}`);
}

mkdirSync(tauriBinariesDir, { recursive: true });

const cpuSidecarPath = buildAndCopy("rust-transcription-cpu", false);
if (isWindowsTarget(targetTriple)) {
  try {
    copySherpaWindowsRuntime(buildArtifactPath(""), tauriBinariesDir);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
prepareOnnxRuntimeLibrary();
const gpuBuildState = resolveGpuBuildState(targetTriple);

if (gpuBuildState.canBuildNative) {
  const gpuSidecarPath = buildAndCopy("rust-transcription-gpu", true, {
    allowFailure: !requireNativeGpuSidecar,
  });

  if (!gpuSidecarPath) {
    mirrorCpuSidecarAsGpu(cpuSidecarPath);
  }
} else {
  if (requireNativeGpuSidecar) {
    fail(
      `Native GPU sidecar is required for ${targetTriple}, but unavailable: ${gpuBuildState.reason}`,
    );
  }

  console.warn(
    `[sidecar] Skipping native GPU sidecar build for ${targetTriple}: ${gpuBuildState.reason}`,
  );
  mirrorCpuSidecarAsGpu(cpuSidecarPath);
}

function buildAndCopy(binaryName, gpuEnabled, options = {}) {
  return buildSidecarArtifact(
    {
      binaryName,
      gpuEnabled,
      allowFailure: options.allowFailure === true,
      targetTriple,
      buildTarget,
      buildProfile,
      sidecarManifestPath,
      rustTargetDir,
      tauriBinariesDir,
      repoRoot,
    },
    {
      run,
      sleep: sleepSync,
      jitter: () => randomInt(0, 1000),
      warn: console.warn,
      log: console.log,
      fail,
    },
  );
}

function buildArtifactPath(fileName) {
  return join(
    rustTargetDir,
    ...(buildTarget ? [buildTarget] : []),
    buildProfile,
    fileName,
  );
}

function prepareOnnxRuntimeLibrary() {
  const libraryName = onnxRuntimeLibraryName(targetTriple);
  const sourcePath = buildArtifactPath(libraryName);
  if (!existsSync(sourcePath)) {
    fail(
      `Expected ONNX Runtime library was not provisioned by the sidecar build: ${sourcePath}`,
    );
  }

  const destinationDir = join(tauriBinariesDir, "onnxruntime");
  const destinationPath = join(destinationDir, libraryName);
  mkdirSync(destinationDir, { recursive: true });
  copyFileSync(sourcePath, destinationPath);
  console.log(
    `[sidecar] Prepared ONNX Runtime ${libraryName}: ${destinationPath}`,
  );
}

function onnxRuntimeLibraryName(target) {
  if (isWindowsTarget(target)) {
    return "onnxruntime.dll";
  }
  if (isAppleTarget(target)) {
    return "libonnxruntime.dylib";
  }
  return "libonnxruntime.so";
}

function mirrorCpuSidecarAsGpu(cpuSidecarPath) {
  const gpuDestinationPath = join(
    tauriBinariesDir,
    `rust-transcription-gpu-${targetTriple}${executableSuffix}`,
  );
  copyFileSync(cpuSidecarPath, gpuDestinationPath);
  if (!isWindowsTarget(targetTriple)) {
    chmodSync(gpuDestinationPath, 0o755);
  }

  console.warn(
    `[sidecar] Using CPU sidecar binary for rust-transcription-gpu on ${targetTriple}: ${gpuDestinationPath}`,
  );
}

function run(command, args, cwd, options = {}) {
  return runSidecarCommand(command, args, cwd, options, { fail });
}

// --- Native pill overlays (platform-specific) ---
// macOS pill is linked directly as a Rust library dependency (no sidecar needed).
// Windows pill is built as a separate binary.
if (isWindowsTarget(targetTriple)) {
  prepareNativePill({
    packageDir: "rust_windows_pill",
    binaryName: "mausvoice-windows-pill",
    repoRoot,
    desktopDir,
    cargoTargetDirOverride,
    buildTarget,
    targetTriple,
    buildProfile,
    executableSuffix,
    run,
    fail,
  });
}

function fail(message) {
  console.error(`[sidecar] ${message}`);
  process.exit(1);
}
