/** Describe the child-process failure without discarding either its code or message. */
export function describeSpawnFailure(result) {
  const error = result?.error;
  const signal = result?.signal;
  const reason =
    error?.code ||
    error?.message ||
    (signal ? `signal:${signal}` : undefined) ||
    (result?.status ?? "unknown");
  const errorSuffix =
    error?.message && reason !== error.message ? ` — ${error.message}` : null;
  const signalSuffix = signal ? ` — killed by signal ${signal}` : "";
  return `${reason}${errorSuffix ?? signalSuffix}`;
}
