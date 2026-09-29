import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BUILD_RS = join(
  REPO_ROOT,
  "patches",
  "sherpa-onnx-sys-1.13.5",
  "build.rs",
);
const TRANSCRIPTION_MANIFEST = join(
  REPO_ROOT,
  "packages",
  "rust_transcription",
  "Cargo.toml",
);

/**
 * One `[target.'cfg(...)'.dependencies]` table for sherpa-onnx, with the cfg
 * predicate split from the dependency line.
 *
 * The cfg text carries nested parentheses, so it is taken with a greedy match up
 * to the closing `'` rather than a balanced scan. No cfg contains a quote, so
 * the greedy match cannot run past the end of the predicate.
 */
const sherpaTargetTables = (manifest) =>
  manifest
    .split(/^\[target\./m)
    .slice(1)
    .map((table) => {
      const predicate = table.match(/^'(.*)'\.dependencies\]/);
      const line = table
        .split("\n")
        .find(
          (row) =>
            row.includes("sherpa-onnx =") && !row.includes("sherpa-onnx-sys"),
        );
      return predicate && line ? { cfg: predicate[1], line } : null;
    })
    .filter(Boolean);

/** True when a cfg predicate sends the android target to a different table. */
const excludesAndroid = (cfg) =>
  /not\s*\([^)]*target_os\s*=\s*"android"/.test(cfg);

/**
 * The prebuilt Android archive is one tarball holding shared objects under
 * `jniLibs/{abi}/`. There is no static Android release, so two things have to
 * hold or the Android sidecar cannot link:
 *
 * 1. No target table may ask for the `static` feature without excluding android
 *    from its cfg. `emit_static_link_directives` would then ask the linker for
 *    twelve `static=` archives the archive does not contain.
 * 2. The build script must not answer a static request on android with a
 *    directory of `.so` files. Returning that directory is what produced a
 *    "cannot find -lsherpa-onnx-c-api" failure that read like a missing library
 *    rather than like an unserviceable request, so it has to be refused.
 *
 * Both were true at once in the shape these tests exist to catch: the manifest
 * asked for `static` on every non-Windows target, and the build script mapped
 * `LinkMode::Static | LinkMode::Shared` on android to the same archive.
 */
describe("sherpa-onnx link mode on android", () => {
  it("requests static only from cfgs that exclude android", () => {
    const tables = sherpaTargetTables(
      readFileSync(TRANSCRIPTION_MANIFEST, "utf8"),
    );
    const staticTables = tables.filter(({ line }) => line.includes('"static"'));

    // Without this the loop below would pass on an empty list, which is how an
    // earlier version of this test came to guard nothing.
    assert.ok(
      staticTables.length > 0,
      "no target table requests the static feature, so this guard would pass vacuously",
    );

    for (const { cfg, line } of staticTables) {
      assert.ok(
        excludesAndroid(cfg),
        `the static feature is requested by a cfg that does not exclude android, and the android archive ships shared objects only: ${line.trim()}`,
      );
    }
  });

  it("asks for shared on the android cfg", () => {
    const android = sherpaTargetTables(
      readFileSync(TRANSCRIPTION_MANIFEST, "utf8"),
    ).filter(
      // The table that *selects* android, not the one whose not(...) excludes
      // it. Both name the target and only one of them is the android build.
      ({ cfg }) =>
        /target_os\s*=\s*"android"/.test(cfg) && !excludesAndroid(cfg),
    );

    // A manifest that never names android leaves the choice to the platform
    // default, which is static. Naming the target is what makes the mode
    // reviewable at all, so require the table rather than skipping it.
    assert.equal(
      android.length,
      1,
      "expected exactly one sherpa-onnx target table that names android, so the mode android is linked with is an explicit choice",
    );
    assert.match(
      android[0].line,
      /"shared"/,
      `the android target table does not request shared: ${android[0].line.trim()}`,
    );
  });

  it("answers a static request on android with a refusal, not an archive", () => {
    const buildRs = readFileSync(BUILD_RS, "utf8");
    const start = buildRs.indexOf("fn archive_name(");
    assert.ok(start > -1, "archive_name was not found in the build script");
    const nextFn = buildRs.indexOf("\nfn ", start + 1);
    const archiveName = buildRs.slice(
      start,
      nextFn > -1 ? nextFn : buildRs.length,
    );

    // The arm may exist, but it must not hand back an archive name: that path
    // resolves to a jniLibs directory and then emits `static=` link directives
    // for libraries the archive never contained. `format!` as the first thing in
    // the body is the shape that hands an archive name back, and it covers the
    // combined `LinkMode::Static | LinkMode::Shared` pattern as well.
    assert.doesNotMatch(
      archiveName,
      /\(LinkMode::Static[^)]*"android"[^)]*\)\s*=>\s*\{\s*format!/,
      "archive_name answers a static request on android with an archive name; that resolves to shared objects the static link directives cannot use",
    );
    assert.match(
      archiveName,
      /\(LinkMode::Static[^)]*"android"[^)]*\)\s*=>\s*\{?\s*return Err/,
      "archive_name has no arm that refuses a static request on android",
    );
  });
});
