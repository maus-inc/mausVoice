export const POST_PROCESS_EDIT_FAILURE_RETRANSCRIBE_AFTER = 2;
export const POST_PROCESS_EDIT_RETRANSCRIBE_BASE_DELAY_MS = 1_000;
export const POST_PROCESS_EDIT_RETRANSCRIBE_MAX_DELAY_MS = 8_000;

const finiteNonNegativeInteger = (value: number | null | undefined): number => {
  if (!Number.isFinite(value) || value === undefined || value === null) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
};

export const nextPostProcessEditFailureCount = (
  previousCount: number | null | undefined,
): number => finiteNonNegativeInteger(previousCount) + 1;

/**
 * A row gets one automatic audio retranscription on the first failure after
 * the two-failure threshold. Later failures stay bounded until the user starts
 * a new chain by editing or successfully retranscribing the row.
 */
export const shouldAutomaticallyRetranscribePostProcessEditFailure = (
  failureCount: number | null | undefined,
): boolean =>
  finiteNonNegativeInteger(failureCount) ===
  POST_PROCESS_EDIT_FAILURE_RETRANSCRIBE_AFTER + 1;

/**
 * Full jitter keeps repeated local retries from lining up while the exponential
 * cap prevents a single History row from waiting without bound. The optional
 * random value makes the policy deterministic in unit tests.
 */
export const getPostProcessEditRetranscribeDelayMs = (
  failureCount: number,
  random = Math.random(),
): number => {
  const attempt = Math.max(
    0,
    finiteNonNegativeInteger(failureCount) -
      POST_PROCESS_EDIT_FAILURE_RETRANSCRIBE_AFTER -
      1,
  );
  const cap = Math.min(
    POST_PROCESS_EDIT_RETRANSCRIBE_MAX_DELAY_MS,
    POST_PROCESS_EDIT_RETRANSCRIBE_BASE_DELAY_MS * 2 ** attempt,
  );
  const jitter = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0;
  return Math.floor(cap * jitter);
};
