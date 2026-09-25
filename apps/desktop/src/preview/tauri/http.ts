import { PreviewOperationError } from "../runtime";

/** Provider traffic is intentionally not proxied from the mock-data preview. */
export const fetch = async (
  _input: RequestInfo | URL,
  _init?: RequestInit,
): Promise<Response> => {
  throw new PreviewOperationError("network provider request");
};
