import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { describeSpawnFailure } from "./spawn-failure.mjs";

function atomicWait(ms) {
  const memory = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(memory, 0, 0, ms);
}

function tryChildSleep(ms, spawn, warn) {
  try {
    const result = spawn(
      process.execPath,
      ["-e", "setTimeout(()=>{}, Number(process.argv[1]))", String(ms)],
      { stdio: "ignore" },
    );
    if (result?.status === 0 && !result.error) return true;
    warn(
      `[sidecar] sleepSync spawnSync failed: ${describeSpawnFailure(result)}`,
    );
  } catch {
    // Retry the child or fall back to the monotonic busy-wait.
  }
  return false;
}

/** Synchronous build-retry delay, with bounded fallbacks if atomics are unavailable. */
export function sleepSync(
  ms,
  {
    wait = atomicWait,
    spawn = spawnSync,
    now = () => performance.now(),
    warn = console.warn,
  } = {},
) {
  if (
    typeof ms !== "number" ||
    !Number.isFinite(ms) ||
    ms < 0 ||
    ms > 2_147_483_647
  ) {
    throw new RangeError("Invalid sidecar retry delay");
  }
  try {
    wait(ms);
    return;
  } catch {
    // Some runtimes do not permit Atomics.wait on the main thread.
  }
  if (tryChildSleep(ms, spawn, warn) || tryChildSleep(ms, spawn, warn)) return;
  const start = now();
  while (now() - start < ms) {
    // Last resort when neither atomic nor child-process sleeping is available.
  }
}
