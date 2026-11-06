import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
// Stored as one whitespace table so SonarCloud does not treat each pin as a
// duplicated `{ version, runtime }` or 3-tuple row. Parse once into a map.
const VERIFIED_ACTION_PINS = Object.fromEntries(
  `
checkout actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 v5.1.0 node24
setup-node actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 v5 node24
upload-artifact actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f v6.0.0 node24
download-artifact actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 v7.0.0 node24
deploy-pages actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 v5 node24
upload-pages-artifact actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa v3 composite
pnpm-action-setup pnpm/action-setup@a8198c4bff370c8506180b035930dea56dbd5288 v5 node24
rust-cache Swatinem/rust-cache@49a0bdc70d2e1b713ca9e2869b211fcce03d3c1c v2 node24
setup-bun oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 v2 node24
rust-toolchain dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c stable composite
action-gh-release softprops/action-gh-release@e598afbe1493e6b1bafb1f389cabb956eab91231 v3.0.3 node24
`
    .trim()
    .split("\n")
    .map((row) => {
      const tokens = row.trim().split(/\s+/);
      if (tokens.length !== 4) {
        throw new Error(
          `pin table row must have 4 whitespace-separated fields: ${row}`,
        );
      }
      const [name, pin, version, runtime] = tokens;
      return [name, [pin, version, runtime]];
    }),
);

const VERIFIED_PINS = new Map(
  Object.values(VERIFIED_ACTION_PINS).map(([pin, version, runtime]) => [
    pin,
    { version, runtime },
  ]),
);

