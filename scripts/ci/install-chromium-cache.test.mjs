import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";

const installer = fileURLToPath(
  new URL("../verify/install-chromium.mjs", import.meta.url),
);
const marker = ".mausvoice-chromium";
const version = "153.0.0";

const fixture = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mausvoice-chromium-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = join(dir, "sparticuz-chromium");
  const pkg = join(cache, "node_modules", "@sparticuz", "chromium");
  const tools = join(dir, "tools");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(tools);
  writeFileSync(join(cache, marker), `${version}\n`);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version }));
  writeFileSync(
    join(pkg, "bin", "chromium.br"),
    brotliCompressSync("#!/bin/sh\necho fixture-chromium\n"),
  );
  const tool = (name, body) =>
    writeFileSync(join(tools, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  tool("npm", "echo fixture-npm-called >&2; exit 23");
  return {
    dir,
    cache,
    pkg,
    tool,
    run: (out) =>
      execFileSync(process.execPath, [installer, "--dir", out], {
        env: {
          ...process.env,
          TMPDIR: dir,
          PATH: `${tools}${delimiter}${process.env.PATH}`,
          FIXTURE_OUT: out,
        },
        stdio: "pipe",
        timeout: 5_000,
      }),
  };
};

const browserVersion = (out) =>
  execFileSync(join(out, "chromium"), { encoding: "utf8" }).trim();

test("the installer accepts a new nested output directory", (t) => {
  const { dir, run } = fixture(t);
  const out = join(dir, "new-parent", "chr");
  run(out);
  assert.equal(browserVersion(out), "fixture-chromium");
});

test("the installer repairs a marked output with an empty browser", (t) => {
  const { dir, run } = fixture(t);
  const out = join(dir, "chr");
  mkdirSync(out);
  writeFileSync(join(out, marker), `${version}\n`);
  writeFileSync(join(out, "chromium"), "");
  run(out);
  assert.equal(browserVersion(out), "fixture-chromium");
});

test("a stale installed version triggers installation despite the declaration", (t) => {
  const { dir, cache, pkg, run } = fixture(t);
  writeFileSync(
    join(cache, "package.json"),
    JSON.stringify({ dependencies: { "@sparticuz/chromium": version } }),
  );
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ version: "141.0.0" }),
  );
  assert.throws(() => run(join(dir, "chr")), /fixture-npm-called/);
});

test("the sweep removes only marked partials whose process has exited", (t) => {
  const { dir, run } = fixture(t);
  const exitedPid = execFileSync("sh", ["-c", "echo $$"], {
    encoding: "utf8",
  }).trim();
  const procStat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const start = procStat.slice(procStat.lastIndexOf(")") + 2).split(" ")[19];
  const abandoned = join(dir, `chr.partial-${exitedPid}-1-oldRun`);
  const live = join(dir, `chr.partial-${process.pid}-${start}-liveXX`);
  const recycled = join(
    dir,
    `chr.partial-${process.pid}-${BigInt(start) + 1n}-reuseX`,
  );
  const foreign = join(dir, "chr.partial-999999999-1-frgnXX");
  for (const path of [abandoned, live, recycled, foreign]) mkdirSync(path);
  for (const path of [abandoned, live, recycled])
    writeFileSync(join(path, marker), `${version}\n`);
  writeFileSync(join(foreign, "keep.txt"), "keep me");

  run(join(dir, "chr"));

  assert.equal(existsSync(abandoned), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(recycled), false);
  assert.equal(existsSync(join(foreign, "keep.txt")), true);
});

test("legacy staging without host provenance is left for manual cleanup", (t) => {
  const { dir, run } = fixture(t);
  const legacy = join(dir, "chr.partial-999999999");
  mkdirSync(legacy);
  writeFileSync(join(legacy, marker), `${version}\n`);

  run(join(dir, "chr"));

  assert.equal(existsSync(join(legacy, marker)), true);
});

const stagePublication = ({ pkg, tool }, files) => {
  writeFileSync(
    join(pkg, "bin", "fonts.tar.br"),
    brotliCompressSync("fixture-archive"),
  );
  tool(
    "tar",
    `mkdir "$FIXTURE_OUT" && touch "$FIXTURE_OUT/${marker}"\n${files}`,
  );
};

test("a concurrent winner is launched and the loser removes its staging tree", (t) => {
  const setup = fixture(t);
  const out = join(setup.dir, "chr");
  stagePublication(
    setup,
    `printf '#!/bin/sh\\necho winner-chromium\\n' > "$FIXTURE_OUT/chromium"\nchmod +x "$FIXTURE_OUT/chromium"`,
  );

  setup.run(out);

  assert.equal(browserVersion(out), "winner-chromium");
  assert.equal(
    readdirSync(setup.dir).some((entry) => entry.startsWith("chr.partial-")),
    false,
  );
});

test("a marked but empty browser is not accepted as a concurrent winner", (t) => {
  const setup = fixture(t);
  stagePublication(setup, 'touch "$FIXTURE_OUT/chromium"');
  assert.throws(() => setup.run(join(setup.dir, "chr")), /ENOTEMPTY|EEXIST/);
});
