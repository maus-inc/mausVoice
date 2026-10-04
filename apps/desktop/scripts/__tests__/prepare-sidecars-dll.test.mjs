import { describe, it, expect } from "vitest";
import { validateSherpaRuntimeDlls } from "../sidecar-runtime-dlls.mjs";

// Mirror the sets declared in prepare-sidecars.mjs.
const REQUIRED_SHERPA_RUNTIME_DLLS = new Set([
  "onnxruntime.dll",
  "sherpa-onnx-c-api.dll",
]);

const WINDOWS_SHERPA_RUNTIME_DLLS = new Set([
  "onnxruntime.dll",
  "onnxruntime_providers_shared.dll",
  "sherpa-onnx-c-api.dll",
  "sherpa-onnx-cxx-api.dll",
]);

describe("validateSherpaRuntimeDlls", () => {
  it("accepts a case-variant on-disk name (e.g. OnnxRuntime.dll)", () => {
    const { missingRequired, missingOptional } = validateSherpaRuntimeDlls(
      [
        "OnnxRuntime.dll",
        "ONNXRUNTIME_PROVIDERS_SHARED.DLL",
        "Sherpa-Onnx-C-Api.dll",
        "Sherpa-Onnx-Cxx-Api.dll",
      ],
      REQUIRED_SHERPA_RUNTIME_DLLS,
      WINDOWS_SHERPA_RUNTIME_DLLS,
    );
    expect(missingRequired).toEqual([]);
    expect(missingOptional).toEqual([]);
  });

  it("treats arbitrary casing of a discovered DLL as present", () => {
    const { missingRequired } = validateSherpaRuntimeDlls(
      ["ONNXRUNTIME.DLL", "SHERPA-ONNX-C-API.DLL"],
      REQUIRED_SHERPA_RUNTIME_DLLS,
      WINDOWS_SHERPA_RUNTIME_DLLS,
    );
    expect(missingRequired).toEqual([]);
  });

  it("fails closed: reports missing required DLLs", () => {
    const { missingRequired } = validateSherpaRuntimeDlls(
      ["sherpa-onnx-c-api.dll"],
      REQUIRED_SHERPA_RUNTIME_DLLS,
      WINDOWS_SHERPA_RUNTIME_DLLS,
    );
    expect(missingRequired).toEqual(["onnxruntime.dll"]);
  });

  it("reports missing optional DLLs without failing", () => {
    const { missingRequired, missingOptional } = validateSherpaRuntimeDlls(
      ["onnxruntime.dll", "sherpa-onnx-c-api.dll"],
      REQUIRED_SHERPA_RUNTIME_DLLS,
      WINDOWS_SHERPA_RUNTIME_DLLS,
    );
    expect(missingRequired).toEqual([]);
    expect(missingOptional).toEqual([
      "onnxruntime_providers_shared.dll",
      "sherpa-onnx-cxx-api.dll",
    ]);
  });

  it("does not flag a discovered DLL missing when only optional ones are absent", () => {
    const { missingRequired } = validateSherpaRuntimeDlls(
      ["onnxruntime.dll", "sherpa-onnx-c-api.dll"],
      REQUIRED_SHERPA_RUNTIME_DLLS,
      WINDOWS_SHERPA_RUNTIME_DLLS,
    );
    expect(missingRequired).toEqual([]);
  });
});
