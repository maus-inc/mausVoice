import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Build the native pill, refusing silent stale or missing release artifacts. */
export function prepareNativePill({
  packageDir,
  binaryName,
  repoRoot,
  desktopDir,
  cargoTargetDirOverride,
  buildTarget,
  targetTriple,
  buildProfile,
  executableSuffix,
  run,
  fail,
  env = process.env,
}) {
  const pillManifestPath = join(repoRoot, "packages", packageDir, "Cargo.toml");
  const destination = join(
    desktopDir,
    "src-tauri",
    "resources",
    `${binaryName}${executableSuffix}`,
  );
  const failure = (reason) => {
    const message = `[sidecar] ${binaryName} build FAILED: ${reason}`;
    if (
      env.MAUSVOICE_ALLOW_PILL_BUILD_FAILURE !== "true" &&
      (buildProfile === "release" || env.CI === "true")
    ) {
      fail(
        `${message}. Refusing to package a stale or missing pill binary — fix the build above, or set MAUSVOICE_ALLOW_PILL_BUILD_FAILURE=true to override.`,
      );
      return;
    }
    if (!existsSync(destination) || !statSync(destination).isFile()) {
      fail(
        `${message}. No previously built binary exists at ${destination} — the build cannot proceed with a missing pill binary.`,
      );
      return;
    }
    console.warn(`${message}; continuing with the previously built binary.`);
  };
  if (!existsSync(pillManifestPath)) {
    failure(`manifest not found: ${pillManifestPath}`);
    return;
  }
  const pillTargetDir = cargoTargetDirOverride
    ? isAbsolute(cargoTargetDirOverride)
      ? cargoTargetDirOverride
      : resolve(repoRoot, cargoTargetDirOverride)
    : join(repoRoot, "packages", packageDir, "target");
  const args = [
    "build",
    "--manifest-path",
    pillManifestPath,
    "--bin",
    binaryName,
  ];
  if (buildTarget) args.push("--target", buildTarget);
  if (buildProfile === "release") args.push("--release");
  if (!run("cargo", args, repoRoot, { allowFailure: true })) {
    failure("cargo failed");
    return;
  }
  const source = join(
    pillTargetDir,
    ...(buildTarget ? [buildTarget] : []),
    buildProfile,
    `${binaryName}${executableSuffix}`,
  );
  if (!existsSync(source)) {
    failure(`expected binary not produced: ${source}`);
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (!targetTriple.includes("windows")) chmodSync(destination, 0o755);
  console.log(`[sidecar] Prepared ${binaryName}: ${destination}`);
}
