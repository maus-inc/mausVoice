import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { runTauriDev, tauriDevArguments } from "./run-tauri-dev.mjs";

describe("run-tauri-dev", () => {
  it("passes a developer-selected config as one literal argument without a shell", () => {
    const injection = "src-tauri/dev.json; touch should-not-run";
    let invocation;

    runTauriDev({
      config: injection,
      spawn(command, args, options) {
        invocation = { command, args, options };
        return { status: 0 };
      },
    });

    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, tauriDevArguments(injection));
    assert.equal(invocation.args.at(-1), injection);
    assert.equal(invocation.options.shell, false);
  });

  it("keeps the package command on the non-shell runner", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );

    assert.equal(
      packageJson.scripts["dev:tauri"],
      "node scripts/run-tauri-dev.mjs",
    );
  });

  it("runs Node-native script tests outside Vitest and includes them in unit verification", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );

    assert.match(
      packageJson.scripts["test:unit"],
      /--exclude scripts\/run-tauri-dev\.test\.mjs/,
    );
    assert.match(
      packageJson.scripts["test:unit"],
      /node --test scripts\/run-tauri-dev\.test\.mjs scripts\/run-tauri-with-sidecars\.test\.mjs/,
    );
  });
});
