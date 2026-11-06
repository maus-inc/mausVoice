import { spawnSync } from "node:child_process";
import { describeSpawnFailure } from "./spawn-failure.mjs";

/** Run a build without a shell and preserve spawn errors and terminating signals. */
export function runSidecarCommand(
  command,
  args,
  cwd,
  options = {},
  dependencies = {},
) {
  const spawn = dependencies.spawn ?? spawnSync;
  const warn = dependencies.warn ?? console.warn;
  const fail =
    dependencies.fail ??
    ((message) => {
      throw new Error(message);
    });
  let result;
  try {
    result = spawn(command, args, { cwd, stdio: "inherit" });
  } catch (error) {
    result = { status: null, error };
  }
  if (result.status === 0 && !result.error) return true;
  const message = `Command failed (${describeSpawnFailure(result)}): ${[command, ...args].join(" ")}`;
  if (options.allowFailure === true) {
    warn(`[sidecar] ${message}`);
    return false;
  }
  fail(message);
  return false;
}
