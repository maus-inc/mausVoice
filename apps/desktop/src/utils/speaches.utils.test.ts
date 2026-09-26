import { HttpError, retry } from "@maus-inc/utilities";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  speachesTestIntegration,
  speachesTranscribeAudio,
} from "./speaches.utils";

// HTTPS endpoints go through plugin-http, so an https base keeps every test on
// the mocked transport instead of the private-network IPC bridge.
const BASE_URL = "https://speaches.example.com";

const transcribe = () =>
  speachesTranscribeAudio({
    baseUrl: BASE_URL,
    model: "Systran/faster-whisper-large-v3",
    blob: new ArrayBuffer(8),
    ext: "wav",
  });

// A Response body is a single-use stream, and the retry policy sends the same
// request more than once, so every attempt needs its own Response.
const respondWith = (body: string, status: number, headers?: HeadersInit) =>
  fetchMock.mockImplementation(
    async () => new Response(body, { status, headers }),
  );

const settled = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("speaches utils report the HTTP status as data", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("attempts a terminal status exactly once and keeps the existing message", async () => {
    respondWith("quota exhausted", 402);

    const error = await settled(retry({ fn: transcribe }));

    // A rejected quota cannot clear on a second identical upload, so the
    // attempt count is the behaviour that matters and is checked first.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(402);
    expect((error as HttpError).retryAfterMs).toBeNull();
    // The settings snackbar and any existing assertion read the message, so it
    // has to stay byte-identical to the plain Error it replaced.
    expect((error as Error).message).toBe(
      "Speaches transcription failed: 402 - quota exhausted",
    );
  });

  it("waits out a rate-limit hint and retries instead of failing at once", async () => {
    vi.useFakeTimers();
    respondWith("slow down", 429, { "retry-after": "1" });

    const attempt = settled(retry({ fn: transcribe }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The hint sets the pace, so the second attempt must not run on the
    // helper's own 20ms floor.
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    const error = await attempt;

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(429);
    expect((error as HttpError).retryAfterMs).toBe(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clamps a long rate-limit hint to the interactive cap", async () => {
    vi.useFakeTimers();
    respondWith("slow down", 503, { "retry-after": "60" });

    const attempt = settled(retry({ fn: transcribe }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // DEFAULT_MAX_RETRY_DELAY_MS is 2s, so a person waiting on a dictation gets
    // the 2s ceiling rather than the full minute the header asked for.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4_000);
    const error = await attempt;

    expect((error as HttpError).status).toBe(503);
    // The hint is parsed in full; only the wait is capped.
    expect((error as HttpError).retryAfterMs).toBe(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps a 2xx body with no text a plain error", async () => {
    respondWith(JSON.stringify({}), 200);

    const error = await settled(transcribe());

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpError);
    expect((error as Error).message).toBe(
      "Transcription failed: no text in response",
    );
  });
});

describe("speachesTestIntegration", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    invokeMock.mockReset();
  });

  it("reports a health-check failure with its status", async () => {
    respondWith("unavailable", 503, { "retry-after": "5" });

    const error = await settled(speachesTestIntegration({ baseUrl: BASE_URL }));

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect((error as HttpError).retryAfterMs).toBe(5_000);
    expect((error as Error).message).toBe(
      "Speaches returned an error (status 503). Check your configuration.",
    );
  });

  it("keeps an unreachable server a plain error so it stays retryable", async () => {
    invokeMock.mockRejectedValue("connection refused");

    const error = await settled(speachesTestIntegration({}));

    // No HTTP response ever arrived, so there is no status. A statusless
    // failure is still worth another attempt, which is exactly what a plain
    // error tells the shared retry policy.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpError);
    expect((error as Error).message).toContain(
      "Unable to connect to Speaches at http://localhost:8000",
    );
  });

  it("resolves true when the health check passes", async () => {
    respondWith("ok", 200);

    await expect(speachesTestIntegration({ baseUrl: BASE_URL })).resolves.toBe(
      true,
    );
  });
});
