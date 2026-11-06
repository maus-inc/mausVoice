import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const HOST_TARGETS = {
  "darwin:arm64": "aarch64-apple-darwin",
  "darwin:x64": "x86_64-apple-darwin",
  "win32:x64": "x86_64-pc-windows-msvc",
  "win32:arm64": "aarch64-pc-windows-msvc",
};

export const mapPlatformArchToTarget = (platform, arch) =>
  HOST_TARGETS[`${platform}:${arch}`] ?? null;
export const isWindowsTarget = (target) => target.includes("windows");
export const isAppleTarget = (target) => target.includes("apple-darwin");

export function resolveGpuCargoFeatures(target) {
  if (isAppleTarget(target)) return ["gpu", "gpu-metal"];
  if (isWindowsTarget(target)) return ["gpu", "gpu-vulkan"];
  throw new Error(`No GPU cargo feature mapping exists for ${target}`);
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Decide whether a native GPU build is supported by the target and SDK. */
export function resolveGpuBuildState(target, env = process.env) {
  if (!isAppleTarget(target) && !isWindowsTarget(target)) {
    return {
      canBuildNative: false,
      reason: "native GPU sidecar builds are unsupported on this platform",
    };
  }
  if (isWindowsTarget(target)) {
    const vulkanSdkDir = env.VULKAN_SDK?.trim();
    if (!vulkanSdkDir || !isDirectory(vulkanSdkDir)) {
      return {
        canBuildNative: false,
        reason: "VULKAN_SDK is not set to an existing directory",
      };
    }
  }
  return { canBuildNative: true, reason: null };
}

/** Prefer rustc's host; fall back only for supported development hosts. */
export function resolveHostTargetTriple({
  cwd,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  spawn = spawnSync,
}) {
  const result = spawn("rustc", ["-vV"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env,
  });
  if (result.status === 0 && result.stdout) {
    const hostLine = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("host:"));
    const host = hostLine?.slice("host:".length).trim();
    if (host) return host;
  }
  const fallback = mapPlatformArchToTarget(platform, arch);
  if (fallback) return fallback;
  throw new Error(
    `Unable to determine Rust host target triple for platform=${platform} arch=${arch}`,
  );
}
