import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fallow = resolve(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "fallow.cmd" : "fallow",
);

test("audit rejects new findings but not inherited findings", (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "mausvoice-fallow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  const audit = (base) => {
    const result = spawnSync(
      fallow,
      [
        "audit",
        "--base",
        base,
        "--gate",
        "new-only",
        "--format",
        "json",
        "--quiet",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        ...(process.platform === "win32" ? { shell: true } : {}),
      },
    );
    assert.ifError(result.error);
    return { status: result.status, report: JSON.parse(result.stdout) };
  };

  git("init", "-q");
  git("config", "user.name", "Fallow test");
  git("config", "user.email", "fallow-test@example.invalid");
  writeFileSync(
    resolve(dir, "package.json"),
    JSON.stringify({ name: "fixture", private: true, main: "index.js" }),
  );
  writeFileSync(
    resolve(dir, "index.js"),
    "export function run(x) { return x }\n",
  );
  writeFileSync(resolve(dir, "old.js"), "export const old = 1\n");
  git("add", ".");
  git("commit", "-qm", "base");

  writeFileSync(resolve(dir, "old.js"), "export const old = 2\n");
  const inherited = audit("HEAD");
  assert.equal(inherited.status, 0);
  assert.equal(inherited.report.attribution.dead_code_introduced, 0);
  assert.ok(inherited.report.attribution.dead_code_inherited > 0);

  writeFileSync(resolve(dir, "new.js"), "export const unused = 1\n");
  const introduced = audit("HEAD");
  assert.equal(introduced.status, 1);
  assert.equal(introduced.report.verdict, "fail");
  assert.ok(introduced.report.attribution.dead_code_introduced > 0);

  const invalid = audit("no-such-base-ref");
  assert.equal(invalid.status, 2);
  assert.equal(invalid.report.error, true);
});

