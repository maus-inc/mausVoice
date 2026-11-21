import { test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
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
  const pkg = join(dir, "fixture-package");
  const tools = join(dir, "tools");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(tools);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version }));
  writeFileSync(
    join(pkg, "bin", "chromium.br"),
    brotliCompressSync("#!/bin/sh\necho fixture-chromium\n"),
  );
  const tool = (name, body) =>
    writeFileSync(join(tools, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const install =
    'mkdir -p node_modules/@sparticuz && cp -R "$FIXTURE_PKG" node_modules/@sparticuz/chromium';
  tool("npm", install);
  const options = (out) => ({
    env: {
      ...process.env,
      TMPDIR: dir,
      PATH: `${tools}${delimiter}${process.env.PATH}`,
      FIXTURE_OUT: out,
      FIXTURE_PKG: pkg,
    },
    timeout: 5_000,
  });
  return {
    dir,
    pkg,
    tool,
    install,
    run: (out) =>
      execFileSync(process.execPath, [installer, "--dir", out], {
        ...options(out),
        stdio: "pipe",
      }),
    runAsync: (out) =>
      promisify(execFile)(
        process.execPath,
        [installer, "--dir", out],
        options(out),
      ),
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

test("a trailing slash does not put staging inside the output directory", (t) => {
  const { dir, run } = fixture(t);
  const parent = join(dir, "new-parent");
  const out = join(parent, "chr");

  run(`${out}/`);

  assert.equal(browserVersion(out), "fixture-chromium");
  assert.deepEqual(readdirSync(parent), ["chr"]);
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

test("an unexpected installed version is not published", (t) => {
  const { dir, pkg, run } = fixture(t);
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ version: "141.0.0" }),
  );
  const out = join(dir, "chr");
  assert.throws(() => run(out), /installed chromium package is 141.0.0/);
  assert.equal(existsSync(out), false);
});

test("an interrupted npm install leaves a clean retry", (t) => {
  const { dir, install, tool, run } = fixture(t);
  const out = join(dir, "chr");
  tool(
    "npm",
    "mkdir partial-install; echo fixture-install-failed >&2; exit 23",
  );
  assert.throws(() => run(out), /fixture-install-failed/);
  assert.equal(
    readdirSync(dir).some((entry) => entry.startsWith("chr.partial-")),
    false,
  );
  tool("npm", install);
  run(out);
  assert.equal(browserVersion(out), "fixture-chromium");
});

test("concurrent installers each retain their private package tree", async (t) => {
  const { dir, install, tool, runAsync } = fixture(t);
  const out = join(dir, "chr");
  // Both npm children must still see their own partial install after the peer starts.
  tool(
    "npm",
    `set -e
mkdir partial-install
pwd >> "$TMPDIR/installer-paths"
while [ "$(wc -l < "$TMPDIR/installer-paths")" -lt 2 ]; do sleep 0.02; done
test -d partial-install
${install}`,
  );
  await Promise.all([runAsync(out), runAsync(out)]);
  const paths = readFileSync(join(dir, "installer-paths"), "utf8")
    .trim()
    .split("\n");
  assert.equal(new Set(paths).size, 2);
  assert.equal(browserVersion(out), "fixture-chromium");
  assert.equal(readdirSync(out).includes("npm-package"), false);
});

function readLocalProcOwner() {
  if (process.platform !== "linux")
    throw new Error("fixture requires Linux /proc");
  const status = readFileSync("/proc/self/status", "utf8");
  const namespacePids = status.match(/^NSpid:[ \t]+(.+)$/m)?.[1].trim();
  if (namespacePids !== String(process.pid)) {
    throw new Error("/proc does not expose the local PID namespace");
  }
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const pidNamespace = readlinkSync("/proc/self/ns/pid");
  const timeNamespace = readlinkSync("/proc/self/ns/time");
  if (!boot) throw new Error("/proc did not supply a boot identifier");
  const stat = readFileSync("/proc/self/stat", "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  return { boot, pidNamespace, timeNamespace, start };
}

test("the sweep removes only marked partials whose process has exited", (t) => {
  let owner;
  try {
    owner = readLocalProcOwner();
  } catch (error) {
    return t.skip(
      `local staging ownership cannot be verified: ${error.message}`,
    );
  }
  const { boot, pidNamespace, timeNamespace, start } = owner;
  const { dir, run } = fixture(t);
  const exitedPid = execFileSync("sh", ["-c", "echo $$"], {
    encoding: "utf8",
  }).trim();
  const abandoned = join(dir, `chr.partial-${exitedPid}-1-oldRun`);
  const live = join(dir, `chr.partial-${process.pid}-${start}-liveXX`);
  const recycled = join(
    dir,
    `chr.partial-${process.pid}-${BigInt(start) + 1n}-reuseX`,
  );
  const foreign = join(dir, "chr.partial-999999999-1-frgnXX");
  for (const path of [abandoned, live, recycled, foreign]) mkdirSync(path);
  const scope = `${boot} ${pidNamespace} ${timeNamespace}`;
  for (const path of [abandoned, live, recycled])
    writeFileSync(join(path, marker), `${version}\n${scope}\n`);
  // Use an absent PID so a sweep without provenance would delete all of these.
  const otherOwners = [
    "",
    `${boot} pid:[1] ${timeNamespace}`,
    `${boot} ${pidNamespace} time:[1]`,
    `00000000-0000-0000-0000-000000000000 ${pidNamespace} ${timeNamespace}`,
  ].map((owner, index) => {
    const path = join(dir, `chr.partial-${exitedPid}-1-fixt0${index}`);
    mkdirSync(path);
    writeFileSync(join(path, marker), `${version}\n${owner}\n`);
    return path;
  });
  writeFileSync(join(foreign, "keep.txt"), "keep me");

  run(join(dir, "chr"));

  assert.equal(
    readFileSync(join(dir, "chr", marker), "utf8"),
    `${version}\n${scope}\n`,
  );
  assert.equal(existsSync(abandoned), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(recycled), false);
  assert.equal(existsSync(join(foreign, "keep.txt")), true);
  for (const path of otherOwners) assert.equal(existsSync(path), true, path);
});

test("staging without host provenance is left for manual cleanup", (t) => {
  const { dir, run } = fixture(t);
  const paths = ["chr.partial-999999999", "chr.partial-999999999-1-noScop"].map(
    (name) => join(dir, name),
  );
  for (const path of paths) {
    mkdirSync(path);
    writeFileSync(join(path, marker), `${version}\n`);
  }

  run(join(dir, "chr"));

  for (const path of paths) assert.equal(existsSync(join(path, marker)), true);
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
