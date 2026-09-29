import { readProviderStatus } from "./provider-error.utils";

export { readProviderStatus };

/**
 * Auth and billing failures belong to the API key, so neither a retry nor
 * another model on the same key can succeed. This is narrower than
 * `isProviderTerminalStatus`, which also treats a bad request and a missing
 * model as terminal, because those two are specific to one model rather than
 * to the key.
 */
export const isKeyRejectedStatus = (status: number | undefined): boolean =>
  status === 401 || status === 402 || status === 403;
