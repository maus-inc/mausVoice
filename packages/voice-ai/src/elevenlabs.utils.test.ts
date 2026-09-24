import { describe, expect, it, vi } from "vitest";
import { elevenlabsTranscribeAudio } from "./elevenlabs.utils";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const makeFetch = (capture: { bodies: FormData[] }) =>
  vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    capture.bodies.push(init?.body as FormData);
    return jsonResponse({ text: "hello world" });
  });

describe("elevenlabsTranscribeAudio keyterm prompting", () => {
  it("appends one keyterms form field per dictionary term", async () => {
    const capture = { bodies: [] as FormData[] };
    await elevenlabsTranscribeAudio({
      apiKey: "key",
      blob: new Uint8Array([1, 2]).buffer,
      ext: "wav",
      language: "en",
      keyterms: ["Soniya", "Ralf"],
      customFetch: makeFetch(capture),
    });

    const body = capture.bodies[0];
    expect(body.getAll("keyterms")).toEqual(["Soniya", "Ralf"]);
    expect(body.get("model_id")).toBe("scribe_v2");
  });

  it("sends no keyterms field when the dictionary is empty", async () => {
    const capture = { bodies: [] as FormData[] };
    await elevenlabsTranscribeAudio({
      apiKey: "key",
      blob: new Uint8Array([1, 2]).buffer,
      ext: "wav",
      language: "en",
      keyterms: [],
      customFetch: makeFetch(capture),
    });

    expect(capture.bodies[0].getAll("keyterms")).toEqual([]);
  });
});
