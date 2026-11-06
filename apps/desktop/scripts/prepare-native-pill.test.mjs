import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNativePill } from "./prepare-native-pill.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const fixture = (overrides = {}) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "pill-build-"));
  dirs.push(repoRoot);
  const desktopDir = join(repoRoot, "apps", "desktop");
  const packageDir = "rust_windows_pill";
  const binaryName = "mausvoice-windows-pill";
  const destination = join(
    desktopDir,
    "src-tauri",
    "resources",
    `${binaryName}.exe`,
  );
  const source = join(
    repoRoot,
    "packages",
    packageDir,
    "target",
    "debug",
    `${binaryName}.exe`,
  );
  const manifest = join(repoRoot, "packages", packageDir, "Cargo.toml");
  const put = (path, content) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };
  const fail = (message) => {
    throw new Error(message);
  };
  const config = {
    packageDir,
    binaryName,
    repoRoot,
    desktopDir,
    cargoTargetDirOverride: null,
    buildTarget: null,
    targetTriple: "x86_64-pc-windows-msvc",
    buildProfile: "debug",
    executableSuffix: ".exe",
    run: vi.fn(() => true),
    fail,
    env: {},
    ...overrides,
  };
  return { config, manifest, destination, source, put };
};

describe("native pill packaging", () => {
  it("fails closed for a missing manifest or missing output in CI", () => {
    const { config, manifest, source, put } = fixture({ env: { CI: "true" } });
    expect(() => prepareNativePill(config)).toThrow("manifest not found");
    put(manifest, "[package]");
    expect(() => prepareNativePill(config)).toThrow(
      "expected binary not produced",
    );
    expect(existsSync(source)).toBe(false);
  });

  it("allows local fallback only with an existing binary", () => {
    const { config, manifest, destination, put } = fixture({
      run: vi.fn(() => false),
    });
    put(manifest, "[package]");
    expect(() => prepareNativePill(config)).toThrow(
      "No previously built binary",
    );
    put(destination, "previous");
    expect(() => prepareNativePill(config)).not.toThrow();
    expect(readFileSync(destination, "utf8")).toBe("previous");
  });

  it("rejects a directory masquerading as the previous executable", () => {
    const { config, manifest, destination, put } = fixture({
      run: vi.fn(() => false),
    });
    put(manifest, "[package]");
    mkdirSync(destination, { recursive: true });
    expect(() => prepareNativePill(config)).toThrow(
      "No previously built binary",
    );
  });

  it("copies the newly built executable and passes the explicit target and release flags", () => {
    const { config, manifest, destination, put } = fixture({
      buildProfile: "release",
      buildTarget: "x86_64-pc-windows-msvc",
      cargoTargetDirOverride: "shared-target",
    });
    const source = join(
      config.repoRoot,
      "shared-target",
      config.buildTarget,
      "release",
      `${config.binaryName}.exe`,
    );
    put(manifest, "[package]");
    put(source, "new binary");
    prepareNativePill(config);
    expect(readFileSync(destination, "utf8")).toBe("new binary");
    expect(config.run).toHaveBeenCalledWith(
      "cargo",
      expect.arrayContaining(["--target", config.buildTarget, "--release"]),
      config.repoRoot,
      { allowFailure: true },
    );
  });

  it("permits explicit CI override only with an existing fallback", () => {
    const { config, destination, put } = fixture({
      env: { CI: "true", MAUSVOICE_ALLOW_PILL_BUILD_FAILURE: "true" },
    });
    expect(() => prepareNativePill(config)).toThrow(
      "No previously built binary",
    );
    put(destination, "old");
    expect(() => prepareNativePill(config)).not.toThrow();
  });
});
