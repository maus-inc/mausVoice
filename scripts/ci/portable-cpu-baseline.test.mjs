import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

// A setting that is commented out changes nothing, so the checks below have to
// read the active lines only. Otherwise a `# set(GGML_AVX2 ON ...)` note, or a
// raised-out line left in place during a bisect, would decide the result.
const activeLines = (source) =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

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
      assert.ok(
        activeLines(read(path)).includes(
          'set(GGML_NATIVE OFF CACHE BOOL "" FORCE)',
        ),
        `${platform} must set GGML_NATIVE OFF outside a comment`,
      );
    });

    it(`pins every instruction set wider than the baseline off in ${platform}`, () => {
      const lines = activeLines(read(path));

      for (const option of WIDER_THAN_BASELINE) {
        assert.ok(
          lines.includes(`set(${option} OFF CACHE BOOL "" FORCE)`),
          `${option} must be forced off outside a comment; GGML_NATIVE=OFF alone leaves it enabled`,
        );
        assert.ok(
          !lines.some((line) => line.startsWith(`set(${option} ON`)),
          `${option} must not be re-enabled`,
        );
      }
    });

    it(`keeps AVX enabled as the shipped ${platform} baseline`, () => {
      const lines = activeLines(read(path));

      // The startup guard in src/cpu_requirements.rs names AVX, so the build
      // and the check have to agree on the same floor.
      assert.ok(!lines.some((line) => line.startsWith("set(GGML_AVX OFF")));
      assert.ok(!lines.some((line) => line.startsWith("set(GGML_SSE42 OFF")));
    });
  }

  const toolchainNames = Object.values(TOOLCHAINS).map((path) =>
    path.split("/").at(-1),
  );

  for (const workflow of WORKFLOWS) {
    it(`selects the portable toolchains from ${workflow}`, () => {
      const source = read(workflow);
      // Every line that sets the variable, not merely every workflow that
      // names a file: a filename in a comment or a stale echo would satisfy a
      // substring search while CMake still used its default baseline.
      // Comments are excluded for the same reason: prose about the variable is
      // not an assignment, and a commented-out export sets nothing.
      const assignments = activeLines(source).filter((line) =>
        line.includes("CMAKE_TOOLCHAIN_FILE"),
      );

      assert.ok(
        assignments.length > 0,
        `${workflow} never sets CMAKE_TOOLCHAIN_FILE, so CMake keeps its default baseline`,
      );
      for (const line of assignments) {
        assert.ok(
          toolchainNames.some((name) => line.includes(name)),
          `${workflow} points CMAKE_TOOLCHAIN_FILE somewhere else: ${line.trim()}`,
        );
      }
      for (const name of toolchainNames) {
        assert.ok(
          assignments.some((line) => line.includes(name)),
          `${workflow} must pass ${name} to CMake`,
        );
      }
    });
  }

  it("lets the sidecar build inherit the toolchain from the environment", () => {
    const source = read("apps/desktop/scripts/prepare-sidecars.mjs");
    const cargoSpawn = source.slice(
      source.indexOf("spawnSync(command, args"),
      source.indexOf("spawnSync(command, args") + 200,
    );

    // CMake reads CMAKE_TOOLCHAIN_FILE from the environment, so the cargo
    // child has to inherit it. An explicit env object here would silently
    // drop the variable and rebuild the sidecar for the runner's own CPU.
    assert.ok(
      cargoSpawn.includes('stdio: "inherit"'),
      "the sidecar build should still spawn cargo directly",
    );
    assert.doesNotMatch(
      cargoSpawn,
      /\benv:/,
      "the cargo spawn must inherit CMAKE_TOOLCHAIN_FILE rather than pass its own env",
    );
  });

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
