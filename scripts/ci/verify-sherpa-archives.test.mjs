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
      /ARCHIVE_SHA256_DIGESTS/,
      "build.rs must maintain pinned SHA-256 table",
    );

    // ORDER, not presence. The first version of this test was
    //
    //     assert.match(buildRs, /verify_archive_digest\(&archive_path,\s*&archive_name\)\?;/)
    //
    // with the message "must call verify_archive_digest before unpacking" -- and nothing in
    // that pattern relates the call to the unpack. Moving `verify_archive_digest` from
    // directly above the unpack to directly below the unpack closure, so that an
    // attacker-supplied archive is extracted onto disk and only then checked, left this
    // suite, `sherpa-onnx-link-mode.test.mjs` and `sherpa-build-script-tests.test.mjs` all
    // green: 4, 4 and 44 passing.
    //
    // One expression spanning both, so it can only match in the order verification has to
    // come in. The bounded window keeps it local: verification has to be near the unpack,
    // not anywhere earlier in the file.
    assert.match(
      buildRs,
      /verify_archive_digest\(&archive_path,\s*&archive_name\)\?;[\s\S]{0,400}?archive\.unpack\(&cache_root\)\?;/,
      "build.rs must verify the archive digest BEFORE unpacking it: extracting an " +
        "unverified, attacker-supplied archive onto disk is the defect this test exists " +
        "to prevent, and a bare presence check cannot see it",
    );

    // The cache-hit branch is a separate ordering, and it is pinned in
    // `sherpa-onnx-link-mode.test.mjs` ("the verified path is not: test for the archive,
    // verify it, then return the directory"). Left there rather than duplicated: two
    // copies of one ordering drift apart, and only one gets updated.
  });

  it("keeps the two verifications distinct, so neither can be deleted silently", () => {
    // Two call sites: the cache-hit branch (indented) and the download path. If one is
    // removed the other still satisfies the bare-presence regex, which is why that regex was
    // not enough on its own.
    const calls = buildRs.match(
      /verify_archive_digest\(&archive_path,\s*&archive_name\)\?;/g,
    );
    assert.equal(
      calls.length,
      2,
      "expected both the cache-hit and the download-path verifications",
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
