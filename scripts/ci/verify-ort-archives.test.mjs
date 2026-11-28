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
// 404 on all three desktop platforms. These contracts pin the shipped source
// configuration. The Rust loopback tests exercise the downloader behavior.
describe("ONNX Runtime archive download contracts", () => {
  const buildRs = readFileSync(
    resolve(repoRoot, "packages/rust_transcription/build.rs"),
    "utf8",
  );

  it("keeps the upstream GitHub release as the primary source", () => {
    const primary = buildRs.indexOf(
      "https://github.com/microsoft/onnxruntime/releases/download/",
    );
    const mirror = buildRs.indexOf(
      "https://registry.npmmirror.com/-/binary/onnxruntime/",
    );
    assert.ok(
      primary >= 0 && mirror > primary,
      "the official release must precede its mirror",
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
});
