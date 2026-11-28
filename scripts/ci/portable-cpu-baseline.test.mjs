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

// Which platform a step or job belongs to. A workflow that names the right
// file in the wrong job still builds the wrong baseline, so the check below
// reads the owning step and runner, not just the filename.
const PLATFORM_MATCHERS = {
  linux: /linux|ubuntu/i,
  macos: /macos|mac os|osx/i,
  windows: /windows|win32/i,
};

const owningContext = (lines, index) => {
  let stepName = "";
  let runner = "";
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const line = lines[cursor].trim();
    if (stepName === "" && line.startsWith("- name:")) stepName = line;
    if (runner === "" && line.startsWith("runs-on:")) runner = line;
    if (stepName !== "" && runner !== "") break;
  }
  return `${stepName} ${runner}`;
};

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
      const lines = source.split("\n");
      // Comments are excluded because prose about the variable is not an
      // assignment; a commented-out export sets nothing.
      const assignments = lines
        .map((text, index) => ({ text: text.trim(), index }))
        .filter(
          ({ text }) =>
            text.length > 0 &&
            !text.startsWith("#") &&
            /CMAKE_TOOLCHAIN_FILE["']?\s*[:=]/.test(text),
        );

      assert.ok(
        assignments.length > 0,
        `${workflow} never sets CMAKE_TOOLCHAIN_FILE, so CMake keeps its default baseline`,
      );
      for (const { text } of assignments) {
        assert.ok(
          toolchainNames.some((name) => text.includes(name)),
          `${workflow} points CMAKE_TOOLCHAIN_FILE somewhere else: ${text}`,
        );
      }
      for (const [platform, path] of Object.entries(TOOLCHAINS)) {
        const name = path.split("/").at(-1);
        const assignment = assignments.find(({ text }) => text.includes(name));

        assert.ok(assignment, `${workflow} must pass ${name} to CMake`);
        // A Linux job that exported the macOS file would satisfy a name-only
        // search while shipping the wrong baseline.
        assert.match(
          owningContext(lines, assignment.index),
          PLATFORM_MATCHERS[platform],
          `${workflow} sets ${name} in a step that does not belong to ${platform}`,
        );
      }
    });
  }

  for (const workflow of WORKFLOWS) {
    it(`retires the cargo cache when the baseline changes in ${workflow}`, () => {
      const source = read(workflow);

      // whisper-rs-sys declares no rerun-if-env-changed for the toolchain, so a
      // restored target directory keeps the instruction set of the run that
      // filled it. The cache key has to carry the toolchain content, or the fix
      // reaches CI on a fresh runner and never reaches a cached release build.
      assert.match(
        source,
        /key:.*hashFiles\('packages\/rust_transcription\/cmake\/\*-ci-toolchain\.cmake'\)/,
        `${workflow} must hash the toolchain files into its cargo cache key`,
      );
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
