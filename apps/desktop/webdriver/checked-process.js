import { spawnSync } from "node:child_process";

/** Fail before using a stale binary when a Webdriver build does not succeed. */
export function runCheckedProcess(command, args, options, spawn = spawnSync) {
  const result = spawn(command, args, options);
  if (result.error) {
    throw new Error(`Could not start Webdriver build: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.signal
      ? `signal ${result.signal}`
      : `status ${result.status ?? "unknown"}`;
    throw new Error(`Webdriver build failed (${detail})`);
  }
  return result;
}
