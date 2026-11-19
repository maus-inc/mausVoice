import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

let dir;
let artifact;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webdriver-build-"));
  artifact = join(dir, "desktop-app");
  // onPrepare locates its npm project relative to the config, not cwd.
  mkdirSync(join(dir, "webdriver"));
  copyFileSync(
    new URL("../webdriver/wdio.conf.js", import.meta.url),
    join(dir, "webdriver/wdio.conf.js"),
  );
  symlinkSync(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    join(dir, "node_modules"),
    "junction",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { build: "node build.cjs", tauri: "node build.cjs" },
    }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function prepare(buildScript) {
  writeFileSync(join(dir, "build.cjs"), buildScript);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { config } from './webdriver/wdio.conf.js';
    try { await config.onPrepare(); } catch (e) { console.error(e.message); process.exitCode = e.status ?? 1; }`,
    ],
    {
      cwd: dir,
      env: { ...process.env, TAURI_APPLICATION_PATH: artifact },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  expect(result.error).toBeUndefined();
  return result;
}

it("refuses an existing artifact when this build fails", () => {
  writeFileSync(artifact, "old");
  const result = prepare("process.exit(17)");
  expect(result.status, result.stderr).toBe(17);
});

// macOS prepares a Chrome preview rather than a native binary.
it.skipIf(process.platform === "darwin")(
  "accepts the binary created by a successful build",
  () => {
    const result = prepare(
      'require("node:fs").writeFileSync(process.env.TAURI_APPLICATION_PATH, "new")',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(artifact, "utf8")).toBe("new");
  },
);
