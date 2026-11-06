import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isWindowsTarget, resolveGpuCargoFeatures } from "./sidecar-target.mjs";

function failClosed(dependencies, message) {
  dependencies.fail(message);
  // Production exits, but an injected or future reporter may return.
  throw new Error(message);
}

/** Assemble Cargo's exact target, profile and platform feature arguments. */
function cargoArguments(settings) {
  const args = [
    "build",
    "--locked",
    "--manifest-path",
    settings.sidecarManifestPath,
    "--bin",
    settings.binaryName,
  ];
  if (settings.buildTarget) args.push("--target", settings.buildTarget);
  if (settings.buildProfile === "release") args.push("--release");
  if (settings.gpuEnabled)
    args.push(
      "--features",
      resolveGpuCargoFeatures(settings.targetTriple).join(","),
    );
  return args;
}

/** Retry failed builds while keeping the final required attempt fail-closed. */
function buildWithRetries(settings, dependencies, args) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const last = attempt === maxAttempts;
    const allowFailure = last ? settings.allowFailure : true;
    if (dependencies.run("cargo", args, settings.repoRoot, { allowFailure }))
      return true;
    if (last) break;
    const delay = Math.min(
      5000 * 2 ** (attempt - 1) + dependencies.jitter(),
      30000,
    );
    dependencies.warn(
      `[sidecar] Retrying cargo build for ${settings.binaryName} (${attempt}/${maxAttempts}) in ${delay}ms — transient network may have caused sherpa download 500`,
    );
    dependencies.sleep(delay);
  }
  if (!settings.allowFailure)
    failClosed(
      dependencies,
      `Required cargo build failed: ${settings.binaryName}`,
    );
  return false;
}

/** Build a transcription sidecar and install only the produced target binary. */
export function buildSidecarArtifact(settings, dependencies) {
  const args = cargoArguments(settings);
  if (!buildWithRetries(settings, dependencies, args)) return null;
  const suffix = isWindowsTarget(settings.targetTriple) ? ".exe" : "";
  const source = join(
    settings.rustTargetDir,
    ...(settings.buildTarget ? [settings.buildTarget] : []),
    settings.buildProfile,
    `${settings.binaryName}${suffix}`,
  );
  const destination = join(
    settings.tauriBinariesDir,
    `${settings.binaryName}-${settings.targetTriple}${suffix}`,
  );
  if (!existsSync(source)) {
    failClosed(
      dependencies,
      `Expected sidecar binary was not produced: ${source}`,
    );
  }
  copyFileSync(source, destination);
  if (!isWindowsTarget(settings.targetTriple)) chmodSync(destination, 0o755);
  dependencies.log(
    `[sidecar] Prepared ${settings.binaryName} for ${settings.targetTriple}: ${destination}`,
  );
  return destination;
}