test("manual entry points cover computed aliases and operational tools", () => {
  const result = spawnSync(
    fallow,
    ["list", "--entry-points", "--format", "json", "--quiet"],
    {
      cwd: root,
      encoding: "utf8",
      ...(process.platform === "win32" ? { shell: true } : {}),
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const entries = new Set(
    JSON.parse(result.stdout).entry_points.map((entry) => entry.path),
  );
  const vite = readFileSync(
    resolve(root, "apps/desktop/vite.config.ts"),
    "utf8",
  );
  const aliases = [...vite.matchAll(/previewAlias\("([A-Za-z]+)"\)/g)].map(
    (match) => match[1],
  );
  assert.ok(aliases.length > 0, "expected preview aliases in Vite config");
  for (const name of aliases) {
    assert.ok(
      entries.has(`apps/desktop/src/preview/tauri/${name}.ts`),
      `missing preview entry ${name}`,
    );
  }
  for (const path of [
    "scripts/ci/check-gitleaks-config.test.mjs",
    "apps/desktop/webdriver/specs/app.render.spec.ts",
    "apps/docs/scripts/make-card-ascii.mjs",
    "docs/assets/badges/source/generate-badges.mjs",
  ]) {
    assert.ok(entries.has(path), `missing entry ${path}`);
  }
  const wdio = readFileSync(
    resolve(root, "apps/desktop/webdriver/wdio.conf.js"),
    "utf8",
  );
  assert.match(wdio, /specs:\s*\["\.\/specs\/\*\*\/\*\.spec\.ts"\]/);
});

test("architecture detects a cyclic fixture", (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "mausvoice-fallow-cycle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    resolve(dir, "package.json"),
    JSON.stringify({ name: "cycle-fixture", private: true, main: "index.js" }),
  );
  writeFileSync(resolve(dir, "index.js"), 'import "./a.js";\n');
  writeFileSync(resolve(dir, "a.js"), 'import "./b.js";\n');
  writeFileSync(resolve(dir, "b.js"), 'import "./a.js";\n');
  const result = spawnSync(
    fallow,
    ["architecture", "--format", "json", "--quiet"],
    {
      cwd: dir,
      encoding: "utf8",
      ...(process.platform === "win32" ? { shell: true } : {}),
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  const cycles = JSON.parse(result.stdout).circular_dependencies;
  assert.ok(
    cycles.some(
      ({ files }) => files.includes("a.js") && files.includes("b.js"),
    ),
  );
});

const cycleSignature = ({ files }) =>
  files
    .map((_, index) => [...files.slice(index), ...files.slice(0, index)])
    .map((cycle) => cycle.join(" -> "))
    .sort()[0];

const architectureCycles = (cwd) => {
  const result = spawnSync(
    fallow,
    ["architecture", "--format", "json", "--quiet"],
    {
      cwd,
      encoding: "utf8",
      ...(process.platform === "win32" ? { shell: true } : {}),
    },
  );
  assert.ifError(result.error);
  return (JSON.parse(result.stdout).circular_dependencies ?? []).map(
    cycleSignature,
  );
};

const resolveBaseSha = () => {
  if (process.env.BASE_SHA) return process.env.BASE_SHA;

  const baseBranch =
    process.env.GITHUB_BASE_REF || process.env.DEFAULT_BRANCH || "main";
  const baseRef = `refs/remotes/origin/${baseBranch}`;
  const readBaseSha = () =>
    spawnSync("git", ["rev-parse", "--verify", baseRef], {
      cwd: root,
      encoding: "utf8",
    });
  let result = readBaseSha();
  if (result.status !== 0) {
    const shallow = execFileSync(
      "git",
      ["rev-parse", "--is-shallow-repository"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    if (shallow === "true") {
      execFileSync("git", ["fetch", "--unshallow", "--no-tags", "origin"], {
        cwd: root,
        stdio: "pipe",
      });
    }
    execFileSync(
      "git",
      ["fetch", "--no-tags", "origin", `refs/heads/${baseBranch}:${baseRef}`],
      { cwd: root, stdio: "pipe" },
    );
    result = readBaseSha();
  }
  assert.equal(
    result.status,
    0,
    `could not resolve target branch ${baseRef}; set BASE_SHA explicitly`,
  );
  return result.stdout.trim();
};

test("the module graph gains no new circular dependencies", (t) => {
  // Compare against the target branch tip, not a hard-coded cycle snapshot.
  // Long-lived PRs can predate fixes already present on their target branch.
  const baseSha = resolveBaseSha();
  const dir = mkdtempSync(resolve(tmpdir(), "mausvoice-fallow-base-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archive = execFileSync("git", ["archive", baseSha], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-", "-C", dir], { input: archive });
  const changedFiles = new Set([
    ...execFileSync("git", ["diff", "--name-only", baseSha], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean),
    ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean),
  ]);
  const architectureConfigChanged = changedFiles.has(".fallowrc.json");
  const inherited = new Set(architectureCycles(dir));
  const observed = architectureCycles(root);
  // Keep each side's own Fallow config. If this branch changes graph
  // configuration, compare every cycle; otherwise only cycles touching changed
  // modules can be introduced by source edits.
  const newCycles = observed.filter(
    (cycle) =>
      (architectureConfigChanged ||
        cycle.split(" -> ").some((file) => changedFiles.has(file))) &&
      !inherited.has(cycle),
  );
  assert.deepEqual(
    newCycles,
    [],
    `new circular dependencies must be broken before merging:\n${newCycles.join("\n")}`,
  );
});

test("audit keeps an unchanged CSS finding inherited after lines move", (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "mausvoice-fallow-css-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Fallow test");
  git("config", "user.email", "fallow-test@example.invalid");
  writeFileSync(
    resolve(dir, "package.json"),
    JSON.stringify({ name: "fixture", private: true, main: "index.js" }),
  );
  writeFileSync(resolve(dir, "index.js"), 'import "./style.css";\n');
  const rule =
    ".notice { opacity: 1 !important; visibility: visible !important; }\n";
  writeFileSync(resolve(dir, "style.css"), rule);
  git("add", ".");
  git("commit", "-qm", "base");
  writeFileSync(resolve(dir, "style.css"), `\n\n${rule}`);
  const audit = () =>
    spawnSync(
      fallow,
      [
        "audit",
        "--base",
        "HEAD",
        "--gate",
        "new-only",
        "--format",
        "json",
        "--quiet",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        ...(process.platform === "win32" ? { shell: true } : {}),
      },
    );
  const result = audit();
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.attribution.styling_introduced, 0);
  assert.equal(report.attribution.styling_inherited, 1);
  assert.equal(report.complexity.styling_findings[0].introduced, false);

  // A genuinely new rule with the same value still remains distinguishable.
  writeFileSync(
    resolve(dir, "style.css"),
    `\n\n${rule}${rule.replace(".notice", ".second")}`,
  );
  const added = audit();
  assert.ifError(added.error);
  assert.equal(added.status, 0); // Styling findings are advisory by default.
  const addedReport = JSON.parse(added.stdout);
  assert.equal(addedReport.attribution.styling_introduced, 1);
  assert.equal(addedReport.attribution.styling_inherited, 1);
  assert.deepEqual(
    addedReport.complexity.styling_findings.map(
      (finding) => finding.introduced,
    ),
    [false, true],
  );
});

test("future-resolution security guards remain in pnpm overrides", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  const overrides = manifest.pnpm.overrides;
  assert.equal(overrides["@hono/node-server@<1.19.13"], ">=1.19.13");
  assert.equal(overrides["@protobufjs/utf8@<=1.1.0"], ">=1.1.1");
  assert.equal(overrides["qs@>=6.11.1 <=6.15.1"], ">=6.15.2");
  assert.equal(overrides["hono@<4.12.25"], ">=4.12.25");
});

test("architecture policies allow the preview dependency and gate prohibited crossings and eval calls", (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "mausvoice-fallow-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  const invoke = (...args) => {
    const result = spawnSync(fallow, [...args, "--format", "json", "--quiet"], {
      cwd: dir,
      encoding: "utf8",
      ...(process.platform === "win32" ? { shell: true } : {}),
    });
    assert.ifError(result.error);
    return { status: result.status, report: JSON.parse(result.stdout) };
  };
  for (const name of [
    "apps/desktop/src",
    "apps/preview/src",
    "packages/utilities/src",
  ]) {
    mkdirSync(resolve(dir, name), { recursive: true });
  }
  const config = JSON.parse(
    readFileSync(resolve(root, ".fallowrc.json"), "utf8"),
  );
  config.entry = [
    "apps/desktop/src/main.js",
    "apps/preview/src/main.js",
    "apps/preview/src/tool.js",
    "packages/utilities/src/index.js",
  ];
  writeFileSync(
    resolve(dir, "package.json"),
    JSON.stringify({ name: "fixture", private: true, type: "module" }),
  );
  writeFileSync(
    resolve(dir, "apps/desktop/src/main.js"),
    "export const desktop = 1;\n",
  );
  writeFileSync(
    resolve(dir, "apps/preview/src/main.js"),
    'import { desktop } from "../../desktop/src/main.js"; export const preview = desktop;\n',
  );
  writeFileSync(
    resolve(dir, "apps/preview/src/tool.js"),
    "export const tool = 1;\n",
  );
  writeFileSync(
    resolve(dir, "packages/utilities/src/index.js"),
    "export const shared = 1;\n",
  );
  git("init", "-q");
  git("config", "user.name", "Fallow test");
  git("config", "user.email", "fallow-test@example.invalid");
  git("add", ".");
  git("commit", "-qm", "base");
  writeFileSync(resolve(dir, ".fallowrc.json"), JSON.stringify(config));

  const clean = invoke("architecture");
  assert.equal(clean.status, 0);
  assert.deepEqual(clean.report.boundary_violations, []);
  assert.deepEqual(clean.report.boundary_call_violations, []);

  writeFileSync(
    resolve(dir, "packages/utilities/src/index.js"),
    [
      'import { desktop } from "../../../apps/desktop/src/main.js";',
      'export const shared = eval("1");',
      'export const generated = Function("return 1");',
      "",
    ].join("\n"),
  );
  const changed = invoke("audit", "--base", "HEAD", "--gate", "new-only");
  assert.equal(changed.status, 1);
  assert.equal(changed.report.verdict, "fail");
  assert.equal(changed.report.dead_code.boundary_violations.length, 1);
  assert.equal(changed.report.dead_code.boundary_call_violations.length, 2);

  writeFileSync(
    resolve(dir, "apps/desktop/src/main.js"),
    'import { tool } from "../../preview/src/tool.js"; export const desktop = tool;\n',
  );
  const reverse = invoke("audit", "--base", "HEAD", "--gate", "new-only");
  assert.equal(reverse.status, 1);
  assert.deepEqual(
    reverse.report.dead_code.boundary_violations
      .map((finding) => `${finding.from_zone}->${finding.to_zone}`)
      .sort(),
    ["desktop->preview", "shared->desktop"],
  );
});
