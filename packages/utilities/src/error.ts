const MAX_ERROR_MESSAGE_LENGTH = 512;

const redactSensitiveTokens = (message: string): string =>
  message
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+={0,2}/gi, "Bearer [redacted]")
    .replace(
      /\b(?:csk_|gsk_|sk-ant-|xai-|sk-)[A-Za-z0-9_\-]{8,}/gi,
      "[redacted]",
    )
    .replace(
      /("?)(api[_-]?key|apiKey|authorization|access_token|refresh_token)("?\s*[:=]\s*"?)([^"\s,;}]+)("?)/gi,
      "$1$2$3[redacted]$5",
    );

const capLength = (message: string): string =>
  message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;

/**
 * Coerce any thrown value to a readable message without producing
 * `[object Object]` for plain objects. Obvious tokens are redacted and
 * the result is capped so logs and tool-failure text cannot dump secrets
 * or huge payloads.
 */
export const unknownToMessage = (error: unknown): string => {
  let message: string;
  if (typeof error === "string") {
    message = error;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    try {
      message = JSON.stringify(error) ?? String(error);
    } catch {
      message = String(error);
    }
  }
  return capLength(redactSensitiveTokens(message));
};
