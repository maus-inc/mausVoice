import { afterEach, describe, expect, it, vi } from "vitest";
import { createAldeaTranscribeTests } from "../src/test-helpers/shared-aldea-transcribe.helper";

createAldeaTranscribeTests({
  describeName: "aldeaTranscribeAudio",
  loadModule: async () => {
    const mod = await import("../src/aldea.utils");
    return mod;
  },
  functionName: "aldeaTranscribeAudio",
});

describe("aldeaTestIntegration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockFetch = (status: number) =>
    vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status }));

  it.each([
    {
      status: 200,
      expected: true,
      title: "reports the endpoint reachable on a 200 response",
    },
    {
      status: 400,
      expected: true,
      title:
        "treats a 400 as reachable (invalid key, not a connectivity failure)",
    },
    {
      status: 500,
      expected: false,
      title: "reports a server error as not usable",
    },
  ])("$title", async ({ status, expected }) => {
    mockFetch(status);
    const { aldeaTestIntegration } = await import("../src/aldea.utils");

    await expect(aldeaTestIntegration({ apiKey: "aldea-key" })).resolves.toBe(
      expected,
    );
  });

  it("wraps a network failure in the integration error message", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const { aldeaTestIntegration } = await import("../src/aldea.utils");

    await expect(aldeaTestIntegration({ apiKey: "aldea-key" })).rejects.toThrow(
      "Aldea integration test failed: ECONNREFUSED",
    );
  });
});

describe("aldeaTranscribeAudio failure handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The retry helper re-runs the request on failure, so every attempt must get
  // a fresh, unconsumed Response — resolving one shared instance would trip
  // "Body has already been read" on the second attempt.
  const respond = (body: BodyInit, status = 200) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(body, { status })),
    );
  };

  it("throws when the HTTP response is not ok", async () => {
    respond("quota exceeded", 402);
    const { aldeaTranscribeAudio } = await import("../src/aldea.utils");

    await expect(
      aldeaTranscribeAudio({
        apiKey: "aldea-key",
        blob: new ArrayBuffer(4),
      }),
    ).rejects.toThrow("Aldea API request failed with status 402");
  });

  it("throws when the response carries no transcript", async () => {
    respond(JSON.stringify({ results: { channels: [] } }));
    const { aldeaTranscribeAudio } = await import("../src/aldea.utils");

    await expect(
      aldeaTranscribeAudio({
        apiKey: "aldea-key",
        blob: new ArrayBuffer(4),
      }),
    ).rejects.toThrow("No transcript in Aldea API response");
  });

  it("reports the word count used from the transcript", async () => {
    respond(
      JSON.stringify({
        results: {
          channels: [{ alternatives: [{ transcript: "hello brave world" }] }],
        },
      }),
    );
    const { aldeaTranscribeAudio } = await import("../src/aldea.utils");

    const result = await aldeaTranscribeAudio({
      apiKey: "aldea-key",
      blob: new ArrayBuffer(4),
    });

    expect(result.text).toBe("hello brave world");
    expect(result.wordsUsed).toBe(3);
  });
});
