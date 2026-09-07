import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const WORKFLOW_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  ".github",
  "workflows",
);

// Every pinned action and the version comment next to it. Each SHA was
// resolved through the GitHub API while writing this test: the commit must be
// the exact commit of the claimed tag, and its action.yml must declare a
// node24 (or composite) runtime. GitHub removes the Node 20 runtime from
// runners on 2026-09-16; any pin that still declares node20 will fail to
// start, so the runtime column is enforced here.
//
// When bumping a pin, re-resolve the tag (git/refs/tags/<version>), confirm
// action.yml runs on node24, then update this table and the workflow comment
// in the same commit.
//
// Keyed by the short action name so the table is not a repeating row of
// `{ version, runtime }` objects (SonarCloud flags that shape as duplication).
const VERIFIED_ACTION_PINS = {
  checkout: [
    "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    "v5.1.0",
    "node24",
  ],
  "setup-node": [
    "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444",
    "v5",
    "node24",
  ],
  "upload-artifact": [
    "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
    "v6.0.0",
    "node24",
  ],
  "download-artifact": [
    "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
    "v7.0.0",
    "node24",
  ],
  "deploy-pages": [
    "actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346",
    "v5",
    "node24",
  ],
  "upload-pages-artifact": [
    "actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa",
    "v3",
    "composite",
  ],
  "pnpm-action-setup": [
    "pnpm/action-setup@a8198c4bff370c8506180b035930dea56dbd5288",
    "v5",
    "node24",
  ],
  "rust-cache": [
    "Swatinem/rust-cache@49a0bdc70d2e1b713ca9e2869b211fcce03d3c1c",
    "v2",
    "node24",
  ],
  "setup-bun": [
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    "v2",
    "node24",
  ],
  "rust-toolchain": [
    "dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c",
    "stable",
    "composite",
  ],
  "action-gh-release": [
    "softprops/action-gh-release@e598afbe1493e6b1bafb1f389cabb956eab91231",
    "v3.0.3",
    "node24",
  ],
};

const VERIFIED_PINS = new Map(
  Object.values(VERIFIED_ACTION_PINS).map(([pin, version, runtime]) => [
    pin,
    { version, runtime },
  ]),
);

const PIN_RE =
  /uses:\s*([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+@[0-9a-f]{40})\s*(?:#\s*([^\s]+))?/;

function leadingSpaces(line) {
  return /^ */.exec(line)[0].length;
}

function collectWorkflowFacts() {
  const pins = [];
  const setupNodeSteps = [];

  for (const file of readdirSync(WORKFLOW_DIR).filter((f) =>
    f.endsWith(".yml"),
  )) {
    const lines = readFileSync(join(WORKFLOW_DIR, file), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = PIN_RE.exec(lines[i]);
      if (!match) {
        if (/^\s*uses:\s*/.test(lines[i])) {
          pins.push({
            file,
            line: i + 1,
            pin: null,
            comment: null,
            unparsed: lines[i].trim(),
          });
        }
        continue;
      }

      pins.push({ file, line: i + 1, pin: match[1], comment: match[2] });
      if (!match[1].startsWith("actions/setup-node@")) continue;

      const usesIndent = leadingSpaces(lines[i]);
      const stepLines = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === "") {
          stepLines.push(lines[j]);
          continue;
        }
        const indent = leadingSpaces(lines[j]);
        // `with:` is a sibling of `uses:` at the same indent. A less-indented
        // line is the next step or job and ends this block.
        if (indent < usesIndent) break;
        stepLines.push(lines[j]);
      }

      setupNodeSteps.push({
        file,
        line: i + 1,
        hasCachePnpm: stepLines.some((l) => /^\s*cache:\s*pnpm\s*$/.test(l)),
        hasPackageManagerCacheFalse: stepLines.some((l) =>
          /^\s*package-manager-cache:\s*false\s*$/.test(l),
        ),
      });
    }
  }

  return { pins, setupNodeSteps };
}

describe("GitHub Actions pin guard", () => {
  const { pins, setupNodeSteps } = collectWorkflowFacts();

  it("pins every action to a commit SHA", () => {
    const floating = pins.filter((p) => !p.pin);
    assert.deepEqual(
      floating.map((p) => `${p.file}:${p.line} ${p.unparsed}`),
      [],
      "every uses: line must be a 40-hex SHA (floating @vX tags drift)",
    );
  });

  it("only allows verified node24 or composite pins", () => {
    const unknown = pins
      .filter((p) => p.pin && !VERIFIED_PINS.has(p.pin))
      .map((p) => `${p.file}:${p.line} ${p.pin}`);
    assert.deepEqual(
      unknown,
      [],
      "unknown pin. Resolve the tag through the GitHub API, confirm " +
        "action.yml declares node24 (or composite), then add it to " +
        "VERIFIED_ACTION_PINS with its version comment.",
    );

    const node20 = pins
      .filter((p) => p.pin && VERIFIED_PINS.get(p.pin)?.runtime === "node20")
      .map((p) => `${p.file}:${p.line} ${p.pin}`);
    assert.deepEqual(
      node20,
      [],
      "pins declaring node20 will fail once GitHub removes Node 20 (2026-09-16)",
    );
  });

  it("labels every pin with the version comment that matches the map", () => {
    const mismatches = pins
      .filter((p) => {
        if (!p.pin) return false;
        const expected = VERIFIED_PINS.get(p.pin)?.version;
        return p.comment !== expected;
      })
      .map((p) => `${p.file}:${p.line} ${p.pin} comment=${p.comment}`);
    assert.deepEqual(
      mismatches,
      [],
      "the # comment must match the version verified in VERIFIED_ACTION_PINS",
    );
  });

  it("opts each setup-node step into pnpm cache or out of package-manager-cache", () => {
    // setup-node v5 defaults package-manager-cache: true, which runs the
    // detected package manager to prime the cache and fails when that binary
    // is not installed. Jobs that never install pnpm (Secret Scan, Rust unit)
    // must set package-manager-cache: false. Jobs that do install pnpm must
    // set cache: pnpm. Setting both is contradictory.
    assert.ok(
      setupNodeSteps.length > 0,
      "expected at least one actions/setup-node step in workflows",
    );

    const bad = setupNodeSteps.filter(
      (s) => s.hasCachePnpm === s.hasPackageManagerCacheFalse,
    );
    assert.deepEqual(
      bad.map(
        (s) =>
          `${s.file}:${s.line} cache:pnpm=${s.hasCachePnpm} package-manager-cache:false=${s.hasPackageManagerCacheFalse}`,
      ),
      [],
      "every setup-node step must set exactly one of cache: pnpm or package-manager-cache: false",
    );
  });
});
