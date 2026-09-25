import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("sherpa-onnx-sys build verification contracts", () => {
  const buildRs = readFileSync(
    resolve(repoRoot, "patches/sherpa-onnx-sys-1.13.5/build.rs"),
    "utf8",
  );
  const cargoToml = readFileSync(
    resolve(repoRoot, "packages/rust_transcription/Cargo.toml"),
    "utf8",
  );

  it("patches sherpa-onnx-sys through rust_transcription Cargo manifest", () => {
    assert.match(
      cargoToml,
      /\[patch\.crates-io\][\s\S]*sherpa-onnx-sys\s*=\s*\{\s*path\s*=\s*"\.\.\/\.\.\/patches\/sherpa-onnx-sys-1\.13\.5"/,
      "packages/rust_transcription/Cargo.toml must patch sherpa-onnx-sys",
    );
  });

  it("enforces SHA-256 verification before archive extraction", () => {
    assert.match(
      buildRs,
      /verify_archive_digest\(&archive_path,\s*&archive_name\)\?;/,
      "build.rs must call verify_archive_digest before unpacking",
    );
    assert.match(
      buildRs,
      /ARCHIVE_SHA256_DIGESTS/,
      "build.rs must maintain pinned SHA-256 table",
    );
  });

  it("covers all tier-1 desktop platform release archives", () => {
    const requiredArchives = [
      "sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2",
      "sherpa-onnx-v1.13.5-linux-aarch64-static-lib.tar.bz2",
      "sherpa-onnx-v1.13.5-osx-x64-static-lib.tar.bz2",
      "sherpa-onnx-v1.13.5-osx-arm64-static-lib.tar.bz2",
      "sherpa-onnx-v1.13.5-win-x64-static-MT-Release-lib.tar.bz2",
      "sherpa-onnx-v1.13.5-win-x64-shared-MT-Release-lib.tar.bz2",
    ];

    for (const archive of requiredArchives) {
      assert.ok(
        buildRs.includes(archive),
        `Pinned digest table must include ${archive}`,
      );
    }
  });

  it("fails closed and removes corrupted or mismatched archives", () => {
    assert.match(
      buildRs,
      /fs::remove_file\(archive_path\)/,
      "verification failure must remove unverified archive",
    );
  });
});
