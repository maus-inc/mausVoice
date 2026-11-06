import { HttpError } from "@maus-inc/utilities";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readSpeachesTranscription,
  requestSpeaches,
  speachesTestIntegration,
  speachesTranscribeAudio,
} from "./speaches.utils";

afterEach(() => vi.unstubAllGlobals());

describe("readSpeachesTranscription", () => {
  it("returns the provider's transcript without rewriting it", async () => {
    const response = new Response(JSON.stringify({ text: " hello " }), {
      status: 200,
    });
    await expect(readSpeachesTranscription(response)).resolves.toBe(" hello ");
  });

  it("preserves error status and retry hint without exposing response detail", async () => {
    const response = new Response("slow down", {
      status: 429,
      headers: { "retry-after": "1" },
    });
    try {
      await readSpeachesTranscription(response);
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({
        status: 429,
        retryAfterMs: 1000,
        message: "Speaches transcription failed: 429",
      });
    }
  });

  it("does not expose a partial transcript or prompt echoed in an error body", async () => {
    const privateFragment = "my private phrase";
    const response = new Response(`Unable to process ${privateFragment}`, {
      status: 400,
    });
    const error = await readSpeachesTranscription(response).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(String(error)).not.toContain(privateFragment);
  });

  it("prioritizes caller cancellation over an HTTP failure", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before response processing");
    controller.abort(reason);
    const response = new Response("private", { status: 401 });
    const cancel = vi
      .spyOn(response.body!, "cancel")
      .mockReturnValue(new Promise(() => {}));
    await expect(
      readSpeachesTranscription(response, controller.signal),
    ).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("stops and cancels a real stalled transcript body on abort", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const pending = readSpeachesTranscription(response, controller.signal);
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => error,
    );
    controller.abort(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        outcome,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("stalled"), 100);
        }),
      ]);
      expect(result).toBe(null);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(timer);
    }
  });

  it("rejects with the caller's reason if cancellation races a successful body read", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during body read");
    const response = new Response("{}", { status: 200 });
    vi.spyOn(response, "json").mockImplementation(async () => {
      controller.abort(reason);
      return { text: "private transcript" };
    });
    await expect(
      readSpeachesTranscription(response, controller.signal),
    ).rejects.toBe(reason);
  });

  it("does not expose private text from invalid successful JSON", async () => {
    const privateFragment = "sensitive";
    const response = new Response(`${privateFragment} transcript`, {
      status: 200,
    });
    const error = await readSpeachesTranscription(response).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(privateFragment);
  });

  it.each([null, [], { text: 42 }, { text: {} }, { text: false }])(
    "rejects a non-string transcript in a successful response: %s",
    async (body) => {
      const response = new Response(JSON.stringify(body), { status: 200 });
      await expect(readSpeachesTranscription(response)).rejects.toThrow(
        "Transcription failed: no text in response",
      );
    },
  );

  it("handles an unreadable error body and rejects empty successful results", async () => {
    const failed = new Response("error", { status: 400 });
    await failed.text();
    await expect(readSpeachesTranscription(failed)).rejects.toThrow(
      "Speaches transcription failed: 400",
    );
    await expect(
      readSpeachesTranscription(new Response("{}", { status: 200 })),
    ).rejects.toThrow("Transcription failed: no text in response");
  });
});

describe("Speaches transport failures", () => {
  it("refuses redirects even when a caller asks to follow them", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok"));
    await requestSpeaches(
      "https://example.com",
      { redirect: "follow" },
      transport,
    );
    expect(transport.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("retires a late transport response after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled while waiting");
    const response = new Response("private response");
    const cancel = vi.spyOn(response.body!, "cancel");
    const transport = vi.fn(async () => {
      controller.abort(reason);
      return response;
    });
    await expect(
      requestSpeaches(
        "https://example.com",
        { signal: controller.signal },
        transport,
      ),
    ).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([200, 503])(
    "discards an unused integration response body on status %s",
    async (status) => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), { status });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(
        speachesTestIntegration({ baseUrl: "https://example.com" }),
      ).resolves.toBe(status === 200);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("does not expose a configured endpoint or transport error in integration checks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("transport-private-detail")),
    );
    const error = await speachesTestIntegration({
      baseUrl: "https://example.com?token=url-secret",
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Unable to connect to Speaches");
    expect(String(error)).not.toMatch(/url-secret|transport-private-detail/);
  });

  it("retries a transport failure without exposing its private detail", async () => {
    const transport = vi
      .fn()
      .mockRejectedValue(new Error("private-audio-fragment"));
    vi.stubGlobal("fetch", transport);
    const error = await speachesTranscribeAudio({
      baseUrl: "https://example.com?token=url-secret",
      model: "test",
      blob: new ArrayBuffer(8),
      ext: "wav",
    }).catch((failure: unknown) => failure);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Unable to connect to Speaches");
    expect(String(error)).not.toMatch(/url-secret|private-audio-fragment/);
  });
});
