#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// These are the runtime DLLs shipped by sherpa-onnx's Windows shared build.
// Never copy arbitrary DLLs from Cargo's profile directory into the app
// bundle: build tools and unrelated native dependencies may be present there.
const WINDOWS_SHERPA_RUNTIME_DLLS = new Set([
  "onnxruntime.dll",
  "onnxruntime_providers_shared.dll",
  "sherpa-onnx-c-api.dll",
  "sherpa-onnx-cxx-api.dll",
]);

const buildTarget =
  process.env.CARGO_BUILD_TARGET?.trim() ||
  process.env.TAURI_ENV_TARGET_TRIPLE?.trim() ||
  null;
const targetTriple = buildTarget || resolveHostTargetTriple();
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
prepareSherpaWindowsRuntime();
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
  const allowFailure = options.allowFailure === true;
  const cargoArgs = [
    "build",
    "--locked",
    "--manifest-path",
    sidecarManifestPath,
    "--bin",
    binaryName,
  ];

  if (buildTarget) {
    cargoArgs.push("--target", buildTarget);
  }

  if (buildProfile === "release") {
    cargoArgs.push("--release");
  }

  if (gpuEnabled) {
    cargoArgs.push(
      "--features",
      resolveGpuCargoFeatures(targetTriple).join(","),
    );
  }

  const buildOk = run("cargo", cargoArgs, repoRoot, { allowFailure });
  if (!buildOk) {
    return null;
  }

  const sourceBinaryPath = buildArtifactPath(
    `${binaryName}${executableSuffix}`,
  );
  const destinationBinaryPath = join(
    tauriBinariesDir,
    `${binaryName}-${targetTriple}${executableSuffix}`,
  );

  if (!existsSync(sourceBinaryPath)) {
    fail(`Expected sidecar binary was not produced: ${sourceBinaryPath}`);
  }

  copyFileSync(sourceBinaryPath, destinationBinaryPath);
  if (!isWindowsTarget(targetTriple)) {
    chmodSync(destinationBinaryPath, 0o755);
  }

  console.log(
    `[sidecar] Prepared ${binaryName} for ${targetTriple}: ${destinationBinaryPath}`,
  );

  return destinationBinaryPath;
}

function buildArtifactPath(fileName) {
  return join(
    rustTargetDir,
    ...(buildTarget ? [buildTarget] : []),
    buildProfile,
    fileName,
  );
}

function prepareSherpaWindowsRuntime() {
  if (!isWindowsTarget(targetTriple)) {
    return;
  }

  const profileDir = join(
    rustTargetDir,
    ...(buildTarget ? [buildTarget] : []),
    buildProfile,
  );
  if (!existsSync(profileDir)) {
    return;
  }

  const runtimeDlls = readdirSync(profileDir).filter((name) =>
    WINDOWS_SHERPA_RUNTIME_DLLS.has(name.toLowerCase()),
  );
  for (const name of runtimeDlls) {
    const destinationDir = join(tauriBinariesDir, "onnxruntime");
    mkdirSync(destinationDir, { recursive: true });
    copyFileSync(join(profileDir, name), join(destinationDir, name));
    console.log(`[sidecar] Prepared sherpa Windows runtime: ${name}`);
  }
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
  const allowFailure = options.allowFailure === true;
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    const rendered = [command, ...args].join(" ");
    if (allowFailure) {
      console.warn(
        `[sidecar] Command failed (${result.status ?? "unknown"}): ${rendered}`,
      );
      return false;
    }
    fail(`Command failed (${result.status ?? "unknown"}): ${rendered}`);
  }

  return true;
}

function resolveHostTargetTriple() {
  const result = spawnSync("rustc", ["-vV"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: process.env,
  });

  if (result.status === 0 && result.stdout) {
    const hostLine = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("host:"));
    const hostTriple = hostLine?.slice("host:".length).trim();
    if (hostTriple) {
      return hostTriple;
    }
  }

  const fallback = mapPlatformArchToTarget(process.platform, process.arch);
  if (fallback) {
    return fallback;
  }

  fail(
    `Unable to determine Rust host target triple for platform=${process.platform} arch=${process.arch}`,
  );
}

