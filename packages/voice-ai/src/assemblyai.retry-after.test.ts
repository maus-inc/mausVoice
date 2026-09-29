import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RETRY_AFTER_MS } from "@maus-inc/utilities";
import { assemblyaiTranscribeAudio } from "./assemblyai.utils";

/**
 * The shared `Retry-After` parser decides what this provider waits for, so the
 * two cases where it answers "no usable hint" and "capped hint" are pinned here
 * rather than only in the parser's own tests.
 */
const jsonResponse = (
  body: unknown,
  headers?: Record<string, string>,
): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

/** A 429 for the first `rateLimited` attempts, then the usual happy path. */
const rateLimitedFetch = (headers: Record<string, string>, rateLimited = 1) => {
  let seen = 0;
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/upload")) {
      seen += 1;
      if (seen <= rateLimited) {
        return new Response("rate limited", { status: 429, headers });
      }
      return jsonResponse({ upload_url: "https://cdn.assemblyai.com/u/abc" });
    }
    if (path.endsWith("/transcript") && init?.method === "POST") {
      return jsonResponse({ id: "transcript-1" });
    }
    return jsonResponse({ status: "completed", text: "hello world" });
  });
};

const transcribe = (customFetch: ReturnType<typeof vi.fn>) =>
  assemblyaiTranscribeAudio({
    apiKey: "key",
    blob: new Uint8Array([1, 2]).buffer,
    language: "en",
    pollIntervalMs: 1,
    customFetch,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("AssemblyAI Retry-After handling", () => {
  it("falls back to its own backoff when the date has already passed", async () => {
    vi.useFakeTimers();
    // 2015 is in the past for any clock, so the hint carries no instruction.
    // Returning 0 for it would have been a busy retry against a live rate
    // limit instead of the 100ms backoff the first attempt earns.
    const customFetch = rateLimitedFetch({
      "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT",
    });
    const pending = transcribe(customFetch);

    await vi.advanceTimersByTimeAsync(99);
    expect(customFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ text: "hello world" });
    // The rate-limited upload, the retried upload, the transcript request, and
    // one poll.
    expect(customFetch).toHaveBeenCalledTimes(4);
  });

  it("waits the shared cap rather than the full hour a hostile hint asks for", async () => {
    vi.useFakeTimers();
    const customFetch = rateLimitedFetch({ "retry-after": "3600" });
    const pending = transcribe(customFetch);

    await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS - 1);
    expect(customFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ text: "hello world" });
    expect(customFetch).toHaveBeenCalledTimes(4);
  });
});
