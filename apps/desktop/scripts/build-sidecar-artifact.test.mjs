import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSidecarArtifact } from "./build-sidecar-artifact.mjs";

describe("building and packaging a transcription sidecar", () => {
  let root;
  let settings;
  let dependencies;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sidecar-artifact-"));
    settings = {
      binaryName: "rust-transcription-cpu",
      gpuEnabled: false,
      allowFailure: false,
      targetTriple: "x86_64-unknown-linux-gnu",
      buildTarget: null,
      buildProfile: "debug",
      sidecarManifestPath: join(root, "Cargo.toml"),
      rustTargetDir: join(root, "target"),
      tauriBinariesDir: join(root, "binaries"),
      repoRoot: root,
    };
    mkdirSync(join(root, "target", "debug"), { recursive: true });
    mkdirSync(settings.tauriBinariesDir);
    dependencies = {
      run: vi.fn(() => true),
      sleep: vi.fn(),
      jitter: () => 123,
      warn: vi.fn(),
      log: vi.fn(),
      fail: (message) => {
        throw new Error(message);
      },
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const artifact = () =>
    writeFileSync(
      join(root, "target", "debug", "rust-transcription-cpu"),
      "binary",
    );

  it("passes the locked cargo arguments and installs an executable", () => {
    artifact();
    const result = buildSidecarArtifact(settings, dependencies);
    expect(dependencies.run).toHaveBeenCalledExactlyOnceWith(
      "cargo",
      [
        "build",
        "--locked",
        "--manifest-path",
        settings.sidecarManifestPath,
        "--bin",
        settings.binaryName,
      ],
      root,
      { allowFailure: true },
    );
    expect(readFileSync(result, "utf8")).toBe("binary");
    expect(statSync(result).mode & 0o777).toBe(0o755);
  });

  it("retries with jitter and makes only the last required attempt fatal", () => {
    artifact();
    dependencies.run
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    buildSidecarArtifact(settings, dependencies);
    expect(
      dependencies.run.mock.calls.map((call) => call[3].allowFailure),
    ).toEqual([true, true, false]);
    expect(dependencies.sleep.mock.calls).toEqual([[5123], [10123]]);
  });

  it("returns no artifact after an optional build fails three times", () => {
    dependencies.run.mockReturnValue(false);
    expect(
      buildSidecarArtifact({ ...settings, allowFailure: true }, dependencies),
    ).toBeNull();
    expect(
      dependencies.run.mock.calls.map((call) => call[3].allowFailure),
    ).toEqual([true, true, true]);
    expect(dependencies.sleep).toHaveBeenCalledTimes(2);
  });

  it("fails closed if the final required build or failure reporter returns", () => {
    dependencies.run.mockReturnValue(false);
    dependencies.fail = vi.fn();
    expect(() => buildSidecarArtifact(settings, dependencies)).toThrow(
      /Required cargo build failed/,
    );
    expect(dependencies.fail).toHaveBeenCalledOnce();
    expect(dependencies.run).toHaveBeenCalledTimes(3);
  });

  it("rejects a successful build that produced no binary", () => {
    expect(() => buildSidecarArtifact(settings, dependencies)).toThrow(
      /Expected sidecar binary was not produced/,
    );
  });

  it("uses the target-specific release path and GPU features for Windows", () => {
    const target = "x86_64-pc-windows-msvc";
    const profile = join(root, "target", target, "release");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "rust-transcription-gpu.exe"), "gpu");
    const result = buildSidecarArtifact(
      {
        ...settings,
        binaryName: "rust-transcription-gpu",
        gpuEnabled: true,
        targetTriple: target,
        buildTarget: target,
        buildProfile: "release",
      },
      dependencies,
    );
    expect(readFileSync(result, "utf8")).toBe("gpu");
    expect(result).toContain(`rust-transcription-gpu-${target}.exe`);
    expect(dependencies.run.mock.calls[0][1]).toEqual([
      "build",
      "--locked",
      "--manifest-path",
      settings.sidecarManifestPath,
      "--bin",
      "rust-transcription-gpu",
      "--target",
      target,
      "--release",
      "--features",
      "gpu,gpu-vulkan",
    ]);
  });
});
