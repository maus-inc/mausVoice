import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// The ONNX Runtime archive is downloaded at build time by the transcription
// sidecar's build script. On 2026-11-17 Microsoft made `microsoft/onnxruntime` and
// its sibling repositories private, which removed the repository, its tags and
// every release asset at once. A build that knew only that one URL failed with a
// 404 on all three desktop platforms. These contracts keep the recovery honest:
// a fallback source must exist, every source must be digest-verified, and a
// definitive 404 must not be retried against a source that will never serve it.
describe("ONNX Runtime archive download contracts", () => {
  const buildRs = readFileSync(
    resolve(repoRoot, "packages/rust_transcription/build.rs"),
    "utf8",
  );

  it("keeps the upstream GitHub release as the primary source", () => {
    assert.match(
      buildRs,
      /https:\/\/github\.com\/microsoft\/onnxruntime\/releases\/download\/v\{ORT_VERSION\}/,
      "build.rs must still try the official GitHub release first",
    );
  });

  it("carries a second source, so one vanished repository cannot stop every build", () => {
    // The mirror is the recovery path. If it is deleted the build silently returns
    // to a single point of failure, which is the defect this file exists to stop.
    assert.match(
      buildRs,
      /https:\/\/registry\.npmmirror\.com\/-\/binary\/onnxruntime\/v\{ORT_VERSION\}/,
      "build.rs must keep the npmmirror fallback for the ONNX Runtime archive",
    );
  });

  it("offers an override for an internal mirror or an air-gapped release build", () => {
    assert.match(
      buildRs,
      /MAUSVOICE_ORT_DOWNLOAD_BASE_URLS/,
      "build.rs must honour MAUSVOICE_ORT_DOWNLOAD_BASE_URLS",
    );
  });

  it("verifies every source's bytes before the archive is stored", () => {
    // ORDER, not presence. The digest comparison and the `fs::rename` that stores
    // the verified archive are the two ends that matter: a check that ran after the
    // rename would leave unverified bytes in the cache. Index comparison, so a
    // later edit cannot satisfy it by moving the check below the rename.
    const compare = buildRs.indexOf("actual != asset.sha256");
    const rename = buildRs.indexOf("fs::rename(&temporary_path, archive_path)");
    assert.notEqual(compare, -1, "build.rs must compare the SHA-256");
    assert.notEqual(
      rename,
      -1,
      "build.rs must rename the verified archive into place",
    );
    assert.ok(
      compare < rename,
      "build.rs must compare the SHA-256 before renaming the archive into place",
    );
  });

  it("treats a client error as terminal rather than retrying a source that has no file", () => {
    // A 404 means this source will never serve the archive; retrying it three times
    // only delays the fallback. The classification lives in DownloadError, and the
    // loop breaks on a non-retryable error.
    assert.match(
      buildRs,
      /StatusCode\(code\)\s+if\s+\(400\.\.500\)\.contains\(&code\)/,
      "build.rs must classify a 4xx as a terminal download error",
    );
    assert.match(
      buildRs,
      /if\s+!error\.retryable\s*\|\|\s*attempt\s*==\s*3\s*\{\s*break;/,
      "build.rs must stop retrying a source when the error is not retryable",
    );
  });

  it("iterates the base URLs so the fallback is actually reached", () => {
    assert.match(
      buildRs,
      /for base_url in &base_urls/,
      "build.rs must try each base URL in turn",
    );
  });
});
