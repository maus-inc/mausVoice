import { raceAbort } from "./async";

/** Discard an unwanted response without waiting for an uncooperative stream. */
export const discardResponseBody = (response: Response): void => {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // A locked or broken body must not prevent the caller from settling.
  }
};

// Preserve custom response methods; only wrap unlocked native bodies.
const abortableNativeResponse = (
  response: Response,
  signal: AbortSignal | null | undefined,
  method: "json" | "arrayBuffer",
): Response => {
  if (
    !signal ||
    typeof TransformStream === "undefined" ||
    typeof Response === "undefined"
  )
    return response;
  if (response[method] !== Response.prototype[method]) return response;
  const body = response.body;
  if (!body || response.bodyUsed || body.locked) return response;
  return new Response(body.pipeThrough(new TransformStream(), { signal }));
};

const readAbortableResponse = async <T>(
  response: Response,
  signal: AbortSignal | null | undefined,
  method: "json" | "arrayBuffer",
): Promise<T> => {
  if (signal?.aborted) {
    discardResponseBody(response);
    signal.throwIfAborted();
  }
  try {
    // Body methods lock the stream, making body.cancel() ineffective. Pipe
    // through an abortable stream while retaining native decoding semantics.
    const source = abortableNativeResponse(response, signal, method);
    const reading = source[method]() as Promise<T>;
    const result = signal ? await raceAbort(reading, signal) : await reading;
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) discardResponseBody(response);
    throw error;
  }
};

/** Read JSON without waiting on an uncooperative body after cancellation. */
export const readAbortableResponseJson = <T>(
  response: Response,
  signal?: AbortSignal | null,
): Promise<T> => readAbortableResponse<T>(response, signal, "json");

/** Read bytes without waiting on an uncooperative body after cancellation. */
export const readAbortableResponseArrayBuffer = (
  response: Response,
  signal?: AbortSignal | null,
): Promise<ArrayBuffer> =>
  readAbortableResponse(response, signal, "arrayBuffer");
