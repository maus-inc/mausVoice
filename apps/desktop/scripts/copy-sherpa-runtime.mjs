import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validateSherpaRuntimeDlls } from "./sidecar-runtime-dlls.mjs";

// Never ship unrelated build tools or native dependencies from Cargo's profile.
const runtimeDlls = new Set([
  "onnxruntime.dll",
  "onnxruntime_providers_shared.dll",
  "sherpa-onnx-c-api.dll",
  "sherpa-onnx-cxx-api.dll",
]);
const requiredDlls = new Set(["onnxruntime.dll", "sherpa-onnx-c-api.dll"]);

function assertUniqueRuntimeNames(files) {
  const names = new Set();
  for (const file of files) {
    const name = file.toLowerCase();
    if (names.has(name))
      throw new Error(`Duplicate Sherpa runtime DLL: ${name}`);
    names.add(name);
  }
}

/** Validate the complete runtime before copying any DLL into the bundle. */
export function copySherpaWindowsRuntime(
  profileDir,
  binariesDir,
  options = {},
) {
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  if (!existsSync(profileDir)) {
    throw new Error(`Sherpa Windows runtime profile is missing: ${profileDir}`);
  }
  const discovered = readdirSync(profileDir).filter((name) =>
    runtimeDlls.has(name.toLowerCase()),
  );
  assertUniqueRuntimeNames(discovered);
  const { missingRequired, missingOptional } = validateSherpaRuntimeDlls(
    discovered,
    requiredDlls,
    runtimeDlls,
  );
  if (missingRequired.length > 0) {
    throw new Error(
      `Sherpa-onnx Windows runtime is missing required DLLs: ${missingRequired.join(", ")} ` +
        `(found: ${discovered.join(", ") || "none"}) in ${profileDir}`,
    );
  }
  if (missingOptional.length > 0) {
    warn(
      `[sidecar] Sherpa Windows runtime may be incomplete; missing: ${missingOptional.join(", ")}`,
    );
  }
  const destination = join(binariesDir, "onnxruntime");
  mkdirSync(destination, { recursive: true });
  for (const name of discovered) {
    copyFileSync(join(profileDir, name), join(destination, name.toLowerCase()));
    log(`[sidecar] Prepared sherpa Windows runtime: ${name}`);
  }
}
