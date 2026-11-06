import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(here, "run-tauri-with-sidecars.mjs"),
  "utf8",
);

describe("run-tauri-with-sidecars", () => {
  it("uses the current Node executable for helper scripts rather than searching PATH", () => {
    assert.match(
      source,
      /run\(\s*process\.execPath,\s*\["scripts\/prepare-sidecars\.mjs"\]/,
    );
    assert.match(source, /run\(\s*process\.execPath,\s*\[sidebarGenerator,/);
    assert.doesNotMatch(source, /run\("node"/);
  });

  it("runs helper scripts using the same Node executable with no PATH lookup", (t) => {
    const root = mkdtempSync(join(tmpdir(), "maus-tauri-node-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const desktop = join(root, "apps", "desktop");
    const scriptDir = join(desktop, "scripts");
    const cliDir = join(desktop, "node_modules", "@tauri-apps", "cli");
    const rootScripts = join(root, "scripts");
    for (const dir of [scriptDir, cliDir, rootScripts])
      mkdirSync(dir, { recursive: true });
    copyFileSync(
      resolve(here, "run-tauri-with-sidecars.mjs"),
      join(scriptDir, "run-tauri-with-sidecars.mjs"),
    );
    const marker = join(root, "invocations");
    const fixture = (name) =>
      `require("node:fs").appendFileSync(process.env.MARKER, "${name}\\n");`;
    writeFileSync(
      join(scriptDir, "prepare-sidecars.mjs"),
      `import { createRequire } from "node:module"; const require = createRequire(import.meta.url); ${fixture("prepare")}`,
    );
    writeFileSync(
      join(rootScripts, "generate-windows-installer-sidebar.mjs"),
      `import { createRequire } from "node:module"; const require = createRequire(import.meta.url); ${fixture("sidebar")}`,
    );
    writeFileSync(join(cliDir, "tauri.js"), fixture("tauri"));
    execFileSync(
      process.execPath,
      [join(scriptDir, "run-tauri-with-sidecars.mjs"), "build"],
      {
        cwd: desktop,
        env: { ...process.env, PATH: "", CI: "true", MARKER: marker },
      },
    );
    assert.deepEqual(readFileSync(marker, "utf8").trim().split("\n"), [
      "prepare",
      "sidebar",
      "tauri",
    ]);

    writeFileSync(join(cliDir, "tauri.js"), "process.exit(7);");
    const privateArg = "config-private-fragment";
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            join(scriptDir, "run-tauri-with-sidecars.mjs"),
            "inspect",
            privateArg,
          ],
          {
            cwd: desktop,
            env: { ...process.env, PATH: "", CI: "true", MARKER: marker },
            stdio: "pipe",
          },
        ),
      (error) => {
        assert.match(String(error.stderr), /Command failed \(7\)/);
        assert.doesNotMatch(String(error.stderr), /config-private-fragment/);
        return true;
      },
    );
  });

  it("runs the Tauri CLI directly instead of interpreting its arguments in a shell", () => {
    // Tauri arguments originate at the package script/CLI boundary. A shell
    // would reinterpret metacharacters embedded in an otherwise ordinary
    // argument, so keep the resolved JavaScript entry point behind Node and
    // assert the wrapper keeps `spawnSync` out of shell mode.
    assert.match(source, /require\.resolve\("@tauri-apps\/cli\/tauri\.js"\)/);
    assert.match(
      source,
      /run\(process\.execPath, \[tauriCli, \.\.\.tauriArgs\]/,
    );
    assert.match(source, /shell:\s*false/);
    assert.doesNotMatch(source, /shell:\s*true/);
  });
});
