import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copySherpaWindowsRuntime } from "./copy-sherpa-runtime.mjs";

describe("Windows sherpa runtime packaging", () => {
  let root;
  let profile;
  let output;
  const log = vi.fn();
  const warn = vi.fn();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sherpa-package-"));
    profile = join(root, "profile");
    output = join(root, "binaries");
    mkdirSync(profile);
    vi.clearAllMocks();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const run = () => copySherpaWindowsRuntime(profile, output, { log, warn });

  it("copies only the allowlisted DLLs under canonical lower-case names", () => {
    writeFileSync(join(profile, "OnnxRuntime.dll"), "runtime");
    writeFileSync(join(profile, "sherpa-onnx-c-api.DLL"), "c-api");
    writeFileSync(join(profile, "build-tool.dll"), "not a runtime");
    run();
    expect(readdirSync(join(output, "onnxruntime")).sort()).toEqual([
      "onnxruntime.dll",
      "sherpa-onnx-c-api.dll",
    ]);
    expect(
      readFileSync(join(output, "onnxruntime", "onnxruntime.dll"), "utf8"),
    ).toBe("runtime");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("onnxruntime_providers_shared.dll"),
    );
  });

  it("rejects case-colliding runtime names before copying", () => {
    writeFileSync(join(profile, "onnxruntime.dll"), "first");
    writeFileSync(join(profile, "OnnxRuntime.DLL"), "second");
    // A case-insensitive host cannot represent this collision.
    if (readdirSync(profile).length < 2) return;
    writeFileSync(join(profile, "sherpa-onnx-c-api.dll"), "c-api");
    expect(run).toThrow(/duplicate.*onnxruntime\.dll/i);
    expect(() => readdirSync(output)).toThrow();
  });

  it("fails before copying any DLL if a required dependency is missing", () => {
    writeFileSync(join(profile, "onnxruntime.dll"), "runtime");
    expect(run).toThrow(/missing required DLLs.*sherpa-onnx-c-api\.dll/);
    expect(() => readdirSync(output)).toThrow();
  });

  it("fails closed if the cargo profile disappears", () => {
    rmSync(profile, { recursive: true });
    expect(run).toThrow(/runtime.*profile/i);
  });

  it("does not warn when all expected runtime DLLs exist", () => {
    for (const file of [
      "onnxruntime.dll",
      "onnxruntime_providers_shared.dll",
      "sherpa-onnx-c-api.dll",
      "sherpa-onnx-cxx-api.dll",
    ])
      writeFileSync(join(profile, file), file);
    run();
    expect(warn).not.toHaveBeenCalled();
    expect(readdirSync(join(output, "onnxruntime"))).toHaveLength(4);
  });
});