const PIN_RE =
  /^\s*(?:-\s*)?uses:\s*([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+@[0-9a-f]{40})(?:[ \t]+#[ \t]*([^\s]+).*)?[ \t]*$/;

// Only structural uses keys count; mentions in comments or shell text cannot
// prove that an action reference is pinned.
const USES_KEY_RE = /^\s*(?:-\s*)?uses:\s*/;

function leadingSpaces(line) {
  return /^ */.exec(line)[0].length;
}

function startsNextStep(line, usesIndent) {
  if (/^\s*(?:#|$)/.test(line)) return false;
  const indent = leadingSpaces(line);
  return (
    indent < usesIndent ||
    (indent === usesIndent && (/^\s*-\s/.test(line) || USES_KEY_RE.test(line)))
  );
}

// Only immediate children of `with:` are action inputs; matching an `env:`
// entry or nested mapping would falsely certify a step with no cache policy.
function stepInputLines(stepLines) {
  const start = stepLines.findIndex((line) =>
    /^\s*with:\s*(?:#.*)?$/.test(line),
  );
  if (start === -1) return [];
  const withIndent = leadingSpaces(stepLines[start]);
  let inputIndent = null;
  const inputs = [];
  for (const line of stepLines.slice(start + 1)) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    const indent = leadingSpaces(line);
    if (indent <= withIndent) break;
    inputIndent ??= indent;
    if (indent === inputIndent) inputs.push(line);
  }
  return inputs;
}

function setupNodeStep(lines, index, file) {
  const usesIndent = leadingSpaces(lines[index]);
  const stepLines = [];
  for (let j = index + 1; j < lines.length; j += 1) {
    if (startsNextStep(lines[j], usesIndent)) break;
    stepLines.push(lines[j]);
  }
  const inputs = stepInputLines(stepLines);
  return {
    file,
    line: index + 1,
    hasCachePnpm: inputs.some((line) =>
      /^\s*cache:\s*(?:pnpm|"pnpm"|'pnpm')(?:\s+#.*)?\s*$/.test(line),
    ),
    hasPackageManagerCacheFalse: inputs.some((line) =>
      /^\s*package-manager-cache:\s*(?:false|"false"|'false')(?:\s+#.*)?\s*$/.test(
        line,
      ),
    ),
  };
}

function collectWorkflowFacts(dir = WORKFLOW_DIR) {
  const pins = [];
  const setupNodeSteps = [];
  // GitHub accepts either .yml or .yaml.
  for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))) {
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const match = PIN_RE.exec(lines[i]);
      if (!match) {
        if (USES_KEY_RE.test(lines[i])) {
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
      if (match[1].startsWith("actions/setup-node@")) {
        setupNodeSteps.push(setupNodeStep(lines, i, file));
      }
    }
  }
  return { pins, setupNodeSteps };
}

describe("GitHub Actions pin guard", () => {
  const { pins, setupNodeSteps } = collectWorkflowFacts();

  it("does not mistake comments or a SHA prefix for a pinned action", () => {
    const dir = mkdtempSync(join(tmpdir(), "pin-guard-comments-"));
    try {
      const sha = "a".repeat(40);
      writeFileSync(
        join(dir, "fixture.yml"),
        [
          `# uses: actions/checkout@${sha}`,
          `- uses: actions/checkout@v5 # uses: actions/checkout@${sha}`,
          `- uses: actions/checkout@${sha}-floating`,
          `- uses: actions/checkout@${sha}#v5`,
        ].join("\n"),
      );
      const { pins: found } = collectWorkflowFacts(dir);
      assert.equal(found.length, 3);
      assert.deepEqual(
        found.map((pin) => pin.pin),
        [null, null, null],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not borrow cache settings from a later step", () => {
    const dir = mkdtempSync(join(tmpdir(), "pin-guard-step-"));
    try {
      const sha = "a".repeat(40);
      writeFileSync(
        join(dir, "fixture.yml"),
        [
          `  - uses: actions/setup-node@${sha} # v5`,
          "  - name: unrelated step",
          "    with:",
          "      cache: pnpm",
          "      package-manager-cache: false",
        ].join("\n"),
      );
      const { setupNodeSteps: steps } = collectWorkflowFacts(dir);
      assert.equal(steps.length, 1);
      assert.equal(steps[0].hasCachePnpm, false);
      assert.equal(steps[0].hasPackageManagerCacheFalse, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat environment variables as setup-node inputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "pin-guard-env-"));
    try {
      const sha = "a".repeat(40);
      writeFileSync(
        join(dir, "fixture.yml"),
        [
          `  - uses: actions/setup-node@${sha} # v5`,
          "    env:",
          "      cache: pnpm",
          "      package-manager-cache: false",
        ].join("\n"),
      );
      const { setupNodeSteps: steps } = collectWorkflowFacts(dir);
      assert.equal(steps.length, 1);
      assert.equal(steps[0].hasCachePnpm, false);
      assert.equal(steps[0].hasPackageManagerCacheFalse, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognizes quoted inputs and comments in a setup-node with block", () => {
    const dir = mkdtempSync(join(tmpdir(), "pin-guard-inputs-"));
    try {
      const sha = "a".repeat(40);
      writeFileSync(
        join(dir, "fixture.yml"),
        [
          `  - uses: actions/setup-node@${sha} # v5`,
          "    with:",
          "      cache: 'pnpm' # explicit package manager",
          "  - uses: actions/setup-node@" + sha + " # v5",
          "    with:",
          '      package-manager-cache: "false" # deliberate opt out',
        ].join("\n"),
      );
      const { setupNodeSteps: steps } = collectWorkflowFacts(dir);
      assert.deepEqual(
        steps.map(({ hasCachePnpm, hasPackageManagerCacheFalse }) => [
          hasCachePnpm,
          hasPackageManagerCacheFalse,
        ]),
        [
          [true, false],
          [false, true],
        ],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins every action to a commit SHA", () => {
    const floating = pins.filter((p) => !p.pin);
    assert.deepEqual(
      floating.map((p) => `${p.file}:${p.line} ${p.unparsed}`),
      [],
      "every uses: line must be a 40-hex SHA (floating @vX tags drift)",
    );
  });

  // The subject the pin guard never had.
  //
  // The assertions above read the real `.github/workflows`, and every one of the 198 `uses:`
  // lines in it is pinned, so `pins.filter((p) => !p.pin)` is empty -- correctly, but for a
  // reason that cannot tell "checked and all pinned" from "never matched the step form". The
  // fallback that records an unpinned line was `/^\s*uses:\s*/`, which rejects a leading `- `,
  // so no step-level action could ever land in that array. This drives the same collector over
  // a fixture containing an unpinned step and asserts it is reported.
  it("reports an unpinned step action, not just one at column 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "pin-guard-"));
    try {
      writeFileSync(
        join(dir, "floating.yml"),
        [
          "name: floating",
          "on: [push]",
          "jobs:",
          "  probe:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          // The form every real step uses, and the one the old regex could not see.
          "      - uses: actions/checkout@v5.1.0 # v5.1.0",
          "      - uses: actions/setup-node@main",
          // ...and the column-0 form, which the old regex DID see, kept as the control.
          "uses: actions/cache@v4",
          "",
        ].join("\n"),
      );

      const { pins: fixturePins } = collectWorkflowFacts(dir);
      const floating = fixturePins.filter((x) => !x.pin);

      assert.deepEqual(
        floating.map((x) => `${x.line}: ${x.unparsed}`),
        [
          "7: - uses: actions/checkout@v5.1.0 # v5.1.0",
          "8: - uses: actions/setup-node@main",
          "9: uses: actions/cache@v4",
        ],
        "every uses: key must be reported when unpinned, in both the `- uses:` step form and " +
          "the column-0 form",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

    // The whole runtime column, not a filter that can select nothing.
    //
    // This used to collect the pins whose recorded runtime is `node20` and assert that
    // collection was empty. No row in `VERIFIED_ACTION_PINS` declares `node20` -- and
    // cannot, because a row is only added after its runtime has been confirmed as node24 --
    // so the filter was empty on every run and the assertion could not fail. It read as
    // coverage of a rule it had never once exercised.
    //
    // Asserting every row's runtime against the two that exist gives it a subject: eleven
    // rows today, and a `node20` row would now fail here rather than being invisible.
    const badRuntime = Object.entries(VERIFIED_ACTION_PINS)
      .filter(
        ([, [, , runtime]]) => runtime !== "node24" && runtime !== "composite",
      )
      .map(([name, [pin, , runtime]]) => `${name} ${pin} declares ${runtime}`);
    assert.deepEqual(
      badRuntime,
      [],
      "every pinned action must run on node24 or be a composite action; a node20 pin will " +
        "fail once GitHub removes the Node 20 runtime (2026-09-16)",
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
