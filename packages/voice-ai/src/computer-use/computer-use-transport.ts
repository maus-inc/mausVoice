import { HttpError, retry } from "@maus-inc/utilities";
import type {
  ComputerUseActionResult,
  ComputerUseAdvanceInput,
  ComputerUseScreenshot,
  ComputerUseSession,
  ComputerUseTurn,
  ComputerUseTurnInput,
} from "@maus-inc/types";
import type { CustomFetch } from "../types";

/**
 * One provider turn, over a connection that can fail.
 *
 * Both adapters need the same three things from their transport and none of
 * them are provider-specific: a non-2xx has to arrive as an error carrying its
 * status so the shared retry policy can tell a rejected request from a slow
 * one, the caller's abort has to reach the request, and an aborted call must
 * not be reissued. Only the URL, the headers and the body shape differ, so
 * those three stay here and the adapters keep only their wire format.
 */
export type ComputerUseTransport = (args: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  /** Shown in the error when the provider's own body is not readable. */
  label: string;
}) => Promise<unknown>;

/**
 * A request whose provider gave a status the caller has to see.
 *
 * The shared `retry` helper treats the client statuses as terminal on its own,
 * so without the status on the error a 400 would be reissued three times and
 * the user would pay for three identical rejections.
 */
class ComputerUseHttpError extends HttpError {
  constructor(status: number, detail: string, label: string, retryAfter?: string | null) {
    super(
      status,
      detail
        ? `${label} responded ${status}: ${detail}`
        : `${label} responded with status ${status}`,
      { retryAfter },
    );
    this.name = "ComputerUseHttpError";
  }
}

/**
 * A 2xx whose body was not JSON.
 *
 * The shared retry helper reads a terminal failure from an HTTP status, and a
 * 200 is not one of them, so this error names itself and the retry predicate
 * below refuses it explicitly. The body length is carried because a proxy's
 * error page is what the user needs to be told about, and an empty body is the
 * other shape this arrives in.
 */
class ComputerUseBodyError extends Error {
  constructor(status: number, bodyLength: number, label: string) {
    super(
      `${label} answered with status ${status} but the body was not JSON` +
        (bodyLength === 0
          ? ". The response was empty, so a proxy or gateway most likely cut it."
          : `. The body was ${bodyLength} characters, which a proxy or gateway most likely rewrote.`),
    );
    this.name = "ComputerUseBodyError";
  }
}

/**
 * The caller's own abort reason, so the caller still sees it.
 *
 * A runtime that leaves `signal.reason` undefined gets a plain error rather
 * than `undefined`, which would reject with nothing and leave a caller unable
 * to tell an abort from a defect.
 */
const readAbortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new Error("The computer-use turn was aborted.");

const isAbort = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
};

/**
 * Issue one computer-use turn, with the package's single retry layer.
 *
 * The abort check is on the predicate as well as on the request, because a
 * caller that stops the agent mid-turn is not a transient failure and reissuing
 * a cancelled request would restart the very action the user just cancelled.
 */
export const requestComputerUseTurn = async (args: {
  transport: ComputerUseTransport;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  label: string;
  signal?: AbortSignal;
}): Promise<unknown> => {
  // Checked before the first attempt, not only on the retry predicate. A
  // signal that is already aborted when the turn begins still reached the
  // transport once, and on a provider that bills per request that is a charge
  // for an action the user cancelled before it started.
  if (args.signal?.aborted) {
    throw readAbortReason(args.signal);
  }

  return retry({
    retries: 3,
    signal: args.signal,
    // A body that would not parse is not reissued. The provider answered, so
    // the same request again buys the same unreadable answer, three times over,
    // and the abort check keeps a cancelled turn from restarting itself.
    isRetryable: (error) => !isAbort(error, args.signal) && !(error instanceof ComputerUseBodyError),
    fn: () =>
      args.transport({
        url: args.url,
        headers: args.headers,
        body: args.body,
        signal: args.signal,
        label: args.label,
      }),
  });
};

export const buildComputerUseTransport =
  (customFetch: CustomFetch): ComputerUseTransport =>
  async ({ url, headers, body, signal, label }) => {
    const response = await customFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new ComputerUseHttpError(
        response.status,
        await response.text().catch(() => ""),
        label,
        response.headers.get("retry-after"),
      );
    }

    // A 2xx body that will not parse is terminal, not retryable. The provider
    // already answered, so reissuing the same request bills for the same
    // answer up to three times, and the raw SyntaxError names a JavaScript
    // engine rather than anything the user or the model can act on.
    const text = await response.text().catch(() => "");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ComputerUseBodyError(response.status, text.length, label);
    }
  };

/** How many turns one computer-use run may take before it is cut off. */
export const COMPUTER_USE_MAX_TURNS = 30;

/**
 * Whether a turn carried nothing to do.
 *
 * Both providers signal the end of a task by returning prose instead of calls,
 * so an empty action list is the loop's signal to report and stop. A turn that
 * produced neither calls nor prose is not a completed task, it is a provider
 * that answered with something unrecognised, and treating it as done would end
 * the run with no explanation.
 */
export const isTerminalTurn = (turn: ComputerUseTurn): boolean =>
  turn.actions.length === 0 && turn.text.trim().length > 0;

/** Raise when a provider answered with neither calls nor prose. */
export const assertTurnHasContent = (turn: ComputerUseTurn): void => {
  if (turn.actions.length === 0 && turn.text.trim().length === 0) {
    throw new Error(
      "The computer-use model returned neither an action nor a message.",
    );
  }
};

/**
 * Refuse a capture the provider will not accept.
 *
 * Both providers require PNG for a computer-use screenshot and reject the
 * request outright otherwise, so the check happens once here rather than as a
 * per-provider branch. It runs on the opening capture too, not only on results,
 * because a conversation that starts as JPEG and continues as PNG would be
 * rejected on its second turn with an error that says nothing about the format.
 *
 * The failure names the format instead of quoting a provider error, because the
 * caller that can fix it is the capture layer, not the adapter.
 */
export const assertScreenshotIsPng = (
  screenshot: ComputerUseScreenshot,
): void => {
  if (screenshot.mimeType !== "image/png") {
    throw new Error(
      `Computer-use screenshots must be captured as PNG, got ${screenshot.mimeType}.`,
    );
  }
};

/** Text every result carries, so the model can tell which action it answers. */
export const describeResult = (result: ComputerUseActionResult): string =>
  result.skipped ? `Skipped: ${result.message}` : result.message;