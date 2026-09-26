/** The HTTP status an OpenAI-compatible SDK attaches to a non-2xx rejection. */
export const readProviderStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
};

/**
 * Auth and billing failures belong to the API key, so neither a retry nor
 * another model on the same key can succeed.
 */
export const isKeyRejectedStatus = (status: number | undefined): boolean =>
  status === 401 || status === 402 || status === 403;
