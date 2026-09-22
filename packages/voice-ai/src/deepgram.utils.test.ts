import { describe, expect, it, vi } from "vitest";
import { deepgramTranscribeAudio } from "./deepgram.utils";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const makeFetch = (capture: { urls: string[] }) =>
  vi.fn(async (url: RequestInfo | URL) => {
    capture.urls.push(String(url));
    return jsonResponse({
      results: {
        channels: [{ alternatives: [{ transcript: "hello world" }] }],
      },
    });
  });

describe("deepgramTranscribeAudio keyterm prompting", () => {
  it("repeats the keyterm parameter per dictionary term", async () => {
    const capture = { urls: [] as string[] };
    await deepgramTranscribeAudio({
      apiKey: "key",
      blob: new Uint8Array([1, 2]).buffer,
      ext: "wav",
      language: "en",
      keyterms: ["Soniya", "Ralf"],
      customFetch: makeFetch(capture),
    });

    const url = capture.urls[0];
    expect(url).toBeDefined();
    expect(url).toContain("keyterm=Soniya");
    expect(url).toContain("keyterm=Ralf");
    expect(url.match(/keyterm=/g)?.length).toBe(2);
  });

  it("sends no keyterm parameter when the dictionary is empty", async () => {
    const capture = { urls: [] as string[] };
    await deepgramTranscribeAudio({
      apiKey: "key",
      blob: new Uint8Array([1, 2]).buffer,
      ext: "wav",
      language: "en",
      keyterms: [],
      customFetch: makeFetch(capture),
    });

    expect(capture.urls[0]).not.toContain("keyterm");
  });

  it("URL-encodes terms and skips blank ones", async () => {
    const capture = { urls: [] as string[] };
    await deepgramTranscribeAudio({
      apiKey: "key",
      blob: new Uint8Array([1, 2]).buffer,
      ext: "wav",
      language: "en",
      keyterms: ["Kanye West", "  "],
      customFetch: makeFetch(capture),
    });

    expect(capture.urls[0]).toContain("keyterm=Kanye+West");
    expect(capture.urls[0].match(/keyterm=/g)?.length).toBe(1);
  });
});