function mapPlatformArchToTarget(platform, arch) {
  if (platform === "darwin" && arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (platform === "darwin" && arch === "x64") {
    return "x86_64-apple-darwin";
  }
  if (platform === "win32" && arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }
  if (platform === "win32" && arch === "arm64") {
    return "aarch64-pc-windows-msvc";
  }
  return null;
}

function isWindowsTarget(target) {
  return target.includes("windows");
}

function isAppleTarget(target) {
  return target.includes("apple-darwin");
}

function supportsNativeGpuSidecar(target) {
  return isAppleTarget(target) || target.includes("windows");
}

function resolveGpuCargoFeatures(target) {
  if (isAppleTarget(target)) {
    return ["gpu", "gpu-metal"];
  }

  if (target.includes("windows")) {
    return ["gpu", "gpu-vulkan"];
  }

  fail(`No GPU cargo feature mapping exists for ${target}`);
}

function resolveGpuBuildState(target) {
  if (!supportsNativeGpuSidecar(target)) {
    return {
      canBuildNative: false,
      reason: "native GPU sidecar builds are unsupported on this platform",
    };
  }

  if (isWindowsTarget(target)) {
    const vulkanSdkDir = process.env.VULKAN_SDK?.trim();
    if (!vulkanSdkDir || !existsSync(vulkanSdkDir)) {
      return {
        canBuildNative: false,
        reason: "VULKAN_SDK is not set to an existing directory",
      };
    }
  }

  return {
    canBuildNative: true,
    reason: null,
  };
}

// --- Native pill overlays (platform-specific) ---
// macOS pill is linked directly as a Rust library dependency (no sidecar needed).
// Windows pill is built as a separate binary.
if (isWindowsTarget(targetTriple)) {
  buildNativePill("rust_windows_pill", "mausvoice-windows-pill");
}

/// Decide what a failed pill build means.
///
/// A failed pill build used to be a warning only, which let a release
/// ship with a stale (or missing) pill binary while the build looked
/// green: the app falls back to the Tauri overlay, so long-press, drag
/// and the pause/cancel controls silently keep their old behaviour.
/// Treat it as fatal for release/CI builds, and keep it non-fatal for
/// local dev where a developer may not have the platform toolchain
/// installed — but only when a previously built binary exists to use.
function pillBuildFailureHandled(binaryName) {
  const message = `[sidecar] ${binaryName} build FAILED`;
  const allowFailure =
    process.env.MAUSVOICE_ALLOW_PILL_BUILD_FAILURE === "true";
  const isCI = process.env.CI === "true";
  if (!allowFailure && (buildProfile === "release" || isCI)) {
    fail(
      `${message}. Refusing to package a stale or missing pill binary — ` +
        `fix the build above, or set MAUSVOICE_ALLOW_PILL_BUILD_FAILURE=true to override.`,
    );
  }

  const pillDestPath = join(
    desktopDir,
    "src-tauri",
    "resources",
    `${binaryName}${executableSuffix}`,
  );
  if (!existsSync(pillDestPath)) {
    fail(
      `${message}. No previously built binary exists at ${pillDestPath} — ` +
        `the build cannot proceed with a missing pill binary.`,
    );
  }

  console.warn(`${message}; continuing with the previously built binary.`);
}

function buildNativePill(packageDir, binaryName) {
  const pillManifestPath = join(repoRoot, "packages", packageDir, "Cargo.toml");

  if (!existsSync(pillManifestPath)) {
    console.warn(`[sidecar] ${binaryName} manifest not found, skipping`);
    return;
  }

  const pillTargetDir = cargoTargetDirOverride
    ? isAbsolute(cargoTargetDirOverride)
      ? cargoTargetDirOverride
      : resolve(repoRoot, cargoTargetDirOverride)
    : join(repoRoot, "packages", packageDir, "target");

  const pillCargoArgs = [
    "build",
    "--manifest-path",
    pillManifestPath,
    "--bin",
    binaryName,
  ];

  if (buildTarget) {
    pillCargoArgs.push("--target", buildTarget);
  }

  if (buildProfile === "release") {
    pillCargoArgs.push("--release");
  }

  const buildOk = run("cargo", pillCargoArgs, repoRoot, {
    allowFailure: true,
  });

  if (!buildOk) {
    // A failed pill build used to be a warning only (see helper below).
    pillBuildFailureHandled(binaryName);
    return;
  }

  const pillSourcePath = join(
    pillTargetDir,
    ...(buildTarget ? [buildTarget] : []),
    buildProfile,
    `${binaryName}${executableSuffix}`,
  );

  const resourcesDir = join(desktopDir, "src-tauri", "resources");
  mkdirSync(resourcesDir, { recursive: true });
  const pillDestPath = join(resourcesDir, `${binaryName}${executableSuffix}`);

  if (existsSync(pillSourcePath)) {
    copyFileSync(pillSourcePath, pillDestPath);
    if (!isWindowsTarget(targetTriple)) {
      chmodSync(pillDestPath, 0o755);
    }
    console.log(`[sidecar] Prepared ${binaryName}: ${pillDestPath}`);
  } else {
    console.warn(
      `[sidecar] Expected pill binary not produced: ${pillSourcePath}`,
    );
  }
}

function fail(message) {
  console.error(`[sidecar] ${message}`);
  process.exit(1);
}
