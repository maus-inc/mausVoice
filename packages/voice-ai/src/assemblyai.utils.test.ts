import { describe, expect, it, vi } from "vitest";
import {
  assemblyaiTranscribeAudio,
  normalizeAssemblyAISpeechModel,
} from "./assemblyai.utils";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("normalizeAssemblyAISpeechModel", () => {
  it("accepts the supported ids and migrates legacy tier names", () => {
    expect(normalizeAssemblyAISpeechModel("universal-3-5-pro")).toBe(
      "universal-3-5-pro",
    );
    expect(normalizeAssemblyAISpeechModel("universal-2")).toBe("universal-2");
    expect(normalizeAssemblyAISpeechModel("best")).toBe("universal-3-5-pro");
    expect(normalizeAssemblyAISpeechModel("nano")).toBe("universal-2");
    expect(normalizeAssemblyAISpeechModel(null)).toBeUndefined();
    expect(() => normalizeAssemblyAISpeechModel("best-est")).toThrow(
      /Unknown AssemblyAI speech model/,
    );
  });
});

describe("assemblyaiTranscribeAudio request contract", () => {
  const makeFetch = (capture: { bodies: Record<string, unknown>[] }) =>
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/upload")) {
        return jsonResponse({ upload_url: "https://cdn.assemblyai.com/u/abc" });
      }
      if (path.endsWith("/transcript") && init?.method === "POST") {
        capture.bodies.push(JSON.parse(init.body as string));
        return jsonResponse({ id: "transcript-1" });
      }
      // Polling
      return jsonResponse({
        status: "completed",
        text: "hello world",
        words: [{}, {}],
      });
    });

  it("posts speech_models (the fallback pair) with audio_url", async () => {
    const capture = { bodies: [] as Record<string, unknown>[] };
    await assemblyaiTranscribeAudio({
      apiKey: "key",
      blob: new Uint8Array([1, 2]).buffer,
      language: "en",
      model: "universal-3-5-pro",
      pollIntervalMs: 1,
      customFetch: makeFetch(capture),
    });

    expect(capture.bodies).toEqual([
      {
        audio_url: "https://cdn.assemblyai.com/u/abc",
        speech_models: ["universal-3-5-pro", "universal-2"],
        language_code: "en",
      },
    ]);
  });

  it("sends the selected model alone and language detection on auto", async () => {
    const capture = { bodies: [] as Record<string, unknown>[] };
    await assemblyaiTranscribeAudio({
      apiKey: "key",
      blob: new Uint8Array([1, 2]).buffer,
      language: "auto",
      model: "universal-2",
      pollIntervalMs: 1,
      customFetch: makeFetch(capture),
    });

    expect(capture.bodies).toEqual([
      {
        audio_url: "https://cdn.assemblyai.com/u/abc",
        speech_models: ["universal-2"],
        language_detection: true,
      },
    ]);
  });

  it("never reuses the deprecated singular speech_model field", async () => {
    const capture = { bodies: [] as Record<string, unknown>[] };
    await assemblyaiTranscribeAudio({
      apiKey: "key",
      blob: new Uint8Array([1, 2]).buffer,
      language: "en",
      model: "best", // legacy value migrates, key shape must not regress
      pollIntervalMs: 1,
      customFetch: makeFetch(capture),
    });

    const body = capture.bodies[0]!;
    expect(body.speech_models).toEqual(["universal-3-5-pro", "universal-2"]);
    expect(body).not.toHaveProperty("speech_model");
  });
});
