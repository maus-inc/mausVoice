import { getEffectiveAuth } from "./auth.utils";

export const DEFAULT_NEW_SERVER_URL = "https://api.mausvoice.com";

const SUPPORTED_SERVER_PROTOCOLS = new Set(["http:", "https:"]);

const withoutTrailingSlash = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
};

const withoutLeadingSlash = (value: string): string => {
  let start = 0;
  while (start < value.length && value[start] === "/") {
    start += 1;
  }
  return value.slice(start);
};

/**
 * Resolves the build-time server URL to a safe HTTP(S) origin/path.
 *
 * The value is build configuration rather than user input, but malformed or
 * unsupported values should still fail closed to the production endpoint. A
 * normalized URL also prevents the WebSocket callers from producing `//v1`
 * paths when an environment file includes a trailing slash.
 */
export const resolveNewServerUrl = (
  configuredUrl: string | undefined,
): string => {
  const raw = configuredUrl?.trim();
  if (!raw) {
    return DEFAULT_NEW_SERVER_URL;
  }

  try {
    const parsed = new URL(raw);
    if (
      !SUPPORTED_SERVER_PROTOCOLS.has(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      return DEFAULT_NEW_SERVER_URL;
    }
    parsed.hash = "";
    parsed.search = "";
    return withoutTrailingSlash(parsed.toString());
  } catch {
    return DEFAULT_NEW_SERVER_URL;
  }
};

/** Builds the wss/ws endpoint used by the streaming transcription clients. */
export const buildNewServerWebSocketUrl = (
  baseUrl: string,
  endpoint: string,
): string => {
  const normalized = resolveNewServerUrl(baseUrl);
  const parsed = new URL(normalized);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  const endpointPath = withoutLeadingSlash(endpoint);
  parsed.pathname = `${withoutTrailingSlash(parsed.pathname)}/${endpointPath}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

export const NEW_SERVER_URL: string = resolveNewServerUrl(
  import.meta.env.VITE_NEW_SERVER_URL,
);

export async function getNewServerAuthHeaders(): Promise<
  Record<string, string>
> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const auth = getEffectiveAuth();
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Not authenticated");
  }
  const idToken = await user.getIdToken();
  if (idToken) {
    headers["Authorization"] = `Bearer ${idToken}`;
  }

  return headers;
}
