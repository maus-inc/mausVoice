import { HttpError } from "@maus-inc/utilities";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aldeaTranscribeAudio } from "./aldea.utils";
import { deepgramTranscribeAudio } from "./deepgram.utils";
import { elevenlabsTranscribeAudio } from "./elevenlabs.utils";
import { openaiCompatibleTranscribeAudio } from "./openai-compatible-transcribe.utils";
import { speachesTranscribeAudio } from "./speaches.utils";
import { runSdkTranscription } from "./transcription.utils";
import { xaiTranscribeAudio } from "./xai.utils";

/**
 * Every provider that used to carry its HTTP status only inside an error
 * message. The shared `retry` policy reads `error.status`, so a status left as
 * prose can never be classified: a dead credential looks identical to a flaky
 * network and gets resent to the retry limit.
 */
const audio = new ArrayBuffer(8);

/** A fresh Response per call, so a retry never reuses a consumed body. */
const respond = (status: number, headers?: Record<string, string>) =>
  vi.fn(async () => new Response("denied", { status, headers }));

const expectHttpError = async (
  run: () => Promise<unknown>,
  status: number,
): Promise<HttpError> => {
  const error = await run().then(
    () => {
      throw new Error("expected the request to reject");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(status);
  return error as HttpError;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetch providers report the status as data", () => {
  it("deepgram", async () => {
    const customFetch = respond(402);
    const error = await expectHttpError(
      () =>
        deepgramTranscribeAudio({
          apiKey: "key",
          blob: audio,
          ext: "wav",
          customFetch,
        }),
      402,
    );
    expect(error.message).toContain(
      "Deepgram transcription request failed with status 402",
    );
  });

  it("elevenlabs", async () => {
    const customFetch = respond(402);
    const error = await expectHttpError(
      () =>
        elevenlabsTranscribeAudio({
          apiKey: "key",
          blob: audio,
          ext: "wav",
          customFetch,
        }),
      402,
    );
    expect(error.message).toContain(
      "ElevenLabs API request failed with status 402",
    );
  });

  it("aldea", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(respond(402));
    const error = await expectHttpError(
      () => aldeaTranscribeAudio({ apiKey: "key", blob: audio }),
      402,
    );
    expect(error.message).toContain("Aldea API request failed with status 402");
  });

  it("speaches", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(respond(402));
    const error = await expectHttpError(
      () =>
        speachesTranscribeAudio({
          baseUrl: "http://localhost:8000",
          model: "whisper-1",
          blob: audio,
          ext: "wav",
        }),
      402,
    );
    expect(error.message).toContain("Speaches transcription failed: 402");
  });

  it("xai", async () => {
    const customFetch = respond(402);
    const error = await expectHttpError(
      () =>
        xaiTranscribeAudio({
          apiKey: "key",
          blob: audio,
          ext: "wav",
          customFetch,
        }),
      402,
    );
    expect(error.message).toContain("xAI STT request failed with status 402");
  });
});

describe("sdk transcription providers normalise the sdk error", () => {
  it("runSdkTranscription", async () => {
    // The OpenAI-compatible SDKs reject with an APIError that carries `status`.
    const sdkError = Object.assign(new Error("402 status code (no body)"), {
      status: 402,
    });

    await expectHttpError(
      () =>
        runSdkTranscription(() => Promise.reject(sdkError), {
          file: audio,
          model: "whisper-1",
          response_format: "json",
        }),
      402,
    );
  });

  it("openaiCompatibleTranscribeAudio", async () => {
    const sdkError = Object.assign(new Error("401 Unauthorized"), {
      status: 401,
    });

    await expectHttpError(
      () =>
        openaiCompatibleTranscribeAudio({
          client: {
            audio: {
              transcriptions: { create: () => Promise.reject(sdkError) },
            },
          },
          blob: audio,
          model: "whisper-1",
          ext: "wav",
        }),
      401,
    );
  });
});

describe("terminal statuses are attempted once", () => {
  it("does not resend an aldea request against an exhausted credential", async () => {
    const customFetch = respond(402);
    vi.spyOn(globalThis, "fetch").mockImplementation(customFetch);

    await expect(
      aldeaTranscribeAudio({ apiKey: "key", blob: audio }),
    ).rejects.toThrow("Aldea API request failed with status 402");
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("does not resend a deepgram request against an exhausted credential", async () => {
    const customFetch = respond(402);

    await expect(
      deepgramTranscribeAudio({
        apiKey: "key",
        blob: audio,
        ext: "wav",
        customFetch,
      }),
    ).rejects.toThrow("Deepgram transcription request failed with status 402");
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("still resends a deepgram request that failed with a server error", async () => {
    const customFetch = respond(503);

    await expect(
      deepgramTranscribeAudio({
        apiKey: "key",
        blob: audio,
        ext: "wav",
        customFetch,
      }),
    ).rejects.toThrow("Deepgram transcription request failed with status 503");
    expect(customFetch).toHaveBeenCalledTimes(3);
  });
});

describe("Retry-After", () => {
  it("reaches the shared retry policy from the response headers", async () => {
    // A 400 is terminal, so this asserts the parsed hint without waiting.
    // The waiting itself is covered by the retry helper's own tests.
    const error = await expectHttpError(
      () =>
        deepgramTranscribeAudio({
          apiKey: "key",
          blob: audio,
          ext: "wav",
          customFetch: respond(400, { "retry-after": "1" }),
        }),
      400,
    );
    expect(error.retryAfterMs).toBe(1_000);
  });
});
