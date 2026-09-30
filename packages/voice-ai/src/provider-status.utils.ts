// Re-exported rather than re-declared: this module is a second public path to the
// reader that already lives in provider-error.utils, and `export ... from` keeps
// it one binding instead of an import paired with a separate export.
export { readProviderStatus } from "./provider-error.utils";

/**
 * Auth and billing failures belong to the API key, so neither a retry nor
 * another model on the same key can succeed. This is narrower than
 * `isProviderTerminalStatus`, which also treats a bad request and a missing
 * model as terminal, because those two are specific to one model rather than
 * to the key.
 */
export const isKeyRejectedStatus = (status: number | undefined): boolean =>
  status === 401 || status === 402 || status === 403;
