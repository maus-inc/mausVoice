import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mapPlatformArchToTarget,
  resolveGpuBuildState,
  resolveGpuCargoFeatures,
  resolveHostTargetTriple,
} from "./sidecar-target.mjs";

describe("sidecar target policy", () => {
  it.each([
    ["darwin", "arm64", "aarch64-apple-darwin"],
    ["darwin", "x64", "x86_64-apple-darwin"],
    ["win32", "x64", "x86_64-pc-windows-msvc"],
    ["win32", "arm64", "aarch64-pc-windows-msvc"],
    ["linux", "x64", null],
  ])("maps %s/%s to its target", (platform, arch, expected) => {
    expect(mapPlatformArchToTarget(platform, arch)).toBe(expected);
  });

  it("uses native features only for supported targets", () => {
    expect(resolveGpuCargoFeatures("aarch64-apple-darwin")).toEqual([
      "gpu",
      "gpu-metal",
    ]);
    expect(resolveGpuCargoFeatures("x86_64-pc-windows-msvc")).toEqual([
      "gpu",
      "gpu-vulkan",
    ]);
    expect(() => resolveGpuCargoFeatures("x86_64-unknown-linux-gnu")).toThrow(
      "No GPU cargo feature mapping",
    );
    expect(
      resolveGpuBuildState("x86_64-unknown-linux-gnu", {}).canBuildNative,
    ).toBe(false);
    expect(
      resolveGpuBuildState("aarch64-apple-darwin", {}).canBuildNative,
    ).toBe(true);
  });

  it("requires an actual Vulkan SDK directory on Windows", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulkan-sdk-"));
    try {
      const file = join(dir, "not-a-directory");
      writeFileSync(file, "fixture");
      for (const value of [undefined, "", file, join(dir, "missing")]) {
        expect(
          resolveGpuBuildState("x86_64-pc-windows-msvc", { VULKAN_SDK: value })
            .canBuildNative,
        ).toBe(false);
      }
      expect(
        resolveGpuBuildState("x86_64-pc-windows-msvc", {
          VULKAN_SDK: ` ${dir} `,
        }).canBuildNative,
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("prefers rustc's host triple and falls back only on known hosts", () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: "rustc 1.0\nhost: x86_64-unknown-linux-gnu\n",
    }));
    expect(
      resolveHostTargetTriple({
        cwd: "/fixture",
        platform: "darwin",
        arch: "arm64",
        env: {},
        spawn,
      }),
    ).toBe("x86_64-unknown-linux-gnu");
    expect(spawn).toHaveBeenCalledWith(
      "rustc",
      ["-vV"],
      expect.objectContaining({ cwd: "/fixture" }),
    );
    const failed = () => ({ status: null, error: new Error("missing rustc") });
    expect(
      resolveHostTargetTriple({
        cwd: "/fixture",
        platform: "darwin",
        arch: "arm64",
        spawn: failed,
      }),
    ).toBe("aarch64-apple-darwin");
    expect(() =>
      resolveHostTargetTriple({
        cwd: "/fixture",
        platform: "linux",
        arch: "x64",
        spawn: failed,
      }),
    ).toThrow("Unable to determine Rust host target triple");
  });
});
