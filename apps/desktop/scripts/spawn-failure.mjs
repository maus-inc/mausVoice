/** Describe the child-process failure without discarding either its code or message. */
export function describeSpawnFailure(result) {
  const error = result?.error;
  const signal = result?.signal;
  const reason =
    error?.code ||
    error?.message ||
    (signal ? `signal:${signal}` : undefined) ||
    (result?.status ?? "unknown");
  const suffix =
    error?.message && reason !== error.message
      ? ` — ${error.message}`
      : signal
        ? ` — killed by signal ${signal}`
        : "";
  return `${reason}${suffix}`;
}
