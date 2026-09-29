import { describe, expect, it } from "vitest";
import {
  HttpError,
  MAX_RETRY_AFTER_MS,
  parseRetryAfterMs,
  toHttpError,
} from "./http-error";

describe("parseRetryAfterMs", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfterMs("12")).toBe(12_000);
    // An explicit zero is a deliberate "retry now", not a missing hint.
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("reads an HTTP-date relative to now", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:30 GMT", now)).toBe(
      30_000,
    );
  });

  it("returns null for an already-elapsed HTTP-date", () => {
    // The date has passed, so it is no longer an instruction. Returning 0 here
    // made a caller that falls back to its own backoff on `null` (AssemblyAI)
    // retry immediately against a live rate limit instead.
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:27:00 GMT", now)).toBeNull();
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT", now)).toBeNull();
  });

  it("caps an oversized hint", () => {
    expect(parseRetryAfterMs("120")).toBe(MAX_RETRY_AFTER_MS);
  });

  it("returns null for a missing or malformed hint", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs("   ")).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
    expect(parseRetryAfterMs("-5")).toBeNull();
  });
});

describe("toHttpError", () => {
  it("carries the Retry-After hint a provider SDK error exposes", () => {
    // The OpenAI-compatible SDKs (openai, groq, deepseek, cerebras) raise
    // APIError, whose `headers` is the response header record from
    // `parseHeaders`, so the hint arrives lowercased.
    const sdkError = Object.assign(new Error("429 Too Many Requests"), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "2" },
    });

    const error = toHttpError(sdkError);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(429);
    expect((error as HttpError).retryAfterMs).toBe(2_000);
  });

  it("reads the hint from a fetch-shaped error and any header casing", () => {
    const fetchError = Object.assign(new Error("Request failed"), {
      status: 429,
      response: { headers: new Headers({ "Retry-After": "1" }) },
    });
    const upperCaseRecord = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers: { "RETRY-AFTER": "3" },
    });

    expect((toHttpError(fetchError) as HttpError).retryAfterMs).toBe(1_000);
    expect((toHttpError(upperCaseRecord) as HttpError).retryAfterMs).toBe(
      3_000,
    );
  });

  it("keeps a usable hint when the error already is an HttpError", () => {
    const error = toHttpError(
      new HttpError(429, "Too Many Requests", { retryAfter: "5" }),
    );

    expect((error as HttpError).retryAfterMs).toBe(5_000);
  });

  it("leaves an error without a status untouched", () => {
    const abort = Object.assign(new Error("aborted"), {
      headers: { "retry-after": "1" },
    });

    expect(toHttpError(abort)).toBe(abort);
    expect(toHttpError("boom")).toBe("boom");
  });
});
