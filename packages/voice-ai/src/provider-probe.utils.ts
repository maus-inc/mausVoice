import { throwHttpError } from "@maus-inc/utilities";
import type { CustomFetch } from "./types";

export type ProviderProbeArgs = {
  /** Provider name as the user sees it, used in the error message. */
  label: string;
  url: string;
  init: RequestInit;
  customFetch?: CustomFetch;
};

/**
 * Probe a provider endpoint with the user's credential. A non-2xx answer throws
 * with the status as data, so the retry policy can tell a dead key from a flaky
 * network, and the body is read only when the endpoint sent one.
 */
export const probeProviderEndpoint = async ({
  label,
  url,
  init,
  customFetch = fetch,
}: ProviderProbeArgs): Promise<boolean> => {
  const response = await customFetch(url, init);
  if (!response.ok) {
    await throwHttpError(response, {
      fallback: "",
      message: (detail) =>
        detail
          ? `${label} responded ${response.status}: ${detail}`
          : `${label} responded with status ${response.status}`,
    });
  }
  return true;
};
