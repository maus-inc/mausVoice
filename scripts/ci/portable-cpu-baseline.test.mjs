import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

// Every toolchain file the release, desktop-build and sidecar-test workflows
// feed to CMake. The transcription sidecar ships as a compiled binary, so the
// baseline these files select is the baseline every user's CPU must meet.
const TOOLCHAINS = {
  linux: "packages/rust_transcription/cmake/linux-ci-toolchain.cmake",
  macos: "packages/rust_transcription/cmake/macos-ci-toolchain.cmake",
  windows: "packages/rust_transcription/cmake/windows-ci-toolchain.cmake",
};

// ggml has no runtime dispatch between instruction-set variants in this static
// build, so anything in this list becomes a hard requirement of the binary.
const WIDER_THAN_BASELINE = [
  "GGML_AVX2",
  "GGML_AVX_VNNI",
  "GGML_BMI2",
  "GGML_FMA",
  "GGML_F16C",
  "GGML_AVX512",
  "GGML_AVX512_VBMI",
  "GGML_AVX512_VNNI",
  "GGML_AVX512_BF16",
  "GGML_AMX_TILE",
  "GGML_AMX_INT8",
  "GGML_AMX_BF16",
];

const WORKFLOWS = [
  ".github/workflows/build-desktop.yml",
  ".github/workflows/release.yml",
  ".github/workflows/test-package-rust-transcription.yml",
];

describe("transcription sidecar CPU baseline", () => {
  for (const [platform, path] of Object.entries(TOOLCHAINS)) {
    it(`disables native tuning in the ${platform} toolchain`, () => {
      assert.match(read(path), /set\(GGML_NATIVE OFF CACHE BOOL "" FORCE\)/);
    });

    it(`pins every instruction set wider than the baseline off in ${platform}`, () => {
      const source = read(path);

      for (const option of WIDER_THAN_BASELINE) {
        assert.match(
          source,
          new RegExp(`set\\(${option} OFF CACHE BOOL "" FORCE\\)`),
          `${option} must be forced off; GGML_NATIVE=OFF alone leaves it enabled`,
        );
        assert.doesNotMatch(
          source,
          new RegExp(`set\\(${option} ON`),
          `${option} must not be re-enabled`,
        );
      }
    });

    it(`keeps AVX enabled as the shipped ${platform} baseline`, () => {
      const source = read(path);

      // The startup guard in src/cpu_requirements.rs names AVX, so the build
      // and the check have to agree on the same floor.
      assert.doesNotMatch(source, /set\(GGML_AVX OFF/);
      assert.doesNotMatch(source, /set\(GGML_SSE42 OFF/);
    });
  }

  for (const workflow of WORKFLOWS) {
    it(`selects the portable toolchains from ${workflow}`, () => {
      const source = read(workflow);

      for (const path of Object.values(TOOLCHAINS)) {
        const toolchain = path.split("/").at(-1);
        assert.match(
          source,
          new RegExp(toolchain.replaceAll(".", "\\.")),
          `${workflow} must pass ${toolchain} to CMake`,
        );
      }
    });
  }

  it("documents the AVX requirement next to the startup guard", () => {
    assert.match(
      read("packages/rust_transcription/src/cpu_requirements.rs"),
      /REQUIRED_X86_FEATURE: &str = "AVX"/,
    );
    assert.match(
      read("packages/rust_transcription/src/lib.rs"),
      /cpu_requirements::check\(\)\?;/,
    );
  });
});
