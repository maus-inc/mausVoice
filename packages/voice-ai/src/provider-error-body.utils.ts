import { redactSensitiveTokens } from "@maus-inc/utilities";

// Provider error bodies are untrusted. Discard an oversized body rather than
// keeping a truncated credential or allocating an unbounded diagnostic.
const MAX_ERROR_BODY_BYTES = 16 * 1024;
// Even empty chunks cost work and can starve a timer through microtasks.
const MAX_ERROR_BODY_CHUNKS = 4096;
const MAX_ERROR_BODY_WAIT_MS = 2_000;

const cancelWithoutWaiting = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void => {
  // The async wrapper turns a transport that throws instead of returning a
  // promise into the same rejection this swallows, so cancellation stays best
  // effort and an HTTP failure still settles.
  void (async () => reader.cancel())().catch(() => {});
};

/** Consume at most the bounded diagnostic bytes. */
const consumeErrorBody = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string | null> => {
  const decoder = new TextDecoder();
  let bytes = 0;
  let chunks = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      chunks += 1;
      if (bytes > MAX_ERROR_BODY_BYTES || chunks > MAX_ERROR_BODY_CHUNKS) {
        cancelWithoutWaiting(reader);
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return null;
  }
};

/** Read a bounded diagnostic without letting a stalled body hold the error open. */
const readErrorBody = async (response: Response): Promise<string | null> => {
  if (response.bodyUsed) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
      cancelWithoutWaiting(reader);
    }, MAX_ERROR_BODY_WAIT_MS);
  });
  try {
    return await Promise.race([consumeErrorBody(reader), deadline]);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
};

/** Include representations a JSON or URL-encoding proxy may echo. */
const secretRepresentations = (secret: string): string[] => {
  // The bounded output cannot contain this string in full. Avoid allocating
  // multiple potentially enormous encoded copies of a caller-provided value.
  if (!secret || secret.length > MAX_ERROR_BODY_BYTES) return [];
  const representations = [secret, JSON.stringify(secret).slice(1, -1)];
  try {
    representations.push(encodeURIComponent(secret));
  } catch {
    // URI encoding rejects lone surrogates. The original and JSON forms
    // remain available, and a malformed secret must not hide the HTTP error.
  }
  return [...new Set(representations)].sort((a, b) => b.length - a.length);
};

/** Sanitize a bounded provider/transport diagnostic before it leaves the call. */
export function sanitizeProviderError(
  message: string,
  secrets: readonly string[] = [],
): string | null {
  if (message.length > MAX_ERROR_BODY_BYTES) return null;
  let text = message;
  const representations = secrets.flatMap(secretRepresentations);
  representations.sort((a, b) => b.length - a.length);
  for (const secret of representations) {
    text = text.split(secret).join("[redacted]");
  }
  return redactSensitiveTokens(text);
}

/** Read a bounded but still untrusted body. Callers must sanitize or discard it. */
export async function readBoundedProviderErrorBody(
  response: Response,
): Promise<string | null> {
  try {
    return await readErrorBody(response);
  } catch {
    // getReader() can throw if another consumer already locked the stream.
    return null;
  }
}

/** Preserve useful error detail without echoing known request credentials. */
export async function readSafeProviderError(
  response: Response,
  secrets: readonly string[] = [],
): Promise<string | null> {
  const text = await readBoundedProviderErrorBody(response);
  return text === null ? null : sanitizeProviderError(text, secrets);
}
