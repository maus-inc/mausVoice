import { PreviewOperationError } from "../runtime";

/**
 * Provider traffic is intentionally not proxied from the mock-data preview.
 * The real plugin returns a rejected promise, so this rejects explicitly
 * rather than throwing synchronously out of the call.
 */
export const fetch = (
  _input: RequestInfo | URL,
  _init?: RequestInit,
): Promise<Response> =>
  Promise.reject(new PreviewOperationError("network provider request"));
