import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const helperUrl = new URL("./child-process-lifecycle.mjs", import.meta.url)
  .href;
const runOutcome = (event) =>
  spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { EventEmitter } from 'node:events';
       import { forwardChildOutcome } from ${JSON.stringify(helperUrl)};
       const child = new EventEmitter();
       forwardChildOutcome(child, 'spawn failed:');
       ${event}`,
    ],
    { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8" },
  );

describe("child process outcome forwarding", () => {
  it("preserves the child exit status", () => {
    expect(runOutcome("child.emit('exit', 23, null)").status).toBe(23);
    expect(runOutcome("child.emit('exit', null, null)").status).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "forwards termination signals to the parent",
    () => {
      const result = runOutcome("child.emit('exit', null, 'SIGTERM')");
      expect(result.signal).toBe("SIGTERM");
    },
  );

  it("logs a spawn error and fails", () => {
    const result = runOutcome("child.emit('error', new Error('no binary'))");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/spawn failed:.*no binary/);
  });
});
