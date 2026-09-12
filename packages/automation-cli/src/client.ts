import type { AutomationConnection } from "./connection.js";

export class AutomationApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "AutomationApiError";
    this.status = status;
  }
}

export const apiGet = async (
  connection: AutomationConnection,
  path: string,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(`${connection.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
  } catch {
    throw new AutomationApiError(
      `Cannot reach the automation API at ${connection.baseUrl}: is the mausVoice desktop app running?`,
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body: status code carries the signal.
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as Record<string, unknown>)["error"])
        : `HTTP ${response.status}`;
    throw new AutomationApiError(
      `Automation API error: ${detail}`,
      response.status,
    );
  }
  return body;
};
